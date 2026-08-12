'use strict';

const db = require('../src/db');

async function main() {
  console.log('--- 1. コネクションプール初期化 ---');
  await db.getPool();

  console.log('\n--- 2. 簡単なクエリ実行 (SELECT 1 FROM dual) ---');
  await db.withConnection(async (connection) => {
    const result = await connection.execute('SELECT 1 AS ok FROM dual');
    console.log('結果:', result.rows);
  });

  console.log('\n--- 3. テーブル一覧の確認 (DDLが正しく反映されているか) ---');
  await db.withConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT table_name FROM user_tables ORDER BY table_name`
    );
    console.log('テーブル一覧:', result.rows.map((r) => r[0]));
  });

  console.log('\n--- 4. LOAD_PROGRESS ヘルパーの動作確認 ---');
  await db.withConnection(async (connection) => {
    const testEndpoint = '__test__';
    const testKey = '__connectivity_check__';

    await db.markProgressStarted(connection, testEndpoint, testKey);
    let status = await db.getProgressStatus(connection, testEndpoint, testKey);
    console.log('markProgressStarted後のstatus:', status); // 'PENDING' のはず

    await db.markProgressSuccess(connection, testEndpoint, testKey, 0);
    status = await db.getProgressStatus(connection, testEndpoint, testKey);
    console.log('markProgressSuccess後のstatus:', status); // 'SUCCESS' のはず

    // テスト用レコードを削除してcrean up
    await connection.execute(
      `DELETE FROM load_progress WHERE endpoint_name = :testEndpoint AND file_key = :testKey`,
      { testEndpoint, testKey }
    );
    await connection.commit();
    console.log('テスト用レコードをクリーンアップしました');
  });

  console.log('\n--- 5. コネクションプールのクローズ ---');
  await db.closePool();

  console.log('\n✅ db.js の疎通確認 OK');
}

main().catch(async (err) => {
  console.error('❌ テスト失敗:', err);
  await db.closePool().catch(() => {});
  process.exit(1);
});
