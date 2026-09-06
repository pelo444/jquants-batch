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
 * 連続する空白を1つの半角スペースにまとめ、前後の空白を落とす。
 *
 * 空売り残高報告の Notes には、金融庁提出様式の桁揃えのための空白が
 * そのまま入っている。2021年4月の訂正報告では
 *   本文123文字 + 空白950文字 = 1073文字
 * となっており、中身は短いのに桁だけが膨らんでいた。
 * 空白を詰めるだけで実用上ほぼすべてが規定長に収まる。
 *
 * 商号・住所についても、桁揃えの空白が入ると同じ報告者が別名として
 * 集計されてしまうため、同様に正規化する。
 *
 * @param {string} s
 * @returns {string}
 */
function squashSpaces(s) {
  return s.replace(/[\s　]+/g, ' ').trim();
}

//------------------------------------------------------------------
// 長大テキストの切り詰め
//
// 【なぜ例外ではなく切り詰めるのか】
//   validateLengths() は「想定外の値が来た」ことを検出する安全網であり、
//   基本は例外で止めるのが正しい。しかし Notes は分析に使わない自由記述で、
//   ここで139ファイルの取込全体を止める価値は無い。
//   そこで自由記述列だけは、投入前に正規化+切り詰めして通す。
//   切り詰めが起きたことは黙って握り潰さず、警告として残す。
//------------------------------------------------------------------

/** 警告を出す上限。同種の警告でログが埋まるのを防ぐ。 */
const TRUNCATION_LOG_LIMIT = 5;
let truncationCount = 0;

/** 切り詰めが何件あったかを返す(フェーズ完了時のログ用) */
function getTruncationCount() {
  return truncationCount;
}

/** ファイル/フェーズ単位で数え直したいときに使う */
function resetTruncationCount() {
  truncationCount = 0;
}

/**
 * 文字数・バイト数の両方の上限に収まるように切り詰める。
 *
 * VARCHAR2(n CHAR) は「n文字以内」かつ「4000バイト以内」の両方を課すため、
 * 文字数で切っただけでは足りない。バイト超過分はさらに末尾から削る。
 *
 * @param {string|undefined} v         CSVの生値
 * @param {number} maxChars            列の文字数上限
 * @param {number} maxBytes            列のバイト数上限
 * @param {string} columnLabel         警告表示用の列名
 * @returns {string|null}
 */
function clampText(v, maxChars, maxBytes, columnLabel) {
  const s = toStrDashNull(v);
  if (s === null) return null;

  const normalized = squashSpaces(s);
  if (
    normalized.length <= maxChars &&
    Buffer.byteLength(normalized, 'utf8') <= maxBytes
  ) {
    return normalized;
  }

  // 末尾に「…」を付けるため、その分(1文字/3バイト)を残して切る
  let out = normalized.slice(0, Math.max(0, maxChars - 1));
  while (Buffer.byteLength(out, 'utf8') > maxBytes - 3 && out.length > 0) {
    const over = Buffer.byteLength(out, 'utf8') - (maxBytes - 3);
    out = out.slice(0, out.length - Math.max(1, Math.ceil(over / 3)));
  }
  // サロゲートペアの片割れで終わらないようにする
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  out += '…';

  truncationCount += 1;
  if (truncationCount <= TRUNCATION_LOG_LIMIT) {
    console.warn(
      `  [警告] ${columnLabel} が長すぎるため切り詰めました ` +
        `(元: ${normalized.length}文字 / ${Buffer.byteLength(normalized, 'utf8')}バイト → ` +
        `${maxChars}文字以内)\n` +
        `         ${normalized.slice(0, 80)}…`
    );
    if (truncationCount === TRUNCATION_LOG_LIMIT) {
      console.warn('  [警告] 以降の切り詰め警告は表示しません(件数はフェーズ完了時に出ます)');
    }
  }
  return out;
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

/** 自由記述列の上限(DDLの VARCHAR2(1000 CHAR) に合わせる) */
const SP_TEXT_MAX_CHARS = 1000;
const SP_TEXT_MAX_BYTES = 4000;

function mapShortPositionRow(row) {
  return [
    toDateStr(pick(row, 'DiscDate')),
    toDateStr(pick(row, 'CalcDate')),
    toStr(pick(row, 'Code')),
    // 値が無い項目は空文字ではなく '-' で来るため toStrDashNull(clampText内)を使う。
    // 加えて、様式の桁揃え空白を詰めてから上限で切り詰める。
    clampText(pick(row, 'SSName'), SP_TEXT_MAX_CHARS, SP_TEXT_MAX_BYTES, 'ss_name(商号)'),
    clampText(pick(row, 'SSAddr'), SP_TEXT_MAX_CHARS, SP_TEXT_MAX_BYTES, 'ss_addr(住所)'),
    clampText(pick(row, 'DICName'), SP_TEXT_MAX_CHARS, SP_TEXT_MAX_BYTES, 'dic_name(委託者商号)'),
    clampText(pick(row, 'DICAddr'), SP_TEXT_MAX_CHARS, SP_TEXT_MAX_BYTES, 'dic_addr(委託者住所)'),
    clampText(pick(row, 'FundName'), SP_TEXT_MAX_CHARS, SP_TEXT_MAX_BYTES, 'fund_name(信託財産名)'),
    toNumRelaxed(pick(row, 'ShrtPosToSO')),
    toNumRelaxed(pick(row, 'ShrtPosShares')),
    toNumRelaxed(pick(row, 'ShrtPosUnits')),
    toDateStr(pick(row, 'PrevRptDate')),
    toNumRelaxed(pick(row, 'PrevRptRatio')),
    clampText(pick(row, 'Notes'), SP_TEXT_MAX_CHARS, SP_TEXT_MAX_BYTES, 'notes(備考)'),
  ];
}


//==================================================================
// 取引カレンダー・指数四本値関連 (Tier 1)
//
// 【CSVヘッダー名について】
//   API仕様書(/spec/mkt-cal, /spec/idx-bars-daily-topix, /spec/idx-bars-daily)の
//   記載に基づく。2026-09-06時点でinspect-bulk-csv.jsによる実データ確認が
//   できていない(Claude(Cowork)のdevice_bashからapi.jquants.comへの通信が
//   egressで遮断されているため)。ユーザーの手元で
//     node scripts/inspect-bulk-csv.js trading-calendar index-topix index-daily
//   を実行し、ヘッダー名・空欄表現が想定通りか確認してから本番投入すること。
//==================================================================

//------------------------------------------------------------------
// TRADING_CALENDAR_STG (取引カレンダー)
// CSVヘッダー(想定): Date,HolDiv
//------------------------------------------------------------------
const CALENDAR_COLUMNS = [
  'calendar_date',
  'hol_div',
];

const CALENDAR_VALUE_EXPRESSIONS = [
  "TO_DATE(?, 'YYYY-MM-DD')",
  null,
];

const CALENDAR_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 },              // calendar_date
  { type: oracledb.STRING, maxSize: 4, maxChars: 1 },  // hol_div
];

