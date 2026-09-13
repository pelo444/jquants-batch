--------------------------------------------------------------------------------
-- 需給指標の週次パネル(検証用)
-- 実行ユーザー: GD_JQUANTS
--
-- 【何のためのビューか】
--   「この需給指標が◯◯の水準になった週の、その後のリターンはどうだったか」を
--   調べるための土台。週を1行とし、その週の需給指標と、そこから4週・13週・26週先の
--   TOPIXリターンを同じ行に並べる。
--
--   queries/sql/demand_signal_backtest.sql がこのビューを使う。
--
-- 【なぜビューにしたか】
--   パネルの組み立て(5つのテーブルを週単位に集約して突き合わせる)が60行以上あり、
--   検証クエリごとに書き写すと保守できなくなる。定義を1箇所に閉じ込める。
--
-- 【処理コストの注意】
--   信用取引残高の金額換算は EQUITY_MARGIN_INTEREST(約220万行)と
--   EQUITY_PRICE_DAILY の突き合わせなので、このビューを1回引くたびに走る。
--   数十秒かかることがある。同じセッションで何度も叩くなら、
--   一度テーブルに落としてから分析するとよい:
--     CREATE TABLE demand_panel_snap AS SELECT * FROM v_demand_weekly_panel;
--   (スナップショットなので、日次バッチで更新されない点に注意)
--
-- 【先行リターンについて】
--   FWD_RET_4W は「その週末から4週後の週末まで」のTOPIX騰落率(%)。
--   LEAD をパネル自身の週の並び順で取っているため、営業日が無い週が
--   間に挟まっても「4行先」= 実質4週後になる(取引所が閉まっている週は
--   そもそもパネルに行が無い)。
--   直近26週は先の値が無いため NULL になる。これは正常。
--
-- 【指標の期間が揃っていないこと】
--   ARB_NET_OKU(裁定取引残高)だけ 2023-01-06 以降しか無い(JPXのバックナンバーが
--   直近4年分しか無いため。ddl/17 参照)。裁定残を条件に使う検証は、
--   他の指標より標本数が大幅に少なくなる。必ず件数を確認してから解釈すること。
--
-- 前提: ddl/08・ddl/11・ddl/12・ddl/17 を実行済みで、取り込みが済んでいること。
--
-- ★ 実行後、CLAUDE_RO への GRANT とシノニムを忘れないこと(本ファイル末尾)。
--   忘れると「取り込みは成功しているのに Claude からだけ ORA-00942」になる。
--------------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_demand_weekly_panel AS
WITH wk AS (
    -- 営業日が1日でもある週を骨格にする
    SELECT DISTINCT TRUNC(c.calendar_date, 'IW') AS week_start
    FROM trading_calendar c
    WHERE c.hol_div IN ('1', '2')
      AND c.calendar_date <= TRUNC(SYSDATE)
),
tpx AS (
    -- 週末のTOPIX終値
    SELECT week_start, close_price
    FROM (
        SELECT TRUNC(t.price_date, 'IW') AS week_start,
               t.close_price,
               ROW_NUMBER() OVER (PARTITION BY TRUNC(t.price_date, 'IW')
                                  ORDER BY t.price_date DESC) AS rn
        FROM topix_price_daily t
    )
    WHERE rn = 1
),
idx AS (
    -- グロース/バリューの比率(TOPIXの中で何が買われたかの代理)
    SELECT week_start,
           MAX(CASE WHEN index_code = '8200' THEN close_price END)
             / NULLIF(MAX(CASE WHEN index_code = '8100' THEN close_price END), 0)
                                                                 AS gv_ratio
    FROM (
        SELECT TRUNC(i.price_date, 'IW') AS week_start,
               i.index_code, i.close_price,
               ROW_NUMBER() OVER (PARTITION BY i.index_code, TRUNC(i.price_date, 'IW')
                                  ORDER BY i.price_date DESC) AS rn
        FROM index_price_daily i
        WHERE i.index_code IN ('8100', '8200')
    )
    WHERE rn = 1
    GROUP BY week_start
),
mgn AS (
    -- 市場全体の信用残(金額換算)。株数の単純合計では低位株に引きずられるため、
    -- 申込日時点の終値を掛けてから合計する(demand_macro_dashboard.sql と同じ考え方)
    SELECT TRUNC(m.app_date, 'IW')             AS week_start,
           SUM(m.long_vol * p.close_price)     AS long_val,
           SUM(m.shrt_vol * p.close_price)     AS shrt_val,
           COUNT(*)                            AS codes_cnt
    FROM equity_margin_interest m
    JOIN equity_master em
      ON em.code = m.code
     AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
    JOIN equity_price_daily p
      ON p.code = m.code
     AND p.price_date = m.app_date
    WHERE p.close_price IS NOT NULL
    GROUP BY TRUNC(m.app_date, 'IW')
),
ssr AS (
    -- 市場全体の空売り比率(33業種を合算)
    SELECT TRUNC(r.ratio_date, 'IW')                          AS week_start,
           SUM(r.shrt_with_res_va + r.shrt_no_res_va)         AS short_va,
           SUM(r.sell_ex_short_va + r.shrt_with_res_va
               + r.shrt_no_res_va)                            AS sell_total_va
    FROM sector_short_ratio r
    GROUP BY TRUNC(r.ratio_date, 'IW')
),
arb AS (
    SELECT TRUNC(a.pos_date, 'IW')                            AS week_start,
           MAX(a.buy_tot_val)                                 AS arb_buy_val,
           MAX(a.buy_tot_val - a.sell_tot_val)                AS arb_net_val
    FROM arbitrage_balance a
    GROUP BY TRUNC(a.pos_date, 'IW')
),
inv AS (
    -- 投資部門別。2022年の市場区分再編をまたいで連続している TokyoNagoya を使う
    -- (TSEPrime 等は2022-04以降しか無く、長期の検証に使えない)
    SELECT TRUNC(v.en_date, 'IW') AS week_start,
           SUM(v.frgn_bal)        AS frgn_bal,
           SUM(v.ind_bal)         AS ind_bal
    FROM v_investor_type_trading_latest v
    WHERE v.section = 'TokyoNagoya'
    GROUP BY TRUNC(v.en_date, 'IW')
),
panel AS (
    SELECT wk.week_start,
           tpx.close_price                                     AS topix_close,
           idx.gv_ratio,
           ROUND(mgn.long_val / 100000000)                     AS margin_long_oku,
           ROUND(mgn.shrt_val / 100000000)                     AS margin_shrt_oku,
           mgn.long_val / NULLIF(mgn.shrt_val, 0)              AS margin_ratio,
           mgn.codes_cnt                                       AS margin_codes_cnt,
           ssr.short_va / NULLIF(ssr.sell_total_va, 0) * 100   AS short_ratio_pct,
           ROUND(arb.arb_buy_val / 100000000)                  AS arb_buy_oku,
           ROUND(arb.arb_net_val / 100000000)                  AS arb_net_oku,
           ROUND(inv.frgn_bal / 100000)                        AS frgn_oku,
           ROUND(inv.ind_bal  / 100000)                        AS ind_oku
    FROM wk
    LEFT JOIN tpx ON tpx.week_start = wk.week_start
    LEFT JOIN idx ON idx.week_start = wk.week_start
    LEFT JOIN mgn ON mgn.week_start = wk.week_start
    LEFT JOIN ssr ON ssr.week_start = wk.week_start
    LEFT JOIN arb ON arb.week_start = wk.week_start
    LEFT JOIN inv ON inv.week_start = wk.week_start
    WHERE tpx.close_price IS NOT NULL
)
SELECT p.week_start,
       p.topix_close,
       ROUND(p.gv_ratio, 4)                                    AS gv_ratio,
       p.margin_long_oku,
       p.margin_shrt_oku,
       ROUND(p.margin_ratio, 3)                                AS margin_ratio,
       p.margin_codes_cnt,
       ROUND(p.short_ratio_pct, 2)                             AS short_ratio_pct,
       p.arb_buy_oku,
       p.arb_net_oku,
       p.frgn_oku,
       p.ind_oku,
       -- 先行リターン(%)。その週末を起点に4週後・13週後・26週後の週末まで
       ROUND((LEAD(p.topix_close,  4) OVER (ORDER BY p.week_start)
              / p.topix_close - 1) * 100, 2)                   AS fwd_ret_4w,
       ROUND((LEAD(p.topix_close, 13) OVER (ORDER BY p.week_start)
              / p.topix_close - 1) * 100, 2)                   AS fwd_ret_13w,
       ROUND((LEAD(p.topix_close, 26) OVER (ORDER BY p.week_start)
              / p.topix_close - 1) * 100, 2)                   AS fwd_ret_26w
