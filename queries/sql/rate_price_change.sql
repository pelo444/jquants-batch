--------------------------------------------------------------------------------
-- 期間騰落率ランキング(株式分割調整済み)
--
-- 指定期間の最初と最後の終値を比較して騰落率を算出する。
-- 期間内に株式分割・併合があった銘柄は AdjFactor で調整するため、
-- 見かけ上の急落・急騰を騰落率として拾ってしまうことがない。
--
-- 【調整の考え方】
--   その日より後に発生した AdjFactor の累積積を終値に掛けると、
--   期間末の株価水準に揃った系列になる。
--   Oracleには積の集計関数が無いため EXP(SUM(LN(...))) で代用している。
--   最終行は「自分より後の行」が無く SUM() が NULL になるため NVL(...,1) が必須。
--
-- 【使い方】
--   PARAMS の日付2箇所を変更する。それ以外は変更不要。
--------------------------------------------------------------------------------

WITH params AS (
    SELECT DATE '2024-04-01' AS d_from,
           DATE '2025-03-31' AS d_to
    FROM dual
),
--------------------------------------------------------------------------------
-- 期間内の各行に「自分より後の累積調整係数」を付与し、調整後終値を算出
--------------------------------------------------------------------------------
adj AS (
    SELECT p.code,
           p.price_date,
           p.close_price,
           p.adj_factor,
           ROUND(
             p.close_price *
             NVL(EXP(SUM(LN(NULLIF(p.adj_factor, 0))) OVER (
                   PARTITION BY p.code
                   ORDER BY p.price_date
                   ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1)
           , 2) AS adj_close
    FROM equity_price_daily p
    CROSS JOIN params
    WHERE p.close_price IS NOT NULL
      AND p.price_date BETWEEN params.d_from AND params.d_to
),
--------------------------------------------------------------------------------
-- 銘柄ごとに期間の両端を1回のスキャンで取得
--------------------------------------------------------------------------------
base AS (
    SELECT code,
           MIN(price_date)  KEEP (DENSE_RANK FIRST ORDER BY price_date) AS d1,
           MAX(price_date)  KEEP (DENSE_RANK LAST  ORDER BY price_date) AS d2,
           MIN(close_price) KEEP (DENSE_RANK FIRST ORDER BY price_date) AS raw_p1,
           MIN(adj_close)   KEEP (DENSE_RANK FIRST ORDER BY price_date) AS p1,
           MAX(adj_close)   KEEP (DENSE_RANK LAST  ORDER BY price_date) AS p2,
           COUNT(*)                                                     AS trading_days,
           COUNT(CASE WHEN adj_factor <> 1 THEN 1 END)                  AS split_count
    FROM adj
    GROUP BY code
)
SELECT b.code,
       em.co_name,
       em.market_name,
       em.sector33_name,
       TO_CHAR(b.d1, 'YYYY-MM-DD')                        AS d1,
       TO_CHAR(b.d2, 'YYYY-MM-DD')                        AS d2,
       b.p1,                                                          -- 調整後の起点株価
       b.p2,                                                          -- 期間末の株価
       ROUND(b.p2 - b.p1, 1)                              AS diff,
       ROUND((b.p2 / NULLIF(b.p1, 0) - 1) * 100, 2)       AS change_pct,
       b.trading_days,
       b.split_count,                                                 -- 期間内の分割・併合回数
       b.raw_p1                                                       -- 調整前の起点株価(検算用)
FROM base b
JOIN equity_master em ON em.code = b.code
WHERE em.sector17_code <> '99'                  -- ETF・REIT等を除外
  AND em.market_name <> 'TOKYO PRO MARKET'      -- 個人が売買できない市場を除外
  AND b.trading_days >= 100                     -- 流動性が極端に低い銘柄を除外
  and exists (
    select * from favorite_tag f 
    where f.tag_name = 'photoelectric_fusion'
    and f.code = b.code
  )
ORDER BY change_pct DESC;

--------------------------------------------------------------------------------
-- 補足
--------------------------------------------------------------------------------
-- ・SPLIT_COUNT > 0 の銘柄は調整が効いている。RAW_P1 と P1 を見比べると
--   どれだけ補正されたかが分かる。
--
-- ・TRADING_DAYS が期間の営業日数に満たない銘柄は、途中で新規上場したか、
--   売買不成立の日が多かった銘柄。同一起点での比較にしたい場合は
--   WHERE 句に「AND b.d1 <= DATE '2025-04-10'」のような条件を足す。
--
-- ・TOB(株式公開買付)進行中の銘柄は、買付価格に張り付いて
--   「高騰かつ値動きなし」という特異な結果になる。上位に見慣れない銘柄が来たら
--   以下で値動きの有無を確認するとよい:
--     SELECT TO_CHAR(price_date,'YYYY-MM-DD'), open_price, high_price,
--            low_price, close_price, volume
--     FROM equity_price_daily WHERE code = '&code'
--     ORDER BY price_date DESC FETCH FIRST 20 ROWS ONLY;
--
-- ・実行が遅い場合は統計情報を収集する:
--     BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER,'EQUITY_PRICE_DAILY',cascade=>TRUE); END;
--     /