'use strict';

/**
 * loadInitial.js の動作確認スクリプト
 *
 * 全ファイル(240件超)をいきなり流す前に、live配下の小さいファイルを
 * マスタ・株価それぞれ1件ずつ処理して、以下を確認する。
 *
 *   - CSVのパースとカラムマッピングが正しいか
 *   - ステージング投入(executeMany + bindDefs)が通るか
 *   - MERGE(マスタ→履歴→株価)が外部キー違反なく通るか
 *   - LOAD_PROGRESS に正しく記録されるか
 *   - 実際に格納された値が元CSVと一致するか
 *
 * ここで取り込んだファイルは LOAD_PROGRESS に SUCCESS として残るため、
 * 本番実行(npm run load:initial)時は自動的にスキップされる。
 * やり直したい場合は末尾のクリーンアップ手順を参照。
 *
 * 実行: node scripts/test-load-initial.js
 */

const jquantsClient = require('../src/jquantsClient');
const db = require('../src/db');
const mergeSql = require('../src/mergeSql');
const loadInitial = require('../src/loadInitial');

/** live配下のファイルを時系列順にすべて返す */
function pickLiveFiles(files, label) {
  const liveFiles = loadInitial
    .sortFilesChronologically(files)
    .filter((f) => f.Key.includes('/live/'));
  if (liveFiles.length === 0) {
    throw new Error(`${label}: live配下のファイルが見つかりませんでした`);
  }
  return liveFiles;
}

async function showTableCounts(title) {
  await db.withConnection(async (connection) => {
    const tables = [
      'EQUITY_MASTER',
      'EQUITY_MASTER_HIST',
      'EQUITY_PRICE_DAILY',
      'LOAD_PROGRESS',
    ];
    console.log(`\n--- ${title} ---`);
    for (const t of tables) {
      const r = await connection.execute(`SELECT COUNT(*) FROM ${t}`);
      console.log(`  ${t.padEnd(22)}: ${r.rows[0][0].toLocaleString()} 行`);
    }
  });
}

