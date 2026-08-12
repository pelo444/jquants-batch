'use strict';

const zlib = require('zlib');
const { parse } = require('csv-parse/sync');
const config = require('./config');

const { apiKey, baseUrl, requestIntervalMs } = config.jquants;

/**
 * 指定ミリ秒だけ待機する
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetchのラッパー。429(レート制限)時は指数バックオフでリトライする。
 * @param {string} url
 * @param {object} [options]
 * @param {number} [maxRetries]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`レート制限超過が続いたためリトライを断念しました: ${url}`);
      }
      const waitMs = 2000 * 2 ** attempt; // 2秒, 4秒, 8秒, 16秒, 32秒...
      console.warn(`429 Too Many Requests。${waitMs}ms待機してリトライします (${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
      attempt += 1;
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTPエラー ${response.status} ${url}\n${body}`);
    }

    return response;
  }
}

/**
 * Bulk APIでダウンロード可能なファイル一覧を取得する
 * @param {string} endpoint 例: '/equities/bars/daily', '/equities/master'
 * @returns {Promise<{Key: string, Size: number, LastModified: string}[]>}
 */
async function listBulkFiles(endpoint) {
  const url = new URL(`${baseUrl}/bulk/list`);
  url.searchParams.set('endpoint', endpoint);

  const response = await fetchWithRetry(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });
  const body = await response.json();
  return body.data;
}

/**
 * Bulk APIのKeyから、実ファイルへの署名付きダウンロードURLを取得する。
 * このURLは発行から300秒で失効するため、取得後は速やかにダウンロードすること。
 * @param {string} key listBulkFilesで得られるKey
 * @returns {Promise<string>} 署名付きダウンロードURL
 */
async function getBulkFileUrl(key) {
  const url = new URL(`${baseUrl}/bulk/get`);
  url.searchParams.set('key', key);

  const response = await fetchWithRetry(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });
  const body = await response.json();
  return body.url;
}

/**
 * 署名付きURLからgzip CSVをダウンロードし、解凍してテキストとして返す。
 * 署名付きURLはx-api-key不要(認証込みのURLのため)。
 * @param {string} signedUrl getBulkFileUrlで得られるURL
 * @returns {Promise<string>} 解凍後のCSVテキスト
 */
async function downloadCsvGz(signedUrl) {
  // 署名付きURL自体はレート制限の対象外と考えられるが、
  // 429が返るケースに備えて念のためリトライ付きにしておく
  const response = await fetchWithRetry(signedUrl, {}, 2);
  const gzBuffer = Buffer.from(await response.arrayBuffer());
  const csvBuffer = zlib.gunzipSync(gzBuffer);
  return csvBuffer.toString('utf-8');
}

/**
 * CSVテキストをオブジェクト配列にパースする(1行目をヘッダーとして使用)
 * @param {string} csvText
 * @returns {Record<string, string>[]}
 */
function parseCsv(csvText) {
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
  });
}

/**
 * 指定エンドポイント・Keyのファイルを一括取得しパース済み配列で返す。
 * bulk/get → ダウンロード → 解凍 → パース、までを1回で行うヘルパー。
 * @param {string} key listBulkFilesで得られるKey
 * @returns {Promise<Record<string, string>[]>}
 */
async function fetchBulkFile(key) {
  const signedUrl = await getBulkFileUrl(key);
  const csvText = await downloadCsvGz(signedUrl);
  return parseCsv(csvText);
}

/**
 * Bulk APIへの負荷軽減のため、呼び出し間に一定間隔を空ける。
 * loadInitial.js等で複数ファイルをループ処理する際に、各ファイル処理の合間に呼ぶ。
 */
async function throttle() {
  await sleep(requestIntervalMs);
}

module.exports = {
  listBulkFiles,
  getBulkFileUrl,
  downloadCsvGz,
  parseCsv,
  fetchBulkFile,
  throttle,
};
