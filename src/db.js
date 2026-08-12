'use strict';

const oracledb = require('oracledb');
const config = require('./config');

// 行データをJSオブジェクトではなく配列で受け取れるようにしておくと
// executeManyのバインドが高速なので、outFormatはデフォルト(ARRAY)のままにする。
oracledb.autoCommit = false; // コミットは呼び出し側で明示的に制御する

let pool = null;

/**
 * コネクションプールを初期化する(未初期化の場合のみ)。
 * Thinモード + ウォレット(mTLS)でOCI ATPに接続する。
 * @returns {Promise<oracledb.Pool>}
 */
async function getPool() {
  if (pool) {
    return pool;
  }

  const { user, password, connectString, walletLocation, walletPassword, poolMin, poolMax, poolIncrement } =
    config.db;

  pool = await oracledb.createPool({
    user,
    password,
    connectString,
    // Thinモードのウォレット接続: tnsnames.ora と ewallet.pem を
    // 同じディレクトリに置いている前提(configDir / walletLocation を同一に指定)
    configDir: walletLocation,
    walletLocation,
    walletPassword,
    poolMin,
    poolMax,
    poolIncrement,
  });

  console.log(`Oracle接続プールを初期化しました (min=${poolMin}, max=${poolMax})`);
  return pool;
}

/**
 * コネクションプールをクローズする。バッチ処理の最後に必ず呼ぶこと。
 */
async function closePool() {
  if (pool) {
    await pool.close(10); // 10秒以内の未完了処理を待ってクローズ
    pool = null;
    console.log('Oracle接続プールをクローズしました');
  }
}

/**
 * プールからコネクションを取得し、渡された関数を実行後に必ず解放する。
 * 関数内で例外が発生した場合はロールバックしてから再スローする。
 * @template T
 * @param {(connection: oracledb.Connection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withConnection(fn) {
  const p = await getPool();
  const connection = await p.getConnection();
  try {
    const result = await fn(connection);
    return result;
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  } finally {
    await connection.close();
  }
}

/**
 * ステージングテーブルを空にする
 * @param {oracledb.Connection} connection
 * @param {string} tableName 例: 'EQUITY_PRICE_DAILY_STG'
 */
async function truncateTable(connection, tableName) {
  await connection.execute(`TRUNCATE TABLE ${tableName}`);
}

/**
 * 配列データをexecuteManyで一括INSERTする。
 * rowsは列の並びがcolumnsと一致する配列の配列(例: [[code, date, ...], ...])。
 *
 * 日付列は、JSのDateではなく 'YYYY-MM-DD' 形式の文字列で渡し、
 * valueExpressions で TO_DATE(?, 'YYYY-MM-DD') を指定することを推奨する。
 * (JSのDateを直接バインドするとタイムゾーンによって日付がずれる恐れがあるため)
 *
 * @param {oracledb.Connection} connection
 * @param {string} tableName 例: 'EQUITY_PRICE_DAILY_STG'
 * @param {string[]} columns 例: ['code','price_date','open_price',...]
 * @param {any[][]} rows
 * @param {object} [options]
 * @param {number} [options.batchSize] 1回のexecuteManyで送る行数(既定: 5000)
 * @param {(string|null)[]} [options.valueExpressions]
 *        columnsと同じ長さの配列。各要素は '?' をバインド変数に置換するSQL式
 *        (例: "TO_DATE(?, 'YYYY-MM-DD')")。nullまたは未指定の要素は素のバインドになる。
 * @param {object[]} [options.bindDefs]
 *        executeManyのbindDefs。NULLを含む列の型を確実に指定するために推奨。
 * @returns {Promise<number>} 投入件数
 */
