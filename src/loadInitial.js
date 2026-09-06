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
 *   Phase 4: 業種別空売り比率(/markets/short-ratio)      → SECTOR_SHORT_RATIO
 *   Phase 5: 信用取引残高(/markets/margin-interest)      → EQUITY_MARGIN_INTEREST
 *   Phase 6: 日々公表信用取引残高(/markets/margin-alert) → EQUITY_MARGIN_ALERT
 *   Phase 7: 空売り残高報告(/markets/short-sale-report)  → EQUITY_SHORT_POSITION
 *   Phase 8: 取引カレンダー(/markets/calendar)            → TRADING_CALENDAR
 *   Phase 9: TOPIX四本値(/indices/bars/daily/topix)       → TOPIX_PRICE_DAILY
 *   Phase10: 指数四本値(/indices/bars/daily)              → INDEX_PRICE_DAILY
 *
 * Phase 4〜10 は Standardプラン以上でのみ利用できる。
 * Phase 5〜7 は EQUITY_MASTER への外部キーを持つためマスタの後に実行する。
 * Phase 8〜10 は銘柄単位のデータではないため EQUITY_MASTER への外部キーを持たず、
 * マスタと独立して(先に)実行しても問題ない。
 *
 * 【一部のフェーズだけ実行する】
 *   既に株価まで取り込み済みの環境に空売り系を追加する場合は --only が使える。
 *     node src/loadInitial.js --only short          (Phase 4〜7)
 *     node src/loadInitial.js --only indices        (Phase 8〜10)
 *     node src/loadInitial.js --only short-ratio    (単独指定)
 *     node src/loadInitial.js --only equity         (Phase 1〜3)
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
const edinetMapper = require('./edinetMapper');

const ENDPOINT_MASTER = '/equities/master';
const ENDPOINT_PRICE = '/equities/bars/daily';

// 空売り・信用取引関連(いずれもStandardプラン以上)
const ENDPOINT_SHORT_RATIO = '/markets/short-ratio';        // 業種別空売り比率
const ENDPOINT_MARGIN_INTEREST = '/markets/margin-interest'; // 信用取引残高
const ENDPOINT_MARGIN_ALERT = '/markets/margin-alert';       // 日々公表信用取引残高
const ENDPOINT_SHORT_POSITION = '/markets/short-sale-report'; // 空売り残高報告

// Tier 1: 取引カレンダー・指数四本値(いずれもStandardプラン以上、FKなし)
const ENDPOINT_TRADING_CALENDAR = '/markets/calendar';        // 取引カレンダー
const ENDPOINT_INDEX_TOPIX = '/indices/bars/daily/topix';     // TOPIX四本値
const ENDPOINT_INDEX_DAILY = '/indices/bars/daily';           // 指数四本値(TOPIX以外)

// Tier 2: 投資部門別情報・決算発表予定日
const ENDPOINT_INVESTOR_TYPES = '/equities/investor-types';   // 投資部門別情報(FKなし)
const ENDPOINT_EARNINGS_DATE = '/fins/earnings-date';         // 決算発表予定日(補助データ、FKあり)

// 財務情報・日経225オプション四本値(Tier 3、いずれもStandardプラン以上)
const ENDPOINT_FINANCIAL_SUMMARY = '/fins/summary';                         // 財務情報(補助データ、FKあり)
const ENDPOINT_OPTION_225 = '/derivatives/bars/daily/options/225';          // 日経225オプション四本値(FKなし)

// 大量保有報告書(EDINET) (Tier 4。Bulk非対応、個別API呼出し+pagination_keyページング)
const ENDPOINT_EDINET_LARGE_VOLUME = '/edinet/large-volume-shareholders';
const ENDPOINT_EDINET_MAJOR_SHAREHOLDER = '/edinet/major-shareholders'; // 大株主状況
const ENDPOINT_EDINET_CROSS_SHAREHOLDING = '/edinet/cross-shareholdings'; // 政策保有株式

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
  if (handlers.streaming) {
    return processFileStreaming(endpointName, fileKey, handlers);
  }

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

  // 桁あふれをexecuteMany前に検出し、原因の列と値を特定できるようにする
  csvMapper.validateLengths(dbRows, handlers.columns, handlers.bindDefs);

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
          batchSize: handlers.batchSize,
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
 * processFile()のストリーミング版。handlers.streaming=trueの場合のみ使われる。
 *
 * 通常版はファイル全体を一度にパース→変換して1回のbulkInsertに渡すが、
 * こちらはjquantsClient.streamBulkFile()でCSVを行単位でストリーム処理し、
 * バッチがたまるごとに都度mapRow→validateLengths→bulkInsertする。
 * ステージングへの投入が複数回に分かれるだけで、進捗管理・MERGEのタイミング・
 * エラー処理(ロールバック→FAILED記録)は通常版と同じ流れにしてある。
 *
 * 日経225オプションのような「1ファイルが巨大(14万行超)」なエンドポイント向け。
 * メモリの小さいVMでNode既定ヒープを超えてOOMになった事例(2026-09-06)への対処。
 *
 * @param {string} endpointName
 * @param {string} fileKey
 * @param {object} handlers processFile()と同じ形。streamBatchSizeで
 *        streamBulkFile()のバッチ行数を上書きできる(既定5000)。
 * @returns {Promise<{skipped: boolean, rowCount: number}>}
 */
async function processFileStreaming(endpointName, fileKey, handlers) {
  const alreadyDone = await db.withConnection(async (connection) => {
    const status = await db.getProgressStatus(connection, endpointName, fileKey);
    return status === 'SUCCESS';
  });

  if (alreadyDone) {
    console.log(`  [SKIP] ${fileKey} (取り込み済み)`);
    return { skipped: true, rowCount: 0 };
  }

  return db.withConnection(async (connection) => {
    await db.markProgressStarted(connection, endpointName, fileKey);
    await connection.commit();

    try {
      await db.truncateTable(connection, handlers.stagingTable);

      let inserted = 0;
      await jquantsClient.streamBulkFile(
        fileKey,
        async (csvBatch) => {
          const dbRows = csvBatch.map(handlers.mapRow);
          csvMapper.validateLengths(dbRows, handlers.columns, handlers.bindDefs);
          inserted += await db.bulkInsert(
            connection,
            handlers.stagingTable,
            handlers.columns,
            dbRows,
            {
              valueExpressions: handlers.valueExpressions,
              bindDefs: handlers.bindDefs,
              batchSize: handlers.batchSize,
            }
          );
        },
        handlers.streamBatchSize
      );

      await handlers.merge(connection);

      await db.markProgressSuccess(connection, endpointName, fileKey, inserted);
      await connection.commit();

      console.log(`  [OK]   ${fileKey} (${inserted.toLocaleString()}行, streaming)`);
      return { skipped: false, rowCount: inserted };
    } catch (err) {
      await connection.rollback().catch(() => {});
      await db.markProgressFailed(connection, endpointName, fileKey, err.message);
      await connection.commit().catch(() => {});
      console.error(`  [FAIL] ${fileKey}: ${err.message}`);
      throw err;
    }
  });
}

/**
 * 銘柄マスタ取り込み用のハンドラ定義(loadMaster / テストスクリプトから共用)
 */
const MASTER_HANDLERS = {
  stagingTable: 'EQUITY_MASTER_STG',
  columns: csvMapper.MASTER_COLUMNS,
  valueExpressions: csvMapper.MASTER_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.MASTER_BIND_DEFS,
  mapRow: csvMapper.mapMasterRow,
  // 銘柄名列(2000バイト×2)のバッファがバッチサイズ分確保されるため、
  // 株価より小さめにしてメモリ使用量を抑える
  batchSize: 2000,
  merge: async (connection) => {
    // EQUITY_MASTER_HIST は EQUITY_MASTER への外部キーを持つため、必ずこの順序で実行する
    await mergeSql.mergeMaster(connection);
    await mergeSql.mergeMasterHist(connection);
  },
};

/**
 * 株価四本値取り込み用のハンドラ定義(loadPrice / テストスクリプトから共用)
 */
