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
 *
 * Phase 4〜7 は Standardプラン以上でのみ利用できる。
 * Phase 5〜7 は EQUITY_MASTER への外部キーを持つためマスタの後に実行する。
 *
 * 【一部のフェーズだけ実行する】
 *   既に株価まで取り込み済みの環境に空売り系を追加する場合は --only が使える。
 *     node src/loadInitial.js --only short          (Phase 4〜7)
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

const ENDPOINT_MASTER = '/equities/master';
const ENDPOINT_PRICE = '/equities/bars/daily';

// 空売り・信用取引関連(いずれもStandardプラン以上)
const ENDPOINT_SHORT_RATIO = '/markets/short-ratio';        // 業種別空売り比率
const ENDPOINT_MARGIN_INTEREST = '/markets/margin-interest'; // 信用取引残高
const ENDPOINT_MARGIN_ALERT = '/markets/margin-alert';       // 日々公表信用取引残高
const ENDPOINT_SHORT_POSITION = '/markets/short-sale-report'; // 空売り残高報告

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
];

/** グループ名でまとめて指定できるようにする */
const PHASE_GROUPS = {
  all: PHASE_DEFS.map((p) => p.key),
  equity: ['master', 'delisted', 'price'],
  short: ['short-ratio', 'margin-interest', 'margin-alert', 'short-position'],
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
  PHASE_DEFS,
  PHASE_GROUPS,
  resolvePhases,
};
