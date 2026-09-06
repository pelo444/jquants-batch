'use strict';

/**
 * 日次投入バッチ
 *
 * J-Quants Bulk API の live 配下(日次ファイル)から、
 * まだ取り込んでいないファイルをすべて取り込む。cronから1日1回実行する想定。
 *
 * 処理順序は loadInitial.js と同じ:
 *   Phase 1: 銘柄マスタ  → EQUITY_MASTER / EQUITY_MASTER_HIST
 *   Phase 2: 上場廃止フラグの更新
 *   Phase 3: 株価四本値  → EQUITY_PRICE_DAILY
 *   Phase 4: 業種別空売り比率      → SECTOR_SHORT_RATIO
 *   Phase 5: 信用取引残高          → EQUITY_MARGIN_INTEREST
 *   Phase 6: 日々公表信用取引残高  → EQUITY_MARGIN_ALERT
 *   Phase 7: 空売り残高報告        → EQUITY_SHORT_POSITION
 *   Phase 8: 取引カレンダー        → TRADING_CALENDAR
 *   Phase 9: TOPIX四本値          → TOPIX_PRICE_DAILY
 *   Phase10: 指数四本値           → INDEX_PRICE_DAILY
 *   Phase11: 投資部門別情報        → INVESTOR_TYPE_TRADING
 *   Phase12: 決算発表予定日        → EARNINGS_SCHEDULE
 *   Phase13: 財務情報              → FINANCIAL_SUMMARY
 *   Phase14: 日経225オプション四本値 → INDEX_OPTION_PRICE_DAILY
 *
 * 【Phase 4〜7 の公開タイミングについて】
 *   これらは株価と公開タイミングが異なる(空売り残高報告は報告があった日のみ、
 *   信用取引残高は2026/9/24以前は週1回)。新規ファイルが無いのは正常な状態であり、
 *   その場合は何も処理せず次へ進む。
 *
 * 【Phase 4〜7 の失敗は他フェーズを止めない】
 *   1つのエンドポイントが失敗しても残りは処理し、最後にまとめて異常終了させる。
 *   契約プランの都合で一部だけ取得できない場合に、他のデータまで
 *   取り込めなくなるのを避けるため。
 *
 * マスタを先に処理するのは EQUITY_PRICE_DAILY が EQUITY_MASTER への
 * 外部キーを持つため(loadInitial.js と同じ理由)。
 *
 * 【対象ファイルの決め方】
 *   「今日の日付」からファイル名を組み立てるのではなく、bulk/list の結果と
 *   LOAD_PROGRESS を突き合わせて未処理のものを処理する。
 *   これにより以下が自動的に扱える:
 *     - 土日祝でファイルが無い日(何も処理せず正常終了)
 *     - 前日の実行が失敗した場合の取りこぼし
 *     - ファイル公開が遅れた場合
 *
 * 【欠損への対応】
 *   live 配下は直近数営業日分しか保持されない。それを超えて実行が止まっていた
 *   場合は live からは復旧できないため、警告を出す。
 *   その場合は historical(月次)を含めて処理する loadInitial.js を再実行すれば、
 *   取り込み済みファイルはスキップされ、欠けている分だけが補完される。
 *
 * 実行: npm run load:daily
 */

const fs = require('fs');
const path = require('path');

const jquantsClient = require('./jquantsClient');
const db = require('./db');
const mergeSql = require('./mergeSql');
const loadInitial = require('./loadInitial');

const LOCK_FILE = path.join(__dirname, '..', '.loadDaily.lock');
/** ロックがこの時間を超えて残っていたら、異常終了の残骸とみなして無視する(ミリ秒) */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // 6時間

