'use strict';

/**
 * 裁定取引残高(ARBITRAGE_BALANCE)の取り込み。
 *
 * 【このファイルだけ他の取込と毛色が違う理由】
 * 裁定取引残高はJ-Quantsが配信していない(API仕様書のデータ一覧に該当エンドポイントが
 * 無く、Premiumに上げても取得できない)。マクロ需給ダッシュボードに必要なため、
 * JPXが毎週第3営業日に公表する週間資料を人手でダウンロードして取り込む。
 * loadInitial.js / loadDaily.js のPhase構成には入れていない。
 * 自動で取れないものをバッチのPhaseに混ぜると、日次バッチが「失敗」し続けるため。
 *
 * 【手順】
 *   1. https://www.jpx.co.jp/markets/statistics-equities/program/01.html から
 *      週間資料(20260828.xls のような YYYYMMDD 8桁のファイル)をダウンロードする
 *      ※ ページ名は「プログラム売買」だが、ファイルの中に
 *         「裁定取引に係る現物ポジション」の表が同梱されている
 *   2. python3 scripts/convert-arbitrage-xls.py <xlsのディレクトリ> --out arbitrage.csv
 *   3. node src/loadArbitrage.js arbitrage.csv
 *
 * 【使い方】
 *   node src/loadArbitrage.js <csvファイル>
 *   node src/loadArbitrage.js <csvファイル> --dry-run   DBに書かず、読んだ内容だけ表示
 *
 * 【冪等性】
 *   ステージングをTRUNCATEしてから流し込み、pos_date単位でMERGEする。
 *   同じCSVを何度実行しても結果は同じ。既存の日付は上書きされる。
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const oracledb = require('oracledb');

const db = require('./db');
const mergeSql = require('./mergeSql');

const STG_TABLE = 'arbitrage_balance_stg';

// CSVの列と、ステージングの列の対応。convert-arbitrage-xls.py の CSV_HEADER と揃えること。
const COLUMNS = [
  'pos_date',
  'buy_cur_vol', 'buy_cur_val', 'buy_nxt_vol', 'buy_nxt_val',
  'sell_cur_vol', 'sell_cur_val', 'sell_nxt_vol', 'sell_nxt_val',
  'src_file',
];

// 金額は円単位で兆の桁になるため、NUMBERのバインドで受ける。
// pos_date だけ DATE、src_file だけ STRING。
const BIND_DEFS = [
  { type: oracledb.DATE },
  { type: oracledb.NUMBER }, { type: oracledb.NUMBER },
  { type: oracledb.NUMBER }, { type: oracledb.NUMBER },
  { type: oracledb.NUMBER }, { type: oracledb.NUMBER },
  { type: oracledb.NUMBER }, { type: oracledb.NUMBER },
  { type: oracledb.STRING, maxSize: 800 },
];

/**
 * 'YYYY-MM-DD' をローカル時刻の Date にする。
 * new Date('2026-08-28') はUTC解釈になり、JSTだと前日9:00になってしまうため使わない。
 */
function toDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) {
    throw new Error(`日付の形式が不正です: ${s} (YYYY-MM-DD である必要があります)`);
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Date をローカル日付の 'YYYY-MM-DD' にする。
 *
 * toISOString() を使ってはいけない。UTCに変換されるため、JST(UTC+9)の
 * 2023-01-06 00:00 が 2023-01-05T15:00Z になり、表示が1日前にずれる。
 * 実際にこれで「CSVにもDBにも存在しない日付」がエラーメッセージに出た。
 * DBに入る値は正しい(oracledbはローカル時刻でDATEにバインドする)ので、
 * ずれるのは表示だけだが、調査を丸ごと空振りさせるので必ずこちらを使う。
 */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toNum(s, colName, lineNo) {
  const t = String(s).trim();
  if (t === '') {
    return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n)) {
    throw new Error(`${lineNo}行目: ${colName} が数値ではありません: "${s}"`);
  }
  return n;
}

/**
 * CSVを読んで、executeMany用の行配列(配列の配列)にする。
 */
function readCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });

  if (records.length === 0) {
    throw new Error('CSVにデータ行がありません');
  }

  const header = Object.keys(records[0]);
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `CSVの列が不足しています: ${missing.join(', ')}\n` +
      '  scripts/convert-arbitrage-xls.py が出力したCSVをそのまま渡してください。'
    );
  }

  return records.map((r, i) => {
    const lineNo = i + 2; // ヘッダー行のぶん
    return [
      toDate(r.pos_date),
      toNum(r.buy_cur_vol, 'buy_cur_vol', lineNo),
      toNum(r.buy_cur_val, 'buy_cur_val', lineNo),
      toNum(r.buy_nxt_vol, 'buy_nxt_vol', lineNo),
      toNum(r.buy_nxt_val, 'buy_nxt_val', lineNo),
      toNum(r.sell_cur_vol, 'sell_cur_vol', lineNo),
      toNum(r.sell_cur_val, 'sell_cur_val', lineNo),
      toNum(r.sell_nxt_vol, 'sell_nxt_vol', lineNo),
      toNum(r.sell_nxt_val, 'sell_nxt_val', lineNo),
      r.src_file || path.basename(csvPath),
    ];
  });
}