function mapCalendarRow(row) {
  return [
    toDateStr(pick(row, 'Date')),
    toStr(pick(row, 'HolDiv')),
  ];
}

//------------------------------------------------------------------
// TOPIX_PRICE_DAILY_STG (TOPIX四本値)
// CSVヘッダー(想定): Date,O,H,L,C (指数コード列は無い。TOPIX固定)
//------------------------------------------------------------------
const TOPIX_COLUMNS = [
  'price_date',
  'open_price',
  'high_price',
  'low_price',
  'close_price',
];

const TOPIX_VALUE_EXPRESSIONS = [
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null,
];

const TOPIX_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 }, // price_date
  { type: oracledb.NUMBER },              // open_price
  { type: oracledb.NUMBER },              // high_price
  { type: oracledb.NUMBER },              // low_price
  { type: oracledb.NUMBER },              // close_price
];

function mapTopixRow(row) {
  return [
    toDateStr(pick(row, 'Date')),
    toNum(pick(row, 'O')),
    toNum(pick(row, 'H')),
    toNum(pick(row, 'L')),
    toNum(pick(row, 'C')),
  ];
}

//------------------------------------------------------------------
// INDEX_PRICE_DAILY_STG (指数四本値)
// CSVヘッダー(想定): Date,Code,O,H,L,C
// 「終値のみ提供」の指数はO/H/Lが空欄で来る(仕様書に明記)。toNum()でNULL化される。
//------------------------------------------------------------------
const INDEX_DAILY_COLUMNS = [
  'index_code',
  'price_date',
  'open_price',
  'high_price',
  'low_price',
  'close_price',
];

const INDEX_DAILY_VALUE_EXPRESSIONS = [
  null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null,
];

const INDEX_DAILY_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // index_code
  { type: oracledb.STRING, maxSize: 10 },               // price_date
  { type: oracledb.NUMBER },                            // open_price
  { type: oracledb.NUMBER },                            // high_price
  { type: oracledb.NUMBER },                            // low_price
  { type: oracledb.NUMBER },                            // close_price
];

function mapIndexDailyRow(row) {
  return [
    toStr(pick(row, 'Code')),
    toDateStr(pick(row, 'Date')),
    toNum(pick(row, 'O')),
    toNum(pick(row, 'H')),
    toNum(pick(row, 'L')),
    toNum(pick(row, 'C')),
  ];
}

//==================================================================
// 投資部門別情報・決算発表予定日関連 (Tier 2)
//
// 【CSVヘッダー名について】
//   API仕様書(/spec/eq-investor-types, /spec/fin-earnings-date)の記載に基づく。
//   2026-09-06時点でinspect-bulk-csv.jsによる実データ確認ができていない
//   (Claude(Cowork)のdevice_bashからapi.jquants.comへの通信がegressで
//   遮断されているため)。ユーザーの手元で
//     node scripts/inspect-bulk-csv.js investor-types earnings-date
//   を実行し、ヘッダー名・空欄表現が想定通りか確認してから本番投入すること。
//==================================================================

//------------------------------------------------------------------
// INVESTOR_TYPE_TRADING_STG (投資部門別情報)
// CSVヘッダー(想定): PubDate,StDate,EnDate,Section,
//                    (13部門×4指標=52項目、例: PropSell,PropBuy,PropTot,PropBal,...)
//------------------------------------------------------------------
const INVESTOR_TYPE_COLUMNS = [
  'pub_date',
  'st_date',
  'en_date',
  'section',
  'prop_sell',
  'prop_buy',
  'prop_tot',
  'prop_bal',
  'brk_sell',
  'brk_buy',
  'brk_tot',
  'brk_bal',
  'tot_sell',
  'tot_buy',
  'tot_tot',
  'tot_bal',
  'ind_sell',
  'ind_buy',
  'ind_tot',
  'ind_bal',
  'frgn_sell',
  'frgn_buy',
  'frgn_tot',
  'frgn_bal',
  'sec_co_sell',
  'sec_co_buy',
  'sec_co_tot',
  'sec_co_bal',
  'inv_tr_sell',
  'inv_tr_buy',
  'inv_tr_tot',
  'inv_tr_bal',
  'bus_co_sell',
  'bus_co_buy',
  'bus_co_tot',
  'bus_co_bal',
  'oth_co_sell',
  'oth_co_buy',
  'oth_co_tot',
  'oth_co_bal',
  'ins_co_sell',
  'ins_co_buy',
  'ins_co_tot',
  'ins_co_bal',
  'bank_sell',
  'bank_buy',
  'bank_tot',
  'bank_bal',
  'trst_bnk_sell',
  'trst_bnk_buy',
  'trst_bnk_tot',
  'trst_bnk_bal',
  'oth_fin_sell',
  'oth_fin_buy',
  'oth_fin_tot',
  'oth_fin_bal',
];

const INVESTOR_TYPE_VALUE_EXPRESSIONS = [
  "TO_DATE(?, 'YYYY-MM-DD')", // pub_date
  "TO_DATE(?, 'YYYY-MM-DD')", // st_date
  "TO_DATE(?, 'YYYY-MM-DD')", // en_date
  null, // section
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
];