const PRICE_HANDLERS = {
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
          '  考えられる原因:\n' +
          '   (1) マスタ(Phase 1)が最後まで完了していない\n' +
          '   (2) 該当銘柄が、取り込み済みのマスタ基準日より後に上場廃止された\n' +
          '       (マスタのliveファイルは翌営業日時点の一覧のため、\n' +
          '        当日廃止された銘柄は最新スナップショットに含まれない)\n' +
          '  Phase 1 が全ファイル完了していれば過去のマスタから補完されるため、\n' +
          '  この状態にはならない。'
      );
    }
    await mergeSql.mergePriceDaily(connection);
  },
};

/**
 * Phase 1: 銘柄マスタの取り込み
 */
async function loadMaster() {
  console.log('=== Phase 1: 銘柄マスタの取り込み ===');
  const files = sortFilesChronologically(await jquantsClient.listBulkFiles(ENDPOINT_MASTER));
  console.log(`対象ファイル数: ${files.length}`);

  let total = 0;
  for (let i = 0; i < files.length; i += 1) {
    const { Key } = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] `);
    const { rowCount } = await processFile(ENDPOINT_MASTER, Key, MASTER_HANDLERS);
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

  let total = 0;
  for (let i = 0; i < files.length; i += 1) {
    const { Key } = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] `);
    const { rowCount } = await processFile(ENDPOINT_PRICE, Key, PRICE_HANDLERS);
    total += rowCount;
    await jquantsClient.throttle();
  }

  console.log(`Phase 3 完了: 合計 ${total.toLocaleString()} 行\n`);
}

//==================================================================
// 空売り・信用取引関連のハンドラ
//
// いずれも EQUITY_MASTER への外部キーを持つため、Phase 1(マスタ)の
// 完了後に実行すること。
//==================================================================

/**
 * 取り込み中にスキップした銘柄コードを、エンドポイント単位で集計する。
 * ファイルごとに警告を出すと139ファイル分のログに埋もれるため、
 * loadEndpoint() の最後にまとめて報告する。
 * @type {Map<string, Map<string, number>>} stagingTable -> (code -> 行数)
 */
const skippedCodes = new Map();

/**
 * EQUITY_MASTERに存在しない銘柄コードの行を、MERGE前に取り除く。
 *
 * 【中断せずスキップにしている理由】
 *   空売り残高報告や信用取引残高には、東証以外の取引所に単独上場している銘柄が
 *   含まれることがある(例: 3808 オーケーウェブ = 名証単独上場)。
 *   J-Quantsの銘柄マスタは東証データのため、これらは構造的にEQUITY_MASTERへ
 *   登録されない。「いつか解消するデータ不整合」ではなく恒久的な差なので、
 *   1銘柄のために9千行のファイル全体を落とすのは割に合わない。
 *
 *   ただし黙って捨てると気づけないので、どの銘柄を何行落としたかを集計して
 *   フェーズの最後に必ず報告する。
 *
 * @param {import('oracledb').Connection} connection
 * @param {string} stagingTable
 * @param {string} label ログ表示用
 */
async function skipUnknownCodes(connection, stagingTable, label) {
  const unknown = await mergeSql.findUnknownCodesInStg(connection, stagingTable);
  if (unknown.length === 0) return;

  const deleted = await mergeSql.deleteUnknownCodesFromStg(connection, stagingTable);

  if (!skippedCodes.has(stagingTable)) {
    skippedCodes.set(stagingTable, new Map());
  }
  const tally = skippedCodes.get(stagingTable);
  for (const code of unknown) {
    tally.set(code, (tally.get(code) || 0) + 1);
  }

  console.warn(
    `\n    [スキップ] ${label}: マスタに無い銘柄 ${unknown.length}件 / ${deleted}行を除外 ` +
      `(${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ' ...' : ''})`
  );
}

/**
 * スキップした銘柄をまとめて報告する。
 * @param {string} stagingTable
 */
function reportSkippedCodes(stagingTable) {
  const tally = skippedCodes.get(stagingTable);
  if (!tally || tally.size === 0) return;

  const entries = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const totalFiles = entries.reduce((sum, [, n]) => sum + n, 0);
  console.warn(
    `  ⚠ EQUITY_MASTERに存在しないため取り込まなかった銘柄が ${entries.length}件 ` +
      `ありました(延べ${totalFiles}ファイル)`
  );
  for (const [code, n] of entries.slice(0, 20)) {
    console.warn(`      ${code}  (${n}ファイルで出現)`);
  }
  if (entries.length > 20) {
    console.warn(`      ... 他 ${entries.length - 20}件`);
  }
  console.warn(
    '    これらは東証以外の取引所に単独上場している銘柄と考えられます\n' +
      '    (J-Quantsの銘柄マスタは東証データのため構造的に含まれません)。\n' +
      '    マスタ(Phase 1)が未完了の場合も同じ症状になるので、\n' +
      '    件数が多い場合は EQUITY_MASTER の取込状況を確認してください。'
  );
  skippedCodes.delete(stagingTable);
}

/** 業種別空売り比率(33業種単位。銘柄への外部キーは無い) */
const SHORT_RATIO_HANDLERS = {
  stagingTable: 'SECTOR_SHORT_RATIO_STG',
  columns: csvMapper.SHORT_RATIO_COLUMNS,
  valueExpressions: csvMapper.SHORT_RATIO_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.SHORT_RATIO_BIND_DEFS,
  mapRow: csvMapper.mapShortRatioRow,
  merge: async (connection) => {
    await mergeSql.mergeShortRatio(connection);
  },
};

/** 信用取引残高(2026/9/24以前は週末時点、9/25以降は日次) */
const MARGIN_INTEREST_HANDLERS = {
  stagingTable: 'EQUITY_MARGIN_INTEREST_STG',
  columns: csvMapper.MARGIN_INTEREST_COLUMNS,
  valueExpressions: csvMapper.MARGIN_INTEREST_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.MARGIN_INTEREST_BIND_DEFS,
  mapRow: csvMapper.mapMarginInterestRow,
  merge: async (connection) => {
    await skipUnknownCodes(connection, 'EQUITY_MARGIN_INTEREST_STG', '信用取引残高');
    await mergeSql.mergeMarginInterest(connection);
  },
};

/** 日々公表信用取引残高(日々公表銘柄のみ) */
const MARGIN_ALERT_HANDLERS = {
  stagingTable: 'EQUITY_MARGIN_ALERT_STG',
  columns: csvMapper.MARGIN_ALERT_COLUMNS,
  valueExpressions: csvMapper.MARGIN_ALERT_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.MARGIN_ALERT_BIND_DEFS,
  mapRow: csvMapper.mapMarginAlertRow,
  merge: async (connection) => {
    await skipUnknownCodes(connection, 'EQUITY_MARGIN_ALERT_STG', '日々公表信用取引残高');
    await mergeSql.mergeMarginAlert(connection);
  },
};

/**
 * 空売り残高報告(報告者単位の明細)
 * MERGEではなく公表日単位の洗い替え。理由は mergeSql.replaceShortPosition() を参照。
 */
const SHORT_POSITION_HANDLERS = {
  stagingTable: 'EQUITY_SHORT_POSITION_STG',
  columns: csvMapper.SHORT_POSITION_COLUMNS,
  valueExpressions: csvMapper.SHORT_POSITION_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.SHORT_POSITION_BIND_DEFS,
  mapRow: csvMapper.mapShortPositionRow,
  // 名称・住所・備考が4000バイト×6列あるため、バッチサイズを絞ってメモリを抑える
  batchSize: 2000,
  merge: async (connection) => {
    await skipUnknownCodes(connection, 'EQUITY_SHORT_POSITION_STG', '空売り残高報告');
    await mergeSql.replaceShortPosition(connection);
  },
};

//==================================================================
// 取引カレンダー・指数四本値関連のハンドラ (Tier 1)
//
// いずれも EQUITY_MASTER への外部キーを持たない(銘柄単位のデータではないため)。
//==================================================================

/** 取引カレンダー(銘柄への外部キーは無い) */
const TRADING_CALENDAR_HANDLERS = {
  stagingTable: 'TRADING_CALENDAR_STG',
  columns: csvMapper.CALENDAR_COLUMNS,
  valueExpressions: csvMapper.CALENDAR_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.CALENDAR_BIND_DEFS,
  mapRow: csvMapper.mapCalendarRow,
  merge: async (connection) => {
    await mergeSql.mergeTradingCalendar(connection);
  },
};

