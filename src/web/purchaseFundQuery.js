'use strict';

/**
 * 購入の流れ b) ファンダメンタル参考情報のデータ取得。判定は src/web/fundamentals.js(純粋関数)。
 *
 * 【業種内の比較(No11 営業利益率・No12 自己資本比率)と PER の中央値】
 *   上場中の全銘柄(33業種「その他」= ETF・REIT 等を除く)について、
 *     営業利益率   直近の本決算の 営業利益 ÷ 売上高
 *     自己資本比率 直近の決算短信の値
 *     予想PER      最新の終値 ÷ 最新の会社予想EPS(分割補正あり。EPS が0以下は除く)
 *   を出し、33業種ごとに並べる。上場銘柄が20社未満の33業種は、17業種でまとめて比べる
 *   (claude/purchase_flow_design.md)。全銘柄を走査するので30分キャッシュする(server.js 側)。
 */

const oracledb = require('oracledb');
const { revisionFromRow } = require('../lossChecks');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const SMALL_SECTOR = 20;

function inBinds(prefix, values) {
  const binds = {};
  const sql = values.map((v, i) => { binds[prefix + i] = v; return ':' + prefix + i; }).join(',');
  return { sql, binds };
}

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 決算短信・予想修正の行(直近5年) */
async function fetchFinancialRows(conn, codes) {
  const b = inBinds('c', codes);
  const r = await conn.execute(
    `SELECT code, disc_date, disc_no, doc_type, cur_per_type, cur_per_en, cur_fy_en, nxt_fy_en,
            sales, op, odp, np, eps, bps, eq_ar, cfo, roe, div_ann,
            f_sales, f_op, f_odp, f_np, f_eps, f_div_ann,
            nxf_sales, nxf_op, nxf_odp, nxf_np, nxf_eps, nxf_div_ann
       FROM financial_summary
      WHERE code IN (${b.sql}) AND disc_date >= ADD_MONTHS(TRUNC(SYSDATE), -60)
      ORDER BY code, disc_date, disc_no`, b.binds, OBJ);
  const by = {};
  for (const x of r.rows) {
    (by[x.CODE] = by[x.CODE] || []).push({
      discDate: iso(x.DISC_DATE), discNo: x.DISC_NO, docType: x.DOC_TYPE, perType: x.CUR_PER_TYPE,
      perEn: iso(x.CUR_PER_EN), fyEn: iso(x.CUR_FY_EN), nxtFyEn: iso(x.NXT_FY_EN),
      sales: x.SALES, op: x.OP, odp: x.ODP, np: x.NP, eps: x.EPS, bps: x.BPS, eqAr: x.EQ_AR, cfo: x.CFO,
      roe: x.ROE, divAnn: x.DIV_ANN,
      fSales: x.F_SALES, fOp: x.F_OP, fOdp: x.F_ODP, fNp: x.F_NP, fEps: x.F_EPS, fDivAnn: x.F_DIV_ANN,
      nxfSales: x.NXF_SALES, nxfOp: x.NXF_OP, nxfOdp: x.NXF_ODP, nxfNp: x.NXF_NP, nxfEps: x.NXF_EPS, nxfDivAnn: x.NXF_DIV_ANN,
    });
  }
  return by;
}

/** 最新の終値と、分割(AdjFactor ≠ 1)の日・係数(直近6年) */
async function fetchPriceAndSplits(conn, codes) {
  const b = inBinds('c', codes);
  const last = await conn.execute(
    `SELECT code, MAX(price_date) KEEP (DENSE_RANK LAST ORDER BY price_date) AS d,
            MAX(close_price) KEEP (DENSE_RANK LAST ORDER BY price_date) AS c
       FROM equity_price_daily
      WHERE code IN (${b.sql}) AND close_price IS NOT NULL AND price_date >= TRUNC(SYSDATE) - 60
      GROUP BY code`, b.binds, OBJ);
  const spl = await conn.execute(
    `SELECT code, price_date, adj_factor FROM equity_price_daily
      WHERE code IN (${b.sql}) AND adj_factor <> 1 AND price_date >= ADD_MONTHS(TRUNC(SYSDATE), -72)
      ORDER BY code, price_date`, b.binds, OBJ);
  const out = {};
  for (const c of codes) out[c] = { close: null, priceDate: null, splits: [] };
  for (const x of last.rows) { out[x.CODE].close = x.C; out[x.CODE].priceDate = iso(x.D); }
  for (const x of spl.rows) out[x.CODE].splits.push({ date: iso(x.PRICE_DATE), af: x.ADJ_FACTOR });
  return out;
}