const INVESTOR_TYPE_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 },               // pub_date
  { type: oracledb.STRING, maxSize: 10 },               // st_date
  { type: oracledb.STRING, maxSize: 10 },               // en_date
  { type: oracledb.STRING, maxSize: 80, maxChars: 20 }, // section
  { type: oracledb.NUMBER },  // prop_sell
  { type: oracledb.NUMBER },  // prop_buy
  { type: oracledb.NUMBER },  // prop_tot
  { type: oracledb.NUMBER },  // prop_bal
  { type: oracledb.NUMBER },  // brk_sell
  { type: oracledb.NUMBER },  // brk_buy
  { type: oracledb.NUMBER },  // brk_tot
  { type: oracledb.NUMBER },  // brk_bal
  { type: oracledb.NUMBER },  // tot_sell
  { type: oracledb.NUMBER },  // tot_buy
  { type: oracledb.NUMBER },  // tot_tot
  { type: oracledb.NUMBER },  // tot_bal
  { type: oracledb.NUMBER },  // ind_sell
  { type: oracledb.NUMBER },  // ind_buy
  { type: oracledb.NUMBER },  // ind_tot
  { type: oracledb.NUMBER },  // ind_bal
  { type: oracledb.NUMBER },  // frgn_sell
  { type: oracledb.NUMBER },  // frgn_buy
  { type: oracledb.NUMBER },  // frgn_tot
  { type: oracledb.NUMBER },  // frgn_bal
  { type: oracledb.NUMBER },  // sec_co_sell
  { type: oracledb.NUMBER },  // sec_co_buy
  { type: oracledb.NUMBER },  // sec_co_tot
  { type: oracledb.NUMBER },  // sec_co_bal
  { type: oracledb.NUMBER },  // inv_tr_sell
  { type: oracledb.NUMBER },  // inv_tr_buy
  { type: oracledb.NUMBER },  // inv_tr_tot
  { type: oracledb.NUMBER },  // inv_tr_bal
  { type: oracledb.NUMBER },  // bus_co_sell
  { type: oracledb.NUMBER },  // bus_co_buy
  { type: oracledb.NUMBER },  // bus_co_tot
  { type: oracledb.NUMBER },  // bus_co_bal
  { type: oracledb.NUMBER },  // oth_co_sell
  { type: oracledb.NUMBER },  // oth_co_buy
  { type: oracledb.NUMBER },  // oth_co_tot
  { type: oracledb.NUMBER },  // oth_co_bal
  { type: oracledb.NUMBER },  // ins_co_sell
  { type: oracledb.NUMBER },  // ins_co_buy
  { type: oracledb.NUMBER },  // ins_co_tot
  { type: oracledb.NUMBER },  // ins_co_bal
  { type: oracledb.NUMBER },  // bank_sell
  { type: oracledb.NUMBER },  // bank_buy
  { type: oracledb.NUMBER },  // bank_tot
  { type: oracledb.NUMBER },  // bank_bal
  { type: oracledb.NUMBER },  // trst_bnk_sell
  { type: oracledb.NUMBER },  // trst_bnk_buy
  { type: oracledb.NUMBER },  // trst_bnk_tot
  { type: oracledb.NUMBER },  // trst_bnk_bal
  { type: oracledb.NUMBER },  // oth_fin_sell
  { type: oracledb.NUMBER },  // oth_fin_buy
  { type: oracledb.NUMBER },  // oth_fin_tot
  { type: oracledb.NUMBER },  // oth_fin_bal
];

function mapInvestorTypeRow(row) {
  return [
    toDateStr(pick(row, 'PubDate')),
    toDateStr(pick(row, 'StDate')),
    toDateStr(pick(row, 'EnDate')),
    toStr(pick(row, 'Section')),
    toNumRelaxed(pick(row, 'PropSell')),
    toNumRelaxed(pick(row, 'PropBuy')),
    toNumRelaxed(pick(row, 'PropTot')),
    toNumRelaxed(pick(row, 'PropBal')),
    toNumRelaxed(pick(row, 'BrkSell')),
    toNumRelaxed(pick(row, 'BrkBuy')),
    toNumRelaxed(pick(row, 'BrkTot')),
    toNumRelaxed(pick(row, 'BrkBal')),
    toNumRelaxed(pick(row, 'TotSell')),
    toNumRelaxed(pick(row, 'TotBuy')),
    toNumRelaxed(pick(row, 'TotTot')),
    toNumRelaxed(pick(row, 'TotBal')),
    toNumRelaxed(pick(row, 'IndSell')),
    toNumRelaxed(pick(row, 'IndBuy')),
    toNumRelaxed(pick(row, 'IndTot')),
    toNumRelaxed(pick(row, 'IndBal')),
    toNumRelaxed(pick(row, 'FrgnSell')),
    toNumRelaxed(pick(row, 'FrgnBuy')),
    toNumRelaxed(pick(row, 'FrgnTot')),
    toNumRelaxed(pick(row, 'FrgnBal')),
    toNumRelaxed(pick(row, 'SecCoSell')),
    toNumRelaxed(pick(row, 'SecCoBuy')),
    toNumRelaxed(pick(row, 'SecCoTot')),
    toNumRelaxed(pick(row, 'SecCoBal')),
    toNumRelaxed(pick(row, 'InvTrSell')),
    toNumRelaxed(pick(row, 'InvTrBuy')),
    toNumRelaxed(pick(row, 'InvTrTot')),
    toNumRelaxed(pick(row, 'InvTrBal')),
    toNumRelaxed(pick(row, 'BusCoSell')),
    toNumRelaxed(pick(row, 'BusCoBuy')),
    toNumRelaxed(pick(row, 'BusCoTot')),
    toNumRelaxed(pick(row, 'BusCoBal')),
    toNumRelaxed(pick(row, 'OthCoSell')),
    toNumRelaxed(pick(row, 'OthCoBuy')),
    toNumRelaxed(pick(row, 'OthCoTot')),
    toNumRelaxed(pick(row, 'OthCoBal')),
    toNumRelaxed(pick(row, 'InsCoSell')),
    toNumRelaxed(pick(row, 'InsCoBuy')),
    toNumRelaxed(pick(row, 'InsCoTot')),
    toNumRelaxed(pick(row, 'InsCoBal')),
    toNumRelaxed(pick(row, 'BankSell')),
    toNumRelaxed(pick(row, 'BankBuy')),
    toNumRelaxed(pick(row, 'BankTot')),
    toNumRelaxed(pick(row, 'BankBal')),
    toNumRelaxed(pick(row, 'TrstBnkSell')),
    toNumRelaxed(pick(row, 'TrstBnkBuy')),
    toNumRelaxed(pick(row, 'TrstBnkTot')),
    toNumRelaxed(pick(row, 'TrstBnkBal')),
    toNumRelaxed(pick(row, 'OthFinSell')),
    toNumRelaxed(pick(row, 'OthFinBuy')),
    toNumRelaxed(pick(row, 'OthFinTot')),
    toNumRelaxed(pick(row, 'OthFinBal')),
  ];
}

