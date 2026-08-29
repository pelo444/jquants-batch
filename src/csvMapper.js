'use strict';

const oracledb = require('oracledb');

//------------------------------------------------------------------
// 値変換ヘルパー
//------------------------------------------------------------------

/**
 * 空文字・空白のみ・'-' をNULLとして扱い、それ以外は文字列として返す。
 * ※ ScaleCat には '-' が入るケースが実データで確認されているが、
 *    これは「規模区分なし」を意味する有効な値のため、そのまま保持する。
 *    このヘルパーで '-' をNULL化するのは数値列のみ(toNum)とする。
 * @param {string|undefined} v
 * @returns {string|null}
 */
function toStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * 数値に変換する。空文字や数値化できない値はNULLを返す。
 * (取引が無かった日の出来高などが空文字で来るケースに備える)
 * @param {string|undefined} v
 * @returns {number|null}
 */
function toNum(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * 'YYYY-MM-DD' 形式の日付文字列をそのまま返す(不正ならnull)。
 * JSのDateには変換せず、SQL側のTO_DATEで変換させることで
 * タイムゾーンによる日付ズレを防ぐ。
 * @param {string|undefined} v
 * @returns {string|null}
 */
function toDateStr(v) {
  const s = toStr(v);
  if (s === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

//------------------------------------------------------------------
// EQUITY_MASTER_STG
//------------------------------------------------------------------

/** ステージングテーブルの列順(rowsの並びと一致させること) */
const MASTER_COLUMNS = [
  'code',
  'as_of_date',
  'co_name',
  'co_name_en',
  'sector17_code',
  'sector17_name',
  'sector33_code',
  'sector33_name',
  'scale_category',
  'market_code',
  'market_name',
  'margin_code',
  'margin_name',
  'prod_category',
];

/** as_of_dateのみTO_DATEで変換する */
const MASTER_VALUE_EXPRESSIONS = [
  null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null, null, null, null, null, null, null, null, null,
];

/**
 * NULLを含む列でも型が確定するようbindDefsを明示する。
 *
 * maxSize はバイト単位。DDL側は VARCHAR2(n CHAR)(文字数指定)なので、
 * UTF-8の日本語が1文字最大4バイトになることを考慮し、文字数×4 を確保する。
 * (ETF等に非常に長い銘柄名が存在するため、余裕を持たせている)
 */
const MASTER_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 40 },                   // code
  { type: oracledb.STRING, maxSize: 10 },                   // as_of_date (TO_DATEに渡す文字列)
  { type: oracledb.STRING, maxSize: 2000, maxChars: 500 },  // co_name       (500 CHAR)
  { type: oracledb.STRING, maxSize: 2000, maxChars: 500 },  // co_name_en    (500 CHAR)
  { type: oracledb.STRING, maxSize: 40,   maxChars: 10 },   // sector17_code (10 CHAR)
  { type: oracledb.STRING, maxSize: 400,  maxChars: 100 },  // sector17_name (100 CHAR)
  { type: oracledb.STRING, maxSize: 40,   maxChars: 10 },   // sector33_code (10 CHAR)
  { type: oracledb.STRING, maxSize: 400,  maxChars: 100 },  // sector33_name (100 CHAR)
  { type: oracledb.STRING, maxSize: 400,  maxChars: 100 },  // scale_category(100 CHAR)
  { type: oracledb.STRING, maxSize: 40,   maxChars: 10 },   // market_code   (10 CHAR)
  { type: oracledb.STRING, maxSize: 400,  maxChars: 100 },  // market_name   (100 CHAR)
  { type: oracledb.STRING, maxSize: 40,   maxChars: 10 },   // margin_code   (10 CHAR)
  { type: oracledb.STRING, maxSize: 400,  maxChars: 100 },  // margin_name   (100 CHAR)
  { type: oracledb.STRING, maxSize: 80,   maxChars: 20 },   // prod_category (20 CHAR)
];

/**
 * bindDefsの上限を超える値が含まれていないか事前検査する。
 *
 * executeManyが投げる NJS-058 は「何行目の何バイト」しか分からず、
 * どの列でどんな値が原因なのか特定しづらいため、投入前に列名と実値を添えて報告する。
 *
 * 【maxSize(バイト)と maxChars(文字)の両方を見る理由】
 *   DDLの VARCHAR2(n CHAR) は「n文字以内」かつ「4000バイト以内」の両方を課す。
 *   maxSize(バイト)だけを見ていると、例えば VARCHAR2(1000 CHAR) の列に
 *   ASCII 1200文字(=1200バイト)を入れようとした場合にこの検査を通過してしまい、
 *   INSERT時に ORA-12899 になる。バイト数と文字数は別々に検査する必要がある。
 *   maxChars は oracledb が無視するプロパティなのでbindDefsに入れても害はない。
 *
 * @param {any[][]} rows
 * @param {string[]} columns
 * @param {object[]} bindDefs
 * @throws {Error} 超過した値があった場合
 */
function validateLengths(rows, columns, bindDefs) {
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < bindDefs.length; c += 1) {
      const def = bindDefs[c];
      if (!def || def.type !== oracledb.STRING || !def.maxSize) continue;
      const v = row[c];
      if (v === null || v === undefined) continue;
      const text = String(v);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > def.maxSize) {
        throw new Error(
          `列 ${columns[c]} の値が上限(${def.maxSize}バイト)を超えています: ` +
            `${bytes}バイト / ${text.length}文字\n` +
            `  該当行(${r + 1}行目)の値: ${text.slice(0, 120)}` +
            `${text.length > 120 ? '…' : ''}\n` +
            '  csvMapper.js の bindDefs と、DDLのカラム定義の両方を広げてください。'
        );
      }
      if (def.maxChars && text.length > def.maxChars) {
        throw new Error(
          `列 ${columns[c]} の値が上限(${def.maxChars}文字)を超えています: ` +
            `${text.length}文字 / ${bytes}バイト\n` +
            `  該当行(${r + 1}行目)の値: ${text.slice(0, 120)}` +
            `${text.length > 120 ? '…' : ''}\n` +
            '  DDLが VARCHAR2(n CHAR) のため、バイト数とは別に文字数の上限があります。\n' +
            '  csvMapper.js の bindDefs(maxChars) と、DDLのカラム定義の両方を広げてください。'
        );
      }
    }
  }
}