/** TOPIX四本値(銘柄への外部キーは無い) */
const INDEX_TOPIX_HANDLERS = {
  stagingTable: 'TOPIX_PRICE_DAILY_STG',
  columns: csvMapper.TOPIX_COLUMNS,
  valueExpressions: csvMapper.TOPIX_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.TOPIX_BIND_DEFS,
  mapRow: csvMapper.mapTopixRow,
  merge: async (connection) => {
    await mergeSql.mergeTopixPriceDaily(connection);
  },
};

/** 指数四本値(銘柄への外部キーは無い) */
const INDEX_DAILY_HANDLERS = {
  stagingTable: 'INDEX_PRICE_DAILY_STG',
  columns: csvMapper.INDEX_DAILY_COLUMNS,
  valueExpressions: csvMapper.INDEX_DAILY_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.INDEX_DAILY_BIND_DEFS,
  mapRow: csvMapper.mapIndexDailyRow,
  merge: async (connection) => {
    await mergeSql.mergeIndexPriceDaily(connection);
  },
};

//==================================================================
// 投資部門別情報・決算発表予定日のハンドラ (Tier 2)
//==================================================================

/** 投資部門別情報(市場単位。銘柄への外部キーは無い) */
const INVESTOR_TYPES_HANDLERS = {
  stagingTable: 'INVESTOR_TYPE_TRADING_STG',
  columns: csvMapper.INVESTOR_TYPE_COLUMNS,
  valueExpressions: csvMapper.INVESTOR_TYPE_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.INVESTOR_TYPE_BIND_DEFS,
  mapRow: csvMapper.mapInvestorTypeRow,
  merge: async (connection) => {
    await mergeSql.mergeInvestorTypeTrading(connection);
  },
};

/**
 * 決算発表予定日(補助データ)
 * 空売り関連と同様、EQUITY_MASTERに無い銘柄コードはスキップする。
 */
const EARNINGS_SCHEDULE_HANDLERS = {
  stagingTable: 'EARNINGS_SCHEDULE_STG',
  columns: csvMapper.EARNINGS_SCHEDULE_COLUMNS,
  valueExpressions: csvMapper.EARNINGS_SCHEDULE_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.EARNINGS_SCHEDULE_BIND_DEFS,
  mapRow: csvMapper.mapEarningsScheduleRow,
  merge: async (connection) => {
    await skipUnknownCodes(connection, 'EARNINGS_SCHEDULE_STG', '決算発表予定日');
    await mergeSql.mergeEarningsSchedule(connection);
  },
};

/**
 * 1エンドポイント分のBulkファイルをすべて取り込む汎用処理。
 * Phase 4以降はどれも同じ流れなので共通化している。
 *
 * @param {string} endpointName
 * @param {object} handlers
 * @param {string} label ログ表示用(例: 'Phase 4: 業種別空売り比率')
 */