/**
 * 直近 days 日の営業利益予想の変更。修正幅 REV の定義は lossChecks の Ch4 と同じ。
 * Ch4 と違い、本決算の翌期予想(NXF_OP)も「直前の予想」に含める。こうしないと、
 * 1Q の決算短信で今期予想を上げた(下げた)場合に、比べる相手がなくて拾えない。
 * 決算短信での予想変更は検証の対象外(verified=false)として返す。
 */
async function fetchRevisions(conn, codes, days) {
  const b = inBinds('c', codes);
  const r = await conn.execute(
    `SELECT * FROM (
        SELECT code, disc_date, doc_type, fy, fop, fsales,
               LAG(fop) OVER (PARTITION BY code, fy ORDER BY disc_date, disc_time, disc_no) AS prev_op
          FROM (
            SELECT code, disc_date, disc_time, disc_no, doc_type, cur_fy_en AS fy, f_op AS fop, f_sales AS fsales
              FROM financial_summary
             WHERE code IN (${b.sql}) AND f_op IS NOT NULL
            UNION ALL
            SELECT code, disc_date, disc_time, disc_no, doc_type, nxt_fy_en, nxf_op, nxf_sales
              FROM financial_summary
             WHERE code IN (${b.sql}) AND cur_per_type = 'FY' AND doc_type LIKE '%FinancialStatements%'
               AND nxf_op IS NOT NULL))
      WHERE disc_date >= TRUNC(SYSDATE) - :days
      ORDER BY code, disc_date DESC`, { ...b.binds, days }, OBJ);
  const by = {};
  for (const x of r.rows) {
    const rv = revisionFromRow({
      discDate: iso(x.DISC_DATE), docType: x.DOC_TYPE, fyEn: iso(x.FY), fOp: x.FOP, fSales: x.FSALES, prevOp: x.PREV_OP,
    });
    if (rv.kind) (by[x.CODE] = by[x.CODE] || []).push(rv);
  }
  return by;
}

/**
 * 業種内の比較に使う全銘柄の値。
 * @returns {{groups: {[key:string]: {name, opm:number[], eqar:number[], per:number[]}}, codeGroup: {[code:string]: string}, marketPerMedian: number|null}}
 */
async function fetchIndustryStats(conn) {
  const r = await conn.execute(
    `WITH lastd AS (SELECT MAX(price_date) d FROM equity_price_daily),
     em AS (
        SELECT code, sector33_code s33, sector33_name n33, sector17_code s17, sector17_name n17
          FROM equity_master
         WHERE delisted_flag = 'N' AND sector33_code IS NOT NULL AND sector33_code <> '9999'
           AND (market_name IS NULL OR market_name <> 'TOKYO PRO MARKET')),
     st AS (
        SELECT f.code, f.cur_per_type, f.op, f.sales, f.eq_ar,
               ROW_NUMBER() OVER (PARTITION BY f.code
                   ORDER BY f.cur_per_en DESC, CASE WHEN f.doc_type LIKE '%NonConsolidated%' THEN 1 ELSE 0 END,
                            f.disc_date DESC, f.disc_no DESC) AS r_any,
               ROW_NUMBER() OVER (PARTITION BY f.code, CASE WHEN f.cur_per_type = 'FY' THEN 1 ELSE 0 END
                   ORDER BY f.cur_per_en DESC, CASE WHEN f.doc_type LIKE '%NonConsolidated%' THEN 1 ELSE 0 END,
                            f.disc_date DESC, f.disc_no DESC) AS r_fy
          FROM financial_summary f
         WHERE f.doc_type LIKE '%FinancialStatements%' AND f.code IN (SELECT code FROM em)),
     fy AS (SELECT code, CASE WHEN sales > 0 THEN op / sales * 100 END AS opm FROM st WHERE cur_per_type = 'FY' AND r_fy = 1),
     eq AS (SELECT code, eq_ar * 100 AS eqar FROM st WHERE r_any = 1),
     fc AS (
        SELECT code, disc_date, eps FROM (
            SELECT f.code, f.disc_date,
                   CASE WHEN f.cur_per_type = 'FY' AND f.doc_type LIKE '%FinancialStatements%' THEN f.nxf_eps ELSE f.f_eps END AS eps,
                   ROW_NUMBER() OVER (PARTITION BY f.code ORDER BY f.disc_date DESC, f.disc_no DESC) AS r
              FROM financial_summary f
             WHERE f.code IN (SELECT code FROM em)
               AND (f.f_eps IS NOT NULL
                    OR (f.cur_per_type = 'FY' AND f.doc_type LIKE '%FinancialStatements%' AND f.nxf_eps IS NOT NULL)))
        WHERE r = 1),
     spl AS (
        SELECT fc.code, EXP(SUM(LN(NULLIF(p.adj_factor, 0)))) AS prodf
          FROM fc JOIN equity_price_daily p ON p.code = fc.code AND p.price_date > fc.disc_date AND p.adj_factor <> 1
         GROUP BY fc.code),
     px AS (SELECT p.code, p.close_price c FROM equity_price_daily p, lastd WHERE p.price_date = lastd.d)
     SELECT em.code, em.s33, em.n33, em.s17, em.n17, fy.opm, eq.eqar,
            CASE WHEN fc.eps > 0 AND px.c IS NOT NULL THEN px.c / (fc.eps * NVL(spl.prodf, 1)) END AS per
       FROM em
       LEFT JOIN fy ON fy.code = em.code
       LEFT JOIN eq ON eq.code = em.code
       LEFT JOIN fc ON fc.code = em.code
       LEFT JOIN spl ON spl.code = em.code
       LEFT JOIN px ON px.code = em.code`, {}, OBJ);

  const count33 = {};
  for (const x of r.rows) count33[x.S33] = (count33[x.S33] || 0) + 1;
  const groups = {};
  const codeGroup = {};
  const allPer = [];
  for (const x of r.rows) {
    const small = count33[x.S33] < SMALL_SECTOR;
    const key = small ? 'S17:' + x.S17 : 'S33:' + x.S33;
    const name = small ? `${x.N17}(17業種でまとめて比較)` : x.N33;
    const g = (groups[key] = groups[key] || { name, opm: [], eqar: [], per: [] });
    if (x.OPM != null) g.opm.push(x.OPM);
    if (x.EQAR != null) g.eqar.push(x.EQAR);
    if (x.PER != null) { g.per.push(x.PER); allPer.push(x.PER); }
    codeGroup[x.CODE] = key;
  }
  allPer.sort((a, b) => a - b);
  const n = allPer.length;
  const marketPerMedian = n ? (n % 2 ? allPer[(n - 1) / 2] : (allPer[n / 2 - 1] + allPer[n / 2]) / 2) : null;
  return { groups, codeGroup, marketPerMedian };
}