//------------------------------------------------------------------
// EARNINGS_SCHEDULE_STG (決算発表予定日)
// CSVヘッダー(想定): PubDate,SchDate,FQName,FYE,Code,CoName,CoNameEn
// SchDateは「未定」の場合空文字で来る(toDateStrで自動的にNULL化される)。
//------------------------------------------------------------------
const EARNINGS_SCHEDULE_COLUMNS = [
  'code',
  'fye',
  'fq_name',
  'pub_date',
  'sch_date',
  'co_name',
  'co_name_en',
];

const EARNINGS_SCHEDULE_VALUE_EXPRESSIONS = [
  null, // code
  null, // fye
  null, // fq_name
  "TO_DATE(?, 'YYYY-MM-DD')", // pub_date
  "TO_DATE(?, 'YYYY-MM-DD')", // sch_date(未定はNULL)
  null, // co_name
  null, // co_name_en
];

const EARNINGS_SCHEDULE_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 },                // code
  { type: oracledb.STRING, maxSize: 16, maxChars: 4 },   // fye
  { type: oracledb.STRING, maxSize: 8, maxChars: 2 },    // fq_name
  { type: oracledb.STRING, maxSize: 10 },                // pub_date
  { type: oracledb.STRING, maxSize: 10 },                // sch_date
  { type: oracledb.STRING, maxSize: 2000, maxChars: 500 }, // co_name
  { type: oracledb.STRING, maxSize: 2000, maxChars: 500 }, // co_name_en
];

function mapEarningsScheduleRow(row) {
  return [
    toStr(pick(row, 'Code')),
    toStr(pick(row, 'FYE')),
    toStr(pick(row, 'FQName')),
    toDateStr(pick(row, 'PubDate')),
    toDateStr(pick(row, 'SchDate')),
    toStr(pick(row, 'CoName')),
    toStr(pick(row, 'CoNameEn')),
  ];
}


//------------------------------------------------------------------
// FINANCIAL_SUMMARY_STG (財務情報 /fins/summary) Tier3
//------------------------------------------------------------------
const FINANCIAL_SUMMARY_COLUMNS = [
  'disc_date',
  'disc_time',
  'code',
  'disc_no',
  'doc_type',
  'cur_per_type',
  'cur_per_st',
  'cur_per_en',
  'cur_fy_st',
  'cur_fy_en',
  'nxt_fy_st',
  'nxt_fy_en',
  'sales',
  'op',
  'odp',
  'np',
  'eps',
  'deps',
  'ta',
  'eq',
  'eq_ar',
  'bps',
  'cfo',
  'cfi',
  'cff',
  'cash_eq',
  'div_1q',
  'div_2q',
  'div_3q',
  'div_fy',
  'div_ann',
  'div_unit',
  'div_total_ann',
  'payout_ratio_ann',
  'f_div_1q',
  'f_div_2q',
  'f_div_3q',
  'f_div_fy',
  'f_div_ann',
  'f_div_unit',
  'f_div_total_ann',
  'f_payout_ratio_ann',
  'nxf_div_1q',
  'nxf_div_2q',
  'nxf_div_3q',
  'nxf_div_fy',
  'nxf_div_ann',
  'nxf_div_unit',
  'nxf_payout_ratio_ann',
  'f_sales_2q',
  'f_op_2q',
  'f_odp_2q',
  'f_np_2q',
  'f_eps_2q',
  'nxf_sales_2q',
  'nxf_op_2q',
  'nxf_odp_2q',
  'nxf_np_2q',
  'nxf_eps_2q',
  'f_sales',
  'f_op',
  'f_odp',
  'f_np',
  'f_eps',
  'nxf_sales',
  'nxf_op',
  'nxf_odp',
  'nxf_np',
  'nxf_eps',
  'mat_chg_sub',
  'sig_chg_in_c',
  'chg_by_as_rev',
  'chg_no_as_rev',
  'chg_ac_est',
  'retro_rst',
  'sh_out_fy',
  'tr_sh_fy',
  'avg_sh',
  'nc_sales',
  'nc_op',
  'nc_odp',
  'nc_np',
  'nc_eps',
  'nc_ta',
  'nc_eq',
  'nc_eq_ar',
  'nc_bps',
  'fnc_sales_2q',
  'fnc_op_2q',
  'fnc_odp_2q',
  'fnc_np_2q',
  'fnc_eps_2q',
  'nxfnc_sales_2q',
  'nxfnc_op_2q',
  'nxfnc_odp_2q',
  'nxfnc_np_2q',
  'nxfnc_eps_2q',
  'fnc_sales',
  'fnc_op',
  'fnc_odp',
  'fnc_np',
  'fnc_eps',
  'nxfnc_sales',
  'nxfnc_op',
  'nxfnc_odp',
  'nxfnc_np',
  'nxfnc_eps',
  'sh_eq',
  'nc_sh_eq',
  'roe',
  'nc_roe',
];