async function loadEndpoint(endpointName, handlers, label) {
  console.log(`=== ${label} の取り込み ===`);
  const files = sortFilesChronologically(await jquantsClient.listBulkFiles(endpointName));
  console.log(`対象ファイル数: ${files.length}`);

  if (files.length === 0) {
    console.log(
      '  ファイルが0件でした。契約プランでこのデータが利用できるか確認してください。\n'
    );
    return;
  }

  csvMapper.resetTruncationCount();

  let total = 0;
  for (let i = 0; i < files.length; i += 1) {
    const { Key } = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] `);
    const { rowCount } = await processFile(endpointName, Key, handlers);
    total += rowCount;
    await jquantsClient.throttle();
  }

  console.log(`${label} 完了: 合計 ${total.toLocaleString()} 行`);
  reportSkippedCodes(handlers.stagingTable);

  // 自由記述列を切り詰めた件数。0件が正常。件数が多い場合はDDLの桁を
  // 見直すか、そもそも値の性質が想定と違っていないか確認すること。
  const truncated = csvMapper.getTruncationCount();
  if (truncated > 0) {
    console.log(
      `  ※ 長すぎるテキストを ${truncated.toLocaleString()} 件切り詰めました(末尾に「…」が付きます)。\n` +
        '     備考・商号などの自由記述のみが対象で、数値・日付・銘柄コードは切り詰めません。'
    );
  }
  console.log('');
}

/** Phase 4: 業種別空売り比率 */
async function loadShortRatio() {
  await loadEndpoint(ENDPOINT_SHORT_RATIO, SHORT_RATIO_HANDLERS, 'Phase 4: 業種別空売り比率');
}

/** Phase 5: 信用取引残高 */
async function loadMarginInterest() {
  await loadEndpoint(
    ENDPOINT_MARGIN_INTEREST,
    MARGIN_INTEREST_HANDLERS,
    'Phase 5: 信用取引残高'
  );
}

/** Phase 6: 日々公表信用取引残高 */
async function loadMarginAlert() {
  await loadEndpoint(
    ENDPOINT_MARGIN_ALERT,
    MARGIN_ALERT_HANDLERS,
    'Phase 6: 日々公表信用取引残高'
  );
}

/** Phase 7: 空売り残高報告 */
async function loadShortPosition() {
  await loadEndpoint(
    ENDPOINT_SHORT_POSITION,
    SHORT_POSITION_HANDLERS,
    'Phase 7: 空売り残高報告'
  );
}

/** Phase 8: 取引カレンダー */
async function loadTradingCalendar() {
  await loadEndpoint(
    ENDPOINT_TRADING_CALENDAR,
    TRADING_CALENDAR_HANDLERS,
    'Phase 8: 取引カレンダー'
  );
}

/** Phase 9: TOPIX四本値 */
async function loadIndexTopix() {
  await loadEndpoint(
    ENDPOINT_INDEX_TOPIX,
    INDEX_TOPIX_HANDLERS,
    'Phase 9: TOPIX四本値'
  );
}

/** Phase 10: 指数四本値 */
async function loadIndexDaily() {
  await loadEndpoint(
    ENDPOINT_INDEX_DAILY,
    INDEX_DAILY_HANDLERS,
    'Phase 10: 指数四本値'
  );
}

/** Phase 11: 投資部門別情報 */
async function loadInvestorTypes() {
  await loadEndpoint(
    ENDPOINT_INVESTOR_TYPES,
    INVESTOR_TYPES_HANDLERS,
    'Phase 11: 投資部門別情報'
  );
}

/** Phase 12: 決算発表予定日 */
async function loadEarningsSchedule() {
  await loadEndpoint(
    ENDPOINT_EARNINGS_DATE,
    EARNINGS_SCHEDULE_HANDLERS,
    'Phase 12: 決算発表予定日'
  );
}

//==================================================================
// 財務情報・日経225オプション四本値のハンドラ (Tier 3)
//==================================================================

/**
 * 財務情報(補助データ)
 * 決算発表予定日と同様、EQUITY_MASTERに無い銘柄コードはスキップする。
 */
const FINANCIAL_SUMMARY_HANDLERS = {
  stagingTable: 'FINANCIAL_SUMMARY_STG',
  columns: csvMapper.FINANCIAL_SUMMARY_COLUMNS,
  valueExpressions: csvMapper.FINANCIAL_SUMMARY_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.FINANCIAL_SUMMARY_BIND_DEFS,
  mapRow: csvMapper.mapFinancialSummaryRow,
  merge: async (connection) => {
    await skipUnknownCodes(connection, 'FINANCIAL_SUMMARY_STG', '財務情報');
    await mergeSql.mergeFinancialSummary(connection);
  },
};

/**
 * 日経225オプション四本値(オプション銘柄コードなので銘柄への外部キーは無い)
 *
 * streaming: true — 月次historicalファイルが14万行を超えることがあり、
 * 通常のprocessFile()(全行を一括パース)だとメモリの小さいVMでOOMになった
 * (2026-09-06)。processFileStreaming()経由でバッチ単位に処理する。
 */
const OPTION_225_HANDLERS = {
  stagingTable: 'INDEX_OPTION_PRICE_DAILY_STG',
  columns: csvMapper.OPTION_225_COLUMNS,
  valueExpressions: csvMapper.OPTION_225_VALUE_EXPRESSIONS,
  bindDefs: csvMapper.OPTION_225_BIND_DEFS,
  mapRow: csvMapper.mapOption225Row,
  streaming: true,
  merge: async (connection) => {
    await mergeSql.mergeOptionPriceDaily(connection);
  },
};

/** Phase 13: 財務情報 */
async function loadFinancialSummary() {
  await loadEndpoint(
    ENDPOINT_FINANCIAL_SUMMARY,
    FINANCIAL_SUMMARY_HANDLERS,
    'Phase 13: 財務情報'
  );
}

/** Phase 14: 日経225オプション四本値 */
async function loadOption225() {
  await loadEndpoint(
    ENDPOINT_OPTION_225,
    OPTION_225_HANDLERS,
    'Phase 14: 日経225オプション四本値'
  );
}

//==================================================================
// 大量保有報告書(EDINET) (Tier 4)
//
// Bulk API非対応のため、Tier1〜3までとは根本的に違う取込方式を取る
// (個別API呼出し+pagination_keyページング、進捗管理は「日付単位」)。
// 設計の詳細・なぜステージングテーブルを使わないか等は
// ddl/14_large_volume_shareholders.sql の冒頭コメントを参照。
//==================================================================

/** データ提供期間の開始日(仕様書より: 提出日2021年7月1日以降) */
const EDINET_LARGE_VOLUME_START_DATE = '2021-07-01';

/** 'YYYY-MM-DD' 文字列をDateに変換する(常にUTC正午として扱い、日付ズレを避ける) */
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Dateを'YYYY-MM-DD'文字列に戻す */
function formatDateStr(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * startからendまでの平日(月〜金)を'YYYY-MM-DD'の配列で返す(両端含む)。
 *
 * 【TSEの取引カレンダー(TRADING_CALENDAR)を使わず単純な平日判定にしている理由】
 *   大量保有報告書はEDINET(金融庁)への提出であり、東証の休業日(大納会・大発会等)
 *   とは休日の基準が別。TRADING_CALENDARを流用すると「EDINETは営業日だが
 *   東証は休みの日」を取りこぼす恐れがある。国民の祝日には空振り(0件応答)の
 *   リクエストが年20日程度発生するが実害はほぼ無いため、安全側に倒している。
 * @param {string} startStr 'YYYY-MM-DD'
 * @param {string} endStr 'YYYY-MM-DD'
 * @returns {string[]}
 */
function businessDaysBetween(startStr, endStr) {
  const days = [];
  let cur = parseDateStr(startStr);
  const end = parseDateStr(endStr);
  while (cur.getTime() <= end.getTime()) {
    const dow = cur.getUTCDay(); // 0=日, 6=土
    if (dow !== 0 && dow !== 6) {
      days.push(formatDateStr(cur));
    }
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

/**
 * EQUITY_MASTERに存在する銘柄コードの集合を取得する。
 *
 * Tier1〜3の skipUnknownCodes() はステージングテーブルからまとめて未知コードを
 * 検出する方式だったが、Tier4はステージングテーブルを持たずJSONを1件ずつ処理する
 * ため、事前にこの集合をロードしてJS側でチェックする方式にしている。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<Set<string>>}
 */
async function loadKnownEquityCodes(connection) {
  const result = await connection.execute('SELECT code FROM equity_master');
  return new Set(result.rows.map((r) => r[0]));
}

/**
 * スキップした銘柄をまとめて報告する(Tier4版。reportSkippedCodes()と違い
 * 「ファイル」ではなく「書類」単位の集計であることを明示する)。
 */
function reportSkippedLargeVolumeCodes() {
  const label = 'LARGE_VOLUME_SHAREHOLDER';
  const tally = skippedCodes.get(label);
  if (!tally || tally.size === 0) return;

  const entries = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const totalDocs = entries.reduce((sum, [, n]) => sum + n, 0);
  console.warn(
    `  ⚠ EQUITY_MASTERに存在しないため取り込まなかった銘柄が ${entries.length}件 ` +
      `ありました(延べ${totalDocs}書類)`
  );
  for (const [code, n] of entries.slice(0, 20)) {
    console.warn(`      ${code}  (${n}書類で出現)`);
  }
  if (entries.length > 20) {
    console.warn(`      ... 他 ${entries.length - 20}件`);
  }
  console.warn(
    '    これらは東証以外の取引所に単独上場している銘柄と考えられます\n' +
      '    (J-Quantsの銘柄マスタは東証データのため構造的に含まれません)。'
  );
  skippedCodes.delete(label);
}

/**
 * 指定日の大量保有報告書を取得し、DBへ反映する。
 *
 * 進捗はLOAD_PROGRESSにendpoint_name=ENDPOINT_EDINET_LARGE_VOLUME,
 * file_key=date('YYYY-MM-DD')として記録する(ファイル単位ではなく日付単位に読み替え)。
 * 提出日(sub_date)＝クエリのdateである(API仕様書より)ことを前提に、
 * その日付でLARGE_VOLUME_SHAREHOLDERをDELETEしてからINSERTする
 * (ON DELETE CASCADEで子・孫テーブルも連動して洗い替えられる)。
 *
 * @param {string} date 'YYYY-MM-DD'
 * @param {Set<string>} knownCodes EQUITY_MASTERに存在する銘柄コードの集合
 * @returns {Promise<{skipped: boolean, docCount: number}>}
 */
async function processEdinetDate(date, knownCodes) {
  const alreadyDone = await db.withConnection(async (connection) => {
    const status = await db.getProgressStatus(connection, ENDPOINT_EDINET_LARGE_VOLUME, date);
    return status === 'SUCCESS';
  });
  if (alreadyDone) {
    return { skipped: true, docCount: 0 };
  }

  const rawDocs = await jquantsClient.fetchAllApiPages(ENDPOINT_EDINET_LARGE_VOLUME, { date });

  const docRows = [];
  const docIds = [];
  const holderRows = [];
  const acqDispRows = [];
  const borrowingRows = [];
  const creditorRows = [];

  for (const doc of rawDocs) {
    const code = doc.Code === undefined || doc.Code === null ? null : String(doc.Code).trim();
    if (code !== null && !knownCodes.has(code)) {
      const label = 'LARGE_VOLUME_SHAREHOLDER';
      if (!skippedCodes.has(label)) {
        skippedCodes.set(label, new Map());
      }
      const tally = skippedCodes.get(label);
      tally.set(code, (tally.get(code) || 0) + 1);
      continue;
    }

    const mapped = edinetMapper.mapLargeVolumeShareholderDoc(doc);
    docRows.push(mapped.docRow);
    docIds.push(mapped.docRow[0]); // DOC_COLUMNSの先頭がdoc_id
    holderRows.push(...mapped.holderRows);
    acqDispRows.push(...mapped.acqDispRows);
    borrowingRows.push(...mapped.borrowingRows);
    creditorRows.push(...mapped.creditorRows);
  }

  return db.withConnection(async (connection) => {
    await db.markProgressStarted(connection, ENDPOINT_EDINET_LARGE_VOLUME, date);
    await connection.commit(); // 開始記録は先に確定させる

    try {
      // 【doc_idベースの事前DELETEが必要な理由】
      //   sub_dateは「クエリに使った日付」ではなく、書類JSON自身のSubDateフィールドから
      //   格納している(mapDocRow参照)。EDINETの大量保有報告書API(--date)は「その日に
      //   問い合わせた結果」を返すが、ごく稀に同一DocIdの書類が「後日の日付でのクエリ」
      //   でも再度返ってくるケースがある(2026-09-06、初回投入の実データで発覚。11日分)。
      //   このとき格納済みのsub_dateは元の日付のままなので、後続の
      //   `sub_date = 今回の対象日` のDELETEでは古い行が消えず、
      //   doc_id主キーの一意制約違反(ORA-00001)で失敗していた。
      //   → 今回取得したdoc_id群を「日付に関係なく」先に消しておくことで、
      //     どの日付で以前登録されていても確実に洗い替えできるようにする。
      if (docIds.length > 0) {
        await connection.executeMany(
          `DELETE FROM large_volume_shareholder WHERE doc_id = :docId`,
          docIds.map((docId) => ({ docId }))
        );
      }

      // 親をDELETEすればON DELETE CASCADEで子・孫テーブルも連動して消える
      // 【bind変数名を:dateではなく:targetDateにしている理由】
      //   ORA-01745(invalid host/bind variable name)の原因になるため。DATEはOracleの
      //   予約語(データ型名)であり、bind変数名として:dateを使うとパーサが弾く
      //   (実際にこのバグで初回投入が全日FAILEDになった。2026-09-06に実データで発覚)。
      //   このDELETEは「同じ対象日を再実行したとき」の洗い替え用(上のdoc_id DELETEと
      //   役割が異なるので両方残す)。
      await connection.execute(
        `DELETE FROM large_volume_shareholder WHERE sub_date = TO_DATE(:targetDate, 'YYYY-MM-DD')`,
        { targetDate: date }
      );

      await db.bulkInsert(connection, 'large_volume_shareholder', edinetMapper.DOC_COLUMNS, docRows, {
        valueExpressions: edinetMapper.DOC_VALUE_EXPRESSIONS,
        bindDefs: edinetMapper.DOC_BIND_DEFS,
      });
      await db.bulkInsert(
        connection,
        'large_volume_shareholder_holder',
        edinetMapper.HOLDER_COLUMNS,
        holderRows,
        { valueExpressions: edinetMapper.HOLDER_VALUE_EXPRESSIONS, bindDefs: edinetMapper.HOLDER_BIND_DEFS }
      );
      await db.bulkInsert(
        connection,
        'large_volume_shareholder_acq_disp',
        edinetMapper.ACQ_DISP_COLUMNS,
        acqDispRows,
        { valueExpressions: edinetMapper.ACQ_DISP_VALUE_EXPRESSIONS, bindDefs: edinetMapper.ACQ_DISP_BIND_DEFS }
      );
      await db.bulkInsert(
        connection,
        'large_volume_shareholder_borrowing',
        edinetMapper.BORROWING_COLUMNS,
        borrowingRows,
        { valueExpressions: edinetMapper.BORROWING_VALUE_EXPRESSIONS, bindDefs: edinetMapper.BORROWING_BIND_DEFS }
      );
      await db.bulkInsert(
        connection,
        'large_volume_shareholder_creditor',
        edinetMapper.CREDITOR_COLUMNS,
        creditorRows,
        { valueExpressions: edinetMapper.CREDITOR_VALUE_EXPRESSIONS, bindDefs: edinetMapper.CREDITOR_BIND_DEFS }
      );

      await db.markProgressSuccess(connection, ENDPOINT_EDINET_LARGE_VOLUME, date, docRows.length);
      await connection.commit();
      return { skipped: false, docCount: docRows.length };
    } catch (err) {
      await connection.rollback().catch(() => {});
      await db.markProgressFailed(connection, ENDPOINT_EDINET_LARGE_VOLUME, date, err.message);
      await connection.commit().catch(() => {});
      throw err;
    }
  });
}

/**
 * Phase 15: 大量保有報告書(EDINET) (Tier 4)
 *
 * 2021-07-01(データ提供開始日)から本日まで、平日単位でループしてAPIを呼ぶ。
 * 1日ごとにLOAD_PROGRESSへ記録するため、中断しても再実行すれば続きから処理される。
 * 1日の呼び出し失敗は他の日を止めない(空売り系と同じ考え方。5.5節参照)。
 */
async function loadLargeVolumeShareholders() {
  console.log('=== Phase 15: 大量保有報告書(EDINET)の取り込み ===');

  const today = formatDateStr(new Date());
  const dates = businessDaysBetween(EDINET_LARGE_VOLUME_START_DATE, today);
  console.log(`対象日数: ${dates.length}日 (${EDINET_LARGE_VOLUME_START_DATE} 〜 ${today}、土日を除く平日単位)`);

  const knownCodes = await db.withConnection((connection) => loadKnownEquityCodes(connection));

  csvMapper.resetTruncationCount();

  let totalDocs = 0;
  let processedDays = 0;
  let skippedDays = 0;
  const failures = [];

  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} `);
    try {
      const { skipped, docCount } = await processEdinetDate(date, knownCodes);
      if (skipped) {
        skippedDays += 1;
        console.log('[SKIP] (取り込み済み)');
      } else {
        processedDays += 1;
        totalDocs += docCount;
        console.log(`[OK] ${docCount}件`);
      }
    } catch (err) {
      console.error(`[FAIL] ${err.message}`);
      failures.push({ date, message: err.message });
    }
    await jquantsClient.apiThrottle();
  }

  console.log(
    `Phase 15 完了: 処理 ${processedDays}日 / スキップ(取り込み済み) ${skippedDays}日 / ` +
      `失敗 ${failures.length}日 / 合計 ${totalDocs.toLocaleString()}件の書類\n`
  );

  reportSkippedLargeVolumeCodes();

  const truncated = csvMapper.getTruncationCount();
  if (truncated > 0) {
    console.log(
      `  ※ 長すぎるテキストを ${truncated.toLocaleString()} 件切り詰めました(末尾に「…」が付きます)。\n` +
        '     氏名・住所・保有目的等の自由記述のみが対象です。\n'
    );
  }

  if (failures.length > 0) {
    console.warn(`  ⚠ ${failures.length}日で失敗しました。再実行すると失敗分だけ再処理されます:`);
    for (const f of failures.slice(0, 20)) {
      console.warn(`      ${f.date}: ${f.message}`);
    }
    if (failures.length > 20) {
      console.warn(`      ... 他 ${failures.length - 20}件`);
    }
  }
}