/**
 * 銘柄マスタCSVの1行を、EQUITY_MASTER_STG投入用の配列に変換する。
 * CSVヘッダー: Date,Code,CoName,CoNameEn,S17,S17Nm,S33,S33Nm,ScaleCat,Mkt,MktNm,Mrgn,MrgnNm,ProdCat
 * @param {Record<string,string>} row
 * @returns {any[]}
 */
function mapMasterRow(row) {
  return [
    toStr(row.Code),
    toDateStr(row.Date),
    toStr(row.CoName),
    toStr(row.CoNameEn),
    toStr(row.S17),
    toStr(row.S17Nm),
    toStr(row.S33),
    toStr(row.S33Nm),
    toStr(row.ScaleCat),
    toStr(row.Mkt),
    toStr(row.MktNm),
    toStr(row.Mrgn),
    toStr(row.MrgnNm),
    toStr(row.ProdCat),
  ];
}

//------------------------------------------------------------------
// EQUITY_PRICE_DAILY_STG
//------------------------------------------------------------------

const PRICE_COLUMNS = [
  'code',
  'price_date',
  'open_price',
  'high_price',
  'low_price',
  'close_price',
  'upper_limit',
  'lower_limit',
  'volume',
  'turnover_value',
  'adj_factor',
];

const PRICE_VALUE_EXPRESSIONS = [
  null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null, null, null, null, null, null,
];

const PRICE_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 }, // code
  { type: oracledb.STRING, maxSize: 10 }, // price_date
  { type: oracledb.NUMBER },              // open_price
  { type: oracledb.NUMBER },              // high_price
  { type: oracledb.NUMBER },              // low_price
  { type: oracledb.NUMBER },              // close_price
  { type: oracledb.NUMBER },              // upper_limit
  { type: oracledb.NUMBER },              // lower_limit
  { type: oracledb.NUMBER },              // volume
  { type: oracledb.NUMBER },              // turnover_value
  { type: oracledb.NUMBER },              // adj_factor
];

/**
 * 株価四本値CSVの1行を、EQUITY_PRICE_DAILY_STG投入用の配列に変換する。
 * CSVヘッダー: Date,Code,O,H,L,C,UL,LL,Vo,Va,AdjFactor
 * @param {Record<string,string>} row
 * @returns {any[]}
 */
