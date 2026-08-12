'use strict';

/**
 * 初回投入バッチ
 *
 * J-Quants Bulk API から過去分の銘柄マスタ・株価四本値を一括取得し、
 * Oracle(OCI ATP)へ取り込む。
 *
 * 処理順序:
 *   Phase 1: 銘柄マスタ(/equities/master)を全ファイル取り込み
 *            → EQUITY_MASTER(最新状態) と EQUITY_MASTER_HIST(日次スナップショット)
 *   Phase 2: 上場廃止フラグの更新
 *   Phase 3: 株価四本値(/equities/bars/daily)を全ファイル取り込み
 *            → EQUITY_PRICE_DAILY
 *
 * マスタを先に完了させるのは、EQUITY_PRICE_DAILY が EQUITY_MASTER への
 * 外部キーを持つため。過去に上場廃止された銘柄の株価も含まれるので、
 * マスタ側も historical を全期間分取り込み「全期間に登場した全銘柄」を揃えておく。
 *
 * 中断・再実行:
 *   LOAD_PROGRESS にファイル単位で進捗を記録し、STATUS='SUCCESS' のファイルは
 *   スキップする。途中で失敗しても再実行すれば続きから処理される。
 *   最初からやり直したい場合は LOAD_PROGRESS の該当行を削除すること。
 *
 * 実行: npm run load:initial
 */

const jquantsClient = require('./jquantsClient');
const db = require('./db');
const csvMapper = require('./csvMapper');
const mergeSql = require('./mergeSql');

const ENDPOINT_MASTER = '/equities/master';
const ENDPOINT_PRICE = '/equities/bars/daily';

/**
 * Bulk APIのKeyを処理順(時系列)に並べ替える。
 * historical(月次)を古い順に処理し、その後 live(日次)を古い順に処理することで、
 * EQUITY_MASTER には最終的に最も新しい情報が残る。
 * @param {{Key: string}[]} files
 * @returns {{Key: string}[]}
 */
function sortFilesChronologically(files) {
  const sortKey = (key) => {
    const isLive = key.includes('/live/') ? 1 : 0;
    // ファイル名末尾の YYYYMM または YYYYMMDD を取り出す
    const m = key.match(/_(\d{6,8})\.csv\.gz$/);
    // YYYYMM(6桁)は月初日とみなして8桁に揃える
    const digits = m ? (m[1].length === 6 ? `${m[1]}01` : m[1]) : '00000000';
    return `${isLive}_${digits}`;
  };
  return [...files].sort((a, b) => sortKey(a.Key).localeCompare(sortKey(b.Key)));
}

/**
 * 秒数を「1時間23分45秒」形式に整形する
 * @param {number} ms
 */
function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/**
 * 1ファイルを取得してステージングへ投入し、本番テーブルへMERGEする。
 * 成功時はコミット、失敗時はロールバックして LOAD_PROGRESS に記録する。
 *
 * @param {string} endpointName
 * @param {string} fileKey
 * @param {object} handlers
 * @param {string} handlers.stagingTable ステージングテーブル名
 * @param {string[]} handlers.columns
 * @param {(string|null)[]} handlers.valueExpressions
 * @param {object[]} handlers.bindDefs
 * @param {(row: Record<string,string>) => any[]} handlers.mapRow
 * @param {(connection: import('oracledb').Connection) => Promise<void>} handlers.merge
 * @returns {Promise<{skipped: boolean, rowCount: number}>}
 */
async function processFile(endpointName, fileKey, handlers) {
  // --- 進捗確認(処理済みならスキップ) ---
  const alreadyDone = await db.withConnection(async (connection) => {
    const status = await db.getProgressStatus(connection, endpointName, fileKey);
    return status === 'SUCCESS';
  });

  if (alreadyDone) {
    console.log(`  [SKIP] ${fileKey} (取り込み済み)`);
    return { skipped: true, rowCount: 0 };
  }

  // --- ダウンロード〜パース(DB接続を保持せずに実施) ---
  const csvRows = await jquantsClient.fetchBulkFile(fileKey);
  const dbRows = csvRows.map(handlers.mapRow);

  // --- ステージング投入 → MERGE → コミット ---
  return db.withConnection(async (connection) => {
    await db.markProgressStarted(connection, endpointName, fileKey);
    await connection.commit(); // 開始記録は先に確定させる

    try {
      await db.truncateTable(connection, handlers.stagingTable);

      const inserted = await db.bulkInsert(
        connection,
        handlers.stagingTable,
        handlers.columns,
        dbRows,
        {
          valueExpressions: handlers.valueExpressions,
          bindDefs: handlers.bindDefs,
        }
      );

      await handlers.merge(connection);

      await db.markProgressSuccess(connection, endpointName, fileKey, inserted);
      await connection.commit();

      console.log(`  [OK]   ${fileKey} (${inserted.toLocaleString()}行)`);
      return { skipped: false, rowCount: inserted };
    } catch (err) {
      await connection.rollback().catch(() => {});
      // 失敗記録は別トランザクションとして確定させる
      await db.markProgressFailed(connection, endpointName, fileKey, err.message);
      await connection.commit().catch(() => {});
      console.error(`  [FAIL] ${fileKey}: ${err.message}`);
      throw err;
    }
  });
}