const FINANCIAL_SUMMARY_VALUE_EXPRESSIONS = [
  "TO_DATE(?, 'YYYY-MM-DD')", // disc_date
  null, // disc_time
  null, // code
  null, // disc_no
  null, // doc_type
  null, // cur_per_type
  "TO_DATE(?, 'YYYY-MM-DD')", // cur_per_st
  "TO_DATE(?, 'YYYY-MM-DD')", // cur_per_en
  "TO_DATE(?, 'YYYY-MM-DD')", // cur_fy_st
  "TO_DATE(?, 'YYYY-MM-DD')", // cur_fy_en
  "TO_DATE(?, 'YYYY-MM-DD')", // nxt_fy_st
  "TO_DATE(?, 'YYYY-MM-DD')", // nxt_fy_en
  null, // sales
  null, // op
  null, // odp
  null, // np
  null, // eps
  null, // deps
  null, // ta
  null, // eq
  null, // eq_ar
  null, // bps
  null, // cfo
  null, // cfi
  null, // cff
  null, // cash_eq
  null, // div_1q
  null, // div_2q
  null, // div_3q
  null, // div_fy
  null, // div_ann
  null, // div_unit
  null, // div_total_ann
  null, // payout_ratio_ann
  null, // f_div_1q
  null, // f_div_2q
  null, // f_div_3q
  null, // f_div_fy
  null, // f_div_ann
  null, // f_div_unit
  null, // f_div_total_ann
  null, // f_payout_ratio_ann
  null, // nxf_div_1q
  null, // nxf_div_2q
  null, // nxf_div_3q
  null, // nxf_div_fy
  null, // nxf_div_ann
  null, // nxf_div_unit
  null, // nxf_payout_ratio_ann
  null, // f_sales_2q
  null, // f_op_2q
  null, // f_odp_2q
  null, // f_np_2q
  null, // f_eps_2q
  null, // nxf_sales_2q
  null, // nxf_op_2q
  null, // nxf_odp_2q
  null, // nxf_np_2q
  null, // nxf_eps_2q
  null, // f_sales
  null, // f_op
  null, // f_odp
  null, // f_np
  null, // f_eps
  null, // nxf_sales
  null, // nxf_op
  null, // nxf_odp
  null, // nxf_np
  null, // nxf_eps
  null, // mat_chg_sub
  null, // sig_chg_in_c
  null, // chg_by_as_rev
  null, // chg_no_as_rev
  null, // chg_ac_est
  null, // retro_rst
  null, // sh_out_fy
  null, // tr_sh_fy
  null, // avg_sh
  null, // nc_sales
  null, // nc_op
  null, // nc_odp
  null, // nc_np
  null, // nc_eps
  null, // nc_ta
  null, // nc_eq
  null, // nc_eq_ar
  null, // nc_bps
  null, // fnc_sales_2q
  null, // fnc_op_2q
  null, // fnc_odp_2q
  null, // fnc_np_2q
  null, // fnc_eps_2q
  null, // nxfnc_sales_2q
  null, // nxfnc_op_2q
  null, // nxfnc_odp_2q
  null, // nxfnc_np_2q
  null, // nxfnc_eps_2q
  null, // fnc_sales
  null, // fnc_op
  null, // fnc_odp
  null, // fnc_np
  null, // fnc_eps
  null, // nxfnc_sales
  null, // nxfnc_op
  null, // nxfnc_odp
  null, // nxfnc_np
  null, // nxfnc_eps
  null, // sh_eq
  null, // nc_sh_eq
  null, // roe
  null, // nc_roe
];

const FINANCIAL_SUMMARY_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 }, // disc_date
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // disc_time
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // code
  { type: oracledb.STRING, maxSize: 80, maxChars: 20 }, // disc_no
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 }, // doc_type
  { type: oracledb.STRING, maxSize: 16, maxChars: 4 }, // cur_per_type
  { type: oracledb.STRING, maxSize: 10 }, // cur_per_st
  { type: oracledb.STRING, maxSize: 10 }, // cur_per_en
  { type: oracledb.STRING, maxSize: 10 }, // cur_fy_st
  { type: oracledb.STRING, maxSize: 10 }, // cur_fy_en
  { type: oracledb.STRING, maxSize: 10 }, // nxt_fy_st
  { type: oracledb.STRING, maxSize: 10 }, // nxt_fy_en
  { type: oracledb.NUMBER }, // sales
  { type: oracledb.NUMBER }, // op
  { type: oracledb.NUMBER }, // odp
  { type: oracledb.NUMBER }, // np
  { type: oracledb.NUMBER }, // eps
  { type: oracledb.NUMBER }, // deps
  { type: oracledb.NUMBER }, // ta
  { type: oracledb.NUMBER }, // eq
  { type: oracledb.NUMBER }, // eq_ar
  { type: oracledb.NUMBER }, // bps
  { type: oracledb.NUMBER }, // cfo
  { type: oracledb.NUMBER }, // cfi
  { type: oracledb.NUMBER }, // cff
  { type: oracledb.NUMBER }, // cash_eq
  { type: oracledb.NUMBER }, // div_1q
  { type: oracledb.NUMBER }, // div_2q
  { type: oracledb.NUMBER }, // div_3q
  { type: oracledb.NUMBER }, // div_fy
  { type: oracledb.NUMBER }, // div_ann
  { type: oracledb.NUMBER }, // div_unit
  { type: oracledb.NUMBER }, // div_total_ann
  { type: oracledb.NUMBER }, // payout_ratio_ann
  { type: oracledb.NUMBER }, // f_div_1q
  { type: oracledb.NUMBER }, // f_div_2q
  { type: oracledb.NUMBER }, // f_div_3q
  { type: oracledb.NUMBER }, // f_div_fy
  { type: oracledb.NUMBER }, // f_div_ann
  { type: oracledb.NUMBER }, // f_div_unit
  { type: oracledb.NUMBER }, // f_div_total_ann
  { type: oracledb.NUMBER }, // f_payout_ratio_ann
  { type: oracledb.NUMBER }, // nxf_div_1q
  { type: oracledb.NUMBER }, // nxf_div_2q
  { type: oracledb.NUMBER }, // nxf_div_3q
  { type: oracledb.NUMBER }, // nxf_div_fy
  { type: oracledb.NUMBER }, // nxf_div_ann
  { type: oracledb.NUMBER }, // nxf_div_unit
  { type: oracledb.NUMBER }, // nxf_payout_ratio_ann
  { type: oracledb.NUMBER }, // f_sales_2q
  { type: oracledb.NUMBER }, // f_op_2q
  { type: oracledb.NUMBER }, // f_odp_2q
  { type: oracledb.NUMBER }, // f_np_2q
  { type: oracledb.NUMBER }, // f_eps_2q
  { type: oracledb.NUMBER }, // nxf_sales_2q
  { type: oracledb.NUMBER }, // nxf_op_2q
  { type: oracledb.NUMBER }, // nxf_odp_2q
  { type: oracledb.NUMBER }, // nxf_np_2q
  { type: oracledb.NUMBER }, // nxf_eps_2q
  { type: oracledb.NUMBER }, // f_sales
  { type: oracledb.NUMBER }, // f_op
  { type: oracledb.NUMBER }, // f_odp
  { type: oracledb.NUMBER }, // f_np
  { type: oracledb.NUMBER }, // f_eps
  { type: oracledb.NUMBER }, // nxf_sales
  { type: oracledb.NUMBER }, // nxf_op
  { type: oracledb.NUMBER }, // nxf_odp
  { type: oracledb.NUMBER }, // nxf_np
  { type: oracledb.NUMBER }, // nxf_eps
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // mat_chg_sub
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // sig_chg_in_c
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // chg_by_as_rev
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // chg_no_as_rev
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // chg_ac_est
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // retro_rst
  { type: oracledb.NUMBER }, // sh_out_fy
  { type: oracledb.NUMBER }, // tr_sh_fy
  { type: oracledb.NUMBER }, // avg_sh
  { type: oracledb.NUMBER }, // nc_sales
  { type: oracledb.NUMBER }, // nc_op
  { type: oracledb.NUMBER }, // nc_odp
  { type: oracledb.NUMBER }, // nc_np
  { type: oracledb.NUMBER }, // nc_eps
  { type: oracledb.NUMBER }, // nc_ta
  { type: oracledb.NUMBER }, // nc_eq
  { type: oracledb.NUMBER }, // nc_eq_ar
  { type: oracledb.NUMBER }, // nc_bps
  { type: oracledb.NUMBER }, // fnc_sales_2q
  { type: oracledb.NUMBER }, // fnc_op_2q
  { type: oracledb.NUMBER }, // fnc_odp_2q
  { type: oracledb.NUMBER }, // fnc_np_2q
  { type: oracledb.NUMBER }, // fnc_eps_2q
  { type: oracledb.NUMBER }, // nxfnc_sales_2q
  { type: oracledb.NUMBER }, // nxfnc_op_2q
  { type: oracledb.NUMBER }, // nxfnc_odp_2q
  { type: oracledb.NUMBER }, // nxfnc_np_2q
  { type: oracledb.NUMBER }, // nxfnc_eps_2q
  { type: oracledb.NUMBER }, // fnc_sales
  { type: oracledb.NUMBER }, // fnc_op
  { type: oracledb.NUMBER }, // fnc_odp
  { type: oracledb.NUMBER }, // fnc_np
  { type: oracledb.NUMBER }, // fnc_eps
  { type: oracledb.NUMBER }, // nxfnc_sales
  { type: oracledb.NUMBER }, // nxfnc_op
  { type: oracledb.NUMBER }, // nxfnc_odp
  { type: oracledb.NUMBER }, // nxfnc_np
  { type: oracledb.NUMBER }, // nxfnc_eps
  { type: oracledb.NUMBER }, // sh_eq
  { type: oracledb.NUMBER }, // nc_sh_eq
  { type: oracledb.NUMBER }, // roe
  { type: oracledb.NUMBER }, // nc_roe
];