//==================================================================
// 大株主状況(EDINET) (Tier 4 続き。大量保有報告書と同じ個別API基盤を再利用)
//
// 大量保有報告書(Phase 15)と全く同じ「個別API呼出し+pagination_keyページング、
// 日付単位のLOAD_PROGRESS、doc_idベースの事前DELETE」方式を踏襲する。
// テーブル設計の詳細はddl/15_edinet_major_shareholders.sql冒頭コメントを参照。
//==================================================================

/** データ提供期間の開始日(仕様書より: 提出日2016年6月1日以降) */
const EDINET_MAJOR_SHAREHOLDER_START_DATE = '2016-06-01';

/**
 * スキップした銘柄をまとめて報告する(Phase16・17共用の汎用版)。
 * reportSkippedLargeVolumeCodes()と同じロジックだが、テーブル名を出さず
 * displayNameで表示名を渡せるようにしている(1関数で複数エンドポイントに対応するため)。
 * @param {string} label skippedCodesのキー
 * @param {string} displayName ログ表示用の日本語名
 */
function reportSkippedEdinetDocCodes(label, displayName) {
  const tally = skippedCodes.get(label);
  if (!tally || tally.size === 0) return;

  const entries = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const totalDocs = entries.reduce((sum, [, n]) => sum + n, 0);
  console.warn(
    `  ⚠ EQUITY_MASTERに存在しないため取り込まなかった銘柄が ${entries.length}件 ` +
      `ありました(延べ${totalDocs}書類、${displayName})`
  );
  for (const [code, n] of entries.slice(0, 20)) {
    console.warn(`      ${code}  (${n}書類で出現)`);
  }
  if (entries.length > 20) {
    console.warn(`      ... 他 ${entries.length - 20}件`);
  }
  console.warn(
    '    これらは東証以外の取引所に単独上場している銘柄と考えられます\n' +
      '    (J-Quantsの銘柄マスタは東証データのため構造的に含まれません)。'
  );
  skippedCodes.delete(label);
}

/**
 * エラーメッセージから、契約プランが実際にカバーする開始日を取り出す。
 *
 * J-Quants APIは、契約プランのアクセス可能範囲外の日付をリクエストすると
 * 400エラーで以下の形式のメッセージを返す:
 *   "Your subscription covers the following dates: 2016-09-06 ~ . If you want more data, ..."
 * @param {string} message エラーメッセージ(HTTPエラー本文を含む)
 * @returns {string|null} 'YYYY-MM-DD'。パターンに一致しなければnull
 */
