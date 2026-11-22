-- 出来高が微増のまま 10 営業日わずかに値上がりし、その翌営業日に急騰した銘柄を探す
--
-- 用語
--   急騰日   : 条件に当たった日(結果の surge_date)
--   静かな期間: 急騰日の直前 10 営業日
--   基準期間 : 静かな期間のさらに前 20 営業日(出来高の「ふだん」を測る)
--
-- 仮に置いた数字(params の中。ここを書き換える)
--   from_date        探す範囲の始め(急騰日)
--   surge_min        急騰日の前日比                  0.08 = +8% 以上
--   quiet_ret_min/max 静かな期間 10 日間の値上がり    0 〜 +5%
--   quiet_day_max    静かな期間の 1 日の値動きの上限  ±3% 以内
--   vol_ratio_min/max 静かな期間の平均出来高 ÷ 基準期間の平均出来高  1.0 〜 1.5 倍
--   vol_spike_max    静かな期間の 1 日の出来高の上限  基準期間平均の 2.5 倍まで
--   tv_min           静かな期間の平均売買代金の下限   5,000 万円
--
-- 株価・出来高は分割調整済み(その日より後の adj_factor の積を掛ける/割る)
WITH params AS (
  SELECT DATE '2026-08-01' AS from_date,
         0.08  AS surge_min,
         0     AS quiet_ret_min,
         0.05  AS quiet_ret_max,
         0.03  AS quiet_day_max,
         1.0   AS vol_ratio_min,
         1.5   AS vol_ratio_max,
         2.5   AS vol_spike_max,
         50000000 AS tv_min
  FROM dual
), px AS (
  SELECT p.code, p.price_date, p.turnover_value,
         p.close_price * NVL(EXP(SUM(LN(p.adj_factor)) OVER (
             PARTITION BY p.code ORDER BY p.price_date DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)), 1) AS adj_close,
         p.volume / NVL(EXP(SUM(LN(p.adj_factor)) OVER (
             PARTITION BY p.code ORDER BY p.price_date DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)), 1) AS adj_vol
  FROM equity_price_daily p
  WHERE p.price_date >= (SELECT from_date - 90 FROM params)   -- 30 営業日ぶんの助走
    AND p.close_price IS NOT NULL
    AND p.adj_factor > 0
), r AS (
  SELECT px.*,
         adj_close / LAG(adj_close) OVER (PARTITION BY code ORDER BY price_date) - 1 AS ret
  FROM px
), w AS (
  SELECT r.*,
    LAG(adj_close, 1)  OVER (PARTITION BY code ORDER BY price_date) AS c_end,     -- 静かな期間の最終日の終値
    LAG(adj_close, 11) OVER (PARTITION BY code ORDER BY price_date) AS c_start,   -- 静かな期間が始まる前日の終値
    MAX(ABS(ret))       OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)  AS max_abs_ret,
    AVG(adj_vol)        OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)  AS vol_quiet,
    MAX(adj_vol)        OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)  AS vol_quiet_max,
    AVG(adj_vol)        OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 30 PRECEDING AND 11 PRECEDING) AS vol_base,
    AVG(turnover_value) OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING)  AS tv_quiet,
    COUNT(*)            OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING)  AS n_prev
  FROM r
)
SELECT w.code,
       m.co_name,
       m.market_name,
       w.price_date                             AS surge_date,         -- 急騰日
       ROUND(w.ret * 100, 1)                    AS surge_pct,          -- 急騰日の前日比(%)
       ROUND((w.c_end / w.c_start - 1) * 100, 1) AS quiet_pct,         -- 静かな期間 10 日間の値上がり(%)
       ROUND(w.max_abs_ret * 100, 1)            AS quiet_max_day_pct,  -- 静かな期間で一番大きかった 1 日の値動き(%)
       ROUND(w.vol_quiet / w.vol_base, 2)       AS vol_ratio,          -- 静かな期間の出来高 ÷ 基準期間の出来高(倍)
       ROUND(w.adj_vol / w.vol_quiet, 1)        AS surge_vol_x,        -- 急騰日の出来高 ÷ 静かな期間の出来高(倍)
       ROUND(w.tv_quiet / 1e8, 1)               AS tv_oku              -- 静かな期間の平均売買代金(億円)
FROM w
JOIN equity_master m ON m.code = w.code
CROSS JOIN params pr
WHERE w.n_prev = 30
  AND w.price_date >= pr.from_date
  AND w.ret >= pr.surge_min
  AND w.c_end / w.c_start - 1 BETWEEN pr.quiet_ret_min AND pr.quiet_ret_max
  AND w.max_abs_ret <= pr.quiet_day_max
  AND w.vol_base > 0
  AND w.vol_quiet / w.vol_base BETWEEN pr.vol_ratio_min AND pr.vol_ratio_max
  AND w.vol_quiet_max <= pr.vol_spike_max * w.vol_base
  AND w.tv_quiet >= pr.tv_min
ORDER BY w.price_date DESC, w.ret DESC
