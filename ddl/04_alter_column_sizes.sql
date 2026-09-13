--------------------------------------------------------------------------------
-- 銘柄マスタ系テーブルの桁数拡張
-- 実行ユーザー: GD_JQUANTS
--
-- 背景:
--   ETF等の銘柄名が VARCHAR2(200) に収まらないケースが実データで確認された
--   (NJS-058: maxSize of 200 is too small for value of length 210)。
--
--   加えて、Oracleの VARCHAR2(n) は既定でバイト数指定のため、
--   UTF-8の日本語(1文字3バイト)では VARCHAR2(200) = 実質66文字しか入らない。
--   桁数を増やすだけでなく CHAR セマンティクスを明示して、
--   「文字数」で確実に確保する。
--
-- 注意:
--   データ投入前(0行)の状態で実行すること。
--   投入後に実行する場合、桁数を広げる方向なのでデータ消失は起きないが、
--   テーブルロックがかかるため実行タイミングに注意すること。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- EQUITY_MASTER
--------------------------------------------------------------------------------
ALTER TABLE equity_master MODIFY (
    co_name          VARCHAR2(500 CHAR),
    co_name_en       VARCHAR2(500 CHAR),
    sector17_code    VARCHAR2(10 CHAR),
    sector17_name    VARCHAR2(100 CHAR),
    sector33_code    VARCHAR2(10 CHAR),
    sector33_name    VARCHAR2(100 CHAR),
    scale_category   VARCHAR2(100 CHAR),
    market_code      VARCHAR2(10 CHAR),
    market_name      VARCHAR2(100 CHAR),
    margin_code      VARCHAR2(10 CHAR),
    margin_name      VARCHAR2(100 CHAR),
    prod_category    VARCHAR2(20 CHAR)
);

--------------------------------------------------------------------------------
-- EQUITY_MASTER_HIST
--------------------------------------------------------------------------------
ALTER TABLE equity_master_hist MODIFY (
    co_name          VARCHAR2(500 CHAR),
    co_name_en       VARCHAR2(500 CHAR),
    sector17_code    VARCHAR2(10 CHAR),
    sector17_name    VARCHAR2(100 CHAR),
    sector33_code    VARCHAR2(10 CHAR),
    sector33_name    VARCHAR2(100 CHAR),
    scale_category   VARCHAR2(100 CHAR),
    market_code      VARCHAR2(10 CHAR),
    market_name      VARCHAR2(100 CHAR),
    margin_code      VARCHAR2(10 CHAR),
    margin_name      VARCHAR2(100 CHAR),
    prod_category    VARCHAR2(20 CHAR)
);

--------------------------------------------------------------------------------
-- EQUITY_MASTER_STG
--------------------------------------------------------------------------------
ALTER TABLE equity_master_stg MODIFY (
    co_name          VARCHAR2(500 CHAR),
    co_name_en       VARCHAR2(500 CHAR),
    sector17_code    VARCHAR2(10 CHAR),
    sector17_name    VARCHAR2(100 CHAR),
    sector33_code    VARCHAR2(10 CHAR),
    sector33_name    VARCHAR2(100 CHAR),
    scale_category   VARCHAR2(100 CHAR),
    market_code      VARCHAR2(10 CHAR),
    market_name      VARCHAR2(100 CHAR),
    margin_code      VARCHAR2(10 CHAR),
    margin_name      VARCHAR2(100 CHAR),
    prod_category    VARCHAR2(20 CHAR)
);

--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name, column_name, data_type, data_length, char_length, char_used
-- FROM user_tab_columns
-- WHERE table_name IN ('EQUITY_MASTER','EQUITY_MASTER_HIST','EQUITY_MASTER_STG')
--   AND data_type = 'VARCHAR2'
-- ORDER BY table_name, column_id;
--   ※ char_used が 'C' なら文字数セマンティクス、'B' ならバイト数セマンティクス