/** cronのログで時刻が分かるようにタイムスタンプ付きで出力する */
function log(message) {
  const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[${ts}] ${message}`);
}

function logError(message) {
  const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.error(`[${ts}] ${message}`);
}

//------------------------------------------------------------------
// 多重起動の防止
//------------------------------------------------------------------

/**
 * ロックを取得する。既にロックがある場合はfalseを返す。
 * cronの実行が重なると、片方がステージングをTRUNCATEしている最中に
 * もう片方がINSERTするなどして不整合が起きるため。
 * @returns {boolean} 取得できたらtrue
 */
function acquireLock() {
  try {
    // 'wx' フラグ: 既に存在する場合は例外(アトミックな作成)
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    // 古いロックが残っていないか確認する
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > LOCK_STALE_MS) {
      logError(
        `古いロックファイルを検出しました(${Math.floor(ageMs / 3600000)}時間経過)。` +
          '前回の異常終了の残骸とみなして処理を続行します。'
      );
      fs.unlinkSync(LOCK_FILE);
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      return true;
    }

    const pid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    logError(`別のプロセス(PID: ${pid})が実行中のため終了します。`);
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logError(`ロックファイルの削除に失敗しました: ${err.message}`);
    }
  }
}

//------------------------------------------------------------------
// 対象ファイルの抽出
//------------------------------------------------------------------

/** Bulk APIのKeyからYYYYMMDD部分を取り出す(取れなければnull) */
function extractDate(key) {
  const m = key.match(/_(\d{8})\.csv\.gz$/);
  return m ? m[1] : null;
}

/**
 * live配下のファイルのうち、LOAD_PROGRESSにSUCCESSが無いものを時系列順に返す。
 * @param {string} endpointName
 * @returns {Promise<{Key: string}[]>}
 */
async function findPendingLiveFiles(endpointName) {
  const all = await jquantsClient.listBulkFiles(endpointName);
  const liveFiles = loadInitial
    .sortFilesChronologically(all)
    .filter((f) => f.Key.includes('/live/'));

  const doneKeys = await db.withConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT file_key FROM load_progress
       WHERE endpoint_name = :endpointName AND status = 'SUCCESS'`,
      { endpointName }
    );
    return new Set(result.rows.map((r) => r[0]));
  });

  return liveFiles.filter((f) => !doneKeys.has(f.Key));
}

/**
 * live配下の最古ファイルより前に欠損が無いか確認し、あれば警告する。
 * liveの保持期間を超えて実行が止まっていた場合、liveだけでは復旧できないため。
 * @param {{Key: string}[]} allLiveFiles
 */
async function warnIfGapExists(allLiveFiles) {
  if (allLiveFiles.length === 0) return;

  const oldestLiveDate = extractDate(allLiveFiles[0].Key);
  if (!oldestLiveDate) return;

  const latestLoaded = await db.withConnection(async (connection) => {
    const r = await connection.execute(
      `SELECT TO_CHAR(MAX(price_date), 'YYYYMMDD') FROM equity_price_daily`
    );
    return r.rows[0][0];
  });

  // 未取込(初回投入前)なら判定しない
  if (!latestLoaded) return;

  // 取込済みの最新日が、live最古ファイルの日付より前 = liveで埋められない期間がある
  if (latestLoaded < oldestLiveDate) {
    logError(
      '⚠️ データに欠損の可能性があります。\n' +
        `   取込済みの最新取引日: ${latestLoaded}\n` +
        `   live配下の最古ファイル: ${oldestLiveDate}\n` +
        '   liveの保持期間を超えて実行が止まっていたため、この間のデータは\n' +
        '   liveからは取得できません。historical(月次)を含めて処理する\n' +
        '   loadInitial.js を再実行して補完してください(取込済み分はスキップされます)。'
    );
  }
}

//------------------------------------------------------------------
// 各フェーズ
//------------------------------------------------------------------

/**
 * 未処理のliveファイルを順に処理する
 * @param {string} endpointName
 * @param {object} handlers
 * @param {string} label ログ表示用
 * @returns {Promise<{fileCount: number, rowCount: number}>}
 */
async function processPendingFiles(endpointName, handlers, label) {
  const pending = await findPendingLiveFiles(endpointName);

  if (pending.length === 0) {
    log(`${label}: 新規ファイルはありません`);
    return { fileCount: 0, rowCount: 0 };
  }

  log(`${label}: ${pending.length}件のファイルを処理します`);

  let rowCount = 0;
  for (let i = 0; i < pending.length; i += 1) {
    const { Key } = pending[i];
    process.stdout.write(`  [${i + 1}/${pending.length}] `);
    const result = await loadInitial.processFile(endpointName, Key, handlers);
    rowCount += result.rowCount;
    await jquantsClient.throttle();
  }

  return { fileCount: pending.length, rowCount };
}

