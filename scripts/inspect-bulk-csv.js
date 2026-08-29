'use strict';

/**
 * Bulk APIのCSVヘッダー確認ツール
 *
 * 【なぜ必要か】
 *   Bulk APIのCSVヘッダー名はAPI仕様書に明記されていない。
 *   本スクリプトは各エンドポイントの最新ファイルを1つだけ取得し、
 *   実際のヘッダーと csvMapper が期待する項目の差分を表示する。
 *
 *   2026-08-29の実行で、列名はいずれもAPIレスポンスのフィールド名と
 *   同一であることを確認した。ただし以下2点は仕様書から読み取れない挙動だった:
 *     ・margin-alert の PubReason は6列に展開されず、1列に辞書形式の
 *       文字列が入って来る
 *         {'Restricted': '0', 'DailyPublication': '0', ...}
 *       (シングルクォートのためJSONではない)
 *     ・short-sale-report の空欄は空文字ではなく '-' で来る
 *   いずれも csvMapper.js 側で対応済み。
 *
 *   J-Quants側の仕様変更に気づけるよう、取込がおかしいと感じたときや
 *   新しいエンドポイントを追加するときに実行すること。
 *
 * 使い方:
 *   node scripts/inspect-bulk-csv.js               全エンドポイント
 *   node scripts/inspect-bulk-csv.js short-ratio   個別指定
 *   node scripts/inspect-bulk-csv.js --rows 3      サンプル行を3行表示
 *
 * DBには接続しない(APIから読むだけ)。
 */

const jquantsClient = require('../src/jquantsClient');
const loadInitial = require('../src/loadInitial');
const csvMapper = require('../src/csvMapper');

/**
 * 確認対象。csvMapper が参照するフィールド名を expected に列挙しておき、
 * 実CSVのヘッダーと突き合わせる。
 */
const TARGETS = [
  {
    key: 'short-ratio',
    label: '業種別空売り比率',
    endpoint: loadInitial.ENDPOINT_SHORT_RATIO,
    expected: ['Date', 'S33', 'SellExShortVa', 'ShrtWithResVa', 'ShrtNoResVa'],
  },
  {
    key: 'margin-interest',
    label: '信用取引残高',
    endpoint: loadInitial.ENDPOINT_MARGIN_INTEREST,
    expected: [
      'Date', 'Code', 'IssType',
      'ShrtVol', 'LongVol', 'ShrtNegVol', 'LongNegVol', 'ShrtStdVol', 'LongStdVol',
    ],
    // 2026年9月25日申込分以降のみ提供されるため、無くても異常ではない
    optional: [
      'ShrtVal', 'LongVal', 'ShrtNegVal', 'LongNegVal', 'ShrtStdVal', 'LongStdVal',
    ],
  },
  {
    key: 'margin-alert',
    label: '日々公表信用取引残高',
    endpoint: loadInitial.ENDPOINT_MARGIN_ALERT,
    expected: [
      'PubDate', 'Code', 'AppDate',
      'ShrtOut', 'ShrtOutChg', 'ShrtOutRatio',
      'LongOut', 'LongOutChg', 'LongOutRatio', 'SLRatio',
      'ShrtNegOut', 'ShrtNegOutChg', 'ShrtStdOut', 'ShrtStdOutChg',
      'LongNegOut', 'LongNegOutChg', 'LongStdOut', 'LongStdOutChg',
      'TSEMrgnRegCls',
    ],
    // PubReason は1列に辞書形式の文字列として入っている(実データで確認済み)
    reasonKeys: [
      'Restricted', 'DailyPublication', 'Monitoring',
      'RestrictedByJSF', 'PrecautionByJSF', 'UnclearOrSecOnAlert',
    ],
  },
  {
    key: 'short-position',
    label: '空売り残高報告',
    endpoint: loadInitial.ENDPOINT_SHORT_POSITION,
    expected: [
      'DiscDate', 'CalcDate', 'Code',
      'SSName', 'SSAddr', 'DICName', 'DICAddr', 'FundName',
      'ShrtPosToSO', 'ShrtPosShares', 'ShrtPosUnits',
      'PrevRptDate', 'PrevRptRatio', 'Notes',
    ],
  },
];

function parseArgs(argv) {
  const opts = { keys: [], rows: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--rows') {
      opts.rows = Number(argv[i + 1] || 1);
      i += 1;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`不明なオプション: ${argv[i]}`);
    } else {
      opts.keys.push(argv[i]);
    }
  }
  return opts;
}