function mapPriceRow(row) {
  return [
    toStr(row.Code),
    toDateStr(row.Date),
    toNum(row.O),
    toNum(row.H),
    toNum(row.L),
    toNum(row.C),
    toNum(row.UL),
    toNum(row.LL),
    toNum(row.Vo),
    toNum(row.Va),
    toNum(row.AdjFactor),
  ];
}

//==================================================================
// 空売り・信用取引関連
//
// 【CSVヘッダー名について】
//   CSVヘッダーは2026-08-29に実ファイル(scripts/inspect-bulk-csv.js)で確認済み。
//   いずれもAPIレスポンスのフィールド名と同一だった。
//
//   ただし以下2点はドキュメントから読み取れない実データ上の挙動があった:
//     ・margin-alert の PubReason は6列に展開されず、Python辞書形式の文字列が
//       入った1列として来る → parsePubReason() で展開する
//     ・short-sale-report の空欄は空文字ではなく '-' で来る
//       → toStrDashNull() でNULLに正規化する
//
//   pick() で候補名を複数試す形は残してある。J-Quants側の変更で列名が
//   変わっても気づけるよう、まず inspect-bulk-csv.js で再確認すること。
//==================================================================

/**
 * CSVの列名がドキュメントと異なる可能性に備え、候補名を順に試して最初に
 * 見つかった値を返す。どれも無ければ undefined。
 * @param {Record<string,string>} row
 * @param {...string} names
 * @returns {string|undefined}
 */
function pick(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
  }
  return undefined;
}

/**
 * 数値に変換する。toNum に加えて '*' もNULLとして扱う。
 *
 * 日々公表信用取引残高では、前日に公表されていない銘柄の前日比が「-」、
 * ETFの上場比が「*」で返る。どちらも「値が無い」であってゼロではないため
 * NULLにする。
 * @param {string|undefined} v
 * @returns {number|null}
 */
function toNumRelaxed(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '*' || s === '－' || s === '＊') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

/**
 * '0'/'1' のフラグを1文字に正規化する。想定外の値はそのまま1文字目を返す。
 * @param {string|undefined} v
 * @returns {string|null}
 */
function toFlag(v) {
  const s = toStr(v);
  return s === null ? null : s.slice(0, 1);
}

/**
 * 空欄を '-' で表現しているCSV項目をNULLに正規化する。
 *
 * 空売り残高報告では、値が無い項目が空文字ではなく '-' で来る
 * (SSAddr / DICName / DICAddr / FundName / Notes で実データを確認)。
 * 既定の toStr() は '-' を意味のある値として保持する仕様(銘柄マスタの
 * ScaleCat が '-' を「規模区分なし」として使うため)なので、
 * こちらのデータには使えない。
 *
 * @param {string|undefined} v
 * @returns {string|null}
 */
function toStrDashNull(v) {
  const s = toStr(v);
  return s === null || s === '-' ? null : s;
}

/**
 * 日々公表信用取引残高の PubReason を展開する。
 *
 * CSVでは6項目がフラットな列に展開されるのではなく、1列にPython辞書形式の
 * 文字列がそのまま入っている(2026-08-29に実ファイルで確認):
 *   {'Restricted': '0', 'DailyPublication': '0', 'Monitoring': '0', ...}
 *
 * シングルクォートのためJSONとしては解釈できない。将来ダブルクォートの
 * 正しいJSONに変わる可能性もあるので、まずJSON.parseを試し、
 * 失敗したら正規表現でキーと値を拾う。
 *
 * @param {string|undefined} raw
 * @returns {Record<string,string>} 展開後のキー・値(解釈できなければ空オブジェクト)
 */
function parsePubReason(raw) {
  if (raw === undefined || raw === null) return {};
  const s = String(raw).trim();
  if (s === '' || s === '-') return {};

  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (err) {
    // Python辞書形式(シングルクォート)なのでJSONとしては解釈できない。下でフォールバックする。
  }

  // 'キー': '値' / "キー": "値" / キー: 値 のいずれにも対応する
  const out = {};
  const re = /['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*['"]?([^'",}\s]*)['"]?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

//------------------------------------------------------------------
// SECTOR_SHORT_RATIO_STG (業種別空売り比率)
// CSVヘッダー(想定): Date,S33,SellExShortVa,ShrtWithResVa,ShrtNoResVa
//------------------------------------------------------------------
const SHORT_RATIO_COLUMNS = [
  's33_code',
  'ratio_date',
  'sell_ex_short_va',
  'shrt_with_res_va',
  'shrt_no_res_va',
];

const SHORT_RATIO_VALUE_EXPRESSIONS = [
  null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null,
];

const SHORT_RATIO_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // s33_code
  { type: oracledb.STRING, maxSize: 10 }, // ratio_date
  { type: oracledb.NUMBER },              // sell_ex_short_va
  { type: oracledb.NUMBER },              // shrt_with_res_va
  { type: oracledb.NUMBER },              // shrt_no_res_va
];

