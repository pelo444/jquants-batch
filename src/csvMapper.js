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

/** NULLを含む列でも型が確定するようbindDefsを明示する */
const MASTER_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 10 },  // code
  { type: oracledb.STRING, maxSize: 10 },  // as_of_date (TO_DATEに渡す文字列)
  { type: oracledb.STRING, maxSize: 200 }, // co_name
  { type: oracledb.STRING, maxSize: 200 }, // co_name_en
  { type: oracledb.STRING, maxSize: 4 },   // sector17_code
  { type: oracledb.STRING, maxSize: 100 }, // sector17_name
  { type: oracledb.STRING, maxSize: 4 },   // sector33_code
  { type: oracledb.STRING, maxSize: 100 }, // sector33_name
  { type: oracledb.STRING, maxSize: 50 },  // scale_category
  { type: oracledb.STRING, maxSize: 4 },   // market_code
  { type: oracledb.STRING, maxSize: 50 },  // market_name
  { type: oracledb.STRING, maxSize: 4 },   // margin_code
  { type: oracledb.STRING, maxSize: 50 },  // margin_name
  { type: oracledb.STRING, maxSize: 10 },  // prod_category
];

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

module.exports = {
  toStr,
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
};

