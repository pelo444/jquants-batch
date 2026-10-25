'use strict';

/**
 * 企業名の一部から銘柄コードを引く(騰落率一覧の「銘柄コード」タブ、銘柄購入の購入検討銘柄で使う)。
 *
 * 【方式】上場中の銘柄マスタ(数千行)を一度だけ読んでメモリに持ち、文字を打つたびの検索はメモリ上で行う。
 *   1文字打つごとに DB へ問い合わせない。マスタは日次でしか変わらないので、読み直しは server.js のキャッシュ期限に任せる。
 *
 * 【照合のそろえ方】入力とマスタの両方に同じ normalize() をかけてから部分一致を見る。
 *   - 全角英数・半角カナ → NFKC で統一(「ＴＯＹＯＴＡ」「ﾄﾖﾀ」も当たる)
 *   - カタカナ → ひらがな(変換前の「とよた」でも「トヨタ」に当たる)
 *   - 英字は小文字、空白と「・」は無視
 *   - 「ホールディングス」「HD」「株式会社」の差は吸収しない(「HD」で「ホールディングス」は出ない)
 *
 * 【並び順】コードの前方一致 → 会社名の前方一致 → 会社名の途中に一致 → 英語名に一致。同じ段の中はコード順。
 */

const oracledb = require('oracledb');

const LIMIT_DEFAULT = 20;

function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s・]+/g, '');
}

/** 4桁で出す(67520 → 6752)。画面の表示と同じ */
function shortCode(c) { return c && c.length === 5 && c[4] === '0' ? c.slice(0, 4) : c; }

/** 上場中の銘柄。ETF・REIT も含める(騰落率一覧では ETF も見るため) */
async function fetchStockNames(conn) {
  const r = await conn.execute(
    `SELECT code, co_name, co_name_en, market_name
     FROM equity_master
     WHERE delisted_flag = 'N'
     ORDER BY code`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows.map((x) => ({
    code: x.CODE, name: x.CO_NAME, nameEn: x.CO_NAME_EN || '', market: x.MARKET_NAME || '',
  }));
}

/** 照合用の文字列を前もって作っておく(検索のたびに作らない) */
function buildIndex(rows) {
  const sorted = rows.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return sorted.map((r) => ({
    code: r.code,
    shortCode: shortCode(r.code),
    name: r.name,
    market: r.market,
    keyName: normalize(r.name),
    keyEn: normalize(r.nameEn),
    keyCode: shortCode(r.code).toLowerCase(),
  }));
}

/**
 * @param {object[]} index buildIndex() の戻り値
 * @param {string} q 入力
 * @param {number} [limit]
 * @returns {{items: object[], total: number}} total は一致した件数(items は先頭 limit 件)
 */
function search(index, q, limit) {
  const key = normalize(q);
  const max = limit || LIMIT_DEFAULT;
  if (!key) return { items: [], total: 0 };
  const ranked = [];
  for (const r of index) {
    let rank = -1;
    if (r.keyCode.startsWith(key)) rank = 0;
    else if (r.keyName.startsWith(key)) rank = 1;
    else if (r.keyName.includes(key)) rank = 2;
    else if (r.keyEn.includes(key)) rank = 3;
    if (rank >= 0) ranked.push({ rank, r });
  }
  // index はコード順なので、段ごとに安定ソートすれば同じ段の中はコード順のまま
  ranked.sort((a, b) => a.rank - b.rank);
  return {
    total: ranked.length,
    items: ranked.slice(0, max).map(({ r }) => ({
      code: r.code, shortCode: r.shortCode, name: r.name, market: r.market,
    })),
  };
}

module.exports = { normalize, fetchStockNames, buildIndex, search, LIMIT_DEFAULT };