function mapFinancialSummaryRow(row) {
  return [
    toDateStr(pick(row, 'DiscDate')), // disc_date
    toStr(pick(row, 'DiscTime')), // disc_time
    toStr(pick(row, 'Code')), // code
    toStr(pick(row, 'DiscNo')), // disc_no
    toStr(pick(row, 'DocType')), // doc_type
    toStr(pick(row, 'CurPerType')), // cur_per_type
    toDateStr(pick(row, 'CurPerSt')), // cur_per_st
    toDateStr(pick(row, 'CurPerEn')), // cur_per_en
    toDateStr(pick(row, 'CurFYSt')), // cur_fy_st
    toDateStr(pick(row, 'CurFYEn')), // cur_fy_en
    toDateStr(pick(row, 'NxtFYSt')), // nxt_fy_st
    toDateStr(pick(row, 'NxtFYEn')), // nxt_fy_en
    toNumRelaxed(pick(row, 'Sales')), // sales
    toNumRelaxed(pick(row, 'OP')), // op
    toNumRelaxed(pick(row, 'OdP')), // odp
    toNumRelaxed(pick(row, 'NP')), // np
    toNumRelaxed(pick(row, 'EPS')), // eps
    toNumRelaxed(pick(row, 'DEPS')), // deps
    toNumRelaxed(pick(row, 'TA')), // ta
    toNumRelaxed(pick(row, 'Eq')), // eq
    toNumRelaxed(pick(row, 'EqAR')), // eq_ar
    toNumRelaxed(pick(row, 'BPS')), // bps
    toNumRelaxed(pick(row, 'CFO')), // cfo
    toNumRelaxed(pick(row, 'CFI')), // cfi
    toNumRelaxed(pick(row, 'CFF')), // cff
    toNumRelaxed(pick(row, 'CashEq')), // cash_eq
    toNumRelaxed(pick(row, 'Div1Q')), // div_1q
    toNumRelaxed(pick(row, 'Div2Q')), // div_2q
    toNumRelaxed(pick(row, 'Div3Q')), // div_3q
    toNumRelaxed(pick(row, 'DivFY')), // div_fy
    toNumRelaxed(pick(row, 'DivAnn')), // div_ann
    toNumRelaxed(pick(row, 'DivUnit')), // div_unit
    toNumRelaxed(pick(row, 'DivTotalAnn')), // div_total_ann
    toNumRelaxed(pick(row, 'PayoutRatioAnn')), // payout_ratio_ann
    toNumRelaxed(pick(row, 'FDiv1Q')), // f_div_1q
    toNumRelaxed(pick(row, 'FDiv2Q')), // f_div_2q
    toNumRelaxed(pick(row, 'FDiv3Q')), // f_div_3q
    toNumRelaxed(pick(row, 'FDivFY')), // f_div_fy
    toNumRelaxed(pick(row, 'FDivAnn')), // f_div_ann
    toNumRelaxed(pick(row, 'FDivUnit')), // f_div_unit
    toNumRelaxed(pick(row, 'FDivTotalAnn')), // f_div_total_ann
    toNumRelaxed(pick(row, 'FPayoutRatioAnn')), // f_payout_ratio_ann
    toNumRelaxed(pick(row, 'NxFDiv1Q')), // nxf_div_1q
    toNumRelaxed(pick(row, 'NxFDiv2Q')), // nxf_div_2q
    toNumRelaxed(pick(row, 'NxFDiv3Q')), // nxf_div_3q
    toNumRelaxed(pick(row, 'NxFDivFY')), // nxf_div_fy
    toNumRelaxed(pick(row, 'NxFDivAnn')), // nxf_div_ann
    toNumRelaxed(pick(row, 'NxFDivUnit')), // nxf_div_unit
    toNumRelaxed(pick(row, 'NxFPayoutRatioAnn')), // nxf_payout_ratio_ann
    toNumRelaxed(pick(row, 'FSales2Q')), // f_sales_2q
    toNumRelaxed(pick(row, 'FOP2Q')), // f_op_2q
    toNumRelaxed(pick(row, 'FOdP2Q')), // f_odp_2q
    toNumRelaxed(pick(row, 'FNP2Q')), // f_np_2q
    toNumRelaxed(pick(row, 'FEPS2Q')), // f_eps_2q
    toNumRelaxed(pick(row, 'NxFSales2Q')), // nxf_sales_2q
    toNumRelaxed(pick(row, 'NxFOP2Q')), // nxf_op_2q
    toNumRelaxed(pick(row, 'NxFOdP2Q')), // nxf_odp_2q
    toNumRelaxed(pick(row, 'NxFNp2Q')), // nxf_np_2q
    toNumRelaxed(pick(row, 'NxFEPS2Q')), // nxf_eps_2q
    toNumRelaxed(pick(row, 'FSales')), // f_sales
    toNumRelaxed(pick(row, 'FOP')), // f_op
    toNumRelaxed(pick(row, 'FOdP')), // f_odp
    toNumRelaxed(pick(row, 'FNP')), // f_np
    toNumRelaxed(pick(row, 'FEPS')), // f_eps
    toNumRelaxed(pick(row, 'NxFSales')), // nxf_sales
    toNumRelaxed(pick(row, 'NxFOP')), // nxf_op
    toNumRelaxed(pick(row, 'NxFOdP')), // nxf_odp
    toNumRelaxed(pick(row, 'NxFNp')), // nxf_np
    toNumRelaxed(pick(row, 'NxFEPS')), // nxf_eps
    toStr(pick(row, 'MatChgSub')), // mat_chg_sub
    toStr(pick(row, 'SigChgInC')), // sig_chg_in_c
    toStr(pick(row, 'ChgByASRev')), // chg_by_as_rev
    toStr(pick(row, 'ChgNoASRev')), // chg_no_as_rev
    toStr(pick(row, 'ChgAcEst')), // chg_ac_est
    toStr(pick(row, 'RetroRst')), // retro_rst
    toNumRelaxed(pick(row, 'ShOutFY')), // sh_out_fy
    toNumRelaxed(pick(row, 'TrShFY')), // tr_sh_fy
    toNumRelaxed(pick(row, 'AvgSh')), // avg_sh
    toNumRelaxed(pick(row, 'NCSales')), // nc_sales
    toNumRelaxed(pick(row, 'NCOP')), // nc_op
    toNumRelaxed(pick(row, 'NCOdP')), // nc_odp
    toNumRelaxed(pick(row, 'NCNP')), // nc_np
    toNumRelaxed(pick(row, 'NCEPS')), // nc_eps
    toNumRelaxed(pick(row, 'NCTA')), // nc_ta
    toNumRelaxed(pick(row, 'NCEq')), // nc_eq
    toNumRelaxed(pick(row, 'NCEqAR')), // nc_eq_ar
    toNumRelaxed(pick(row, 'NCBPS')), // nc_bps
    toNumRelaxed(pick(row, 'FNCSales2Q')), // fnc_sales_2q
    toNumRelaxed(pick(row, 'FNCOP2Q')), // fnc_op_2q
    toNumRelaxed(pick(row, 'FNCOdP2Q')), // fnc_odp_2q
    toNumRelaxed(pick(row, 'FNCNP2Q')), // fnc_np_2q
    toNumRelaxed(pick(row, 'FNCEPS2Q')), // fnc_eps_2q
    toNumRelaxed(pick(row, 'NxFNCSales2Q')), // nxfnc_sales_2q
    toNumRelaxed(pick(row, 'NxFNCOP2Q')), // nxfnc_op_2q
    toNumRelaxed(pick(row, 'NxFNCOdP2Q')), // nxfnc_odp_2q
    toNumRelaxed(pick(row, 'NxFNCNP2Q')), // nxfnc_np_2q
    toNumRelaxed(pick(row, 'NxFNCEPS2Q')), // nxfnc_eps_2q
    toNumRelaxed(pick(row, 'FNCSales')), // fnc_sales
    toNumRelaxed(pick(row, 'FNCOP')), // fnc_op
    toNumRelaxed(pick(row, 'FNCOdP')), // fnc_odp
    toNumRelaxed(pick(row, 'FNCNP')), // fnc_np
    toNumRelaxed(pick(row, 'FNCEPS')), // fnc_eps
    toNumRelaxed(pick(row, 'NxFNCSales')), // nxfnc_sales
    toNumRelaxed(pick(row, 'NxFNCOP')), // nxfnc_op
    toNumRelaxed(pick(row, 'NxFNCOdP')), // nxfnc_odp
    toNumRelaxed(pick(row, 'NxFNCNP')), // nxfnc_np
    toNumRelaxed(pick(row, 'NxFNCEPS')), // nxfnc_eps
    toNumRelaxed(pick(row, 'ShEq')), // sh_eq
    toNumRelaxed(pick(row, 'NCShEq')), // nc_sh_eq
    toNumRelaxed(pick(row, 'ROE')), // roe
    toNumRelaxed(pick(row, 'NCROE')), // nc_roe
  ];
}

