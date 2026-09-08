'use strict';

/**
 * JPX週間公表資料(.xls)の一括ダウンロード。
 *
 * 裁定取引残高の過去分を揃えるためのツール。
 * ダウンロードしたファイルは scripts/convert-arbitrage-xls.py → src/loadArbitrage.js
 * の順に流してDBへ入れる(詳細は ddl/17_arbitrage_balance.sql の冒頭コメント)。
 *
 * 【ページ構成】(2026-09-09 に確認)
 *   最新5週:  /markets/statistics-equities/program/01.html
 *   年別:     /markets/statistics-equities/program/01-archives-NN.html
 *               NN=00 → 当年(2026)、01 → 前年(2025)、02 → 2024、03 → 2023
 *   掲載は年52件前後、直近4年分まで。それより古い週は取得できない。
 *
 *   ファイルのURLは
 *     /markets/statistics-equities/program/<ハッシュ>-att/YYYYMMDD.xls
 *   の形だが、<ハッシュ>は週ごとに違い規則性が無い(t13vrt... / bkk2ed... / cg27su... 等)。
 *   URLを組み立てることはできないので、必ずページのhrefを拾う。
 *
 * 【JPXのサイトへの負荷について】
 *   逐次1件ずつ、既定1秒間隔でダウンロードする。**並列化しないこと。**
 *   4年分でも200件程度・8MB程度なので、数分待てば済む。
 *   取得済みのファイルは既定でスキップするため、2回目以降は差分だけになる。
 *
 * 【依存】
 *   なし。Node 18以降の組み込み fetch を使う(package.json の engines も >=18)。
 *
 * 【使い方】
 *   # 何が落ちてくるか確認する(ダウンロードしない)
 *   node scripts/download-arbitrage-archives.js --dry-run
 *
 *   # 全アーカイブ(直近4年分)を取得
 *   node scripts/download-arbitrage-archives.js
 *
 *   # 最新ページ(直近5週)だけ。毎週の運用はこちら
 *   node scripts/download-arbitrage-archives.js --latest
 *
 *   # 出力先を変える(既定は ../manual_dl_datas/program_weekly)
 *   node scripts/download-arbitrage-archives.js --out /path/to/dir
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.jpx.co.jp';
const LATEST_PAGE = `${BASE}/markets/statistics-equities/program/01.html`;
const ARCHIVE_PAGE = (n) =>
  `${BASE}/markets/statistics-equities/program/01-archives-${String(n).padStart(2, '0')}.html`;

// アーカイブページを何番まで探すか。現在は03(2023年)までだが、
// 年が変わると増える可能性があるので少し余裕を持って打ち切る。
const MAX_ARCHIVE_PAGES = 8;

const DEFAULT_OUT = path.resolve(__dirname, '..', '..', 'manual_dl_datas', 'program_weekly');
const DEFAULT_DELAY_MS = 1000;

// 週間資料のファイルURL。<ハッシュ>-att/YYYYMMDD.xls の形だけを拾う。
// 日次版(YYMMDD 6桁)は対象外なので、8桁に限定することで自然に除外される。
const XLS_HREF = /href\s*=\s*["']([^"']*\/statistics-equities\/program\/[^"']*?\/(\d{8})\.xls)["']/gi;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'jquants-batch/1.0 (personal research use)' },
  });
  if (res.status === 404) {
    return null; // アーカイブページの打ち切り判定に使う
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${url}`);
  }
  // hrefはASCIIなので、本文の文字コード(Shift_JIS/UTF-8)に関わらずUTF-8で読んでよい。
  // 日本語部分が文字化けしてもリンク抽出には影響しない。
  return res.text();
}

/**
 * HTMLから週間資料の .xls のURLを抽出する。
 * @returns {Array<{url: string, name: string}>} name は 'YYYYMMDD.xls'
 */
function extractXlsLinks(html, pageUrl) {
  const found = new Map(); // name → url (同一ページ内の重複を潰す)
  let m;
  XLS_HREF.lastIndex = 0;
  while ((m = XLS_HREF.exec(html)) !== null) {
    const abs = new URL(m[1], pageUrl).href;
    const name = `${m[2]}.xls`;
    if (!found.has(name)) {
      found.set(name, abs);
    }
  }
  return [...found.entries()].map(([name, url]) => ({ name, url }));
}

/**
 * 最新ページと各アーカイブページを回って、取得対象の一覧を作る。
 */