function parseSubscriptionCoverageStart(message) {
  const m = String(message || '').match(/covers the following dates:\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * 個別API呼出し方式(Tier4)のPhaseで、契約プランのアクセス可能範囲を踏まえた
 * 実際のループ開始日を求める。
 *
 * 【なぜ必要か】
 *   API仕様書に書かれている「データ提供開始日」は、そのエンドポイント自体が
 *   いつからデータを持っているかであって、契約プランのアクセス可能範囲とは別。
 *   Standardプランは「今日から遡って10年」のローリングウィンドウ(下限は日々前進する)
 *   のため、データ提供開始日がこのウィンドウより古いと、それより前の日付は
 *   恒久的にアクセス不可になる(ウィンドウの下限は前進する一方なので、時間が経っても
 *   対象日に追いつかれることは無い)。
 *
 *   ハードコードした年数(10年)で判定する方法も考えられるが、プラン変更
 *   (Premium=20年等)に追随できなくなるため、実際に1日分を問い合わせてみて
 *   エラーメッセージから真の開始日を検出する方式にした
 *   (2026-09-06、大株主状況(`edinet-major-shareholders`)の初回投入で
 *   データ提供開始日2016-06-01が400エラーになり発覚。仕様書のデータ提供開始日と
 *   実際にアクセス可能な範囲が食い違うケースがあることが分かった)。
 *
 *   大量保有報告書(Phase15)のデータ提供開始日(2021-07-01)は現時点(2026年)では
 *   ローリングウィンドウの範囲内のため今のところこの問題は起きないが、
 *   2031年以降は同じ問題が起き得る(ウィンドウの下限がいずれ2021-07-01を超えて
 *   前進するため)。Phase15は稼働中の完成済み機能のため、今回は変更を加えていない。
 *
 * @param {string} endpoint 例: '/edinet/major-shareholders'
 * @param {string} providedStartDate 仕様書のデータ提供開始日('YYYY-MM-DD')
 * @returns {Promise<string>} 実際にループを開始すべき日付('YYYY-MM-DD')
 */
async function resolveEdinetLoopStartDate(endpoint, providedStartDate) {
  try {
    await jquantsClient.fetchAllApiPages(endpoint, { date: providedStartDate });
    return providedStartDate;
  } catch (err) {
    const covered = parseSubscriptionCoverageStart(err.message);
    if (covered && covered > providedStartDate) {
      console.log(
        `  ※ 契約プランのアクセス可能範囲により開始日を ${providedStartDate} → ${covered} に調整します\n` +
          `     (${providedStartDate}〜${covered}の前日までは恒久的にアクセス不可のため対象から除外)`
      );
      return covered;
    }
    // プラン制約以外の理由(ネットワーク断・一時的な5xx等)であれば、ここでは握り潰さず
    // 元の開始日をそのまま返す。通常のループ内で同じ日付が再度処理され、
    // 本来のfailures集計(再実行で再処理される仕組み)に乗る。
    console.warn(`  ⚠ 開始日のプレフライト確認でエラーが発生しました(プラン制約以外の可能性): ${err.message}`);
    return providedStartDate;
  }
}

/**
 * 指定日の大株主状況を取得し、DBへ反映する(Phase15のprocessEdinetDateと同型)。
 * @param {string} date 'YYYY-MM-DD'
 * @param {Set<string>} knownCodes EQUITY_MASTERに存在する銘柄コードの集合
 * @returns {Promise<{skipped: boolean, docCount: number}>}
 */
async function processEdinetMajorShareholderDate(date, knownCodes) {
  const alreadyDone = await db.withConnection(async (connection) => {
    const status = await db.getProgressStatus(connection, ENDPOINT_EDINET_MAJOR_SHAREHOLDER, date);
    return status === 'SUCCESS';
  });
  if (alreadyDone) {
    return { skipped: true, docCount: 0 };
  }

  const rawDocs = await jquantsClient.fetchAllApiPages(ENDPOINT_EDINET_MAJOR_SHAREHOLDER, { date });

  const docRows = [];
  const docIds = [];
  const holderRows = [];

  for (const doc of rawDocs) {
    const code = doc.Code === undefined || doc.Code === null ? null : String(doc.Code).trim();
    if (code !== null && !knownCodes.has(code)) {
      const label = 'EDINET_MAJOR_SHAREHOLDER';
      if (!skippedCodes.has(label)) {
        skippedCodes.set(label, new Map());
      }
      const tally = skippedCodes.get(label);
      tally.set(code, (tally.get(code) || 0) + 1);
      continue;
    }

    const mapped = edinetMapper.mapMajorShareholderDoc(doc);
    docRows.push(mapped.docRow);
    docIds.push(mapped.docRow[0]); // MAJOR_SHAREHOLDER_DOC_COLUMNSの先頭がdoc_id
    holderRows.push(...mapped.holderRows);
  }

  return db.withConnection(async (connection) => {
    await db.markProgressStarted(connection, ENDPOINT_EDINET_MAJOR_SHAREHOLDER, date);
    await connection.commit();

    try {
      // doc_id単位の事前DELETE(理由はprocessEdinetDateのコメント参照。
      // 同一書類が別日付クエリでも稀に再度返ってくるケースへの対処。
      // 大量保有報告書で11日分発生したのと同じ問題が起こり得る前提で最初から入れておく)。
      if (docIds.length > 0) {
        await connection.executeMany(
          `DELETE FROM edinet_major_shareholder WHERE doc_id = :docId`,
          docIds.map((docId) => ({ docId }))
        );
      }

      // 親をDELETEすればON DELETE CASCADEで子テーブルも連動して消える
      await connection.execute(
        `DELETE FROM edinet_major_shareholder WHERE sub_date = TO_DATE(:targetDate, 'YYYY-MM-DD')`,
        { targetDate: date }
      );

      await db.bulkInsert(
        connection,
        'edinet_major_shareholder',
        edinetMapper.MAJOR_SHAREHOLDER_DOC_COLUMNS,
        docRows,
        {
          valueExpressions: edinetMapper.MAJOR_SHAREHOLDER_DOC_VALUE_EXPRESSIONS,
          bindDefs: edinetMapper.MAJOR_SHAREHOLDER_DOC_BIND_DEFS,
        }
      );
      await db.bulkInsert(
        connection,
        'edinet_major_shareholder_holder',
        edinetMapper.MAJOR_SHAREHOLDER_HOLDER_COLUMNS,
        holderRows,
        {
          valueExpressions: edinetMapper.MAJOR_SHAREHOLDER_HOLDER_VALUE_EXPRESSIONS,
          bindDefs: edinetMapper.MAJOR_SHAREHOLDER_HOLDER_BIND_DEFS,
        }
      );

      await db.markProgressSuccess(connection, ENDPOINT_EDINET_MAJOR_SHAREHOLDER, date, docRows.length);
      await connection.commit();
      return { skipped: false, docCount: docRows.length };
    } catch (err) {
      await connection.rollback().catch(() => {});
      await db.markProgressFailed(connection, ENDPOINT_EDINET_MAJOR_SHAREHOLDER, date, err.message);
      await connection.commit().catch(() => {});
      throw err;
    }
  });
}

/**
 * Phase 16: 大株主状況(EDINET)
 *
 * 2016-06-01(データ提供開始日)から本日まで、平日単位でループしてAPIを呼ぶ。
 * Phase15と同じ考え方(1日ごとにLOAD_PROGRESSへ記録、1日の失敗は他日を止めない)。
 */
async function loadEdinetMajorShareholders() {
  console.log('=== Phase 16: 大株主状況(EDINET)の取り込み ===');

  const today = formatDateStr(new Date());
  const startDate = await resolveEdinetLoopStartDate(ENDPOINT_EDINET_MAJOR_SHAREHOLDER, EDINET_MAJOR_SHAREHOLDER_START_DATE);
  const dates = businessDaysBetween(startDate, today);
  console.log(`対象日数: ${dates.length}日 (${startDate} 〜 ${today}、土日を除く平日単位)`);

  const knownCodes = await db.withConnection((connection) => loadKnownEquityCodes(connection));

  csvMapper.resetTruncationCount();

  let totalDocs = 0;
  let processedDays = 0;
  let skippedDays = 0;
  const failures = [];

  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} `);
    try {
      const { skipped, docCount } = await processEdinetMajorShareholderDate(date, knownCodes);
      if (skipped) {
        skippedDays += 1;
        console.log('[SKIP] (取り込み済み)');
      } else {
        processedDays += 1;
        totalDocs += docCount;
        console.log(`[OK] ${docCount}件`);
      }
    } catch (err) {
      console.error(`[FAIL] ${err.message}`);
      failures.push({ date, message: err.message });
    }
    await jquantsClient.apiThrottle();
  }

  console.log(
    `Phase 16 完了: 処理 ${processedDays}日 / スキップ(取り込み済み) ${skippedDays}日 / ` +
      `失敗 ${failures.length}日 / 合計 ${totalDocs.toLocaleString()}件の書類\n`
  );

  reportSkippedEdinetDocCodes('EDINET_MAJOR_SHAREHOLDER', '大株主状況');

  const truncated = csvMapper.getTruncationCount();
  if (truncated > 0) {
    console.log(
      `  ※ 長すぎるテキストを ${truncated.toLocaleString()} 件切り詰めました(末尾に「…」が付きます)。\n` +
        '     氏名・住所等の自由記述のみが対象です。\n'
    );
  }

  if (failures.length > 0) {
    console.warn(`  ⚠ ${failures.length}日で失敗しました。再実行すると失敗分だけ再処理されます:`);
    for (const f of failures.slice(0, 20)) {
      console.warn(`      ${f.date}: ${f.message}`);
    }
    if (failures.length > 20) {
      console.warn(`      ... 他 ${failures.length - 20}件`);
    }
  }
}

//==================================================================
// 政策保有株式(EDINET) (Tier 4 続き)
//
// 大量保有報告書・大株主状況と同じ個別API基盤を使うが、レスポンス構造は
// 書類 → Report/Largest/SecondLargestの3スコープ → Spec/Deemの銘柄配列、
// という3階層のネストになっており、これまでで最も深い。テーブル設計・
// 理由の詳細はddl/16_edinet_cross_shareholdings.sql冒頭コメントを参照。
//==================================================================

/** データ提供期間の開始日(仕様書より: 提出日2020年3月31日以降) */
const EDINET_CROSS_SHAREHOLDING_START_DATE = '2020-03-31';

/**
 * 指定日の政策保有株式を取得し、DBへ反映する。
 * @param {string} date 'YYYY-MM-DD'
 * @param {Set<string>} knownCodes EQUITY_MASTERに存在する銘柄コードの集合
 * @returns {Promise<{skipped: boolean, docCount: number}>}
 */
async function processEdinetCrossShareholdingDate(date, knownCodes) {
  const alreadyDone = await db.withConnection(async (connection) => {
    const status = await db.getProgressStatus(connection, ENDPOINT_EDINET_CROSS_SHAREHOLDING, date);
    return status === 'SUCCESS';
  });
  if (alreadyDone) {
    return { skipped: true, docCount: 0 };
  }

  const rawDocs = await jquantsClient.fetchAllApiPages(ENDPOINT_EDINET_CROSS_SHAREHOLDING, { date });

  const docRows = [];
  const docIds = [];
  const holderRows = [];
  const stockRows = [];

  for (const doc of rawDocs) {
    const code = doc.Code === undefined || doc.Code === null ? null : String(doc.Code).trim();
    if (code !== null && !knownCodes.has(code)) {
      const label = 'EDINET_CROSS_SHAREHOLDING';
      if (!skippedCodes.has(label)) {
        skippedCodes.set(label, new Map());
      }
      const tally = skippedCodes.get(label);
      tally.set(code, (tally.get(code) || 0) + 1);
      continue;
    }

    const mapped = edinetMapper.mapCrossShareholdingDoc(doc);
    docRows.push(mapped.docRow);
    docIds.push(mapped.docRow[0]); // CROSS_SHAREHOLDING_DOC_COLUMNSの先頭がdoc_id
    holderRows.push(...mapped.holderRows);
    stockRows.push(...mapped.stockRows);
  }

  return db.withConnection(async (connection) => {
    await db.markProgressStarted(connection, ENDPOINT_EDINET_CROSS_SHAREHOLDING, date);
    await connection.commit();

    try {
      if (docIds.length > 0) {
        await connection.executeMany(
          `DELETE FROM edinet_cross_shareholding WHERE doc_id = :docId`,
          docIds.map((docId) => ({ docId }))
        );
      }

      await connection.execute(
        `DELETE FROM edinet_cross_shareholding WHERE sub_date = TO_DATE(:targetDate, 'YYYY-MM-DD')`,
        { targetDate: date }
      );

      await db.bulkInsert(
        connection,
        'edinet_cross_shareholding',
        edinetMapper.CROSS_SHAREHOLDING_DOC_COLUMNS,
        docRows,
        {
          valueExpressions: edinetMapper.CROSS_SHAREHOLDING_DOC_VALUE_EXPRESSIONS,
          bindDefs: edinetMapper.CROSS_SHAREHOLDING_DOC_BIND_DEFS,
        }
      );
      await db.bulkInsert(
        connection,
        'edinet_cross_shareholding_holder',
        edinetMapper.CROSS_SHAREHOLDING_HOLDER_COLUMNS,
        holderRows,
        {
          valueExpressions: edinetMapper.CROSS_SHAREHOLDING_HOLDER_VALUE_EXPRESSIONS,
          bindDefs: edinetMapper.CROSS_SHAREHOLDING_HOLDER_BIND_DEFS,
        }
      );
      await db.bulkInsert(
        connection,
        'edinet_cross_shareholding_stock',
        edinetMapper.CROSS_SHAREHOLDING_STOCK_COLUMNS,
        stockRows,
        {
          valueExpressions: edinetMapper.CROSS_SHAREHOLDING_STOCK_VALUE_EXPRESSIONS,
          bindDefs: edinetMapper.CROSS_SHAREHOLDING_STOCK_BIND_DEFS,
        }
      );

      await db.markProgressSuccess(connection, ENDPOINT_EDINET_CROSS_SHAREHOLDING, date, docRows.length);
      await connection.commit();
      return { skipped: false, docCount: docRows.length };
    } catch (err) {
      await connection.rollback().catch(() => {});
      await db.markProgressFailed(connection, ENDPOINT_EDINET_CROSS_SHAREHOLDING, date, err.message);
      await connection.commit().catch(() => {});
      throw err;
    }
  });
}

/**
 * Phase 17: 政策保有株式(EDINET)
 *
 * 2020-03-31(データ提供開始日)から本日まで、平日単位でループしてAPIを呼ぶ。
 */
async function loadEdinetCrossShareholdings() {
  console.log('=== Phase 17: 政策保有株式(EDINET)の取り込み ===');

  const today = formatDateStr(new Date());
  const startDate = await resolveEdinetLoopStartDate(ENDPOINT_EDINET_CROSS_SHAREHOLDING, EDINET_CROSS_SHAREHOLDING_START_DATE);
  const dates = businessDaysBetween(startDate, today);
  console.log(`対象日数: ${dates.length}日 (${startDate} 〜 ${today}、土日を除く平日単位)`);

  const knownCodes = await db.withConnection((connection) => loadKnownEquityCodes(connection));

  csvMapper.resetTruncationCount();

  let totalDocs = 0;
  let processedDays = 0;
  let skippedDays = 0;
  const failures = [];

  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} `);
    try {
      const { skipped, docCount } = await processEdinetCrossShareholdingDate(date, knownCodes);
      if (skipped) {
        skippedDays += 1;
        console.log('[SKIP] (取り込み済み)');
      } else {
        processedDays += 1;
        totalDocs += docCount;
        console.log(`[OK] ${docCount}件`);
      }
    } catch (err) {
      console.error(`[FAIL] ${err.message}`);
      failures.push({ date, message: err.message });
    }
    await jquantsClient.apiThrottle();
  }

  console.log(
    `Phase 17 完了: 処理 ${processedDays}日 / スキップ(取り込み済み) ${skippedDays}日 / ` +
      `失敗 ${failures.length}日 / 合計 ${totalDocs.toLocaleString()}件の書類\n`
  );

  reportSkippedEdinetDocCodes('EDINET_CROSS_SHAREHOLDING', '政策保有株式');

  const truncated = csvMapper.getTruncationCount();
  if (truncated > 0) {
    console.log(
      `  ※ 長すぎるテキストを ${truncated.toLocaleString()} 件切り詰めました(末尾に「…」が付きます)。\n` +
        '     保有目的等の自由記述のみが対象です。\n'
    );
  }

  if (failures.length > 0) {
    console.warn(`  ⚠ ${failures.length}日で失敗しました。再実行すると失敗分だけ再処理されます:`);
    for (const f of failures.slice(0, 20)) {
      console.warn(`      ${f.date}: ${f.message}`);
    }
    if (failures.length > 20) {
      console.warn(`      ... 他 ${failures.length - 20}件`);
    }
  }
}