//------------------------------------------------------------------
// OPTION_225_PRICE_STG (日経225オプション四本値 /derivatives/bars/daily/options/225) Tier3
//------------------------------------------------------------------
const OPTION_225_COLUMNS = [
  'trade_date',
  'code',
  'o',
  'h',
  'l',
  'c',
  'eo',
  'eh',
  'el',
  'ec',
  'ao',
  'ah',
  'al',
  'ac',
  'vo',
  'oi',
  'va',
  'contract_month',
  'strike_price',
  'vo_oa',
  'em_mrgn_trg_div',
  'pc_div',
  'last_trading_date',
  'sq_date',
  'settle_price',
  'theoretical_price',
  'base_volatility',
  'underlying_price',
  'implied_volatility',
  'interest_rate',
];

const OPTION_225_VALUE_EXPRESSIONS = [
  "TO_DATE(?, 'YYYY-MM-DD')", // trade_date
  null, // code
  null, // o
  null, // h
  null, // l
  null, // c
  null, // eo
  null, // eh
  null, // el
  null, // ec
  null, // ao
  null, // ah
  null, // al
  null, // ac
  null, // vo
  null, // oi
  null, // va
  null, // contract_month
  null, // strike_price
  null, // vo_oa
  null, // em_mrgn_trg_div
  null, // pc_div
  "TO_DATE(?, 'YYYY-MM-DD')", // last_trading_date
  "TO_DATE(?, 'YYYY-MM-DD')", // sq_date
  null, // settle_price
  null, // theoretical_price
  null, // base_volatility
  null, // underlying_price
  null, // implied_volatility
  null, // interest_rate
];

