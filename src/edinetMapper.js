'use strict';

/**
 * EDINET系個別API(Bulk非対応)のJSONレスポンスを、DBの行配列に変換するマッパー。
 *
 * csvMapper.js が「Bulk CSVの1行(フラットな文字列の集まり)→1テーブルの1行」を
 * 前提にしているのに対し、こちらは「1書類分のネストしたJSON→親子5テーブル分の
 * 複数行」を1回で組み立てる必要がある点が根本的に違う。そのためcsvMapper.jsとは
 * 別ファイルに分けている。
 *
 * 値変換の基本方針(csvMapper.jsとの違い):
 *   CSVは全項目が文字列で来るため toStr()/toNum() 等は「空文字・'-' をNULL化する」
 *   役割を持つが、こちらはJSON由来ですでに number/string/null の型が付いている。
 *   toStr()はnull/undefinedをNULLにするだけで実害が無く、toNum()も
 *   Number(String(v))で数値化するだけなので、そのまま流用できる
 *   (ただし toNum() は文字列 '-' もNULL化する。EDINET由来のフィールドが
 *   '-' 1文字だけの値を取ることは無い想定だが、実データ確認時に一応注意すること)。
 */

const oracledb = require('oracledb');
const csvMapper = require('./csvMapper');

const { toStr, toNum, toDateStr, clampText } = csvMapper;

/**
 * 自由記述欄(氏名・住所・保有目的等)をclampText()に通す。
 *
 * 空売り残高報告(EQUITY_SHORT_POSITION)で、金融庁提出様式由来の桁揃え空白が
 * SSName/SSAddr等に混入していた前例がある(csvMapper.clampTextのコメント参照)。
 * 大量保有報告書も同じ系統の提出様式から来ているため、念のため同じ切り詰め処理を
 * 全ての自由記述欄に適用しておく(実データ未確認。過剰な切り詰めが起きていないかは
 * scripts/inspect-edinet-api.js での確認時にtruncationの警告有無で判断すること)。
 * @param {*} v 生値(文字列以外が来ることは想定していない)
 * @param {number} maxChars
 * @param {number} maxBytes
 * @param {string} columnLabel
 * @returns {string|null}
 */
function text(v, maxChars, maxBytes, columnLabel) {
  if (v === null || v === undefined) return null;
  return clampText(String(v), maxChars, maxBytes, columnLabel);
}

//------------------------------------------------------------------
// LARGE_VOLUME_SHAREHOLDER (書類メタ)
//------------------------------------------------------------------
const DOC_COLUMNS = [
  'doc_id',
  'code',
  'edinet_code',
  'isr_name',
  'doc_type_code',
  'sub_date',
  'sub_time',
  'large_hldg_type_code',
  'doc_title',
  'chg_rsn',
  'total_shs_held',
  'total_shs_ratio',
  'total_shs_ratio_last',
  'total_out_stks',
];

const DOC_VALUE_EXPRESSIONS = [
  null, null, null, null, null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null, null, null, null, null,
];

const DOC_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 80 },                   // doc_id
  { type: oracledb.STRING, maxSize: 40 },                   // code
  { type: oracledb.STRING, maxSize: 80 },                   // edinet_code
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 },  // isr_name
  { type: oracledb.STRING, maxSize: 40 },                   // doc_type_code
  { type: oracledb.STRING, maxSize: 10 },                   // sub_date (TO_DATEに渡す文字列)
  { type: oracledb.STRING, maxSize: 40 },                   // sub_time
  { type: oracledb.STRING, maxSize: 20 },                   // large_hldg_type_code
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 },  // doc_title
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // chg_rsn
  { type: oracledb.NUMBER },                                // total_shs_held
  { type: oracledb.NUMBER },                                // total_shs_ratio
  { type: oracledb.NUMBER },                                // total_shs_ratio_last
  { type: oracledb.NUMBER },                                // total_out_stks
];

function mapDocRow(doc) {
  return [
    toStr(doc.DocId),
    toStr(doc.Code),
    toStr(doc.EdinetCode),
    text(doc.IsrName, 400, 1600, 'IsrName'),
    toStr(doc.DocTypeCode),
    toDateStr(doc.SubDate),
    toStr(doc.SubTime),
    toStr(doc.LargeHldgTypeCode),
    text(doc.DocTitle, 400, 1600, 'DocTitle'),
    text(doc.ChgRsn, 1000, 4000, 'ChgRsn'),
    toNum(doc.TotalShsHeld),
    toNum(doc.TotalShsRatio),
    toNum(doc.TotalShsRatioLast),
    toNum(doc.TotalOutStks),
  ];
}

//------------------------------------------------------------------
// LARGE_VOLUME_SHAREHOLDER_HOLDER (Hldrs配列)
//------------------------------------------------------------------
const HOLDER_COLUMNS = [
  'doc_id',
  'hldr_seq',
  'hldr_name',
  'hldr_name_en',
  'hldr_edinet_code',
  'hldr_code',
  'large_hldr_type_code',
  'large_hldr_type_raw',
  'hldg_purp',
  'imp_prop',
  'col_agr',
  'shs_held',
  'shs_ratio',
  'shs_ratio_last',
  'own_fund',
  'total_brw',
  'total_other',
  'other_brk',
  'total_fund',
];