function mapShortRatioRow(row) {
  return [
    toStr(pick(row, 'S33')),
    toDateStr(pick(row, 'Date')),
    toNumRelaxed(pick(row, 'SellExShortVa')),
    toNumRelaxed(pick(row, 'ShrtWithResVa')),
    toNumRelaxed(pick(row, 'ShrtNoResVa')),
  ];
}

//------------------------------------------------------------------
// EQUITY_MARGIN_INTEREST_STG (信用取引残高)
// CSVヘッダー(想定): Date,Code,IssType,ShrtVol,LongVol,ShrtNegVol,LongNegVol,
//                    ShrtStdVol,LongStdVol,ShrtVal,LongVal,ShrtNegVal,
//                    LongNegVal,ShrtStdVal,LongStdVal
//
// 金額6項目(*_Val)は2026年9月25日申込分以降のみ提供される。
// それ以前はキー自体が無いか null のため、いずれの場合もNULLになる。
//------------------------------------------------------------------
const MARGIN_INTEREST_COLUMNS = [
  'code',
  'app_date',
  'iss_type',
  'shrt_vol',
  'long_vol',
  'shrt_neg_vol',
  'long_neg_vol',
  'shrt_std_vol',
  'long_std_vol',
  'shrt_val',
  'long_val',
  'shrt_neg_val',
  'long_neg_val',
  'shrt_std_val',
  'long_std_val',
];

const MARGIN_INTEREST_VALUE_EXPRESSIONS = [
  null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null, null, null, null, null, null, null, null, null, null,
];

const MARGIN_INTEREST_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 }, // code
  { type: oracledb.STRING, maxSize: 10 }, // app_date
  { type: oracledb.STRING, maxSize: 8, maxChars: 2 },  // iss_type
  { type: oracledb.NUMBER },              // shrt_vol
  { type: oracledb.NUMBER },              // long_vol
  { type: oracledb.NUMBER },              // shrt_neg_vol
  { type: oracledb.NUMBER },              // long_neg_vol
  { type: oracledb.NUMBER },              // shrt_std_vol
  { type: oracledb.NUMBER },              // long_std_vol
  { type: oracledb.NUMBER },              // shrt_val
  { type: oracledb.NUMBER },              // long_val
  { type: oracledb.NUMBER },              // shrt_neg_val
  { type: oracledb.NUMBER },              // long_neg_val
  { type: oracledb.NUMBER },              // shrt_std_val
  { type: oracledb.NUMBER },              // long_std_val
];

function mapMarginInterestRow(row) {
  return [
    toStr(pick(row, 'Code')),
    toDateStr(pick(row, 'Date')),
    toStr(pick(row, 'IssType')),
    toNumRelaxed(pick(row, 'ShrtVol')),
    toNumRelaxed(pick(row, 'LongVol')),
    toNumRelaxed(pick(row, 'ShrtNegVol')),
    toNumRelaxed(pick(row, 'LongNegVol')),
    toNumRelaxed(pick(row, 'ShrtStdVol')),
    toNumRelaxed(pick(row, 'LongStdVol')),
    toNumRelaxed(pick(row, 'ShrtVal')),
    toNumRelaxed(pick(row, 'LongVal')),
    toNumRelaxed(pick(row, 'ShrtNegVal')),
    toNumRelaxed(pick(row, 'LongNegVal')),
    toNumRelaxed(pick(row, 'ShrtStdVal')),
    toNumRelaxed(pick(row, 'LongStdVal')),
  ];
}