const OPTION_225_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 }, // trade_date
  { type: oracledb.STRING, maxSize: 80, maxChars: 20 }, // code
  { type: oracledb.NUMBER }, // o
  { type: oracledb.NUMBER }, // h
  { type: oracledb.NUMBER }, // l
  { type: oracledb.NUMBER }, // c
  { type: oracledb.NUMBER }, // eo
  { type: oracledb.NUMBER }, // eh
  { type: oracledb.NUMBER }, // el
  { type: oracledb.NUMBER }, // ec
  { type: oracledb.NUMBER }, // ao
  { type: oracledb.NUMBER }, // ah
  { type: oracledb.NUMBER }, // al
  { type: oracledb.NUMBER }, // ac
  { type: oracledb.NUMBER }, // vo
  { type: oracledb.NUMBER }, // oi
  { type: oracledb.NUMBER }, // va
  { type: oracledb.STRING, maxSize: 28, maxChars: 7 }, // contract_month
  { type: oracledb.NUMBER }, // strike_price
  { type: oracledb.NUMBER }, // vo_oa
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // em_mrgn_trg_div
  { type: oracledb.STRING, maxSize: 40, maxChars: 10 }, // pc_div
  { type: oracledb.STRING, maxSize: 10 }, // last_trading_date
  { type: oracledb.STRING, maxSize: 10 }, // sq_date
  { type: oracledb.NUMBER }, // settle_price
  { type: oracledb.NUMBER }, // theoretical_price
  { type: oracledb.NUMBER }, // base_volatility
  { type: oracledb.NUMBER }, // underlying_price
  { type: oracledb.NUMBER }, // implied_volatility
  { type: oracledb.NUMBER }, // interest_rate
];

function mapOption225Row(row) {
  return [
    toDateStr(pick(row, 'Date')), // trade_date
    toStr(pick(row, 'Code')), // code
    toNumRelaxed(pick(row, 'O')), // o
    toNumRelaxed(pick(row, 'H')), // h
    toNumRelaxed(pick(row, 'L')), // l
    toNumRelaxed(pick(row, 'C')), // c
    toNumRelaxed(pick(row, 'EO')), // eo
    toNumRelaxed(pick(row, 'EH')), // eh
    toNumRelaxed(pick(row, 'EL')), // el
    toNumRelaxed(pick(row, 'EC')), // ec
    toNumRelaxed(pick(row, 'AO')), // ao
    toNumRelaxed(pick(row, 'AH')), // ah
    toNumRelaxed(pick(row, 'AL')), // al
    toNumRelaxed(pick(row, 'AC')), // ac
    toNumRelaxed(pick(row, 'Vo')), // vo
    toNumRelaxed(pick(row, 'OI')), // oi
    toNumRelaxed(pick(row, 'Va')), // va
    toStr(pick(row, 'CM')), // contract_month
    toNumRelaxed(pick(row, 'Strike')), // strike_price
    toNumRelaxed(pick(row, 'VoOA')), // vo_oa
    toStr(pick(row, 'EmMrgnTrgDiv')), // em_mrgn_trg_div
    toStr(pick(row, 'PCDiv')), // pc_div
    toDateStr(pick(row, 'LTD')), // last_trading_date
    toDateStr(pick(row, 'SQD')), // sq_date
    toNumRelaxed(pick(row, 'Settle')), // settle_price
    toNumRelaxed(pick(row, 'Theo')), // theoretical_price
    toNumRelaxed(pick(row, 'BaseVol')), // base_volatility
    toNumRelaxed(pick(row, 'UnderPx')), // underlying_price
    toNumRelaxed(pick(row, 'IV')), // implied_volatility
    toNumRelaxed(pick(row, 'IR')), // interest_rate
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
  squashSpaces,
  clampText,
  getTruncationCount,
  resetTruncationCount,
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

  // 取引カレンダー・指数四本値関連
  CALENDAR_COLUMNS,
  CALENDAR_VALUE_EXPRESSIONS,
  CALENDAR_BIND_DEFS,
  mapCalendarRow,
  TOPIX_COLUMNS,
  TOPIX_VALUE_EXPRESSIONS,
  TOPIX_BIND_DEFS,
  mapTopixRow,
  INDEX_DAILY_COLUMNS,
  INDEX_DAILY_VALUE_EXPRESSIONS,
  INDEX_DAILY_BIND_DEFS,
  mapIndexDailyRow,

  // 投資部門別情報・決算発表予定日関連 (Tier 2)
  INVESTOR_TYPE_COLUMNS,
  INVESTOR_TYPE_VALUE_EXPRESSIONS,
  INVESTOR_TYPE_BIND_DEFS,
  mapInvestorTypeRow,
  EARNINGS_SCHEDULE_COLUMNS,
  EARNINGS_SCHEDULE_VALUE_EXPRESSIONS,
  EARNINGS_SCHEDULE_BIND_DEFS,
  mapEarningsScheduleRow,

  // 財務情報・日経225オプション四本値関連 (Tier 3)
  FINANCIAL_SUMMARY_COLUMNS,
  FINANCIAL_SUMMARY_VALUE_EXPRESSIONS,
  FINANCIAL_SUMMARY_BIND_DEFS,
  mapFinancialSummaryRow,
  OPTION_225_COLUMNS,
  OPTION_225_VALUE_EXPRESSIONS,
  OPTION_225_BIND_DEFS,
  mapOption225Row,
};
