'use strict';

/**
 * 楽天証券「取引履歴(国内株式)」CSV の解析。DBには触らない純粋な関数だけを置く。
 *
 * 【列の取り方】
 *   列の並びではなく見出しの名前で取る。楽天のCSVは見出しに単位が付く
 *   (「数量［株］」「単価［円］」など)ので、括弧と単位・空白を落としてから照合する。
 *   知らない列は捨てずに raw_json に残す(後で解釈を直せるように)。
 *   必須の列(約定日・銘柄コード・売買区分・数量・単価)が無ければエラーにする
 *   (米国株や投資信託のCSVを間違えて入れたときに、黙って0件にしない)。
 *
 * 【文字コード】
 *   楽天のCSVは Shift_JIS。UTF-8(BOMあり・なし)も受け付ける。
 *   UTF-8 として不正なバイト列があれば Shift_JIS とみなす。
 *
 * 【重複の判定】
 *   期間が重なるCSVを何度入れても同じ約定が増えないように、行の内容のハッシュに
 *   「同じファイル内で同じ内容の何件目か」を足したものを dedup_key にする
 *   (同じ日・同じ値段・同じ数量の約定が2件ある場合を区別するため)。
 *   楽天のCSVは約定日の範囲で切り出すので、同じ日の約定は常に全部入っている前提。
 */

const crypto = require('crypto');
const { parse } = require('csv-parse/sync');

const SOURCE = 'RAKUTEN_JP_STOCK';

