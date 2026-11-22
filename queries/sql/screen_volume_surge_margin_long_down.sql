-- 出来高が膨らみ、同じ期間に信用買残が減った銘柄を探す
--
-- 用語
--   窓        : 出来高を見る直近の期間(既定 3 営業日。win_start 〜 win_end)
--   基準日    : 窓の直前の営業日(base_date)。信用買残の出発点
--   ふだんの出来高 : 基準日までの 25 営業日平均、および 5 営業日平均(窓は含めない)
--   減少/出来高    : 信用買残の減少株数 ÷ 窓の出来高合計(窓の売買のうち何%が信用買いの整理だったか)
--
-- 条件
--   1 出来高が膨らんだ : 窓の1日平均出来高 ÷ 25営業日平均 が vol_x25_min 倍以上
--   2 信用買残が減った : 基準日の買残 > 窓終わりの買残
--
-- 並び : 減少/出来高 の大きい順
--
-- 仮に置いた数字(params の中。ここを書き換える)
--   win_start / win_end  窓の始めと終わり(信用買残は win_end の申込日を使う)
--   base_date            窓の直前の営業日
--   vol_x25_min          出来高の倍率(25営業日平均比) 2.0 倍以上
--   tv_min               窓の1日平均売買代金の下限(円)。0 = 絞らない
--
-- 読むときの注意
--   信用買残は申込日ベースで、株価より 1 営業日遅れて出る
--   信用買残はコーポレートアクションの遡及調整が行われないため、
--   窓と基準期間に adj_factor <> 1 の日がある銘柄は対象から外している
--   減少/出来高 が 100% を超える銘柄は、市場での売り以外の決済(現引きなど)が
--   含まれている可能性がある
--   ETF・ETN も信用取引残高に含まれるので結果に混ざる(prod_cat 列で判別する)
WITH params AS (
  SELECT DATE '2026-11-17' AS win_start,
         DATE '2026-11-19' AS win_end,
         DATE '2026-11-16' AS base_date,
         2.0 AS vol_x25_min,
         0   AS tv_min
  FROM dual
), win AS (
  SELECT p.code,
         SUM(p.volume) AS vol_win,
         SUM(p.turnover_value) AS tv_win,
         COUNT(*) AS n_win
  FROM equity_price_daily p
  CROSS JOIN params pa
  WHERE p.price_date BETWEEN pa.win_start AND pa.win_end
  GROUP BY p.code
), base_rank AS (
  SELECT p.code, p.volume,
         ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
  FROM equity_price_daily p
  CROSS JOIN params pa
  WHERE p.price_date <= pa.base_date
    AND p.price_date >= pa.base_date - 120
), base_avg AS (
  SELECT code,
         AVG(CASE WHEN rn <= 25 THEN volume END) AS avg25,
         AVG(CASE WHEN rn <= 5  THEN volume END) AS avg5,
         COUNT(*) AS n_base
  FROM base_rank
  WHERE rn <= 25
  GROUP BY code
), adj AS (
  SELECT p.code, MIN(NVL(p.adj_factor,1)) AS af_min, MAX(NVL(p.adj_factor,1)) AS af_max
  FROM equity_price_daily p
  CROSS JOIN params pa
  WHERE p.price_date >= pa.base_date - 120
  GROUP BY p.code
), mrg AS (
  SELECT mi.code,
         MAX(CASE WHEN mi.app_date = pa.base_date THEN mi.long_vol END) AS long_base,
         MAX(CASE WHEN mi.app_date = pa.win_end   THEN mi.long_vol END) AS long_end,
         MAX(CASE WHEN mi.app_date = pa.win_end   THEN mi.shrt_vol END) AS shrt_end
  FROM equity_margin_interest mi
  CROSS JOIN params pa
  WHERE mi.app_date IN (pa.base_date, pa.win_end)
  GROUP BY mi.code
), px AS (
  SELECT p.code,
         MAX(CASE WHEN p.price_date = pa.base_date THEN p.close_price END) AS c_base,
         MAX(CASE WHEN p.price_date = pa.win_end   THEN p.close_price END) AS c_end
  FROM equity_price_daily p
  CROSS JOIN params pa
  WHERE p.price_date IN (pa.base_date, pa.win_end)
  GROUP BY p.code
)
SELECT w.code,
       em.co_name,
       em.sector33_name,
       em.prod_category AS prod_cat,
       ROUND((mrg.long_base - mrg.long_end) / w.vol_win * 100, 1) AS down_per_vol_pct,
       ROUND((mrg.long_base - mrg.long_end) / mrg.long_base * 100, 1) AS down_rate_pct,
       mrg.long_base,
       mrg.long_end,
       ROUND((w.vol_win / w.n_win) / ba.avg25, 2) AS vol_x25,
       ROUND((w.vol_win / w.n_win) / ba.avg5, 2) AS vol_x5,
       ROUND(w.tv_win / w.n_win / 100000000, 2) AS tv_oku_per_day,
       ROUND((px.c_end / px.c_base - 1) * 100, 1) AS ret_win_pct,
       ROUND(mrg.long_end / NULLIF(mrg.shrt_end, 0), 1) AS margin_ratio
FROM win w
JOIN base_avg ba ON ba.code = w.code
JOIN adj       ON adj.code = w.code
JOIN mrg       ON mrg.code = w.code
JOIN px        ON px.code = w.code
JOIN equity_master em ON em.code = w.code
CROSS JOIN params pa
WHERE ba.n_base = 25
  AND ba.avg25 > 0
  AND ba.avg5 > 0
  AND adj.af_min = 1
  AND adj.af_max = 1
  AND mrg.long_base > 0
  AND mrg.long_end IS NOT NULL
  AND mrg.long_end < mrg.long_base
  AND (w.vol_win / w.n_win) / ba.avg25 >= pa.vol_x25_min
  AND w.tv_win / w.n_win >= pa.tv_min
ORDER BY (mrg.long_base - mrg.long_end) / w.vol_win DESC