/** 最も新しいファイルを1つ選ぶ(liveがあればlive、無ければhistoricalの最新) */
function pickLatest(files) {
  const sorted = loadInitial.sortFilesChronologically(files);
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

async function inspect(target, sampleRows) {
  console.log('='.repeat(78));
  console.log(`${target.label}  (${target.endpoint})`);
  console.log('='.repeat(78));

  let files;
  try {
    files = await jquantsClient.listBulkFiles(target.endpoint);
  } catch (err) {
    console.log(`  ✗ ファイル一覧を取得できませんでした: ${err.message}`);
    console.log('    契約プランでこのデータが利用できるか確認してください。\n');
    return;
  }

  if (!files || files.length === 0) {
    console.log('  ✗ ファイルが0件でした。契約プランを確認してください。\n');
    return;
  }

  const latest = pickLatest(files);
  console.log(`  ファイル数: ${files.length}`);
  console.log(`  最古: ${loadInitial.sortFilesChronologically(files)[0].Key}`);
  console.log(`  最新: ${latest.Key}`);

  const rows = await jquantsClient.fetchBulkFile(latest.Key);
  if (rows.length === 0) {
    console.log('  ファイルは取得できましたが0行でした。\n');
    return;
  }

  const headers = Object.keys(rows[0]);
  console.log(`  行数: ${rows.length.toLocaleString()}`);
  console.log(`  ヘッダー(${headers.length}列): ${headers.join(', ')}`);

  // --- csvMapper が期待する項目との突合 ---
  const missing = target.expected.filter((h) => !headers.includes(h));
  const optionalMissing = (target.optional || []).filter((h) => !headers.includes(h));
  const extra = headers.filter(
    (h) =>
      !target.expected.includes(h) &&
      !(target.optional || []).includes(h) &&
      !h.includes('Reason') &&
      !(target.reasonKeys || []).includes(h)
  );

  if (missing.length === 0) {
    console.log('  ✓ 想定した必須項目はすべて存在します');
  } else {
    console.log(`  ✗ 想定した項目が見つかりません: ${missing.join(', ')}`);
    console.log('    → src/csvMapper.js の pick() の候補名を実際のヘッダーに合わせてください');
  }

  if (optionalMissing.length > 0) {
    console.log(
      `  ・任意項目は未提供: ${optionalMissing.join(', ')}\n` +
        '    (信用取引残高の金額項目は2026年9月25日申込分以降のみ。NULLで取り込まれます)'
    );
  }

  if (extra.length > 0) {
    console.log(`  ・想定に無い列があります(取り込み対象外): ${extra.join(', ')}`);
  }

  // --- PubReason の形式を特定する ---
  //
  // 実データでは6項目が列に展開されず、1列に辞書形式の文字列が入っていた。
  // 列に展開されている場合と、1列に入っている場合の両方を判定する。
  if (target.reasonKeys) {
    console.log('  PubReason の形式:');

    if (headers.includes('PubReason')) {
      // 1列に辞書形式の文字列が入っているパターン。実際のパーサで展開して検証する。
      const sample = rows.find((r) => r.PubReason);
      const raw = sample ? String(sample.PubReason) : '';
      console.log(`    1列に格納されています: ${raw.slice(0, 70)}${raw.length > 70 ? '…' : ''}`);

      const parsed = csvMapper.parsePubReason(raw);
      const missingKeys = target.reasonKeys.filter((k) => parsed[k] === undefined);
      if (missingKeys.length === 0) {
        console.log('    ✓ csvMapper.parsePubReason() で6項目すべて展開できました');
        for (const k of target.reasonKeys) {
          console.log(`      ${k.padEnd(22)} = ${parsed[k]}`);
        }
      } else {
        console.log(`    ✗ 展開できない項目があります: ${missingKeys.join(', ')}`);
        console.log('      → src/csvMapper.js の parsePubReason() を実データに合わせてください');
      }
    } else {
      // 列に展開されているパターン
      let allFound = true;
      for (const k of target.reasonKeys) {
        const candidates = [`PubReason.${k}`, `PubReason_${k}`, `PubReason${k}`, k];
        const found = candidates.find((c) => headers.includes(c));
        if (!found) allFound = false;
        console.log(
          `    ${k.padEnd(22)} ${found ? '✓ ' + found : '✗ 見つかりません(候補: ' + candidates.join(' / ') + ')'}`
        );
      }
      if (allFound) {
        console.log('    ✓ 列に展開されています(csvMapper はこの形式にも対応済み)');
      }
    }
  }

  // --- 空欄の表現を確認する ---
  //
  // 空売り残高報告では、値が無い項目が空文字ではなく '-' で来ることを実データで確認した。
  // csvMapper 側は toStrDashNull() でNULL化しているが、他のデータでも同様か確認する。
  const dashCols = headers.filter((h) =>
    rows.some((r) => String(r[h] === null || r[h] === undefined ? '' : r[h]).trim() === '-')
  );
  const starCols = headers.filter((h) =>
    rows.some((r) => String(r[h] === null || r[h] === undefined ? '' : r[h]).trim() === '*')
  );
  if (dashCols.length > 0) {
    console.log(`  ・'-'(値なし)が出現する列: ${dashCols.join(', ')}`);
  }
  if (starCols.length > 0) {
    console.log(`  ・'*'(ETF等で算出不可)が出現する列: ${starCols.join(', ')}`);
  }

  // --- サンプル行 ---
  for (let i = 0; i < Math.min(sampleRows, rows.length); i += 1) {
    console.log(`  サンプル行 ${i + 1}:`);
    for (const [k, v] of Object.entries(rows[i])) {
      const shown = String(v === null || v === undefined ? '' : v);
      console.log(`    ${k.padEnd(24)} ${shown.length > 60 ? shown.slice(0, 60) + '…' : shown}`);
    }
  }
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const targets =
    opts.keys.length === 0
      ? TARGETS
      : opts.keys.map((k) => {
          const t = TARGETS.find((x) => x.key === k);
          if (!t) {
            throw new Error(
              `不明な対象: ${k}\n  指定できる値: ${TARGETS.map((x) => x.key).join(', ')}`
            );
          }
          return t;
        });

  console.log('Bulk APIのCSVヘッダーを確認します(DBには接続しません)\n');

  for (const t of targets) {
    await inspect(t, opts.rows);
    await jquantsClient.throttle();
  }

  console.log('確認が終わりました。');
  console.log('「✗」が出た項目は src/csvMapper.js の該当する箇所を修正してください。');
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exitCode = 1;
});