const HOLDER_VALUE_EXPRESSIONS = new Array(HOLDER_COLUMNS.length).fill(null);

const HOLDER_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 80 },                   // doc_id
  { type: oracledb.NUMBER },                                // hldr_seq
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 },  // hldr_name
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 },  // hldr_name_en
  { type: oracledb.STRING, maxSize: 80 },                   // hldr_edinet_code
  { type: oracledb.STRING, maxSize: 40 },                   // hldr_code
  { type: oracledb.STRING, maxSize: 20 },                   // large_hldr_type_code
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 },   // large_hldr_type_raw
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // hldg_purp
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // imp_prop
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // col_agr
  { type: oracledb.NUMBER },                                // shs_held
  { type: oracledb.NUMBER },                                // shs_ratio
  { type: oracledb.NUMBER },                                // shs_ratio_last
  { type: oracledb.NUMBER },                                // own_fund
  { type: oracledb.NUMBER },                                // total_brw
  { type: oracledb.NUMBER },                                // total_other
  { type: oracledb.STRING, maxSize: 4000, maxChars: 1000 }, // other_brk
  { type: oracledb.NUMBER },                                // total_fund
];

function mapHolderRow(docId, hldrSeq, h) {
  return [
    docId,
    hldrSeq,
    text(h.HldrName, 400, 1600, 'HldrName'),
    text(h.HldrNameEn, 400, 1600, 'HldrNameEn'),
    toStr(h.HldrEdinetCode),
    toStr(h.HldrCode),
    toStr(h.LargeHldrTypeCode),
    text(h.LargeHldrTypeRaw, 200, 800, 'LargeHldrTypeRaw'),
    text(h.HldgPurp, 1000, 4000, 'HldgPurp'),
    text(h.ImpProp, 1000, 4000, 'ImpProp'),
    text(h.ColAgr, 1000, 4000, 'ColAgr'),
    toNum(h.ShsHeld),
    toNum(h.ShsRatio),
    toNum(h.ShsRatioLast),
    toNum(h.OwnFund),
    toNum(h.TotalBrw),
    toNum(h.TotalOther),
    text(h.OtherBrk, 1000, 4000, 'OtherBrk'),
    toNum(h.TotalFund),
  ];
}

//------------------------------------------------------------------
// LARGE_VOLUME_SHAREHOLDER_ACQ_DISP (Hldrs[].AcqDisp配列)
//------------------------------------------------------------------
const ACQ_DISP_COLUMNS = [
  'doc_id',
  'hldr_seq',
  'acq_seq',
  'acq_date',
  'sec_type',
  'shs',
  'ratio',
  'mkt',
  'mkt_code',
  'txn_type',
  'txn_type_code',
  'cptty',
  'price',
  'price_raw',
];

const ACQ_DISP_VALUE_EXPRESSIONS = [
  null, null, null,
  "TO_DATE(?, 'YYYY-MM-DD')",
  null, null, null, null, null, null, null, null, null, null,
];

const ACQ_DISP_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 80 },                 // doc_id
  { type: oracledb.NUMBER },                              // hldr_seq
  { type: oracledb.NUMBER },                              // acq_seq
  { type: oracledb.STRING, maxSize: 10 },                 // acq_date
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 }, // sec_type
  { type: oracledb.NUMBER },                              // shs
  { type: oracledb.NUMBER },                              // ratio
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 }, // mkt
  { type: oracledb.STRING, maxSize: 20 },                 // mkt_code
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 }, // txn_type
  { type: oracledb.STRING, maxSize: 20 },                 // txn_type_code
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 },// cptty
  { type: oracledb.NUMBER },                              // price
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 }, // price_raw
];

function mapAcqDispRow(docId, hldrSeq, acqSeq, a) {
  return [
    docId,
    hldrSeq,
    acqSeq,
    toDateStr(a.Date),
    text(a.SecType, 200, 800, 'AcqDisp.SecType'),
    toNum(a.Shs),
    toNum(a.Ratio),
    text(a.Mkt, 200, 800, 'AcqDisp.Mkt'),
    toStr(a.MktCode),
    text(a.TxnType, 200, 800, 'AcqDisp.TxnType'),
    toStr(a.TxnTypeCode),
    text(a.Cptty, 400, 1600, 'AcqDisp.Cptty'),
    toNum(a.Price),
    toStr(a.PriceRaw),
  ];
}

//------------------------------------------------------------------
// LARGE_VOLUME_SHAREHOLDER_BORROWING (Hldrs[].BrwList配列)
//------------------------------------------------------------------
const BORROWING_COLUMNS = [
  'doc_id',
  'hldr_seq',
  'brw_seq',
  'brw_name',
  'brw_ind',
  'brw_rep',
  'brw_addr',
  'disc_brw_purp',
  'amt',
];

