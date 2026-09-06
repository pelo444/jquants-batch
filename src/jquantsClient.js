'use strict';

const zlib = require('zlib');
const { Readable } = require('stream');
const { parse } = require('csv-parse/sync');
const { parse: parseStream } = require('csv-parse');
const config = require('./config');

const { apiKey, baseUrl, requestIntervalMs, apiRequestIntervalMs } = config.jquants;

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

/**
 * 指定エンドポイント・Keyのファイルを取得し、CSVを行単位でストリーム処理する。
 * fetchBulkFile()と違い、全行を一括で配列にせず batchSize 行たまるごとに
 * onBatch を呼び出す(1バッチ分しかメモリに載らない)。
 *
 * 【なぜ必要か】
 *   日経225オプションの月次historicalファイルは1ファイルで14万行を超えることがあり、
 *   fetchBulkFile()(csv-parse/syncで全行を一括パース)だと、そのファイル1つのために
 *   数百MBを一度に確保する。メモリの小さいVM(実測で物理メモリ約950MB)では
 *   これだけでNode のデフォルトヒープ上限(自動計算で約480MB)を超えてOOMになった
 *   (2026-09-06に実際に発生。114ファイル目=148,554行までは成功し、115ファイル目で
 *   ヒープ不足でクラッシュ)。
 *
 *   ダウンロード〜解凍(gzip)まではfetchBulkFileと同じで全体を一度に持つが、
 *   これはCSVテキストのサイズ(数十MB程度)であって「パース済みJSオブジェクトの配列」
 *   ほど大きくならないため許容する。パース以降だけをストリーム化することで、
 *   ピークメモリを「1バッチ分の行数」に抑える。
 *
 * @param {string} key listBulkFilesで得られるKey
 * @param {(rows: Record<string,string>[]) => Promise<void>} onBatch
 *        batchSize行たまるごと(最後の端数も含む)に呼ばれる。処理が終わるまで
 *        次のバッチの読み込みは進まない(for await によりストリームの読み出しが
 *        自然に一時停止するため、明示的なpause/resumeは不要)。
 * @param {number} [batchSize] 既定5000(db.bulkInsertの既定batchSizeと合わせている)
 * @returns {Promise<number>} 総行数
 */
async function streamBulkFile(key, onBatch, batchSize = 5000) {
  const signedUrl = await getBulkFileUrl(key);
  const response = await fetchWithRetry(signedUrl, {}, 2);
  const gzBuffer = Buffer.from(await response.arrayBuffer());
  const csvBuffer = zlib.gunzipSync(gzBuffer);

  // 【重要】csvBufferを一度に parseStream() へ渡す(1回の.write())と、
  // csv-parseは1回のTransform呼び出しの中で渡された分を全部パースして
  // 内部のreadableバッファに積んでしまい、結局「全行が一度にメモリに載る」のと
  // 変わらなくなる(実測で確認済み: 15万行・約20MBのCSVで250MBヒープでもOOMした)。
  // そこで小さいチャンク(64KB)に分けてstream.Readableから流し込み、
  // for await 側の消費ペースに合わせて自然にバックプレッシャーがかかるようにする。
  const CHUNK_BYTES = 64 * 1024;
  let offset = 0;
  const source = new Readable({
    read() {
      if (offset >= csvBuffer.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + CHUNK_BYTES, csvBuffer.length);
      this.push(csvBuffer.subarray(offset, end));
      offset = end;
    },
  });

  const parser = source.pipe(parseStream({
    columns: true,
    skip_empty_lines: true,
  }));

  let batch = [];
  let total = 0;

  for await (const record of parser) {
    batch.push(record);
    total += 1;
    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await onBatch(batch);
  }

  return total;
}

//------------------------------------------------------------------
// 個別API呼出し関連(EDINET系等、Bulk非対応のエンドポイント用)
//
// Bulk API(bulk/list, bulk/get)は「ファイル一覧を取得してCSVを丸ごと
// ダウンロードする」方式だったが、こちらは実データそのものを1リクエストごとに
// JSONで返す通常のREST的エンドポイントを想定する(例: /edinet/large-volume-shareholders)。
// 429時のリトライはfetchWithRetry()を共用する(大量保有報告書の実装で
// 新設した「個別API呼出しの共通基盤」の中核部分)。
//------------------------------------------------------------------

/**
 * 個別APIエンドポイントを1回呼び出す。
 * @param {string} path '/'始まりのパス(例: '/edinet/large-volume-shareholders')
 * @param {Record<string, string|undefined>} [params] クエリパラメータ。undefined/null/''は付与しない
 * @returns {Promise<{data: any[], pagination_key?: string}>}
 */
async function fetchApiPage(path, params = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetchWithRetry(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });
  return response.json();
}

/**
 * pagination_keyを使い、指定パラメータに一致する全ページのdataを結合して返す
 * (ページネーション対応パターン。次ページがある間はapiThrottle()相当の間隔を空けて呼び続ける)。
 * @param {string} path
 * @param {Record<string, string|undefined>} [params]
 * @returns {Promise<any[]>}
 */
async function fetchAllApiPages(path, params = {}) {
  const all = [];
  let paginationKey;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pageParams = paginationKey ? { ...params, pagination_key: paginationKey } : params;
    const body = await fetchApiPage(path, pageParams);
    if (Array.isArray(body.data)) {
      all.push(...body.data);
    }

    if (body.pagination_key) {
      paginationKey = body.pagination_key;
      await sleep(apiRequestIntervalMs);
    } else {
      break;
    }
  }

  return all;
}

/**
 * 個別API呼出しの間隔を空ける(loadInitial.js等で日付ごとにループする際に呼ぶ)。
 * Bulk APIのthrottle()とは別間隔(config.jquants.apiRequestIntervalMs)を使う。
 */
async function apiThrottle() {
  await sleep(apiRequestIntervalMs);
}

module.exports = {
  listBulkFiles,
  getBulkFileUrl,
  downloadCsvGz,
  parseCsv,
  fetchBulkFile,
  streamBulkFile,
  throttle,
  fetchApiPage,
  fetchAllApiPages,
  apiThrottle,
};
