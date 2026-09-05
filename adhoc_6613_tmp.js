'use strict';
const db = require('./src/db');

async function main() {
  await db.withConnection(async (conn) => {
    const master = await conn.execute(
      `SELECT code, co_name, co_name_en, market_name, sector33_name, margin_name FROM equity_master WHERE code LIKE '6613%'`
    );
    console.log('=== MASTER ===');
    console.log(JSON.stringify(master.rows));

    const price = await conn.execute(
      `SELECT TO_CHAR(price_date,'YYYY-MM-DD') d, open_price, high_price, low_price, close_price, volume, adj_factor
       FROM equity_price_daily
       WHERE code = '66130' AND price_date BETWEEN DATE '2026-07-15' AND DATE '2026-08-31'
       ORDER BY price_date`
    );
    console.log('=== PRICE ===');
    console.log(JSON.stringify(price.rows));

    const margin = await conn.execute(
      `SELECT TO_CHAR(app_date,'YYYY-MM-DD') d, shrt_vol, long_vol, shrt_neg_vol, shrt_std_vol
       FROM equity_margin_interest
       WHERE code = '66130' AND app_date BETWEEN DATE '2026-07-01' AND DATE '2026-08-31'
       ORDER BY app_date`
    );
    console.log('=== MARGIN_INTEREST ===');
    console.log(JSON.stringify(margin.rows));

    const alert = await conn.execute(
      `SELECT TO_CHAR(app_date,'YYYY-MM-DD') app_d, TO_CHAR(pub_date,'YYYY-MM-DD') pub_d,
              shrt_out, shrt_out_chg, shrt_out_ratio, long_out, sl_ratio,
              reason_restricted, reason_daily_publication, reason_monitoring
       FROM equity_margin_alert
       WHERE code = '66130' AND app_date BETWEEN DATE '2026-07-01' AND DATE '2026-08-31'
       ORDER BY app_date, pub_date`
    );
    console.log('=== MARGIN_ALERT ===');
    console.log(JSON.stringify(alert.rows));

    const shortpos = await conn.execute(
      `SELECT TO_CHAR(disc_date,'YYYY-MM-DD') disc_d, TO_CHAR(calc_date,'YYYY-MM-DD') calc_d,
              ss_name, shrt_pos_to_so, shrt_pos_shares, TO_CHAR(prev_rpt_date,'YYYY-MM-DD') prev_d, prev_rpt_ratio
       FROM equity_short_position
       WHERE code = '66130' AND calc_date BETWEEN DATE '2026-06-01' AND DATE '2026-08-31'
       ORDER BY calc_date, ss_name`
    );
    console.log('=== SHORT_POSITION ===');
    console.log(JSON.stringify(shortpos.rows));

    const ratio = await conn.execute(
      `SELECT TO_CHAR(r.ratio_date,'YYYY-MM-DD') d, r.sell_ex_short_va, r.shrt_with_res_va, r.shrt_no_res_va
       FROM sector_short_ratio r
       JOIN equity_master em ON em.sector33_code = r.s33_code
       WHERE em.code = '66130' AND r.ratio_date BETWEEN DATE '2026-07-15' AND DATE '2026-08-31'
       ORDER BY r.ratio_date`
    );
    console.log('=== SECTOR_SHORT_RATIO ===');
    console.log(JSON.stringify(ratio.rows));
  });
  await db.closePool();
}

main().catch(async (err) => {
  console.error('ERROR:', err);
  await db.closePool().catch(() => {});
  process.exit(1);
});