//------------------------------------------------------------------
// EQUITY_MARGIN_ALERT_STG (日々公表信用取引残高)
//
// PubReason はAPIでは入れ子オブジェクト。CSVでの展開名が仕様書に無いため、
// 'PubReason.Restricted' / 'PubReasonRestricted' / 'Restricted' の3通りを試す。
//------------------------------------------------------------------
const MARGIN_ALERT_COLUMNS = [
  'code',
  'app_date',
  'pub_date',
  'reason_restricted',
  'reason_daily_publication',
  'reason_monitoring',
  'reason_restricted_by_jsf',
  'reason_precaution_by_jsf',
  'reason_unclear_or_sec_alert',
  'shrt_out',
  'shrt_out_chg',
  'shrt_out_ratio',
  'long_out',
  'long_out_chg',
  'long_out_ratio',
  'sl_ratio',
  'shrt_neg_out',
  'shrt_neg_out_chg',
  'shrt_std_out',
  'shrt_std_out_chg',
  'long_neg_out',
  'long_neg_out_chg',
  'long_std_out',
  'long_std_out_chg',
  'tse_mrgn_reg_cls',
];

const MARGIN_ALERT_VALUE_EXPRESSIONS = [
  null,
  "TO_DATE(?, 'YYYY-MM-DD')", // app_date
  "TO_DATE(?, 'YYYY-MM-DD')", // pub_date
  null, null, null, null, null, null,
  null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null,
];

const MARGIN_ALERT_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 }, // code
  { type: oracledb.STRING, maxSize: 10 }, // app_date
  { type: oracledb.STRING, maxSize: 10 }, // pub_date
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // reason_restricted
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // reason_daily_publication
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // reason_monitoring
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // reason_restricted_by_jsf
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // reason_precaution_by_jsf
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // reason_unclear_or_sec_alert
  { type: oracledb.NUMBER },              // shrt_out
  { type: oracledb.NUMBER },              // shrt_out_chg
  { type: oracledb.NUMBER },              // shrt_out_ratio
  { type: oracledb.NUMBER },              // long_out
  { type: oracledb.NUMBER },              // long_out_chg
  { type: oracledb.NUMBER },              // long_out_ratio
  { type: oracledb.NUMBER },              // sl_ratio
  { type: oracledb.NUMBER },              // shrt_neg_out
  { type: oracledb.NUMBER },              // shrt_neg_out_chg
  { type: oracledb.NUMBER },              // shrt_std_out
  { type: oracledb.NUMBER },              // shrt_std_out_chg
  { type: oracledb.NUMBER },              // long_neg_out
  { type: oracledb.NUMBER },              // long_neg_out_chg
  { type: oracledb.NUMBER },              // long_std_out
  { type: oracledb.NUMBER },              // long_std_out_chg
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // tse_mrgn_reg_cls
];

function mapMarginAlertRow(row) {
  // CSVでは PubReason は辞書形式の文字列が入った1列。まず展開する。
  const parsed = parsePubReason(pick(row, 'PubReason'));

  // 将来フラットな列に変わった場合にも動くよう、展開できなければ列名も探す
  const reason = (key) =>
    toFlag(
      parsed[key] !== undefined
        ? parsed[key]
        : pick(row, `PubReason.${key}`, `PubReason_${key}`, `PubReason${key}`, key)
    );

  return [
    toStr(pick(row, 'Code')),
    toDateStr(pick(row, 'AppDate')),
    toDateStr(pick(row, 'PubDate')),
    reason('Restricted'),
    reason('DailyPublication'),
    reason('Monitoring'),
    reason('RestrictedByJSF'),
    reason('PrecautionByJSF'),
    reason('UnclearOrSecOnAlert'),
    toNumRelaxed(pick(row, 'ShrtOut')),
    toNumRelaxed(pick(row, 'ShrtOutChg')),
    toNumRelaxed(pick(row, 'ShrtOutRatio')),
    toNumRelaxed(pick(row, 'LongOut')),
    toNumRelaxed(pick(row, 'LongOutChg')),
    toNumRelaxed(pick(row, 'LongOutRatio')),
    toNumRelaxed(pick(row, 'SLRatio')),
    toNumRelaxed(pick(row, 'ShrtNegOut')),
    toNumRelaxed(pick(row, 'ShrtNegOutChg')),
    toNumRelaxed(pick(row, 'ShrtStdOut')),
    toNumRelaxed(pick(row, 'ShrtStdOutChg')),
    toNumRelaxed(pick(row, 'LongNegOut')),
    toNumRelaxed(pick(row, 'LongNegOutChg')),
    toNumRelaxed(pick(row, 'LongStdOut')),
    toNumRelaxed(pick(row, 'LongStdOutChg')),
    toStr(pick(row, 'TSEMrgnRegCls')),
  ];
}

