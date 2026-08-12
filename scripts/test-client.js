'use strict';

const jquantsClient = require('../src/jquantsClient');

async function main() {
  console.log('--- 1. bulk/list テスト (/equities/master) ---');
  const files = await jquantsClient.listBulkFiles('/equities/master');
  console.log(`取得ファイル数: ${files.length}`);
  console.log('先頭3件:', files.slice(0, 3));

  // liveディレクトリの中から一番小さいファイル(=直近の日次分)を選ぶ
  const liveFiles = files.filter((f) => f.Key.includes('/live/'));
  if (liveFiles.length === 0) {
    throw new Error('liveディレクトリのファイルが見つかりませんでした');
  }
  const target = liveFiles.sort((a, b) => a.Size - b.Size)[0];
  console.log(`\nテスト対象ファイル: ${target.Key} (${target.Size} bytes)`);

  console.log('\n--- 2. bulk/get + ダウンロード + 解凍 + パース テスト ---');
  const rows = await jquantsClient.fetchBulkFile(target.Key);
  console.log(`パース後の行数: ${rows.length}`);
  console.log('先頭2行:', rows.slice(0, 2));

  console.log('\n✅ jquantsClient.js の疎通確認 OK');
}

main().catch((err) => {
  console.error('❌ テスト失敗:', err);
  process.exit(1);
});
