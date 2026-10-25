'use strict';

/**
 * 信用残の「要確認」の印。/market・/daily・/demand で共通に使う。判定はここだけに置く。
 *
 * 【判定】全銘柄の信用買残(株数)の合計が、前回の申込日から ±LONG_PCT_LIM % 以上動いた日を「要確認」とする。
 *   DB には保存しない(表示のたびに計算する)。取り直しで数字が直れば、印も自然に消える。
 *
 * 【10% の根拠】(2026-10-21 ユーザーと確認)
 *   - 2026-10-20 申込分で、買残の合計が1日で −27.7%、売残も −18.3%。同じ日の TOPIX は −1.4%、
 *     出来高も普段どおりで、値動きで説明できない。JPX の公表 PDF の値も同じ(トヨタ 9,718,100 株)。
 *   - 2016 年以降の週次で、買残の合計が 10% を超えて減ったのは 2018/12・2020/3・2024/8(最大 −15.6%)・
 *     2025/4 の急落の週だけ。2017/9 末の −15.7% は株式併合が集中したことによる見かけの減少。
 *   → 10% を超える動きは「大きな急落」か「データの事情」のどちらか。どちらでも数字をそのまま使う前に確かめる価値がある。
 *
 * 【売残は条件に使わない】権利付き最終日の前後は、優待のクロス取引で一般信用の売残が1日に ±30〜50% 動くのが
 *   普通にある(2026/9/28〜9/29 で実際にあった)。条件に入れると毎回点灯して意味がなくなる。値は文言に添える。
 *
 * 【種類】
 *   jump … その日の合計が前回から大きく動いた。その日の値そのものを疑う
 *   back … 前回が jump で、この日に jump の前の水準(±BACK_TOL %)へ戻った。この日の値は正常とみなすが、
 *           前回(= jump の日)との比較は意味がない
 */

const oracledb = require('oracledb');

const LONG_PCT_LIM = 10;
const BACK_TOL = 3;
const LOOKBACK_DAYS = 21; // 調べる期間の先頭の日にも「前回」が要るので、その分だけ前から読む

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const signed = (v) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1));

/**
 * 合計と TOPIX から要確認の日を決める(純粋関数)。
 * @param {Array<{d:string, lv:number, sv:number}>} totals  申込日ごとの合計(昇順)
 * @param {Map<string, number>} topix                       日付 → TOPIX 終値
 * @returns {Array<object>} 要確認の日(昇順)
 */
function classify(totals, topix) {
  const out = [];
  const pct = (a, b) => (a == null || b == null || Number(b) === 0 ? null : (Number(a) / Number(b) - 1) * 100);
  for (let i = 1; i < totals.length; i++) {
    const cur = totals[i];
    const prev = totals[i - 1];
    const longPct = pct(cur.lv, prev.lv);
    if (longPct == null || Math.abs(longPct) < LONG_PCT_LIM - 1e-9) continue; // 1e-9 は浮動小数の誤差(ちょうど10%を落とさない)
    const shortPct = pct(cur.sv, prev.sv);
    const topixPct = pct(topix.get(cur.d), topix.get(prev.d));
    const last = out[out.length - 1];
    // 前回が jump で、その前の水準に戻ったなら back
    if (last && last.kind === 'jump' && last.date === prev.d && i >= 2) {
      const vsBefore = pct(cur.lv, totals[i - 2].lv);
      if (vsBefore != null && Math.abs(vsBefore) <= BACK_TOL) {
        out.push({
          kind: 'back', date: cur.d, prevDate: prev.d, longPct, shortPct, topixPct,
          text: `${md(cur.d)} 申込分の前回比は、要確認の ${md(prev.d)} 申込分との比較です` +
            `(${md(totals[i - 2].d)} 申込分の水準に戻っています)`,
        });
        continue;
      }
    }
    out.push({
      kind: 'jump', date: cur.d, prevDate: prev.d, longPct, shortPct, topixPct,
      text: `要確認: ${md(cur.d)} 申込分は全銘柄の信用買残の合計が前回(${md(prev.d)})から ${signed(longPct)}%` +
        `(売残 ${signed(shortPct)}%、同じ日の TOPIX ${signed(topixPct)}%)。` +
        '大きな急落の日でなければ、公表側のデータの事情の可能性があります',
    });
  }
  return out;
}

/**
 * fromYmd 以降の申込日について要確認の日を返す。
 * 全銘柄の合計なので、市場区分で絞らない(ETF 等も含む。株価が無くても数える)。
 */
async function fetchMarginChecks(conn, fromYmd) {
  const readFrom = addDays(fromYmd, -LOOKBACK_DAYS);
  const [m, t] = await Promise.all([
    conn.execute(
      `SELECT TO_CHAR(app_date, 'YYYY-MM-DD') AS d, SUM(long_vol) AS lv, SUM(shrt_vol) AS sv
         FROM equity_margin_interest
        WHERE app_date >= TO_DATE(:f, 'YYYY-MM-DD')
        GROUP BY app_date
        ORDER BY app_date`, { f: readFrom }, OBJ),
    conn.execute(
      `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d, close_price AS c
         FROM topix_price_daily
        WHERE price_date >= TO_DATE(:f, 'YYYY-MM-DD')`, { f: readFrom }, OBJ),
  ]);
  const totals = m.rows.map((r) => ({ d: r.D, lv: r.LV, sv: r.SV }));
  const topix = new Map(t.rows.map((r) => [r.D, r.C]));
  return classify(totals, topix).filter((c) => c.date >= fromYmd);
}

module.exports = { fetchMarginChecks, classify, LONG_PCT_LIM, BACK_TOL };