/**
 * 取り込む前の最終チェック。
 * 変換スクリプト側でも検証しているが、CSVを手で編集して壊す余地があるため
 * DBに入れる直前にもう一度見る。
 *
 * 【errors と warnings を分ける理由】
 * 「起きたら確実に壊れている」ものだけを errors(取り込み中止)にする。
 * 「珍しいが起こり得る」ものを止めてしまうと、正しいデータを取り込めなくなる。
 * 実際、初回の過去分取り込み(191件)で「売残 > 買残」を止める作りにしていたため
 * 2023年1月の3週で止まった。調べたところ実データで、当時は本当に売り長だった
 * (売残5,561億円 / 買残3,505億円。前後の週とも連続していた)。
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
function sanityCheck(rows) {
  const errors = [];
  const warnings = [];
  const OKU = 100000000;

  rows.forEach((r) => {
    const [d, bcv, bca, bnv, bna, scv, sca, snv, sna] = r;
    const ymd = fmtDate(d);
    const buyTotal = (bca || 0) + (bna || 0);
    const sellTotal = (sca || 0) + (sna || 0);

    // 買残の合計金額。実績は2023年で3,462億円、2026年で38,684億円と3年で3倍近く
    // 動いているため、範囲は広めに取っている。ここを外れるのは単位の取り違え
    // (千株・百万円のまま入れた等)で、桁が3桁ずれるので必ず引っかかる。
    if (buyTotal < 100 * OKU || buyTotal > 200000 * OKU) {
      errors.push(
        `${ymd}: 買残の合計金額が ${Math.round(buyTotal / OKU).toLocaleString()}億円。` +
        '単位(株・円に正規化済みか)を確認してください'
      );
    }

    // 株数が負になっていないか
    [['buy_cur_vol', bcv], ['buy_nxt_vol', bnv],
     ['sell_cur_vol', scv], ['sell_nxt_vol', snv]].forEach(([name, v]) => {
      if (v !== null && v < 0) {
        errors.push(`${ymd}: ${name} が負の値です (${v})`);
      }
    });

    // 売り長。稀だが実在する(2023年1月)。止めずに知らせるだけにする。
    if (sellTotal > buyTotal) {
      warnings.push(
        `${ymd}: 売残(${Math.round(sellTotal / OKU).toLocaleString()}億円)が ` +
        `買残(${Math.round(buyTotal / OKU).toLocaleString()}億円)を上回っています(売り長)`
      );
    }
  });

  return { errors, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const csvPath = args.find((a) => !a.startsWith('--'));

  if (!csvPath) {
    console.error('使い方: node src/loadArbitrage.js <csvファイル> [--dry-run]');
    console.error('  CSVは scripts/convert-arbitrage-xls.py で作ります。');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`ファイルがありません: ${csvPath}`);
    process.exit(1);
  }

  const rows = readCsv(csvPath);
  console.log(`CSVを読みました: ${rows.length}件 (${path.basename(csvPath)})`);

  const { errors, warnings } = sanityCheck(rows);
  if (warnings.length > 0) {
    console.log(`注意 (${warnings.length}件。取り込みは続行します):`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
  if (errors.length > 0) {
    console.error('取り込み前チェックで問題が見つかりました:');
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error('修正してから再実行してください。');
    process.exit(1);
  }

  const dates = rows.map((r) => fmtDate(r[0])).sort();
  console.log(`  対象期間: ${dates[0]} 〜 ${dates[dates.length - 1]}`);

  if (dryRun) {
    console.log('--dry-run のためDBには書き込みません。');
    rows.slice(0, 5).forEach((r) => {
      const OKU = 100000000;
      console.log(
        `  ${fmtDate(r[0])}  ` +
        `買残 ${Math.round(((r[2] || 0) + (r[4] || 0)) / OKU).toLocaleString()}億円 / ` +
        `売残 ${Math.round(((r[6] || 0) + (r[8] || 0)) / OKU).toLocaleString()}億円`
      );
    });
    if (rows.length > 5) {
      console.log(`  ... 他 ${rows.length - 5}件`);
    }
    return;
  }

  await db.withConnection(async (connection) => {
    await db.truncateTable(connection, STG_TABLE);
    const inserted = await db.bulkInsert(connection, STG_TABLE, COLUMNS, rows, {
      bindDefs: BIND_DEFS,
    });
    console.log(`ステージングに投入: ${inserted}件`);

    const merged = await mergeSql.mergeArbitrageBalance(connection);
    console.log(`ARBITRAGE_BALANCE にMERGE: ${merged}件`);

    await connection.commit();
    await db.truncateTable(connection, STG_TABLE);
    await connection.commit();
  });

  console.log('完了しました。');
  console.log('確認: SELECT * FROM v_arbitrage_balance_weekly ORDER BY pos_date DESC FETCH FIRST 10 ROWS ONLY;');
}

if (require.main === module) {
  main()
    .then(() => db.closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('取り込みに失敗しました:', err.message);
      if (err.stack) {
        console.error(err.stack);
      }
      await db.closePool().catch(() => {});
      process.exit(1);
    });
}

module.exports = { readCsv, sanityCheck };
