'use strict';

/**
 * 株価チャート一覧の生成ツール
 *
 * 指定した銘柄の終値(株式分割調整済み)を、1銘柄1グラフで縦に並べた
 * 自己完結型のHTMLを出力する。外部CDNに依存しないのでオフラインでも開ける。
 *
 * 使い方:
 *   node src/chart.js --codes 44880,55740,68570 --years 1
 *   node src/chart.js --tag 110_ai_model --from 2024-04-01
 *   node src/chart.js --tag 130_semi_equip_material --years 3 --open
 *   node src/chart.js --list-tags
 *
 * 主なオプション:
 *   --codes <list>   カンマ区切りの銘柄コード。4桁(6857)でも5桁(68570)でも可。
 *   --tag <name>     タグ名を指定して、そのタグの銘柄をまとめて表示(例: 110_ai_model)
 *   --from <date>    開始日 YYYY-MM-DD
 *   --to <date>      終了日 YYYY-MM-DD (既定: 取込済みデータの最新営業日)
 *   --years <n>      --from の代わりに「終了日からn年前」を開始日にする
 *   --months <n>     同様に「終了日からnか月前」
 *   --max-codes <n>  一度に扱う銘柄数の上限(既定: 30)
 *   --out <path>     出力ファイルパス(既定: output/chart_<日時>.html)
 *   --open           出力後にブラウザで開く
 *   --list-tags      登録済みタグと銘柄数を一覧表示して終了
 *
 * 制限(処理負荷を抑えるための既定値):
 *   ・期間は最大3年。超える指定は3年に切り詰めて警告する。
 *   ・銘柄数は既定30。超える場合は警告して先頭30銘柄のみを対象にする。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const db = require('./db');
const q = require('./chartQuery');
const { buildHtml } = require('./chartHtml');
const { buildPayload } = require('./chartPayload');

const MAX_YEARS = 3;
const DEFAULT_MAX_CODES = 30;

//------------------------------------------------------------------
// 引数解析
//------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { maxCodes: DEFAULT_MAX_CODES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${a} には値が必要です`);
      }
      i++;
      return v;
    };
    switch (a) {
      case '--codes': opts.codes = next(); break;
      case '--tag': opts.tag = next(); break;
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--years': opts.years = Number(next()); break;
      case '--months': opts.months = Number(next()); break;
      case '--max-codes': opts.maxCodes = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--open': opts.open = true; break;
      case '--list-tags': opts.listTags = true; break;
      case '--help':
      case '-h': opts.help = true; break;
      default:
        throw new Error(`不明なオプション: ${a}\n--help で使い方を表示します`);
    }
  }
  return opts;
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8');
  const m = header.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) {
    console.log(m[1].replace(/^[ \t]*\* ?/gm, '').trim());
  }
}

/** 4桁の証券コードをJ-Quantsの5桁形式に揃える */
function normalizeCode(raw) {
  const c = String(raw).trim().toUpperCase();
  if (!c) return null;
  if (c.length === 4) return c + '0';
  if (c.length === 5) return c;
  throw new Error(`銘柄コードの桁数が不正です: "${raw}" (4桁または5桁で指定してください)`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(s, label) {
  if (!ISO_DATE.test(s)) {
    throw new Error(`${label} は YYYY-MM-DD 形式で指定してください: "${s}"`);
  }
}

/** 'YYYY-MM-DD' から n年 / nか月 遡った日付を返す(UTC基準で計算しズレを避ける) */
function shiftDate(iso, { years = 0, months = 0 }) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCFullYear(dt.getUTCFullYear() - years);
  dt.setUTCMonth(dt.getUTCMonth() - months);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
}

function timestampForFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

//------------------------------------------------------------------
// メイン
//------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.listTags) {
    await db.withConnection(async (conn) => {
      const tags = await q.fetchTagList(conn);
      if (tags.length === 0) {
        console.log('タグが登録されていません(ddl/05_tag_master.sql は実行済みですか?)');
        return;
      }
      console.log('登録済みタグ:');
      for (const t of tags) {
        console.log(`  ${t.tagName.padEnd(28)} ${String(t.count).padStart(4)}銘柄  ${t.label}`);
      }
    });
    return;
  }

  if (!opts.codes && !opts.tag) {
    throw new Error('--codes または --tag のどちらかを指定してください(--help で使い方を表示)');
  }
  if (opts.codes && opts.tag) {
    throw new Error('--codes と --tag は同時に指定できません');
  }

  const html = await db.withConnection(async (conn) => {
    //---------------------------------------------------------- 期間の決定
    let to = opts.to;
    if (to) {
      assertIsoDate(to, '--to');
    } else {
      to = await q.fetchLatestPriceDate(conn);
      if (!to) throw new Error('EQUITY_PRICE_DAILY にデータがありません');
      console.log(`終了日を取込済みデータの最新営業日 ${to} にしました`);
    }

    let from = opts.from;
    if (from) {
      assertIsoDate(from, '--from');
    } else if (opts.years) {
      from = shiftDate(to, { years: opts.years });
    } else if (opts.months) {
      from = shiftDate(to, { months: opts.months });
    } else {
      from = shiftDate(to, { years: 1 });
      console.log(`開始日の指定が無いので直近1年 (${from}) にしました`);
    }

    if (daysBetween(from, to) <= 0) {
      throw new Error(`期間が不正です: ${from} 〜 ${to}`);
    }

    const limitFrom = shiftDate(to, { years: MAX_YEARS });
    if (from < limitFrom) {
      console.warn(
        `[警告] 期間の上限は${MAX_YEARS}年です。開始日を ${from} から ${limitFrom} に切り詰めました。`
      );
      from = limitFrom;
    }

    //---------------------------------------------------------- 銘柄の決定
    let codes;
    let source;
    if (opts.tag) {
      const tagged = await q.fetchCodesByTag(conn, opts.tag);
      if (tagged.length === 0) {
        throw new Error(
          `タグ "${opts.tag}" に紐づく銘柄がありません。--list-tags で登録済みタグを確認してください。`
        );
      }
      codes = tagged.map((t) => t.code);
      source = `タグ: ${opts.tag}`;
      console.log(`タグ "${opts.tag}" から ${codes.length} 銘柄を取得しました`);
    } else {
      codes = opts.codes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizeCode);
      source = null;
    }

    // 重複を除去(指定順は保つ)
    const seen = new Set();
    codes = codes.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));

    if (codes.length > opts.maxCodes) {
      const dropped = codes.slice(opts.maxCodes);
      console.warn(
        `[警告] 銘柄数が上限 ${opts.maxCodes} を超えています(${codes.length}銘柄)。\n` +
          `        先頭 ${opts.maxCodes} 銘柄のみを対象にします。除外: ${dropped.join(', ')}\n` +
          `        全件見たい場合は --max-codes ${codes.length} を指定してください。`
      );
      codes = codes.slice(0, opts.maxCodes);
    }

    //---------------------------------------------------------- 取得
    console.log(`${codes.length}銘柄 / ${from} 〜 ${to} のデータを取得します...`);
    const rows = await q.fetchAdjustedCloses(conn, codes, from, to);
    if (rows.length === 0) {
      throw new Error('該当するデータが0件でした。銘柄コードと期間を確認してください。');
    }
    console.log(`${rows.length} 行を取得しました`);

    const payload = buildPayload(rows, codes, {
      from,
      to,
      source,
      generatedAt: new Date().toISOString(),
    });

    const missing = codes.filter((c) => !payload.series.some((s) => s.code === c));
    if (missing.length > 0) {
      console.warn(`[警告] この期間にデータが無かった銘柄: ${missing.join(', ')}`);
    }

    return buildHtml(payload);
  });

  //---------------------------------------------------------- 出力
  const outPath = path.resolve(
    opts.out || path.join(__dirname, '..', 'output', `chart_${timestampForFileName()}.html`)
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log(`出力しました: ${outPath} (${kb} KB)`);

  if (opts.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(cmd, [outPath], (err) => {
      if (err) console.warn(`ブラウザを開けませんでした: ${err.message}`);
    });
  }
}

main()
  .catch((err) => {
    console.error(`エラー: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.closePool().catch(() => {});
  });