//------------------------------------------------------------------
// テクニカル(src/web/technicals.js が使う)
//------------------------------------------------------------------

/** 日足の四本値・出来高・調整係数(直近約450日 = 250営業日と、年初来・RSI の助走) */
async function fetchDailyOhlc(conn, codes) {
  const b = inBinds('c', codes);
  const r = await conn.execute(
    `SELECT code, price_date, open_price, high_price, low_price, close_price, volume, adj_factor
       FROM equity_price_daily
      WHERE code IN (${b.sql}) AND price_date >= TRUNC(SYSDATE) - 450 AND close_price IS NOT NULL
      ORDER BY code, price_date`, b.binds, OBJ);
  const by = {};
  for (const c of codes) by[c] = [];
  for (const x of r.rows) {
    by[x.CODE].push({
      date: iso(x.PRICE_DATE), o: x.OPEN_PRICE, h: x.HIGH_PRICE, l: x.LOW_PRICE, c: x.CLOSE_PRICE,
      v: x.VOLUME, af: x.ADJ_FACTOR,
    });
  }
  return by;
}

/** 最新の信用残(株数)。直近60日に無ければ返さない */
async function fetchMarginLatest(conn, codes) {
  const b = inBinds('c', codes);
  const r = await conn.execute(
    `SELECT code, app_date, long_vol, shrt_vol FROM (
        SELECT code, app_date, long_vol, shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY code ORDER BY app_date DESC) AS rn
          FROM equity_margin_interest
         WHERE code IN (${b.sql}) AND app_date >= TRUNC(SYSDATE) - 60)
      WHERE rn = 1`, b.binds, OBJ);
  const by = {};
  for (const x of r.rows) by[x.CODE] = { date: iso(x.APP_DATE), long: x.LONG_VOL, shrt: x.SHRT_VOL };
  return by;
}

//------------------------------------------------------------------
// 外す候補(追加下落スコアの上位10%)
//------------------------------------------------------------------

/**
 * 追加下落スコア(claude/downside_risk_rank_backtest.md)の上位10%(D10)を、最新の株価で出す。
 *
 * 検証と同じ定義:
 *   母集団   売買代金 1億円/日以上、調整後の週末終値が52週高値から −15% 以下
 *   スコア   次の4つの母集団内パーセンタイルの単純平均(高いほど追加下落しやすい)
 *            (1) 下落が深い (2) 直近13週の週次リターンの標準偏差が大きい
 *            (3) 直近4週リターンが低い (4) 売買代金が小さい
 *   D10      NTILE(10)(同値はコード順)の 10
 * 検証のパネル(xs_weekly_panel)はスナップショットで日々更新されないため、ここでは日足から直接作る。
 * 対象は検証のパネル(ddl/20)と同じく、33業種「その他」(ETF・REIT 等、'9999')と TOKYO PRO MARKET を除く。
 * 違い: 週は「各週の最後の取引日の終値」で、今週は途中でも最新の終値を使う。売買代金は直近20営業日の
 * 平均売買代金(検証は 4週平均出来高 × 終値)。最新日に取引のない銘柄は除く。
 * 全銘柄 × 約400日を走査するので10秒ほどかかる。呼び出し側で30分キャッシュする。
 */
