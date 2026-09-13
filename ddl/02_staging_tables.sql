--------------------------------------------------------------------------------
-- ステージングテーブル DDL
-- 対象: Oracle Database 19c / OCI Autonomous Database (ATP)
-- 実行ユーザー: GD_JQUANTS
--
-- 設計方針:
--   ・本番テーブル(EQUITY_MASTER / EQUITY_PRICE_DAILY)と同じ列構成にするが、
--     PK/FK/CHECK制約は持たせない(APIの生データをそのまま受け止めるため)
--   ・バッチ処理の流れ: TRUNCATE → INSERT(生データ投入) → 検証 → MERGE(本番反映)
--   ・TRUNCATE前提のため、ロードバッチを識別するID等は持たせていない
--     (複数バッチを並行運用する場合は BATCH_ID 列の追加を検討)
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. EQUITY_MASTER_STG (銘柄マスタ ステージング)
--------------------------------------------------------------------------------
CREATE TABLE equity_master_stg (
    code             VARCHAR2(10),
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
    prod_category    VARCHAR2(20 CHAR),
    as_of_date       DATE,
    loaded_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE equity_master_stg IS '銘柄マスタ ステージング(制約なし。TRUNCATE→INSERT→検証→MERGEで運用)';
COMMENT ON COLUMN equity_master_stg.code            IS '銘柄コード(Code)';
COMMENT ON COLUMN equity_master_stg.co_name         IS '会社名(CoName)';
COMMENT ON COLUMN equity_master_stg.co_name_en      IS '会社名英語(CoNameEn)';
COMMENT ON COLUMN equity_master_stg.sector17_code   IS '17業種コード(S17)';
COMMENT ON COLUMN equity_master_stg.sector17_name   IS '17業種名(S17Nm)';
COMMENT ON COLUMN equity_master_stg.sector33_code   IS '33業種コード(S33)';
COMMENT ON COLUMN equity_master_stg.sector33_name   IS '33業種名(S33Nm)';
COMMENT ON COLUMN equity_master_stg.scale_category  IS '規模区分(ScaleCat)';
COMMENT ON COLUMN equity_master_stg.market_code     IS '市場区分コード(Mkt)';
COMMENT ON COLUMN equity_master_stg.market_name     IS '市場区分名(MktNm)';
COMMENT ON COLUMN equity_master_stg.margin_code     IS '信用区分コード(Mrgn)';
COMMENT ON COLUMN equity_master_stg.margin_name     IS '信用区分名(MrgnNm)';
COMMENT ON COLUMN equity_master_stg.prod_category   IS '商品区分(ProdCat)';
COMMENT ON COLUMN equity_master_stg.as_of_date      IS 'この情報の基準日(Date)';
COMMENT ON COLUMN equity_master_stg.loaded_at       IS 'ステージングへの投入日時';

--------------------------------------------------------------------------------
-- 2. EQUITY_PRICE_DAILY_STG (株価四本値 ステージング)
--------------------------------------------------------------------------------
CREATE TABLE equity_price_daily_stg (
    code             VARCHAR2(10),
    price_date       DATE,
    open_price       NUMBER(12,2),
    high_price       NUMBER(12,2),
    low_price        NUMBER(12,2),
    close_price      NUMBER(12,2),
    upper_limit      NUMBER(1),
    lower_limit      NUMBER(1),
    volume           NUMBER(15),
    turnover_value   NUMBER(20,2),
    adj_factor       NUMBER(10,6),
    loaded_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE equity_price_daily_stg IS '株価四本値 ステージング(制約なし。TRUNCATE→INSERT→検証→MERGEで運用)';
COMMENT ON COLUMN equity_price_daily_stg.code            IS '銘柄コード(Code)';
COMMENT ON COLUMN equity_price_daily_stg.price_date      IS '取引日(Date)';
COMMENT ON COLUMN equity_price_daily_stg.open_price      IS '始値(O)';
COMMENT ON COLUMN equity_price_daily_stg.high_price      IS '高値(H)';
COMMENT ON COLUMN equity_price_daily_stg.low_price       IS '安値(L)';
COMMENT ON COLUMN equity_price_daily_stg.close_price     IS '終値(C)';
COMMENT ON COLUMN equity_price_daily_stg.upper_limit     IS 'ストップ高フラグ(UL、0/1)';
COMMENT ON COLUMN equity_price_daily_stg.lower_limit     IS 'ストップ安フラグ(LL、0/1)';
COMMENT ON COLUMN equity_price_daily_stg.volume          IS '出来高(Vo)';
COMMENT ON COLUMN equity_price_daily_stg.turnover_value  IS '売買代金(Va)';
COMMENT ON COLUMN equity_price_daily_stg.adj_factor      IS '調整係数(AdjFactor)';
COMMENT ON COLUMN equity_price_daily_stg.loaded_at       IS 'ステージングへの投入日時';

--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables WHERE table_name LIKE '%_STG' ORDER BY table_name;