//------------------------------------------------------------------
// フェーズの選択
//
// 既に株価まで取り込み済みの環境で空売り系だけを追加したい場合に、
// 3000件超のファイル一覧を走査し直さずに済むようにする。
//   node src/loadInitial.js --only short
//   node src/loadInitial.js --only short-ratio,margin-interest
//------------------------------------------------------------------
const PHASE_DEFS = [
  { key: 'master', run: () => loadMaster() },
  { key: 'delisted', run: () => updateDelistedFlag() },
  { key: 'price', run: () => loadPrice() },
  { key: 'short-ratio', run: () => loadShortRatio() },
  { key: 'margin-interest', run: () => loadMarginInterest() },
  { key: 'margin-alert', run: () => loadMarginAlert() },
  { key: 'short-position', run: () => loadShortPosition() },
  { key: 'trading-calendar', run: () => loadTradingCalendar() },
  { key: 'index-topix', run: () => loadIndexTopix() },
  { key: 'index-daily', run: () => loadIndexDaily() },
  { key: 'investor-types', run: () => loadInvestorTypes() },
  { key: 'earnings-date', run: () => loadEarningsSchedule() },
  { key: 'financial-summary', run: () => loadFinancialSummary() },
  { key: 'options-225', run: () => loadOption225() },
  { key: 'edinet-large-volume', run: () => loadLargeVolumeShareholders() },
  { key: 'edinet-major-shareholders', run: () => loadEdinetMajorShareholders() },
  { key: 'edinet-cross-shareholdings', run: () => loadEdinetCrossShareholdings() },
];

