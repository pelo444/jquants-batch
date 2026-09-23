--------------------------------------------------------------------------------
-- 相場の値動きの大きさを年・月で比べる(TOPIX と個別株)
--
-- 「今年の4月以降は他の年より上がり下がりが大きいか」を測る。2026-09-19 に作成。
-- 5本のクエリを1ファイルに置く。各クエリは末尾の ; で区切る(1本ずつ実行すること)。
--
-- 【計算式】
--   日次リターン(対数)   lr = LN(当日終値 / 前営業日終値)
--   年率ばらつき         STDDEV(lr) * SQRT(252) * 100
--                        STDDEV は標本標準偏差。252 は年間営業日数の近似。
--   1日の平均的な動き    AVG(ABS(lr)) * 100
--                        暴落の1日に引っ張られにくい(ばらつきより頑健)。
--   N%以上動いた日数     ABS(lr) >= 0.0N の日数
--
-- 【指標の読み分け】
--   ばらつき(標準偏差)は単発の急落に強く反応する。2024年8月・2025年4月・
--   2020年3月のような年は、それだけで順位が上がる。
--   「動きが大きい状態がずっと続いたか」を見るなら 1日の平均的な動き と
--   1%以上動いた日数のほうが向いている。
--
-- 【データ範囲】
--   TOPIX_PRICE_DAILY は 2016-09-01 開始。2016年は9月以降しか無いので、
--   年別比較(クエリ2・3)では 2016 の行を外して読むこと。
--
-- 【個別株(クエリ3)の前提】
--   * EQUITY_PRICE_DAILY の終値は分割調整前。ADJ_FACTOR <> 1 の日(分割・併合の日)は
--     日次リターンを丸ごと除外する。見かけの暴落・暴騰を混ぜないため。
--   * PROD_CATEGORY = '011' を内国株とみなしている(件数から推定。コードの意味は
--     未確認)。EQUITY_MASTER の現在値で判定し、上場廃止銘柄も含む。
--   * 期間内に 100 営業日未満の銘柄は集計から外す。
--   * 全銘柄×全期間を LAG で走らせるので重い(2026-09-19 時点で約50秒)。
--     クエリ実行のタイムアウト 120 秒に注意。
--
-- 【期間の変え方】
--   クエリ2・3 の BETWEEN '0401' AND '0918' が「各年の4/1〜9/18」。
--   比べたい期間に書き換える(MMDD 形式)。年の途中までのデータを、他の年の
--   同じ範囲と揃えるための指定なので、最新日に合わせて終端を更新すること。
--
-- 【実行結果の要約(2026-09-19、2026年4/1〜9/18)】
--   TOPIX 年率ばらつき 19.7%(10年中4位。上は2024の30.9・2025の24.3・2020の20.0)
--   TOPIX 1日の平均的な動き 0.93%(3位)、1%以上動いた日 42日(2020と並び最多)
--   個別株 1日の平均的な動きの中央値 1.34%(10年中5位)
--   2026年4〜8月の月別ばらつきの中央値 20.7% / 全年の同じ月の中央値 14.5%
--   この10年は上昇相場が中心で、下降局面の年は含まれない(regime_bias_limits 参照)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. TOPIX の月別集計(年×月の一覧)
--    range_pct は月内の終値の最高値/最安値 - 1(%)。月の途中は暫定値になる。
--------------------------------------------------------------------------------
WITH r AS (
    SELECT price_date, close_price,
           LN(close_price / LAG(close_price) OVER (ORDER BY price_date)) AS lr
    FROM topix_price_daily
), m AS (
    SELECT TO_CHAR(price_date,'YYYY') AS yr,
           TO_CHAR(price_date,'MM')   AS mo,
           COUNT(lr)                  AS n_days,
           STDDEV(lr) * SQRT(252) * 100 AS ann_vol_pct,
           AVG(ABS(lr)) * 100         AS mean_abs_daily_pct,
           MAX(close_price) / MIN(close_price) * 100 - 100 AS range_pct
    FROM r
    WHERE lr IS NOT NULL
    GROUP BY TO_CHAR(price_date,'YYYY'), TO_CHAR(price_date,'MM')
)
SELECT yr, mo, n_days,
       ROUND(ann_vol_pct, 1)       AS ann_vol_pct,
       ROUND(mean_abs_daily_pct,2) AS mean_abs_daily_pct,
       ROUND(range_pct, 1)         AS range_pct
FROM m
ORDER BY yr, mo;