/** 見出しの正規化: 空白・全角/半角の括弧と中身(単位)を落とす */
function normHeader(h) {
  return String(h || '')
    .replace(/^﻿/, '')
    .replace(/[［\[（(【〔].*?[］\]）)】〕]/g, '')
    .replace(/[\s　"]/g, '')
    .trim();
}

// 正規化後の見出し → 内部の名前。同じ意味で表記違いがあるものは並べておく。
const HEADER_MAP = {
  約定日: 'tradeDate',
  受渡日: 'settleDate',
  銘柄コード: 'code',
  銘柄名: 'name',
  銘柄: 'name',
  市場名称: 'market',
  市場: 'market',
  口座区分: 'accountType',
  口座: 'accountType',
  取引区分: 'tradeType',
  取引: 'tradeType',
  売買区分: 'sideRaw',
  売買: 'sideRaw',
  信用区分: 'marginType',
  弁済期限: 'repayTerm',
  数量: 'qty',
  単価: 'price',
  手数料: 'fee',
  税金等: 'tax',
  税金: 'tax',
  諸費用: 'otherCost',
  税区分: 'taxType',
  受渡金額: 'settleAmount',
  受渡金額決済損益: 'settleAmount',
  '受渡金額/決済損益': 'settleAmount',
  '受渡金額・決済損益': 'settleAmount',
  建約定日: 'openDate',
  建単価: 'openPrice',
};

const REQUIRED = ['tradeDate', 'code', 'sideRaw', 'qty', 'price'];
const REQUIRED_LABEL = {
  tradeDate: '約定日', code: '銘柄コード', sideRaw: '売買区分', qty: '数量', price: '単価',
};

class CsvError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** バイト列を文字列にする。UTF-8 として読めなければ Shift_JIS */
function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch (e) {
    const text = new TextDecoder('shift_jis').decode(buf);
    return { text, encoding: 'shift_jis' };
  }
}

/** "1,234" "－" "" "-" → 数値 または null */
function toNum(v) {
  if (v === undefined || v === null) return null;
  const s = String(v)
    .replace(/[,\s　円株]/g, '')
    .replace(/[－−―]/g, '-')
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "2026/7/28" "2026-07-28" "20260728" → "2026-07-28" または null */
function toDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** 4桁(英字入りを含む)は末尾に0を付けて J-Quants の5桁に揃える */
function toCode(v) {
  const s = String(v || '').trim().toUpperCase().replace(/[０-９Ａ-Ｚ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^[0-9A-Z]{4}$/.test(s)) return s + '0';
  if (/^[0-9A-Z]{5}$/.test(s)) return s;
  return null;
}

/**
 * 取引区分・売買区分から、建玉のどちら側に効くかを決める。
 *   現物の買付/売付 → CASH の OPEN/CLOSE
 *   信用新規の買建/売建 → MLONG/MSHORT の OPEN
 *   信用返済の売埋/買埋 → MLONG/MSHORT の CLOSE
 *   現引(買建玉を現物で引き取る) → MLONG の CONVERT(建玉が閉じて現物が増える)
 *   現渡(売建玉に現物を渡す)     → MSHORT の CONVERT(建玉が閉じて現物が減る)
 *   入庫 / 出庫 → CASH の DEPOSIT / WITHDRAW(分割で増えた株、または他社からの移管)
 * 解釈できなければ null(取込時にエラー行として返す)。
 */
function classify(tradeType, sideRaw) {
  const t = String(tradeType || '');
  const s = String(sideRaw || '');
  // 入庫・出庫(取引区分は空)。楽天は株式分割で増えた株も「入庫」で記録する(単価は分割後の取得単価)。
  // 分割か移管かはここでは決めず、保有計算で DB の分割日と突き合わせる(journalPositions.js)
  if (s.includes('入庫')) return { side: 'B', kind: 'CASH', effect: 'DEPOSIT' };
  if (s.includes('出庫')) return { side: 'S', kind: 'CASH', effect: 'WITHDRAW' };
  if (s.includes('現引') || t.includes('現引')) return { side: 'B', kind: 'MLONG', effect: 'CONVERT' };
  if (s.includes('現渡') || t.includes('現渡')) return { side: 'S', kind: 'MSHORT', effect: 'CONVERT' };
  if (s.includes('買建')) return { side: 'B', kind: 'MLONG', effect: 'OPEN' };
  if (s.includes('売建')) return { side: 'S', kind: 'MSHORT', effect: 'OPEN' };
  if (s.includes('売埋')) return { side: 'S', kind: 'MLONG', effect: 'CLOSE' };
  if (s.includes('買埋')) return { side: 'B', kind: 'MSHORT', effect: 'CLOSE' };
  if (t.includes('信用')) {
    // 売買区分が「買」「売」だけの場合は取引区分の新規/返済で決める
    const buy = s.includes('買');
    const sell = s.includes('売');
    if (t.includes('新規')) {
      if (buy) return { side: 'B', kind: 'MLONG', effect: 'OPEN' };
      if (sell) return { side: 'S', kind: 'MSHORT', effect: 'OPEN' };
    }
    if (t.includes('返済')) {
      if (sell) return { side: 'S', kind: 'MLONG', effect: 'CLOSE' };
      if (buy) return { side: 'B', kind: 'MSHORT', effect: 'CLOSE' };
    }
    return null;
  }
  if (s.includes('買')) return { side: 'B', kind: 'CASH', effect: 'OPEN' };
  if (s.includes('売')) return { side: 'S', kind: 'CASH', effect: 'CLOSE' };
  return null;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * CSV を解析する。
 * @param {Buffer} buf ファイルの中身
 * @returns {{encoding:string, headers:string[], unknownHeaders:string[], trades:object[], errors:object[]}}
 */
function parseRakutenCsv(buf) {
  const { text, encoding } = decode(buf);
  let records;
  try {
    records = parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true });
  } catch (e) {
    throw new CsvError(`CSVとして読めませんでした: ${e.message}`);
  }

  // 見出し行を探す(先頭に説明行がある形式にも耐えるよう、最初の10行から探す)
  let hIdx = -1;
  for (let i = 0; i < Math.min(records.length, 10); i++) {
    const norm = records[i].map(normHeader);
    if (norm.includes('約定日') && norm.includes('銘柄コード')) {
      hIdx = i;
      break;
    }
  }
  if (hIdx < 0) {
    const first = (records[0] || []).slice(0, 12).join(' / ');
    throw new CsvError(
      '「約定日」と「銘柄コード」の列が見つかりません。楽天証券の「取引履歴 → 国内株式」の' +
        `CSVか確認してください(先頭行: ${first || '空'})`
    );
  }

  const headers = records[hIdx].map((h) => String(h).replace(/^﻿/, '').trim());
  const fieldOf = headers.map((h) => HEADER_MAP[normHeader(h)] || null);
  const unknownHeaders = headers.filter((h, i) => !fieldOf[i] && h !== '');
  const present = new Set(fieldOf.filter(Boolean));
  const missing = REQUIRED.filter((f) => !present.has(f));
  if (missing.length) {
    throw new CsvError(
      `必須の列がありません: ${missing.map((f) => REQUIRED_LABEL[f]).join('、')}` +
        `(見つかった列: ${headers.join('、')})`
    );
  }

  const trades = [];
  const errors = [];
  const seen = new Map();

  for (let r = hIdx + 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.every((v) => String(v).trim() === '')) continue;
    const raw = {};
    const f = {};
    headers.forEach((h, i) => {
      const v = rec[i] === undefined ? '' : String(rec[i]).trim();
      raw[h || `col${i + 1}`] = v;
      if (fieldOf[i] && f[fieldOf[i]] === undefined) f[fieldOf[i]] = v;
    });
    const line = r + 1;

    const tradeDate = toDate(f.tradeDate);
    const code = toCode(f.code);
    const qty = toNum(f.qty);
    const price = toNum(f.price);
    const cls = classify(f.tradeType, f.sideRaw);
    const problems = [];
    if (!tradeDate) problems.push(`約定日「${f.tradeDate}」`);
    if (!code) problems.push(`銘柄コード「${f.code}」`);
    if (qty === null || qty <= 0) problems.push(`数量「${f.qty}」`);
    if (price === null || price < 0) problems.push(`単価「${f.price}」`);
    if (!cls) problems.push(`取引区分「${f.tradeType || ''}」/売買区分「${f.sideRaw}」`);
    if (problems.length) {
      errors.push({ line, message: `解釈できません: ${problems.join('、')}`, raw });
      continue;
    }

    const t = {
      source: SOURCE,
      tradeDate,
      settleDate: toDate(f.settleDate),
      code,
      name: f.name || null,
      market: f.market || null,
      accountType: f.accountType || null,
      tradeType: f.tradeType || null,
      sideRaw: f.sideRaw || null,
      side: cls.side,
      positionKind: cls.kind,
      positionEffect: cls.effect,
      marginType: f.marginType || null,
      qty,
      price,
      fee: toNum(f.fee),
      tax: toNum(f.tax),
      otherCost: toNum(f.otherCost),
      settleAmount: toNum(f.settleAmount),
      taxType: f.taxType || null,
      raw,
      line,
    };

    // 内容が同じ行の何件目か、を足して重複判定のキーにする
    const content = JSON.stringify([
      t.tradeDate, t.settleDate, t.code, t.accountType, t.tradeType, t.sideRaw, t.marginType,
      t.qty, t.price, t.fee, t.tax, t.otherCost, t.settleAmount,
    ]);
    const n = (seen.get(content) || 0) + 1;
    seen.set(content, n);
    t.dedupKey = `RK1:${sha256(content).slice(0, 48)}#${n}`;
    trades.push(t);
  }

  return { encoding, headers, unknownHeaders, trades, errors };
}

module.exports = {
  SOURCE,
  CsvError,
  parseRakutenCsv,
  // テスト用
  _internal: { normHeader, decode, toNum, toDate, toCode, classify },
};