async function main() {
  console.log('loadInitial.js のテストを開始します\n');

  await showTableCounts('実行前の件数');

  //----------------------------------------------------------------
  // 1. マスタを取り込む(live配下を全件)
  //
  //    マスタのliveファイルは「翌営業日時点の上場銘柄一覧」なので、
  //    最新1件だけでは、その日に上場廃止された銘柄が欠落する。
  //    株価側にはその銘柄の取引データが存在するため外部キー違反になる。
  //    本番(loadInitial)は2016年からの全ファイルを読むので問題にならないが、
  //    テストでもlive分は全件読んでおく。
  //----------------------------------------------------------------
  console.log('\n=== 1. 銘柄マスタ(live配下を全件) ===');
  const masterFiles = await jquantsClient.listBulkFiles(loadInitial.ENDPOINT_MASTER);
  const masterTargets = pickLiveFiles(masterFiles, 'master');
  console.log(`対象ファイル数: ${masterTargets.length}`);

  for (let i = 0; i < masterTargets.length; i += 1) {
    process.stdout.write(`[${i + 1}/${masterTargets.length}] `);
    await loadInitial.processFile(
      loadInitial.ENDPOINT_MASTER,
      masterTargets[i].Key,
      loadInitial.MASTER_HANDLERS
    );
    await jquantsClient.throttle();
  }

  //----------------------------------------------------------------
  // 2. 上場廃止フラグの更新
  //----------------------------------------------------------------
  console.log('\n=== 2. 上場廃止フラグの更新 ===');
  await db.withConnection(async (connection) => {
    const updated = await mergeSql.refreshDelistedFlag(connection);
    await connection.commit();
    console.log(`更新件数: ${updated.toLocaleString()} 件`);
  });

  //----------------------------------------------------------------
  // 3. 株価を1ファイル取り込む
  //----------------------------------------------------------------
  console.log('\n=== 3. 株価四本値(liveの最新1ファイル) ===');
  const priceFiles = await jquantsClient.listBulkFiles(loadInitial.ENDPOINT_PRICE);
  const priceLiveFiles = pickLiveFiles(priceFiles, 'price');
  const priceTarget = priceLiveFiles[priceLiveFiles.length - 1];
  console.log(`対象: ${priceTarget.Key}`);

  await loadInitial.processFile(
    loadInitial.ENDPOINT_PRICE,
    priceTarget.Key,
    loadInitial.PRICE_HANDLERS
  );

  //----------------------------------------------------------------
  // 4. 格納された値のサンプル確認
  //----------------------------------------------------------------
  console.log('\n=== 4. 格納データの確認 ===');
  await db.withConnection(async (connection) => {
    // キーエンス(6861)で確認。存在しなければ任意の1件を表示する
    const master = await connection.execute(
      `SELECT code, co_name, market_name, sector33_name,
              TO_CHAR(as_of_date,'YYYY-MM-DD'), delisted_flag
       FROM equity_master WHERE code LIKE '6861%'`
    );
    console.log('\nEQUITY_MASTER (6861*):');
    console.log(master.rows.length ? master.rows : '  該当なし');

    const price = await connection.execute(
      `SELECT code, TO_CHAR(price_date,'YYYY-MM-DD'),
              open_price, high_price, low_price, close_price,
              upper_limit, lower_limit, volume, turnover_value, adj_factor
       FROM equity_price_daily
       WHERE code LIKE '6861%'
       ORDER BY price_date DESC
       FETCH FIRST 3 ROWS ONLY`
    );
    console.log('\nEQUITY_PRICE_DAILY (6861*):');
    console.log(price.rows.length ? price.rows : '  該当なし');

    // 日付が意図せずずれていないかの確認(TO_DATE経由でJSTのままか)
    const dateCheck = await connection.execute(
      `SELECT TO_CHAR(MIN(price_date),'YYYY-MM-DD'), TO_CHAR(MAX(price_date),'YYYY-MM-DD')
       FROM equity_price_daily`
    );
    console.log(`\n株価の日付範囲: ${dateCheck.rows[0][0]} 〜 ${dateCheck.rows[0][1]}`);
    console.log('  (取り込んだliveファイルの日付と一致していればタイムゾーンずれなし)');

    // NULLが不自然に多くないかの確認
    const nullCheck = await connection.execute(
      `SELECT COUNT(*),
              COUNT(close_price), COUNT(volume), COUNT(adj_factor)
       FROM equity_price_daily`
    );
    const [total, cClose, cVol, cAdj] = nullCheck.rows[0];
    console.log(`\nNULLチェック (全${total}行中の非NULL数):`);
    console.log(`  close_price: ${cClose} / volume: ${cVol} / adj_factor: ${cAdj}`);
  });

  //----------------------------------------------------------------
  // 5. 進捗記録の確認
  //----------------------------------------------------------------
  console.log('\n=== 5. LOAD_PROGRESS の確認 ===');
  await db.withConnection(async (connection) => {
    const r = await connection.execute(
      `SELECT endpoint_name, file_key, status, row_count
       FROM load_progress ORDER BY endpoint_name, file_key`
    );
    r.rows.forEach((row) => {
      console.log(`  [${row[2]}] ${row[0]} : ${row[1]} (${row[3]}行)`);
    });
  });

  //----------------------------------------------------------------
  // 6. 再実行時にスキップされるか確認
  //----------------------------------------------------------------
  console.log('\n=== 6. 再実行時のスキップ動作確認 ===');
  const again = await loadInitial.processFile(
    loadInitial.ENDPOINT_PRICE,
    priceTarget.Key,
    loadInitial.PRICE_HANDLERS
  );
  console.log(again.skipped ? '  スキップされました (正常)' : '  ⚠️ スキップされませんでした');

  await showTableCounts('実行後の件数');

  console.log('\n✅ loadInitial.js のテスト完了');
  console.log('\n【このテストをやり直す場合】');
  console.log('  以下のSQLでLOAD_PROGRESSの記録を消すと、再度同じファイルを処理できます:');
  console.log("    DELETE FROM load_progress WHERE file_key LIKE '%/live/%'; COMMIT;");
  console.log('  ※ 取り込まれたデータ自体はMERGEなので重複せず、消さなくても問題ありません');
}

main()
  .then(async () => {
    await db.closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ テスト失敗:', err);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