async function fetchAvoidSet(conn) {
  const r = await conn.execute(
    `WITH lastd AS (SELECT MAX(price_date) d FROM equity_price_daily),
     px AS (
        SELECT p.code, p.price_date, p.close_price, p.turnover_value,
               p.close_price * NVL(EXP(SUM(LN(NULLIF(p.adj_factor, 0))) OVER (
                   PARTITION BY p.code ORDER BY p.price_date
                   ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1) AS adjc,
               ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn_d,
               ROW_NUMBER() OVER (PARTITION BY p.code, TRUNC(p.price_date, 'IW') ORDER BY p.price_date DESC) AS rn_wk
          FROM equity_price_daily p, lastd
         WHERE p.price_date > lastd.d - 400 AND p.close_price IS NOT NULL
           AND p.code IN (SELECT code FROM equity_master
                           WHERE delisted_flag = 'N' AND sector33_code <> '9999'
                             AND NVL(market_name, '-') <> 'TOKYO PRO MARKET')),
     tv AS (
        SELECT code, AVG(turnover_value) / 1e8 AS tv_oku, MAX(CASE WHEN rn_d = 1 THEN price_date END) AS last_date
          FROM px WHERE rn_d <= 20 GROUP BY code),
     w AS (SELECT code, adjc, ROW_NUMBER() OVER (PARTITION BY code ORDER BY price_date DESC) AS rn_w FROM px WHERE rn_wk = 1),
     w2 AS (SELECT code, rn_w, adjc, adjc / LEAD(adjc) OVER (PARTITION BY code ORDER BY rn_w) - 1 AS r FROM w WHERE rn_w <= 53),
     f AS (
        SELECT code,
               MAX(CASE WHEN rn_w = 1 THEN adjc END)   AS c0,
               MAX(CASE WHEN rn_w = 5 THEN adjc END)   AS c4,
               MAX(CASE WHEN rn_w <= 52 THEN adjc END) AS hi52,
               COUNT(CASE WHEN rn_w <= 52 THEN 1 END)  AS nw,
               STDDEV(CASE WHEN rn_w <= 13 THEN r END) AS vol13
          FROM w2 GROUP BY code),
     u AS (
        SELECT f.code, f.c0 / f.hi52 - 1 AS dd, f.vol13, (f.c0 / f.c4 - 1) * 100 AS ret4w, tv.tv_oku
          FROM f JOIN tv ON tv.code = f.code, lastd
         WHERE tv.last_date = lastd.d AND f.nw >= 52 AND f.c0 / f.hi52 - 1 <= -0.15
           AND tv.tv_oku >= 1 AND f.vol13 IS NOT NULL AND f.c4 IS NOT NULL),
     sc AS (
        SELECT u.*, (PERCENT_RANK() OVER (ORDER BY dd DESC) + PERCENT_RANK() OVER (ORDER BY vol13)
                   + PERCENT_RANK() OVER (ORDER BY ret4w DESC) + PERCENT_RANK() OVER (ORDER BY tv_oku DESC)) / 4 AS risk
          FROM u),
     d AS (SELECT sc.*, NTILE(10) OVER (ORDER BY risk, code) AS dec FROM sc)
     SELECT d.code, d.dd, d.vol13, d.ret4w, d.tv_oku, d.risk, d.dec, (SELECT COUNT(*) FROM d) AS pop,
            (SELECT TO_CHAR(lastd.d, 'YYYY-MM-DD') FROM lastd) AS as_of
       FROM d WHERE d.dec = 10`, {}, OBJ);
  const codes = {};
  let pop = 0;
  let asOf = null;
  for (const x of r.rows) {
    pop = x.POP;
    asOf = x.AS_OF;
    codes[x.CODE] = { dd: x.DD * 100, vol13: x.VOL13 * 100, ret4w: x.RET4W, turnover: x.TV_OKU, risk: x.RISK };
  }
  return { asOf, population: pop, d10: codes };
}

module.exports = {
  fetchFinancialRows, fetchPriceAndSplits, fetchRevisions, fetchIndustryStats,
  fetchDailyOhlc, fetchMarginLatest, fetchAvoidSet,
};