//------------------------------------------------------------------
// EQUITY_SHORT_POSITION_STG (空売り残高報告)
// CSVヘッダー(想定): DiscDate,CalcDate,Code,SSName,SSAddr,DICName,DICAddr,
//                    FundName,ShrtPosToSO,ShrtPosShares,ShrtPosUnits,
//                    PrevRptDate,PrevRptRatio,Notes
//------------------------------------------------------------------
const SHORT_POSITION_COLUMNS = [
  'disc_date',
  'calc_date',
  'code',
  'ss_name',
  'ss_addr',
  'dic_name',
  'dic_addr',
  'fund_name',
  'shrt_pos_to_so',
  'shrt_pos_shares',
  'shrt_pos_units',
  'prev_rpt_date',
  'prev_rpt_ratio',
  'notes',
];

const SHORT_POSITION_VALUE_EXPRESSIONS = [
  "TO_DATE(?, 'YYYY-MM-DD')", // disc_date
  "TO_DATE(?, 'YYYY-MM-DD')", // calc_date
  null, null, null, null, null, null, null, null, null,
  "TO_DATE(?, 'YYYY-MM-DD')", // prev_rpt_date
  null, null,
];

// 名称・住所・備考は VARCHAR2(1000 CHAR)。
// 「1000文字以内」かつ「4000バイト以内」の両方を課すため maxChars も指定する。
const SHORT_POSITION_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 },   // disc_date
  { type: oracledb.STRING, maxSize: 10 },   // calc_date
  { type: oracledb.STRING, maxSize: 10 },   // code
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // ss_name
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // ss_addr
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // dic_name
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // dic_addr
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // fund_name
  { type: oracledb.NUMBER },                // shrt_pos_to_so
  { type: oracledb.NUMBER },                // shrt_pos_shares
  { type: oracledb.NUMBER },                // shrt_pos_units
  { type: oracledb.STRING, maxSize: 10 },   // prev_rpt_date
  { type: oracledb.NUMBER },                // prev_rpt_ratio
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // notes
];

function mapShortPositionRow(row) {
  return [
    toDateStr(pick(row, 'DiscDate')),
    toDateStr(pick(row, 'CalcDate')),
    toStr(pick(row, 'Code')),
    // 値が無い項目は空文字ではなく '-' で来るため toStrDashNull を使う
    toStrDashNull(pick(row, 'SSName')),
    toStrDashNull(pick(row, 'SSAddr')),
    toStrDashNull(pick(row, 'DICName')),
    toStrDashNull(pick(row, 'DICAddr')),
    toStrDashNull(pick(row, 'FundName')),
    toNumRelaxed(pick(row, 'ShrtPosToSO')),
    toNumRelaxed(pick(row, 'ShrtPosShares')),
    toNumRelaxed(pick(row, 'ShrtPosUnits')),
    toDateStr(pick(row, 'PrevRptDate')),
    toNumRelaxed(pick(row, 'PrevRptRatio')),
    toStrDashNull(pick(row, 'Notes')),
  ];
}


module.exports = {
  toStr,
  validateLengths,
  toNum,
  toDateStr,
  MASTER_COLUMNS,
  MASTER_VALUE_EXPRESSIONS,
  MASTER_BIND_DEFS,
  mapMasterRow,
  PRICE_COLUMNS,
  PRICE_VALUE_EXPRESSIONS,
  PRICE_BIND_DEFS,
  mapPriceRow,

  // 空売り・信用取引関連
  pick,
  toNumRelaxed,
  toFlag,
  toStrDashNull,
  parsePubReason,
  SHORT_RATIO_COLUMNS,
  SHORT_RATIO_VALUE_EXPRESSIONS,
  SHORT_RATIO_BIND_DEFS,
  mapShortRatioRow,
  MARGIN_INTEREST_COLUMNS,
  MARGIN_INTEREST_VALUE_EXPRESSIONS,
  MARGIN_INTEREST_BIND_DEFS,
  mapMarginInterestRow,
  MARGIN_ALERT_COLUMNS,
  MARGIN_ALERT_VALUE_EXPRESSIONS,
  MARGIN_ALERT_BIND_DEFS,
  mapMarginAlertRow,
  SHORT_POSITION_COLUMNS,
  SHORT_POSITION_VALUE_EXPRESSIONS,
  SHORT_POSITION_BIND_DEFS,
  mapShortPositionRow,
};