async function bulkInsert(connection, tableName, columns, rows, options = {}) {
  if (rows.length === 0) {
    return 0;
  }

  const batchSize = options.batchSize || 5000;
  const valueExpressions = options.valueExpressions || [];

  const placeholders = columns
    .map((_, i) => {
      const bind = `:${i + 1}`;
      const expr = valueExpressions[i];
      return expr ? expr.replace('?', bind) : bind;
    })
    .join(', ');

  const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

  const executeOptions = {
    autoCommit: false,
    // 1件でもエラーがあれば例外を投げて全体を止める(ステージングはやり直し前提のため)
    batchErrors: false,
  };
  if (options.bindDefs) {
    executeOptions.bindDefs = options.bindDefs;
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const result = await connection.executeMany(sql, batch, executeOptions);
    inserted += result.rowsAffected || batch.length;
  }

  return inserted;
}

/**
 * MERGE文などの任意のDML/SQLを実行する。
 * @param {oracledb.Connection} connection
 * @param {string} sql
 * @param {object|any[]} [binds]
 * @returns {Promise<oracledb.Result<unknown>>}
 */
async function executeSql(connection, sql, binds = {}) {
  return connection.execute(sql, binds, { autoCommit: false });
}

//------------------------------------------------------------------
// LOAD_PROGRESS 用ヘルパー
//------------------------------------------------------------------

/**
 * 指定ファイルの処理状況を取得する。未登録の場合はnullを返す。
 * @param {oracledb.Connection} connection
 * @param {string} endpointName
 * @param {string} fileKey
 * @returns {Promise<'PENDING'|'SUCCESS'|'FAILED'|null>}
 */
async function getProgressStatus(connection, endpointName, fileKey) {
  const result = await connection.execute(
    `SELECT status FROM load_progress WHERE endpoint_name = :endpointName AND file_key = :fileKey`,
    { endpointName, fileKey }
  );
  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0][0];
}

/**
 * 処理開始をPENDINGとして記録する(既存ならSTATUSをPENDINGに戻して再登録)
 * @param {oracledb.Connection} connection
 * @param {string} endpointName
 * @param {string} fileKey
 */
async function markProgressStarted(connection, endpointName, fileKey) {
  await connection.execute(
    `MERGE INTO load_progress t
     USING (SELECT :endpointName AS endpoint_name, :fileKey AS file_key FROM dual) s
     ON (t.endpoint_name = s.endpoint_name AND t.file_key = s.file_key)
     WHEN MATCHED THEN
       UPDATE SET status = 'PENDING', started_at = SYSTIMESTAMP, error_message = NULL,
                  updated_at = SYSTIMESTAMP
     WHEN NOT MATCHED THEN
       INSERT (endpoint_name, file_key, status, started_at)
       VALUES (s.endpoint_name, s.file_key, 'PENDING', SYSTIMESTAMP)`,
    { endpointName, fileKey }
  );
}

/**
 * 処理成功を記録する
 * @param {oracledb.Connection} connection
 * @param {string} endpointName
 * @param {string} fileKey
 * @param {number} rowCount
 */
async function markProgressSuccess(connection, endpointName, fileKey, rowCount) {
  await connection.execute(
    `UPDATE load_progress
     SET status = 'SUCCESS', row_count = :rowCount, finished_at = SYSTIMESTAMP, updated_at = SYSTIMESTAMP
     WHERE endpoint_name = :endpointName AND file_key = :fileKey`,
    { rowCount, endpointName, fileKey }
  );
}

/**
 * 処理失敗を記録する
 * @param {oracledb.Connection} connection
 * @param {string} endpointName
 * @param {string} fileKey
 * @param {string} errorMessage
 */
async function markProgressFailed(connection, endpointName, fileKey, errorMessage) {
  await connection.execute(
    `UPDATE load_progress
     SET status = 'FAILED', error_message = :errorMessage, finished_at = SYSTIMESTAMP, updated_at = SYSTIMESTAMP
     WHERE endpoint_name = :endpointName AND file_key = :fileKey`,
    { errorMessage: String(errorMessage).slice(0, 4000), endpointName, fileKey }
  );
}

module.exports = {
  getPool,
  closePool,
  withConnection,
  truncateTable,
  bulkInsert,
  executeSql,
  getProgressStatus,
  markProgressStarted,
  markProgressSuccess,
  markProgressFailed,
};

