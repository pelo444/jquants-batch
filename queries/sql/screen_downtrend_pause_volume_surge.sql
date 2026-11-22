-- 下落が続いていたところで下げ止まり、出来高が急に増えた日を探す
--
-- 用語
--   当日     : 条件に当たった日(結果の hit_date)
--   直前10日 : 前日から数えて 10 営業日ぶんの値動き(当日は含めない)
--   ふだんの出来高 : 当日の直前 5 営業日の平均出来高(当日は含めない)
--
-- 条件
--   1 下落が続いていた : 直前10日の下落率が drop_max 以下
--   2 下げ止まり       : 前日は下落していて、当日の前日比が前日の前日比より大きい
--   3 出来高が急増     : 当日の出来高 ÷ ふだんの出来高 が vol_x_min 倍以上
--
-- 仮に置いた数字(params の中。ここを書き換える)
--   from_date  探す範囲の始め(当日)
--   drop_max   直前10日の下落率   -0.20 = -20% 以下
--   vol_x_min  出来高の倍率        3.0 倍以上
--   tv_min     直前 5 営業日の平均売買代金の下限(円)。0 = 絞らない
--
-- 株価・出来高は分割調整済み(その日より後の adj_factor の積を掛ける/割る)
-- 調整の積を正しく取るため、base は from_date の 1 年以上前から読む
WITH params AS (
  SELECT DATE '2025-11-18' AS from_date,
         -0.20     AS drop_max,
         3.0       AS vol_x_min,
         100000000 AS tv_min
  FROM dual
), base AS (
  SELECT CODE, PRICE_DATE, CLOSE_PRICE, VOLUME, TURNOVER_VALUE, NVL(ADJ_FACTOR,1) AS af
  FROM EQUITY_PRICE_DAILY
  WHERE PRICE_DATE >= (SELECT from_date - 400 FROM params)
    AND CLOSE_PRICE > 0
), px AS (
  SELECT CODE, PRICE_DATE, CLOSE_PRICE, VOLUME, TURNOVER_VALUE,
         EXP(NVL(SUM(LN(CASE WHEN af > 0 THEN af END))
                 OVER (PARTITION BY CODE ORDER BY PRICE_DATE
                       ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING), 0)) AS cum
  FROM base
), adj AS (
  SELECT CODE, PRICE_DATE,
         CLOSE_PRICE * cum AS c,
         VOLUME / cum      AS v,
         TURNOVER_VALUE    AS tv,
         CLOSE_PRICE       AS close_px
  FROM px
), w AS (
  SELECT adj.*,
         LAG(c, 1)  OVER (PARTITION BY CODE ORDER BY PRICE_DATE) AS c1,
         LAG(c, 2)  OVER (PARTITION BY CODE ORDER BY PRICE_DATE) AS c2,
         LAG(c, 11) OVER (PARTITION BY CODE ORDER BY PRICE_DATE) AS c11,
         AVG(v)  OVER (PARTITION BY CODE ORDER BY PRICE_DATE
                       ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS v5,
         AVG(tv) OVER (PARTITION BY CODE ORDER BY PRICE_DATE
                       ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS tv5
  FROM adj
)
SELECT TO_CHAR(w.PRICE_DATE, 'YYYY-MM-DD')    AS hit_date,
       SUBSTR(w.CODE, 1, 4)                   AS code,
       m.CO_NAME                              AS co_name,
       ROUND((w.c1 / w.c11 - 1) * 100, 1)     AS drop10_pct,
       ROUND((w.c1 / w.c2  - 1) * 100, 1)     AS prev_day_pct,
       ROUND((w.c  / w.c1  - 1) * 100, 1)     AS hit_day_pct,
       ROUND(w.v / w.v5, 1)                   AS vol_x,
       ROUND(w.tv5 / 100000000, 1)            AS tv5_oku,
       ROUND(w.close_px)                      AS close_px
FROM w
JOIN EQUITY_MASTER m ON m.CODE = w.CODE
CROSS JOIN params p
WHERE w.PRICE_DATE >= p.from_date
  AND w.c11 > 0
  AND w.v5  > 0
  AND w.tv5 >= p.tv_min
  AND w.c1 / w.c11 - 1 <= p.drop_max
  AND w.c1 / w.c2  - 1 <  0
  AND w.c  / w.c1  - 1 >  w.c1 / w.c2 - 1
  AND w.v / w.v5 >= p.vol_x_min
ORDER BY w.PRICE_DATE DESC, w.v / w.v5 DESC
