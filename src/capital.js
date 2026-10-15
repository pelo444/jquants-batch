'use strict';

/**
 * 元手と「まだ使っていない元手」の計算。売買記録の口座タブ(src/web/journalRoutes.js)と
 * 損失回避チェックの Ch9(src/lossChecks.js)の両方がここを使う。表は ddl/30_journal_capital.sql。
 *
 *   取得額の累計         = 現物の買付の受渡金額の合計
 *   売却額の累計         = 現物の売付の受渡金額の合計
 *   株に入れた正味の額   = 取得額の累計 − 売却額の累計
 *   まだ使っていない元手 = 元手 − 株に入れた正味の額
 *
 * 金額の出し方は src/web/journalPositions.js(保有の計算)と同じ:
 *   受渡金額があればその絶対値。無ければ 買付 = 数量×単価+手数料+税+諸費用、売付 = 数量×単価−手数料−税−諸費用。
 * 入庫・出庫(株式分割で増えた株など、お金が動かないもの)は数えない。
 * 信用取引は今は扱わない(2026-10-14 時点で約定が無く、使う予定もないため)。
 * 取り込んだ CSV の期間より前の売買は数えられないので、元手は CSV の最初の約定より前の時点の額で決める。
 */

function objFormat() {
  return { outFormat: require('oracledb').OUT_FORMAT_OBJECT };
}

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function fetchCapitalHistory(conn) {
  const r = await conn.execute(
    `SELECT capital_id, effective_date, amount_yen, note,
            TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
       FROM jnl_capital ORDER BY effective_date DESC, capital_id DESC`, {}, objFormat());
  return r.rows.map((x) => ({
    capitalId: x.CAPITAL_ID, effectiveDate: iso(x.EFFECTIVE_DATE), amount: x.AMOUNT_YEN, note: x.NOTE, updatedAt: x.UPDATED_AT,
  }));
}

async function fetchFlows(conn) {
  const r = await conn.execute(
    `SELECT SUM(CASE WHEN position_effect = 'OPEN' THEN
                  NVL(NULLIF(ABS(settle_amount), 0), qty * price + NVL(fee, 0) + NVL(tax, 0) + NVL(other_cost, 0)) END) AS buy_total,
            COUNT(CASE WHEN position_effect = 'OPEN' THEN 1 END) AS buy_n,
            SUM(CASE WHEN position_effect = 'CLOSE' THEN
                  NVL(NULLIF(ABS(settle_amount), 0), qty * price - NVL(fee, 0) - NVL(tax, 0) - NVL(other_cost, 0)) END) AS sell_total,
            COUNT(CASE WHEN position_effect = 'CLOSE' THEN 1 END) AS sell_n,
            MIN(trade_date) AS first_date, MAX(trade_date) AS last_date
       FROM jnl_trade
      WHERE position_kind = 'CASH' AND position_effect IN ('OPEN', 'CLOSE')`, {}, objFormat());
  const x = r.rows[0] || {};
  return {
    buyTotal: x.BUY_TOTAL || 0, buyCount: x.BUY_N || 0,
    sellTotal: x.SELL_TOTAL || 0, sellCount: x.SELL_N || 0,
    firstTradeDate: iso(x.FIRST_DATE), lastTradeDate: iso(x.LAST_DATE),
  };
}

/**
 * @returns {{current: object|null, history: object[], flows: object, netInvested: number, unused: number|null}}
 */
async function fetchCapital(conn) {
  const [history, flows] = await Promise.all([fetchCapitalHistory(conn), fetchFlows(conn)]);
  const current = history[0] || null;
  const netInvested = flows.buyTotal - flows.sellTotal;
  return {
    current,
    history,
    flows,
    netInvested,
    unused: current ? current.amount - netInvested : null,
  };
}

/** 元手を記録する(同じ日付は上書き) */
async function upsertCapital(conn, { effectiveDate, amount, note }) {
  await conn.execute(
    `MERGE INTO jnl_capital t
     USING (SELECT TO_DATE(:d, 'YYYY-MM-DD') AS effective_date FROM dual) s
        ON (t.effective_date = s.effective_date)
      WHEN MATCHED THEN UPDATE SET amount_yen = :amount, note = :note, updated_at = SYSTIMESTAMP
      WHEN NOT MATCHED THEN INSERT (effective_date, amount_yen, note) VALUES (s.effective_date, :amount, :note)`,
    { d: effectiveDate, amount, note });
  await conn.commit();
}

async function deleteCapital(conn, capitalId) {
  const r = await conn.execute(`DELETE FROM jnl_capital WHERE capital_id = :id`, { id: capitalId });
  await conn.commit();
  return r.rowsAffected > 0;
}

module.exports = { fetchCapital, upsertCapital, deleteCapital };
