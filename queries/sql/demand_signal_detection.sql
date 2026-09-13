--------------------------------------------------------------------------------
-- 第三階層: シグナル検出
--
-- 第一階層・第二階層のデータから、投資判断に直結する条件を機械的に抽出する。
--
--   S1 出来高急増      直近出来高 > 20日平均出来高 × 2.0
--   S2 信用倍率低下    信用倍率 <= 1.0(買残 <= 売残。売り長)
--                      ※3月・9月は季節性で誤検知しやすい。下記参照
--   S3 大量保有の動き  直近14日以内に大量保有報告書が提出された
--   S4 空売り残高過大  空売り残高合計 > 発行済株式数の5%
--
-- 複数が同時に点灯した銘柄を SIGNAL_SCORE の降順で並べる。
--
-- 前提: queries/sql/demand_watchlist_sheet.sql が動くこと(同じテーブルを使う)。
--
-- 【しきい値は params で変える】
--   本ファイルのしきい値は書籍の記載をそのまま採っている。
--   運用しながら「点灯が多すぎる/少なすぎる」を見て調整する前提で、
--   数値は全て params CTE に集めてある。SQL本体には直接書かない。
--
-- 【対象範囲の考え方】
--   ウォッチリストだけを見ると、まだ知らない銘柄を拾えない。
--   逆に全銘柄を対象にすると流動性の低い銘柄が大量に点灯する。
--   2 でウォッチリスト、3 で全銘柄(流動性フィルタ付き)の両方を用意している。
--
-- 【S2 は3月・9月に誤検知しやすい】
--   3月末・9月末の権利付最終日の直前は、株主優待・配当を取るための
--   つなぎ売り(クロス取引)で信用売残が急増する。市場全体でも売残が
--   平常時の1.5〜2倍になることを実データで確認している
--   (2025-09-22週・2026-03-23週。demand_macro_dashboard.sql 参照)。
--   個別銘柄では優待人気銘柄ほど極端に効く。
--
--   この時期の「信用倍率1倍割れ」は実需の売り圧力ではなく、
--   権利落ち後に反対売買で消える。3月末・9月末の前後2週は
--   S2 の点灯を割り引いて見るか、前年同期と比べること。
--
-- 【割合の単位】
--   SHRT_POS_TO_SO・SHS_RATIO は小数表現(0.05 = 5%)。
--   しきい値も小数で書くこと(params の short_ratio_th = 0.05)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 各データの鮮度確認
--
-- シグナルは「最新値」で判定するため、どれか1つでも取込が止まっていると
-- 静かに誤判定する。バッチが動いているかを最初に見る。
--------------------------------------------------------------------------------
SELECT '株価(出来高)'      AS data_name,
       TO_CHAR(MAX(price_date), 'YYYY-MM-DD') AS latest,
       TRUNC(SYSDATE) - MAX(price_date)       AS days_behind