async function main() {
  const startedAt = Date.now();
  log('日次投入バッチを開始します');

  // --- Phase 1: 銘柄マスタ ---
  const masterResult = await processPendingFiles(
    loadInitial.ENDPOINT_MASTER,
    loadInitial.MASTER_HANDLERS,
    'Phase 1 銘柄マスタ'
  );

  // --- Phase 2: 上場廃止フラグ ---
  // マスタに新規ファイルがあった場合のみ実行(無駄な全件UPDATEを避ける)
  if (masterResult.fileCount > 0) {
    await db.withConnection(async (connection) => {
      const updated = await mergeSql.refreshDelistedFlag(connection);
      await connection.commit();
      log(`Phase 2 上場廃止フラグ: ${updated.toLocaleString()}件を更新`);
    });
  } else {
    log('Phase 2 上場廃止フラグ: マスタに更新が無いためスキップ');
  }

  // --- Phase 3: 株価四本値 ---
  const priceResult = await processPendingFiles(
    loadInitial.ENDPOINT_PRICE,
    loadInitial.PRICE_HANDLERS,
    'Phase 3 株価四本値'
  );

  // --- Phase 4〜7: 空売り・信用取引関連 ---
  // 1つ失敗しても残りは処理し、最後にまとめて報告する
  const shortPhases = [
    ['Phase 4 業種別空売り比率', loadInitial.ENDPOINT_SHORT_RATIO, loadInitial.SHORT_RATIO_HANDLERS],
    ['Phase 5 信用取引残高', loadInitial.ENDPOINT_MARGIN_INTEREST, loadInitial.MARGIN_INTEREST_HANDLERS],
    ['Phase 6 日々公表信用取引残高', loadInitial.ENDPOINT_MARGIN_ALERT, loadInitial.MARGIN_ALERT_HANDLERS],
    ['Phase 7 空売り残高報告', loadInitial.ENDPOINT_SHORT_POSITION, loadInitial.SHORT_POSITION_HANDLERS],
    ['Phase 8 取引カレンダー', loadInitial.ENDPOINT_TRADING_CALENDAR, loadInitial.TRADING_CALENDAR_HANDLERS],
    ['Phase 9 TOPIX四本値', loadInitial.ENDPOINT_INDEX_TOPIX, loadInitial.INDEX_TOPIX_HANDLERS],
    ['Phase 10 指数四本値', loadInitial.ENDPOINT_INDEX_DAILY, loadInitial.INDEX_DAILY_HANDLERS],
    ['Phase 11 投資部門別情報', loadInitial.ENDPOINT_INVESTOR_TYPES, loadInitial.INVESTOR_TYPES_HANDLERS],
    ['Phase 12 決算発表予定日', loadInitial.ENDPOINT_EARNINGS_DATE, loadInitial.EARNINGS_SCHEDULE_HANDLERS],
    ['Phase 13 財務情報', loadInitial.ENDPOINT_FINANCIAL_SUMMARY, loadInitial.FINANCIAL_SUMMARY_HANDLERS],
    ['Phase 14 日経225オプション四本値', loadInitial.ENDPOINT_OPTION_225, loadInitial.OPTION_225_HANDLERS],
  ];

  const shortResults = [];
  const failures = [];
  for (const [label, endpoint, handlers] of shortPhases) {
    try {
      const r = await processPendingFiles(endpoint, handlers, label);
      shortResults.push({ label, ...r });
    } catch (err) {
      logError(`${label} でエラーが発生しました: ${err.message}`);
      console.error(err.stack || err);
      failures.push({ label, message: err.message, error: err });
    }
  }

  // --- 欠損チェック ---
  const allPriceLive = (await jquantsClient.listBulkFiles(loadInitial.ENDPOINT_PRICE))
    .filter((f) => f.Key.includes('/live/'));
  await warnIfGapExists(loadInitial.sortFilesChronologically(allPriceLive));

  // --- サマリ ---
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const shortSummary = shortResults
    .filter((r) => r.fileCount > 0)
    .map((r) => `${r.label} ${r.fileCount}ファイル/${r.rowCount.toLocaleString()}行`)
    .join(', ');

  log(
    `日次投入バッチが完了しました ` +
      `(マスタ ${masterResult.fileCount}ファイル/${masterResult.rowCount.toLocaleString()}行, ` +
      `株価 ${priceResult.fileCount}ファイル/${priceResult.rowCount.toLocaleString()}行` +
      `${shortSummary ? ', ' + shortSummary : ''}, ` +
      `${elapsedSec}秒)`
  );

  if (failures.length > 0) {
    throw new Error(
      `${failures.length}件のフェーズが失敗しました:\n` +
        failures.map((f) => `  - ${f.label}: ${f.message}`).join('\n')
    );
  }
}

if (require.main === module) {
  if (!acquireLock()) {
    process.exit(0); // 多重起動はエラーではないので正常終了扱い
  }

  // 異常終了時もロックが残らないようにする
  const cleanup = () => releaseLock();
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  main()
    .then(async () => {
      await db.closePool();
      releaseLock();
      process.exit(0);
    })
    .catch(async (err) => {
      logError(`日次投入バッチが異常終了しました: ${err.message}`);
      console.error(err);
      await db.closePool().catch(() => {});
      releaseLock();
      process.exit(1);
    });
}

module.exports = {
  findPendingLiveFiles,
  processPendingFiles,
  extractDate,
  main,
};