/** グループ名でまとめて指定できるようにする */
const PHASE_GROUPS = {
  all: PHASE_DEFS.map((p) => p.key),
  equity: ['master', 'delisted', 'price'],
  short: ['short-ratio', 'margin-interest', 'margin-alert', 'short-position'],
  indices: ['trading-calendar', 'index-topix', 'index-daily'],
  tier2: ['investor-types', 'earnings-date'],
  tier3: ['financial-summary', 'options-225'],
  tier4: ['edinet-large-volume', 'edinet-major-shareholders', 'edinet-cross-shareholdings'],
};

/**
 * --only の指定を、実行するフェーズキーの配列に解決する。
 * 指定が無ければ全フェーズ。
 * @param {string[]} argv
 * @returns {string[]}
 */
function resolvePhases(argv) {
  const idx = argv.indexOf('--only');
  if (idx < 0) return PHASE_GROUPS.all;

  const value = argv[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--only には実行するフェーズを指定してください(例: --only short)');
  }

  const requested = value.split(',').map((s) => s.trim()).filter(Boolean);
  const keys = [];
  for (const r of requested) {
    if (PHASE_GROUPS[r]) {
      keys.push(...PHASE_GROUPS[r]);
    } else if (PHASE_DEFS.some((p) => p.key === r)) {
      keys.push(r);
    } else {
      throw new Error(
        `不明なフェーズです: ${r}\n` +
          `  指定できる値: ${PHASE_DEFS.map((p) => p.key).join(', ')}\n` +
          `  グループ: ${Object.keys(PHASE_GROUPS).join(', ')}`
      );
    }
  }
  // PHASE_DEFS の並び順を保ったまま重複を除く(依存関係を崩さないため)
  return PHASE_DEFS.map((p) => p.key).filter((k) => keys.includes(k));
}


async function main() {
  const startedAt = Date.now();
  const phases = resolvePhases(process.argv.slice(2));

  console.log(`初回投入バッチを開始します (${new Date().toISOString()})`);
  console.log(`実行するフェーズ: ${phases.join(', ')}\n`);

  // 空売り系は EQUITY_MASTER への外部キーを持つため、マスタが未取込だと失敗する
  const shortOnly = phases.every((k) => PHASE_GROUPS.short.includes(k));
  if (shortOnly && phases.length > 0) {
    console.log(
      '※ 空売り・信用取引関連のみを実行します。これらは EQUITY_MASTER への\n' +
        '   外部キーを持つため、マスタ(master)が取り込み済みである必要があります。\n'
    );
  }

  for (const key of phases) {
    const def = PHASE_DEFS.find((p) => p.key === key);
    await def.run();
  }

  console.log(`初回投入バッチが完了しました (所要時間: ${formatDuration(Date.now() - startedAt)})`);
}

// テストスクリプト等からrequireされた場合は実行しない
if (require.main === module) {
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
}

module.exports = {
  ENDPOINT_MASTER,
  ENDPOINT_PRICE,
  MASTER_HANDLERS,
  PRICE_HANDLERS,
  sortFilesChronologically,
  processFile,
  loadMaster,
  loadPrice,
  updateDelistedFlag,

  // 空売り・信用取引関連
  ENDPOINT_SHORT_RATIO,
  ENDPOINT_MARGIN_INTEREST,
  ENDPOINT_MARGIN_ALERT,
  ENDPOINT_SHORT_POSITION,
  ENDPOINT_TRADING_CALENDAR,
  ENDPOINT_INDEX_TOPIX,
  ENDPOINT_INDEX_DAILY,
  SHORT_RATIO_HANDLERS,
  MARGIN_INTEREST_HANDLERS,
  MARGIN_ALERT_HANDLERS,
  SHORT_POSITION_HANDLERS,
  loadEndpoint,
  skipUnknownCodes,
  reportSkippedCodes,
  loadShortRatio,
  loadMarginInterest,
  loadMarginAlert,
  loadShortPosition,
  TRADING_CALENDAR_HANDLERS,
  INDEX_TOPIX_HANDLERS,
  INDEX_DAILY_HANDLERS,
  loadTradingCalendar,
  loadIndexTopix,
  loadIndexDaily,
  ENDPOINT_INVESTOR_TYPES,
  ENDPOINT_EARNINGS_DATE,
  INVESTOR_TYPES_HANDLERS,
  EARNINGS_SCHEDULE_HANDLERS,
  ENDPOINT_FINANCIAL_SUMMARY,
  ENDPOINT_OPTION_225,
  FINANCIAL_SUMMARY_HANDLERS,
  OPTION_225_HANDLERS,
  loadInvestorTypes,
  loadEarningsSchedule,
  ENDPOINT_EDINET_LARGE_VOLUME,
  EDINET_LARGE_VOLUME_START_DATE,
  formatDateStr,
  businessDaysBetween,
  loadKnownEquityCodes,
  processEdinetDate,
  loadLargeVolumeShareholders,
  ENDPOINT_EDINET_MAJOR_SHAREHOLDER,
  EDINET_MAJOR_SHAREHOLDER_START_DATE,
  processEdinetMajorShareholderDate,
  loadEdinetMajorShareholders,
  ENDPOINT_EDINET_CROSS_SHAREHOLDING,
  EDINET_CROSS_SHAREHOLDING_START_DATE,
  processEdinetCrossShareholdingDate,
  loadEdinetCrossShareholdings,
  reportSkippedEdinetDocCodes,
  parseSubscriptionCoverageStart,
  resolveEdinetLoopStartDate,
  PHASE_DEFS,
  PHASE_GROUPS,
  resolvePhases,
};