const BORROWING_VALUE_EXPRESSIONS = new Array(BORROWING_COLUMNS.length).fill(null);

const BORROWING_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 80 },                  // doc_id
  { type: oracledb.NUMBER },                               // hldr_seq
  { type: oracledb.NUMBER },                               // brw_seq
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 }, // brw_name
  { type: oracledb.STRING, maxSize: 800, maxChars: 200 },  // brw_ind
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 }, // brw_rep
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 }, // brw_addr
  { type: oracledb.STRING, maxSize: 20 },                  // disc_brw_purp
  { type: oracledb.NUMBER },                               // amt
];

function mapBorrowingRow(docId, hldrSeq, brwSeq, b) {
  return [
    docId,
    hldrSeq,
    brwSeq,
    text(b.Name, 400, 1600, 'BrwList.Name'),
    text(b.Ind, 200, 800, 'BrwList.Ind'),
    text(b.Rep, 400, 1600, 'BrwList.Rep'),
    text(b.Addr, 400, 1600, 'BrwList.Addr'),
    toStr(b.DiscBrwPurp),
    toNum(b.Amt),
  ];
}

//------------------------------------------------------------------
// LARGE_VOLUME_SHAREHOLDER_CREDITOR (Hldrs[].CredList配列)
//------------------------------------------------------------------
const CREDITOR_COLUMNS = ['doc_id', 'hldr_seq', 'cred_seq', 'cred_name', 'cred_rep', 'cred_addr'];

const CREDITOR_VALUE_EXPRESSIONS = new Array(CREDITOR_COLUMNS.length).fill(null);

const CREDITOR_BIND_DEFS = [
  { type: oracledb.STRING, maxSize: 80 },                  // doc_id
  { type: oracledb.NUMBER },                               // hldr_seq
  { type: oracledb.NUMBER },                               // cred_seq
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 }, // cred_name
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 }, // cred_rep
  { type: oracledb.STRING, maxSize: 1600, maxChars: 400 }, // cred_addr
];

function mapCreditorRow(docId, hldrSeq, credSeq, c) {
  return [
    docId,
    hldrSeq,
    credSeq,
    text(c.Name, 400, 1600, 'CredList.Name'),
    text(c.Rep, 400, 1600, 'CredList.Rep'),
    text(c.Addr, 400, 1600, 'CredList.Addr'),
  ];
}

//------------------------------------------------------------------
// 書類単位のJSON → 5テーブル分のrowsへの展開
//------------------------------------------------------------------

/**
 * 1書類分のJSON(large-volume-shareholders APIレスポンスのdata配列要素1件)を、
 * bulkInsert可能な行配列に展開する。
 * @param {object} doc
 * @returns {{
 *   docRow: any[],
 *   holderRows: any[][],
 *   acqDispRows: any[][],
 *   borrowingRows: any[][],
 *   creditorRows: any[][],
 * }}
 */
function mapLargeVolumeShareholderDoc(doc) {
  const docId = toStr(doc.DocId);
  const docRow = mapDocRow(doc);

  const holderRows = [];
  const acqDispRows = [];
  const borrowingRows = [];
  const creditorRows = [];

  const holders = Array.isArray(doc.Hldrs) ? doc.Hldrs : [];
  holders.forEach((h, i) => {
    const hldrSeq = i + 1;
    holderRows.push(mapHolderRow(docId, hldrSeq, h));

    (Array.isArray(h.AcqDisp) ? h.AcqDisp : []).forEach((a, j) => {
      acqDispRows.push(mapAcqDispRow(docId, hldrSeq, j + 1, a));
    });
    (Array.isArray(h.BrwList) ? h.BrwList : []).forEach((b, j) => {
      borrowingRows.push(mapBorrowingRow(docId, hldrSeq, j + 1, b));
    });
    (Array.isArray(h.CredList) ? h.CredList : []).forEach((c, j) => {
      creditorRows.push(mapCreditorRow(docId, hldrSeq, j + 1, c));
    });
  });

  return { docRow, holderRows, acqDispRows, borrowingRows, creditorRows };
}

module.exports = {
  DOC_COLUMNS,
  DOC_VALUE_EXPRESSIONS,
  DOC_BIND_DEFS,
  HOLDER_COLUMNS,
  HOLDER_VALUE_EXPRESSIONS,
  HOLDER_BIND_DEFS,
  ACQ_DISP_COLUMNS,
  ACQ_DISP_VALUE_EXPRESSIONS,
  ACQ_DISP_BIND_DEFS,
  BORROWING_COLUMNS,
  BORROWING_VALUE_EXPRESSIONS,
  BORROWING_BIND_DEFS,
  CREDITOR_COLUMNS,
  CREDITOR_VALUE_EXPRESSIONS,
  CREDITOR_BIND_DEFS,
  mapLargeVolumeShareholderDoc,
};
