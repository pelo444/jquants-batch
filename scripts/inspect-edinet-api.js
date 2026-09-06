'use strict';

/**
 * EDINET系個別APIエンドポイント(Bulk非対応)の実データ確認用スクリプト。
 *
 * scripts/inspect-bulk-csv.js がBulk CSVのヘッダーを確認するのに対し、こちらは
 * 個別API呼出し(pagination_key方式)のJSONレスポンスをそのまま出力する。
 * DBには接続しない。
 *
 * 使い方:
 *   node scripts/inspect-edinet-api.js large-volume-shareholders --date 2025-07-07
 *   node scripts/inspect-edinet-api.js major-shareholders --date 2025-06-20
 *   node scripts/inspect-edinet-api.js cross-shareholdings --date 2025-06-20
 *   node scripts/inspect-edinet-api.js <target> --code 86970
 *   node scripts/inspect-edinet-api.js <target> --edinet-code E03814
 *
 * 【本番投入前に必ず1回実行すること】
 *   ddl/14〜16・src/edinetMapper.jsは、Cowork(Claude)のdevice_bashから
 *   api.jquants.comへ到達できない制約(cowork_device_bridge_limits参照)により、
 *   API仕様書の記載のみに基づいて設計している。実際のフィールド名・null表現・
 *   自由記述欄の桁揃え空白の有無が想定と一致するか、本番投入
 *   (node src/loadInitial.js --only edinet-major-shareholders 等)の前に
 *   必ずこのスクリプトで確認すること。
 *
 * 【--dateに何を指定すればよいか】
 *   - large-volume-shareholders: 仕様書サンプルの書類S100WBIVの提出日 2025-07-07
 *   - major-shareholders / cross-shareholdings: 仕様書のQuery Parameters例に
 *     ある 2025-06-20 でまず試すのが手軽(該当データが無ければ他の平日で再試行)
 */

const jquantsClient = require('../src/jquantsClient');

const ENDPOINTS = {
  'large-volume-shareholders': '/edinet/large-volume-shareholders',
  'major-shareholders': '/edinet/major-shareholders',
  'cross-shareholdings': '/edinet/cross-shareholdings',
};

function parseArgs(argv) {
  const [target, ...rest] = argv;
  const params = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === '--date') params.date = value;
    else if (key === '--code') params.code = value;
    else if (key === '--edinet-code') params.edinet_code = value;
  }
  return { target, params };
}

/** オブジェクトの直下のキー一覧を型付きで表示する(配列はarray(n)、objectはobject/nullとして表示) */
function printFields(indent, obj) {
  if (obj === null || obj === undefined) {
    console.log(`${indent}(null)`);
    return;
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    let typeLabel;
    if (Array.isArray(v)) {
      typeLabel = `array(${v.length})`;
    } else if (v === null) {
      typeLabel = 'null';
    } else {
      typeLabel = typeof v;
    }
    console.log(`${indent}${key}: ${typeLabel}`);
  }
}

async function main() {
  const { target, params } = parseArgs(process.argv.slice(2));
  if (!target || !ENDPOINTS[target]) {
    console.error(
      `使い方: node scripts/inspect-edinet-api.js <${Object.keys(ENDPOINTS).join('|')}> ` +
        '[--date YYYY-MM-DD] [--code XXXXX] [--edinet-code EXXXXX]'
    );
    process.exit(1);
  }

  const path = ENDPOINTS[target];
  console.log(`GET ${path}`, params);

  const docs = await jquantsClient.fetchAllApiPages(path, params);
  console.log(`取得件数: ${docs.length}件`);

  if (docs.length === 0) {
    console.log(
      '該当データがありませんでした。指定日に提出が無かった可能性があります。\n' +
        '別の日付で試してください(large-volume-shareholdersなら2025-07-07、\n' +
        'major-shareholders/cross-shareholdingsなら2025-06-20が仕様書サンプルに近い日付)。'
    );
    return;
  }

  console.log('\n--- 1件目のフルレスポンス(JSON) ---');
  console.log(JSON.stringify(docs[0], null, 2));

  console.log('\n--- フィールド一覧(1件目、書類メタ) ---');
  printFields('  ', docs[0]);

  // large-volume-shareholders / major-shareholders: 直下にHldrs配列がある
  const holders = Array.isArray(docs[0].Hldrs) ? docs[0].Hldrs : null;
  if (holders) {
    if (holders.length > 0) {
      console.log('\n--- Hldrs[0]のフィールド一覧 ---');
      printFields('  ', holders[0]);
    } else {
      console.log('\n(1件目の書類にHldrsが0件でした。他の書類・日付でも確認してください)');
    }
  }

  // cross-shareholdings: Report/Largest/SecondLargestの3ブロック + Spec/Deem配列
  const scopeKeys = ['Report', 'Largest', 'SecondLargest'];
  if (scopeKeys.some((k) => k in docs[0])) {
    for (const key of scopeKeys) {
      const block = docs[0][key];
      console.log(`\n--- ${key} ---`);
      if (block === null || block === undefined) {
        console.log('  (null)');
        continue;
      }
      printFields('  ', block);

      for (const arrKey of ['Spec', 'Deem']) {
        const arr = Array.isArray(block[arrKey]) ? block[arrKey] : [];
        console.log(`  ${arrKey}: array(${arr.length})`);
        if (arr.length > 0) {
          console.log(`  --- ${key}.${arrKey}[0]のフィールド一覧 ---`);
          printFields('    ', arr[0]);
        }
      }
    }
  }

  if (docs.length > 1) {
    console.log(`\n(${docs.length}件取得しましたが、詳細出力は1件目のみです。他も見る場合は --date 等を絞って再実行してください)`);
  }
}

main().catch((err) => {
  console.error('エラー:', err);
  process.exit(1);
});
