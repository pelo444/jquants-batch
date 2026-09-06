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
 *   node scripts/inspect-edinet-api.js large-volume-shareholders --code 86970
 *   node scripts/inspect-edinet-api.js large-volume-shareholders --edinet-code E03814
 *
 * 【本番投入前に必ず1回実行すること】
 *   ddl/14_large_volume_shareholders.sql・src/edinetMapper.jsは、Cowork(Claude)の
 *   device_bashからapi.jquants.comへ到達できない制約(cowork_device_bridge_limits参照)
 *   により、API仕様書(/spec/edinet-large-volume-shareholders)の記載のみに基づいて
 *   設計している。実際のフィールド名・null表現・自由記述欄の桁揃え空白の有無が
 *   想定と一致するか、本番投入(node src/loadInitial.js --only edinet-large-volume)の
 *   前に必ずこのスクリプトで確認すること。
 *
 * 【--dateに何を指定すればよいか】
 *   API仕様書のレスポンスサンプルにある書類 S100WBIV は提出日 2025-07-07。
 *   まずはこの日付で試すのが手軽(実際に該当データが返るはず)。
 */

const jquantsClient = require('../src/jquantsClient');

const ENDPOINTS = {
  'large-volume-shareholders': '/edinet/large-volume-shareholders',
  // 政策保有株式・大株主状況に着手する際は、describe_endpointで正式なエンドポイント名を
  // 確認したうえでここに追加する(edinet_bulk_holding_report.mdのNext Action参照)。
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
        '別の日付(例: --date 2025-07-07。仕様書サンプルの書類S100WBIVの提出日)で試してください。'
    );
    return;
  }

  console.log('\n--- 1件目のフルレスポンス(JSON) ---');
  console.log(JSON.stringify(docs[0], null, 2));

  console.log('\n--- フィールド一覧(1件目、書類メタ) ---');
  for (const key of Object.keys(docs[0])) {
    const v = docs[0][key];
    console.log(`  ${key}: ${Array.isArray(v) ? `array(${v.length})` : typeof v}`);
  }

  const holders = Array.isArray(docs[0].Hldrs) ? docs[0].Hldrs : [];
  if (holders.length > 0) {
    console.log('\n--- Hldrs[0]のフィールド一覧 ---');
    for (const key of Object.keys(holders[0])) {
      const v = holders[0][key];
      console.log(`  ${key}: ${Array.isArray(v) ? `array(${v.length})` : typeof v}`);
    }
  } else {
    console.log('\n(1件目の書類にHldrsが0件でした。他の書類・日付でも確認してください)');
  }

  if (docs.length > 1) {
    console.log(`\n(${docs.length}件取得しましたが、詳細出力は1件目のみです。他も見る場合は --date 等を絞って再実行してください)`);
  }
}

main().catch((err) => {
  console.error('エラー:', err);
  process.exit(1);
});
