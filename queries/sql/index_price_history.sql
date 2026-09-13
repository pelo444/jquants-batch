--------------------------------------------------------------------------------
-- 指数の四本値を指数名付きで取得(TOPIX-17・東証業種別指数等)
--
-- INDEX_PRICE_DAILY は指数コードのみを持つため、INDEX_MASTER(手動管理の参考データ)
-- と結合して指数名を付ける。TOPIXそのものはTOPIX_PRICE_DAILY(専用テーブル)にも
-- 入っているが、他の指数と並べて見たい場合はこちらでINDEX_CODE='0000'を指定すればよい
-- (INDEX_PRICE_DAILY側にもTOPIXが含まれているかは実データ確認後に判明)。
--
-- 【使い方】
--   PARAMS の指数コード・期間を変更する。指数コード一覧は INDEX_MASTER を参照。
--     SELECT index_code, index_name FROM index_master WHERE premium_only = 'N' ORDER BY index_code;
--------------------------------------------------------------------------------

WITH params AS (
    SELECT '0028'          AS index_code,   -- TOPIX Core30
           DATE '2025-01-01' AS d_from,
           DATE '2025-12-31' AS d_to
    FROM dual
)
SELECT m.index_code,
       m.index_name,
       p.price_date,
       p.open_price,
       p.high_price,
       p.low_price,
       p.close_price
FROM index_price_daily p
JOIN index_master m ON m.index_code = p.index_code
CROSS JOIN params
WHERE p.index_code = params.index_code
  AND p.price_date BETWEEN params.d_from AND params.d_to
ORDER BY p.price_date;