async function collectTargets({ latestOnly, delayMs }) {
  const pages = [LATEST_PAGE];
  if (!latestOnly) {
    for (let n = 0; n < MAX_ARCHIVE_PAGES; n += 1) {
      pages.push(ARCHIVE_PAGE(n));
    }
  }

  const all = new Map(); // name → url
  let missStreak = 0;

  for (const page of pages) {
    const html = await fetchText(page);
    if (html === null) {
      // 存在しないアーカイブページ。2回続いたら以降も無いとみなして打ち切る
      missStreak += 1;
      console.log(`  ${path.basename(page)}: ページなし(404)`);
      if (missStreak >= 2) {
        break;
      }
      continue;
    }
    missStreak = 0;

    const links = extractXlsLinks(html, page);
    console.log(`  ${path.basename(page)}: ${links.length}件`);
    links.forEach(({ name, url }) => {
      if (!all.has(name)) {
        all.set(name, url);
      }
    });
    await sleep(delayMs);
  }

  return [...all.entries()]
    .map(([name, url]) => ({ name, url }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function download(url, destPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'jquants-batch/1.0 (personal research use)' },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // 中身の検査。JPXがエラーページをHTMLで返した場合に、それを .xls として
  // 保存してしまうと、後段の変換スクリプトで分かりにくいエラーになる。
  // 旧形式(BIFF8)の .xls は D0 CF 11 E0 で始まる複合ドキュメント。
  if (buf.length < 4 || buf[0] !== 0xd0 || buf[1] !== 0xcf || buf[2] !== 0x11 || buf[3] !== 0xe0) {
    throw new Error(`.xls ではない内容が返りました (${buf.length} bytes)`);
  }

  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const latestOnly = args.includes('--latest');
  const force = args.includes('--force');

  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;

  const delayIdx = args.indexOf('--delay');
  const delayMs = delayIdx >= 0 && args[delayIdx + 1]
    ? Number(args[delayIdx + 1]) : DEFAULT_DELAY_MS;

  if (!fs.existsSync(outDir)) {
    if (dryRun) {
      console.log(`(--dry-run) 出力先が無いので作成します: ${outDir}`);
    } else {
      fs.mkdirSync(outDir, { recursive: true });
      console.log(`出力先を作成しました: ${outDir}`);
    }
  }

  console.log(latestOnly ? '最新ページを確認します' : '最新ページとアーカイブを確認します');
  const targets = await collectTargets({ latestOnly, delayMs });
  console.log(`対象: ${targets.length}件`);

  const todo = targets.filter((t) => force || !fs.existsSync(path.join(outDir, t.name)));
  const skipped = targets.length - todo.length;
  if (skipped > 0) {
    console.log(`  取得済みのためスキップ: ${skipped}件`);
  }
  if (todo.length === 0) {
    console.log('新しいファイルはありません。');
    return;
  }
  console.log(`  ダウンロード対象: ${todo.length}件`);

  if (dryRun) {
    todo.forEach((t) => console.log(`    ${t.name}  ${t.url}`));
    console.log('--dry-run のためダウンロードしません。');
    return;
  }

  const estSec = Math.round((todo.length * delayMs) / 1000);
  console.log(`  ${delayMs}ms間隔で逐次取得します(推定 ${estSec} 秒)`);

  let ok = 0;
  const failures = [];
  for (const [i, t] of todo.entries()) {
    const dest = path.join(outDir, t.name);
    try {
      const bytes = await download(t.url, dest);
      ok += 1;
      console.log(`  [${i + 1}/${todo.length}] ${t.name} (${bytes.toLocaleString()} bytes)`);
    } catch (e) {
      failures.push({ name: t.name, url: t.url, message: e.message });
      console.error(`  [${i + 1}/${todo.length}] ${t.name} 失敗: ${e.message}`);
    }
    await sleep(delayMs);
  }

  console.log(`\n完了: 成功 ${ok}件 / 失敗 ${failures.length}件`);
  if (failures.length > 0) {
    console.log('失敗したファイル(再実行すれば未取得分だけ取り直します):');
    failures.forEach((f) => console.log(`  ${f.name}  ${f.url}  ${f.message}`));
  }
  console.log('\n次の手順:');
  console.log(`  python3 scripts/convert-arbitrage-xls.py ${outDir} --out ../manual_dl_datas/arbitrage_balance.csv`);
  console.log('  node src/loadArbitrage.js ../manual_dl_datas/arbitrage_balance.csv --dry-run');
  console.log('  node src/loadArbitrage.js ../manual_dl_datas/arbitrage_balance.csv');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('失敗しました:', err.message);
    process.exit(1);
  });
}

module.exports = { extractXlsLinks };