FROM equity_price_daily
UNION ALL
SELECT '信用取引残高',
       TO_CHAR(MAX(app_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(app_date)
FROM equity_margin_interest
UNION ALL
SELECT '空売り残高報告',
       TO_CHAR(MAX(calc_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(calc_date)
FROM equity_short_position
UNION ALL
SELECT '大量保有報告書',
       TO_CHAR(MAX(sub_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(sub_date)
FROM large_volume_shareholder;


--------------------------------------------------------------------------------
-- 2. 【本命】シグナル検出(ウォッチリスト銘柄)
--
-- 全銘柄について4つのフラグを立て、1つ以上点灯した行だけを返す。
-- SIGNAL_SCORE が2以上の銘柄が、書籍の言う「需給面での転換点が近い可能性が高い」
-- 優先調査候補にあたる。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0   AS vol_mult_th,      -- S1: 20日平均出来高の何倍で点灯させるか
           1.0   AS margin_ratio_th,  -- S2: 信用倍率がこの値以下で点灯
           14    AS lvs_days_th,      -- S3: 大量保有報告書を「新規」と見なす日数
           0.05  AS short_ratio_th    -- S4: 空売り残高割合(小数。0.05 = 5%)
    FROM dual
),
target AS (
    SELECT f.code
    FROM favorite_master f
    WHERE f.is_watching = 1
    -- タグで絞る場合はここを差し替える:
    -- SELECT t.code FROM favorite_tag t WHERE t.tag_name IN ('130_semi_equip_material')
),
px AS (
    SELECT p.code,
           p.price_date,
           p.close_price,
           p.volume,
           AVG(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
               OVER (PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)           AS split_flag,
           ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
    FROM equity_price_daily p
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
      AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
),
px_latest AS (
    SELECT code, price_date, close_price, volume, avg_vol_20d, split_flag
    FROM px WHERE rn = 1
),
mgn AS (
    SELECT code, app_date, long_vol, shrt_vol
    FROM (
        SELECT m.code, m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
          AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -3)
    )
    WHERE rn = 1
),
sp AS (
    SELECT code, calc_date, total_shrt_ratio, reporter_count
    FROM (
        SELECT v.code, v.calc_date, v.total_shrt_ratio, v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = v.code)
    )
    WHERE rn = 1
),
lvs AS (
    -- 直近 lvs_days_th 日以内に提出された書類。同期間に複数あればまとめる
    SELECT l.code,
           COUNT(*)                                                  AS lvs_docs,
           MAX(l.sub_date)                                           AS last_sub_date,
           MAX(l.total_shs_ratio) KEEP (DENSE_RANK LAST
                 ORDER BY l.sub_date, l.doc_id)                      AS last_ratio,
           MAX(l.total_shs_ratio_last) KEEP (DENSE_RANK LAST
                 ORDER BY l.sub_date, l.doc_id)                      AS last_ratio_prev
    FROM large_volume_shareholder l
    CROSS JOIN params
    WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)
      AND l.sub_date >= TRUNC(SYSDATE) - params.lvs_days_th
    GROUP BY l.code
),
flags AS (
    SELECT em.code,
           em.co_name,
           em.market_name,
           px_latest.price_date,
           px_latest.close_price,
           px_latest.volume,
           ROUND(px_latest.avg_vol_20d)                              AS avg_vol_20d,
           ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
           NVL(px_latest.split_flag, 'N')                            AS split_flag,
           mgn.app_date                                              AS margin_date,
           ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)          AS margin_ratio,
           mgn.shrt_vol                                              AS margin_shrt_vol,
           sp.calc_date                                              AS short_calc_date,
           ROUND(sp.total_shrt_ratio * 100, 2)                       AS short_ratio_pct,
           sp.reporter_count,
           lvs.lvs_docs,
           lvs.last_sub_date                                         AS lvs_sub_date,
           ROUND(lvs.last_ratio * 100, 2)                            AS lvs_ratio_pct,
           ROUND((lvs.last_ratio - lvs.last_ratio_prev) * 100, 2)    AS lvs_ratio_chg_pt,
           -- S1: 出来高急増
           CASE WHEN px_latest.avg_vol_20d > 0
                 AND px_latest.volume >= px_latest.avg_vol_20d * p.vol_mult_th
                THEN 1 ELSE 0 END                                    AS sig_volume,
           -- S2: 信用倍率が1倍以下(売残0の銘柄は判定対象外)
           CASE WHEN mgn.shrt_vol > 0
                 AND mgn.long_vol / mgn.shrt_vol <= p.margin_ratio_th
                THEN 1 ELSE 0 END                                    AS sig_margin,
           -- S3: 直近に大量保有報告書が提出された
           CASE WHEN lvs.lvs_docs > 0 THEN 1 ELSE 0 END              AS sig_lvs,
           -- S4: 空売り残高が発行済株式数の5%超
           CASE WHEN sp.total_shrt_ratio > p.short_ratio_th
                THEN 1 ELSE 0 END                                    AS sig_short
    FROM equity_master em
    JOIN target ON target.code = em.code
    CROSS JOIN params p
    LEFT JOIN px_latest ON px_latest.code = em.code
    LEFT JOIN mgn       ON mgn.code       = em.code
    LEFT JOIN sp        ON sp.code        = em.code
    LEFT JOIN lvs       ON lvs.code       = em.code
)
SELECT code,
       co_name,
       market_name,
       sig_volume + sig_margin + sig_lvs + sig_short                 AS signal_score,
       -- 点灯したシグナルを1列にまとめる。HTML側でバッジにする想定
       RTRIM(
         CASE WHEN sig_volume = 1 THEN '出来高急増 ' END ||
         CASE WHEN sig_margin = 1 THEN '信用倍率1倍割れ ' END ||
         CASE WHEN sig_lvs    = 1 THEN '大量保有提出 ' END ||
         CASE WHEN sig_short  = 1 THEN '空売り残5%超 ' END
       )                                                             AS signals,
       TO_CHAR(price_date, 'YYYY-MM-DD')                             AS price_date,
       close_price,
       volume,
       avg_vol_20d,
       vol_vs_20d,
       split_flag,
       TO_CHAR(margin_date, 'YYYY-MM-DD')                            AS margin_date,
       margin_ratio,
       margin_shrt_vol,
       TO_CHAR(short_calc_date, 'YYYY-MM-DD')                        AS short_calc_date,
       short_ratio_pct,
       reporter_count,
       TO_CHAR(lvs_sub_date, 'YYYY-MM-DD')                           AS lvs_sub_date,
       lvs_docs,
       lvs_ratio_pct,
       lvs_ratio_chg_pt
FROM flags
WHERE sig_volume + sig_margin + sig_lvs + sig_short > 0
ORDER BY signal_score DESC, vol_vs_20d DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 3. シグナル検出(全銘柄・流動性フィルタ付き)
--
-- ウォッチリストの外から候補を拾うための版。2 と判定ロジックは同じで、
-- 対象を「東証プライム/スタンダード/グロース かつ 20日平均売買代金が一定以上」に
-- 差し替えてある。
--
-- 流動性フィルタを入れる理由: 出来高が普段ほぼ0の銘柄は、数千株の売買で
-- 簡単に「20日平均の2倍」を超える。フィルタ無しだとその手の銘柄で埋まる。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0        AS vol_mult_th,
           1.0        AS margin_ratio_th,
           14         AS lvs_days_th,
           0.05       AS short_ratio_th,
           50000000   AS min_turnover_20d   -- 20日平均売買代金の下限(円)。5000万円
    FROM dual
),
px AS (
    SELECT p.code,
           p.price_date,
           p.close_price,
           p.volume,
           AVG(p.volume)         OVER (PARTITION BY p.code ORDER BY p.price_date
                                       ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           AVG(p.turnover_value) OVER (PARTITION BY p.code ORDER BY p.price_date
                                       ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_turnover_20d,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
               OVER (PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)                   AS split_flag,
           ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC)     AS rn
    FROM equity_price_daily p
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
),
px_latest AS (
    SELECT px.code, px.price_date, px.close_price, px.volume,
           px.avg_vol_20d, px.avg_turnover_20d, px.split_flag
    FROM px
    CROSS JOIN params
    JOIN equity_master em
      ON em.code = px.code
     AND em.delisted_flag = 'N'
     AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
    WHERE px.rn = 1
      AND px.avg_turnover_20d >= params.min_turnover_20d
),
mgn AS (
    SELECT code, app_date, long_vol, shrt_vol
    FROM (
        SELECT m.code, m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -3)
    )
    WHERE rn = 1
),
sp AS (
    SELECT code, calc_date, total_shrt_ratio, reporter_count
    FROM (
        SELECT v.code, v.calc_date, v.total_shrt_ratio, v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE v.calc_date >= ADD_MONTHS(TRUNC(SYSDATE), -6)
    )
    WHERE rn = 1
),
lvs AS (
    SELECT l.code,
           COUNT(*)                                                  AS lvs_docs,
           MAX(l.sub_date)                                           AS last_sub_date,
           MAX(l.total_shs_ratio) KEEP (DENSE_RANK LAST
                 ORDER BY l.sub_date, l.doc_id)                      AS last_ratio
    FROM large_volume_shareholder l
    CROSS JOIN params
    WHERE l.sub_date >= TRUNC(SYSDATE) - params.lvs_days_th
    GROUP BY l.code
),
flags AS (
    SELECT em.code,
           em.co_name,
           em.market_name,
           em.sector33_name,
           px_latest.price_date,
           px_latest.close_price,
           px_latest.volume,
           ROUND(px_latest.avg_vol_20d)                                  AS avg_vol_20d,
           ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
           ROUND(px_latest.avg_turnover_20d / 1000000)                   AS avg_turnover_20d_mil,
           NVL(px_latest.split_flag, 'N')                                AS split_flag,
           ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)              AS margin_ratio,
           ROUND(sp.total_shrt_ratio * 100, 2)                           AS short_ratio_pct,
           sp.reporter_count,
           lvs.lvs_docs,
           lvs.last_sub_date                                             AS lvs_sub_date,
           ROUND(lvs.last_ratio * 100, 2)                                AS lvs_ratio_pct,
           CASE WHEN px_latest.avg_vol_20d > 0
                 AND px_latest.volume >= px_latest.avg_vol_20d * p.vol_mult_th
                THEN 1 ELSE 0 END                                        AS sig_volume,
           CASE WHEN mgn.shrt_vol > 0
                 AND mgn.long_vol / mgn.shrt_vol <= p.margin_ratio_th
                THEN 1 ELSE 0 END                                        AS sig_margin,
           CASE WHEN lvs.lvs_docs > 0 THEN 1 ELSE 0 END                  AS sig_lvs,
           CASE WHEN sp.total_shrt_ratio > p.short_ratio_th
                THEN 1 ELSE 0 END                                        AS sig_short
    FROM px_latest
    JOIN equity_master em ON em.code = px_latest.code
    CROSS JOIN params p
    LEFT JOIN mgn ON mgn.code = px_latest.code
    LEFT JOIN sp  ON sp.code  = px_latest.code
    LEFT JOIN lvs ON lvs.code = px_latest.code
)
SELECT code,
       co_name,
       market_name,
       sector33_name,
       sig_volume + sig_margin + sig_lvs + sig_short                     AS signal_score,
       RTRIM(
         CASE WHEN sig_volume = 1 THEN '出来高急増 ' END ||
         CASE WHEN sig_margin = 1 THEN '信用倍率1倍割れ ' END ||
         CASE WHEN sig_lvs    = 1 THEN '大量保有提出 ' END ||
         CASE WHEN sig_short  = 1 THEN '空売り残5%超 ' END
       )                                                                 AS signals,
       TO_CHAR(price_date, 'YYYY-MM-DD')                                 AS price_date,
       close_price,
       vol_vs_20d,
       avg_turnover_20d_mil,
       split_flag,
       margin_ratio,
       short_ratio_pct,
       reporter_count,
       TO_CHAR(lvs_sub_date, 'YYYY-MM-DD')                               AS lvs_sub_date,
       lvs_ratio_pct