FROM panel p;

COMMENT ON TABLE v_demand_weekly_panel IS
  '需給指標の週次パネル(検証用。指標と4/13/26週先のTOPIXリターンを1行に並べる)';


--------------------------------------------------------------------------------
-- CLAUDE_RO への権限付与
--
-- ddl/18 の教訓: 新しいビューを作ったら GRANT とシノニムを必ずセットで足す。
-- 忘れると CLAUDE_RO から ORA-00942(「存在しない」と出るが実際は権限が無い)になる。
--
-- 1 を GD_JQUANTS で、2 を CLAUDE_RO で接続し直して実行すること。
-- **一気に流すと 2 で ORA-01471 になる**(GD_JQUANTS は同名の実体を持つため)。
--------------------------------------------------------------------------------

-- 1. GD_JQUANTS で実行
-- GRANT SELECT ON gd_jquants.v_demand_weekly_panel TO claude_ro;

-- 2. CLAUDE_RO で接続し直して実行
-- SELECT USER AS connected_as FROM dual;   -- CLAUDE_RO であること
-- CREATE SYNONYM v_demand_weekly_panel FOR gd_jquants.v_demand_weekly_panel;


--------------------------------------------------------------------------------
-- 動作確認
--------------------------------------------------------------------------------
-- 期間と各指標の充足状況(指標ごとに始まりが違うことの確認)
-- SELECT COUNT(*)                                        AS weeks,
--        TO_CHAR(MIN(week_start), 'YYYY-MM-DD')          AS from_week,
--        TO_CHAR(MAX(week_start), 'YYYY-MM-DD')          AS to_week,
--        COUNT(margin_ratio)                             AS has_margin,
--        COUNT(short_ratio_pct)                          AS has_short_ratio,
--        COUNT(arb_net_oku)                              AS has_arb,
--        COUNT(frgn_oku)                                 AS has_frgn,
--        COUNT(fwd_ret_13w)                              AS has_fwd13
-- FROM v_demand_weekly_panel;