/**
 * Phase 1: 銘柄マスタの取り込み
 */
async function loadMaster() {
  console.log('=== Phase 1: 銘柄マスタの取り込み ===');
  const files = sortFilesChronologically(await jquantsClient.listBulkFiles(ENDPOINT_MASTER));
  console.log(`対象ファイル数: ${files.length}`);

  const handlers = {
    stagingTable: 'EQUITY_MASTER_STG',
    columns: csvMapper.MASTER_COLUMNS,
    valueExpressions: csvMapper.MASTER_VALUE_EXPRESSIONS,
    bindDefs: csvMapper.MASTER_BIND_DEFS,
    mapRow: csvMapper.mapMasterRow,
    merge: async (connection) => {
      // EQUITY_MASTER_HIST は EQUITY_MASTER への外部キーを持つため、必ずこの順序で実行する
      await mergeSql.mergeMaster(connection);
      await mergeSql.mergeMasterHist(connection);
    },
  };

  let total = 0;
  for (let i = 0; i < files.length; i += 1) {
    const { Key } = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] `);
    const { rowCount } = await processFile(ENDPOINT_MASTER, Key, handlers);
    total += rowCount;
    await jquantsClient.throttle();
  }

  console.log(`Phase 1 完了: 合計 ${total.toLocaleString()} 行\n`);
}

/**
 * Phase 2: 上場廃止フラグの更新
 */
async function updateDelistedFlag() {
  console.log('=== Phase 2: 上場廃止フラグの更新 ===');
  await db.withConnection(async (connection) => {
    const updated = await mergeSql.refreshDelistedFlag(connection);
    await connection.commit();
    console.log(`更新件数: ${updated.toLocaleString()} 件\n`);
  });
}

/**
 * Phase 3: 株価四本値の取り込み
 */
async function loadPrice() {
  console.log('=== Phase 3: 株価四本値の取り込み ===');
  const files = sortFilesChronologically(await jquantsClient.listBulkFiles(ENDPOINT_PRICE));
  console.log(`対象ファイル数: ${files.length}`);

  const handlers = {
    stagingTable: 'EQUITY_PRICE_DAILY_STG',
    columns: csvMapper.PRICE_COLUMNS,
    valueExpressions: csvMapper.PRICE_VALUE_EXPRESSIONS,
    bindDefs: csvMapper.PRICE_BIND_DEFS,
    mapRow: csvMapper.mapPriceRow,
    merge: async (connection) => {
      // 外部キー違反は MERGE 時に ORA-02291 として出るが、
      // どの銘柄が原因か分からないため事前に検出して分かりやすいエラーにする
      const unknownCodes = await mergeSql.findUnknownCodesInPriceStg(connection);
      if (unknownCodes.length > 0) {
        throw new Error(
          `EQUITY_MASTERに存在しない銘柄コードが${unknownCodes.length}件あります: ` +
            `${unknownCodes.slice(0, 10).join(', ')}${unknownCodes.length > 10 ? ' ...' : ''}\n` +
            'マスタ(Phase 1)が最後まで完了しているか確認してください。'
        );
      }
      await mergeSql.mergePriceDaily(connection);
    },
  };

  let total = 0;
  for (let i = 0; i < files.length; i += 1) {
    const { Key } = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] `);
    const { rowCount } = await processFile(ENDPOINT_PRICE, Key, handlers);
    total += rowCount;
    await jquantsClient.throttle();
  }

  console.log(`Phase 3 完了: 合計 ${total.toLocaleString()} 行\n`);
}

async function main() {
  const startedAt = Date.now();
  console.log(`初回投入バッチを開始します (${new Date().toISOString()})\n`);

  await loadMaster();
  await updateDelistedFlag();
  await loadPrice();

  console.log(`初回投入バッチが完了しました (所要時間: ${formatDuration(Date.now() - startedAt)})`);
}

main()
  .then(async () => {
    await db.closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n初回投入バッチが異常終了しました:', err);
    console.error('再実行すると、取り込み済みのファイルはスキップされ続きから処理されます。');
    await db.closePool().catch(() => {});
    process.exit(1);
  });