--------------------------------------------------------------------------------
-- 2. TOPIX: 各年の 4/1〜9/18 を1つの期間として年別に比較
--------------------------------------------------------------------------------
WITH r AS (
    SELECT price_date,
           LN(close_price / LAG(close_price) OVER (ORDER BY price_date)) AS lr
    FROM topix_price_daily
), w AS (
    SELECT EXTRACT(YEAR FROM price_date) AS yr, lr, ABS(lr) AS alr
    FROM r
    WHERE lr IS NOT NULL
      AND TO_CHAR(price_date,'MMDD') BETWEEN '0401' AND '0918'
)
SELECT yr,
       COUNT(*)                                        AS n_days,
       ROUND(STDDEV(lr) * SQRT(252) * 100, 1)          AS ann_vol_pct,
       ROUND(AVG(alr) * 100, 2)                        AS mean_abs_daily_pct,
       SUM(CASE WHEN alr >= 0.02 THEN 1 ELSE 0 END)    AS days_move_2pct_plus,
       SUM(CASE WHEN alr >= 0.01 THEN 1 ELSE 0 END)    AS days_move_1pct_plus
FROM w
GROUP BY yr
ORDER BY ann_vol_pct DESC;


--------------------------------------------------------------------------------
-- 3. 個別株: 1銘柄ごとの「1日の平均的な動き」を年別に集計し、銘柄間の中央値・平均を出す
--    前提は冒頭の【個別株の前提】を参照。重いクエリ(約50秒)。
--------------------------------------------------------------------------------
WITH p AS (
    SELECT e.code, e.price_date, e.close_price, e.adj_factor,
           LAG(e.close_price) OVER (PARTITION BY e.code ORDER BY e.price_date) AS prev_close
    FROM equity_price_daily e
    JOIN equity_master m
      ON m.code = e.code
     AND m.prod_category = '011'
    WHERE e.close_price > 0
), w AS (
    SELECT code,
           EXTRACT(YEAR FROM price_date) AS yr,
           ABS(LN(close_price / prev_close)) AS alr
    FROM p
    WHERE prev_close > 0
      AND NVL(adj_factor, 1) = 1
      AND TO_CHAR(price_date,'MMDD') BETWEEN '0401' AND '0918'
), s AS (
    SELECT yr, code, COUNT(*) AS n, AVG(alr) * 100 AS mean_abs
    FROM w
    GROUP BY yr, code
    HAVING COUNT(*) >= 100
)
SELECT yr,
       COUNT(*)                   AS n_stocks,
       ROUND(MEDIAN(mean_abs), 2) AS median_stock_mean_abs_daily_pct,
       ROUND(AVG(mean_abs), 2)    AS avg_stock_mean_abs_daily_pct
FROM s
GROUP BY yr
ORDER BY yr;


--------------------------------------------------------------------------------
-- 4. 2026年の各月が、全月(2016-10〜)の中で何番目に動いたか
--    pctile_among_all_months が 90 なら「上位10%」。
--    最新月は営業日が少ないうちは暫定値(ばらつきが不安定)。
--------------------------------------------------------------------------------
WITH d AS (
    SELECT price_date, close_price,
           LN(close_price / LAG(close_price) OVER (ORDER BY price_date)) AS lr,
           TO_CHAR(price_date,'YYYY-MM') AS ym
    FROM topix_price_daily
), m AS (
    SELECT ym, STDDEV(lr) * SQRT(252) * 100 AS vol
    FROM d
    WHERE lr IS NOT NULL
    GROUP BY ym
), z AS (
    SELECT ym, vol, PERCENT_RANK() OVER (ORDER BY vol) AS pr
    FROM m
    WHERE ym > '2016-09'
)
SELECT ym,
       ROUND(vol, 1)   AS vol,
       ROUND(pr * 100) AS pctile_among_all_months
FROM z
WHERE ym >= '2026-04'
ORDER BY ym;


--------------------------------------------------------------------------------
-- 5. 全月の中央値と、4〜8月・2026年4〜8月の中央値の比較
--    ym の上限は「営業日が揃った最後の月」に合わせる(月の途中を含めない)。
--------------------------------------------------------------------------------
WITH d AS (
    SELECT price_date,
           LN(close_price / LAG(close_price) OVER (ORDER BY price_date)) AS lr,
           TO_CHAR(price_date,'YYYY-MM') AS ym,
           TO_CHAR(price_date,'MM')      AS mo
    FROM topix_price_daily
), m AS (
    SELECT ym, mo, STDDEV(lr) * SQRT(252) * 100 AS vol
    FROM d
    WHERE lr IS NOT NULL
      AND ym BETWEEN '2016-10' AND '2026-08'
    GROUP BY ym, mo
)
SELECT ROUND(MEDIAN(vol), 1) AS median_all_months,
       ROUND(AVG(vol), 1)    AS mean_all_months,
       ROUND(MEDIAN(CASE WHEN mo BETWEEN '04' AND '08' THEN vol END), 1) AS median_apr_aug_all_years,
       ROUND(MEDIAN(CASE WHEN ym BETWEEN '2026-04' AND '2026-08' THEN vol END), 1) AS median_apr_aug_2026
FROM m;
