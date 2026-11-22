-- 出来高が増えた日に株価も 5% 以上上げ、5 営業日後の終値が
--   ・上げた日の終値以上
--   ・その後 5 営業日の終値の中で一番高い
-- 銘柄を探す
--
-- 用語
--   上げた日 : 条件に当たった日(結果の up_date)
--   その後   : 上げた日の翌営業日から 5 営業日
--   基準期間 : 上げた日の直前 20 営業日(出来高の「ふだん」を測る)
--
-- 仮に置いた数字(params の中。ここを書き換える)
--   from_date  探す範囲の始め(上げた日)
--   up_min     上げた日の前日比                        0.05 = +5% 以上
--   vol_x_min  上げた日の出来高 ÷ 基準期間の平均出来高  2.0 倍以上
--   tv_min     基準期間の平均売買代金の下限(円)。0 = 絞らない
--
-- 上げた日は、その後 5 営業日ぶんのデータがある日までが対象(直近 5 営業日は出てこない)
-- 株価・出来高は分割調整済み(その日より後の adj_factor の積を掛ける/割る)
WITH params AS (
  SELECT DATE '2026-08-01' AS from_date,
         0.05  AS up_min,
         2.0   AS vol_x_min,
         0     AS tv_min
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
  WHERE p.price_date >= (SELECT from_date - 60 FROM params)   -- 20 営業日ぶんの助走
    AND p.close_price IS NOT NULL
    AND p.adj_factor > 0
), r AS (
  SELECT px.*,
         adj_close / LAG(adj_close) OVER (PARTITION BY code ORDER BY price_date) - 1 AS ret
  FROM px
), w AS (
  SELECT r.*,
    AVG(adj_vol)        OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS vol_base,
    AVG(turnover_value) OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS tv_base,
    COUNT(*)            OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS n_prev,
    MIN(adj_close)      OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING)  AS min_close_next,
    MAX(adj_close)      OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING)  AS max_close_next,
    LEAD(adj_close, 5)  OVER (PARTITION BY code ORDER BY price_date)                                           AS close_5d,
    SUM(CASE WHEN ret < 0 THEN 1 ELSE 0 END)
                        OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING)  AS down_days,
    COUNT(*)            OVER (PARTITION BY code ORDER BY price_date ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING)  AS n_next
  FROM r
)
SELECT w.code,
       m.co_name,
       m.market_name,
       w.price_date                                      AS up_date,       -- 上げた日
       ROUND(w.ret * 100, 1)                             AS up_pct,        -- 上げた日の前日比(%)
       ROUND(w.adj_vol / w.vol_base, 1)                  AS vol_x,         -- 上げた日の出来高 ÷ 直前 20 日の平均(倍)
       ROUND((w.close_5d / w.adj_close - 1) * 100, 1)    AS after_5d_pct,  -- 5 営業日後の終値(上げた日の終値比 %)
       ROUND((w.min_close_next / w.adj_close - 1) * 100, 1) AS min_next_pct, -- その後 5 日で一番安い終値(上げた日の終値比 %)
       w.down_days,                                                        -- その後 5 日のうち前日比マイナスだった日数
       ROUND(w.tv_base / 1e8, 2)                         AS tv_oku         -- 直前 20 日の平均売買代金(億円)
FROM w
JOIN equity_master m ON m.code = w.code
CROSS JOIN params pr
WHERE w.n_prev = 20
  AND w.n_next = 5
  AND w.price_date >= pr.from_date
  AND w.ret >= pr.up_min
  AND w.vol_base > 0
  AND w.adj_vol >= pr.vol_x_min * w.vol_base
  AND w.close_5d >= w.adj_close          -- 5 営業日後の終値が、上げた日の終値以上
  AND w.close_5d >= w.max_close_next     -- 5 営業日後の終値が、その後 5 営業日の終値の中で一番高い
  AND w.tv_base >= pr.tv_min
ORDER BY w.price_date DESC, w.ret DESC