FROM flags
WHERE sig_volume + sig_margin + sig_lvs + sig_short >= 2   -- 2つ以上の同時点灯に絞る
ORDER BY signal_score DESC, vol_vs_20d DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY;


--------------------------------------------------------------------------------
-- 4. 補助シグナル(4つの本則に加えて見ておくと効くもの)
--
-- 書籍の4条件は「今まさに起きている変化」を捉えるが、
-- 踏み上げの燃料がどれだけ溜まっているかは別に見たほうがよい。
--
--   days to cover     売残 ÷ 20日平均出来高。買い戻しに何日かかるか
--   日々公表銘柄入り  取引所が残高を毎日公表する水準まで積み上がった銘柄
--   報告者数の増加    0.5%以上の空売りを報告する主体が増えている
--------------------------------------------------------------------------------
WITH target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
avg_vol AS (
    SELECT code, AVG(volume) AS avg_vol_20d
    FROM (
        SELECT p.code, p.volume,
               ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
        FROM equity_price_daily p
        WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -3)
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
    )
    WHERE rn <= 20
    GROUP BY code
),
mgn AS (
    SELECT code, app_date, shrt_vol, long_vol
    FROM (
        SELECT m.code, m.app_date, m.shrt_vol, m.long_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
          AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -3)
    )
    WHERE rn = 1
),
alert AS (
    -- 日々公表銘柄。同一申込日の訂正は公表日が最新の行だけを見る
    SELECT code, app_date, sl_ratio, shrt_out_ratio, tse_mrgn_reg_cls
    FROM (
        SELECT a.code, a.app_date, a.sl_ratio, a.shrt_out_ratio, a.tse_mrgn_reg_cls,
               ROW_NUMBER() OVER (PARTITION BY a.code ORDER BY a.app_date DESC) AS rn
        FROM v_equity_margin_alert_latest a
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = a.code)
          AND a.app_date >= TRUNC(SYSDATE) - 30
    )
    WHERE rn = 1
),
sp AS (
    SELECT code,
           MAX(CASE WHEN rn = 1 THEN calc_date END)       AS calc_date,
           MAX(CASE WHEN rn = 1 THEN reporter_count END)  AS reporter_count,
           MAX(CASE WHEN rn = 2 THEN reporter_count END)  AS reporter_count_prev
    FROM (
        SELECT v.code, v.calc_date, v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = v.code)
    )
    WHERE rn <= 2
    GROUP BY code
)
SELECT em.code,
       em.co_name,
       TO_CHAR(mgn.app_date, 'YYYY-MM-DD')                          AS margin_date,
       mgn.shrt_vol                                                 AS margin_shrt_vol,
       ROUND(avg_vol.avg_vol_20d)                                   AS avg_vol_20d,
       ROUND(mgn.shrt_vol / NULLIF(avg_vol.avg_vol_20d, 0), 1)      AS days_to_cover,
       CASE WHEN alert.code IS NOT NULL THEN 'Y' ELSE 'N' END       AS daily_publication,
       alert.sl_ratio                                               AS alert_sl_ratio,
       alert.tse_mrgn_reg_cls,
       sp.reporter_count,
       sp.reporter_count - sp.reporter_count_prev                   AS reporter_chg
FROM equity_master em
JOIN target ON target.code = em.code
LEFT JOIN mgn     ON mgn.code     = em.code
LEFT JOIN avg_vol ON avg_vol.code = em.code
LEFT JOIN alert   ON alert.code   = em.code
LEFT JOIN sp      ON sp.code      = em.code
ORDER BY days_to_cover DESC NULLS LAST;
