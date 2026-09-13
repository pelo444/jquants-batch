--------------------------------------------------------------------------------
-- 取引カレンダー・指数四本値関連テーブル (Tier 1)
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ(いずれもJ-Quants Standardプラン以上、Bulk API(CSV)で取得):
--   1. 取引カレンダー   /markets/calendar             → TRADING_CALENDAR
--   2. TOPIX四本値      /indices/bars/daily/topix     → TOPIX_PRICE_DAILY
--   3. 指数四本値       /indices/bars/daily           → INDEX_PRICE_DAILY
--
-- いずれも EQUITY_MASTER への外部キーを持たない(銘柄単位のデータではないため)。
--
-- 【実データ未確認であることについて】
--   7章の手順(新エンドポイント追加時は必ずinspect-bulk-csv.jsで実データを確認する)を
--   今回は実行できていない。Claude(Cowork)のdevice_bashからapi.jquants.comへの通信が
--   egressで遮断されており、実行できなかったため([[cowork_device_bridge_limits]]参照)。
--   このDDL・csvMapper.js・mergeSql.jsはAPI仕様書(/spec/mkt-cal, /spec/idx-bars-daily-topix,
--   /spec/idx-bars-daily)の記載のみに基づいている。
--   ユーザーの手元で以下を必ず実行してから本番投入すること:
--     node scripts/inspect-bulk-csv.js trading-calendar index-topix index-daily --rows 3
--   ヘッダー名や空欄表現がここでの想定と異なっていた場合は、csvMapper.jsの対応箇所を
--   実データに合わせて修正すること。
--
-- 前提: 01〜04 のDDLを実行済みであること(既存の運用と揃えるため。本DDL自体はFKを持たない)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. TRADING_CALENDAR (取引カレンダー)
--
-- 東証・OSEの営業日/非営業日/半日立会/祝日取引の情報。銘柄に紐づかない全期間共通データ。
-- 休日区分(HolDiv)の値は仕様書(/spec/mkt-cal/holiday-division)より:
--   0: 非営業日   1: 営業日   2: 東証半日立会日   3: 非営業日(祝日取引あり)
--------------------------------------------------------------------------------
CREATE TABLE trading_calendar (
    calendar_date  DATE               NOT NULL,
    hol_div        VARCHAR2(1 CHAR)   NOT NULL,
    loaded_at      TIMESTAMP          DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_trading_calendar PRIMARY KEY (calendar_date)
);

COMMENT ON TABLE  trading_calendar                IS '取引カレンダー(東証・OSEの営業日区分)';
COMMENT ON COLUMN trading_calendar.calendar_date  IS '日付(Date)';
COMMENT ON COLUMN trading_calendar.hol_div        IS '休日区分(HolDiv) 0:非営業日 1:営業日 2:東証半日立会日 3:非営業日(祝日取引あり)';
COMMENT ON COLUMN trading_calendar.loaded_at      IS '取込日時';


--------------------------------------------------------------------------------
-- 2. TOPIX_PRICE_DAILY (TOPIX四本値)
--
-- 専用エンドポイント(/indices/bars/daily/topix)は指数コードを返さない
-- (TOPIX固定・1行1日)。指数四本値(INDEX_PRICE_DAILY)にも指数コード'0000'として
-- TOPIXが含まれる可能性があるが、どちらが実際にどう重複するかは実データ確認後に
-- [[standard_plan_unloaded_data]]へ追記する。重複していても実害はない
-- (どちらも同じ値のはずで、分析側は好きな方を参照すればよい)。
--------------------------------------------------------------------------------
CREATE TABLE topix_price_daily (
    price_date   DATE           NOT NULL,
    open_price   NUMBER(20,4),
    high_price   NUMBER(20,4),
    low_price    NUMBER(20,4),
    close_price  NUMBER(20,4),
    loaded_at    TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_topix_price_daily PRIMARY KEY (price_date)
);

COMMENT ON TABLE  topix_price_daily              IS 'TOPIX四本値(日次)';
COMMENT ON COLUMN topix_price_daily.price_date   IS '日付(Date)';
COMMENT ON COLUMN topix_price_daily.open_price   IS '始値(O)';
COMMENT ON COLUMN topix_price_daily.high_price   IS '高値(H)';
COMMENT ON COLUMN topix_price_daily.low_price    IS '安値(L)';
COMMENT ON COLUMN topix_price_daily.close_price  IS '終値(C)';
COMMENT ON COLUMN topix_price_daily.loaded_at    IS '取込日時';


--------------------------------------------------------------------------------
-- 3. INDEX_PRICE_DAILY (指数四本値)
--
-- TOPIX-17・東証業種別指数・配当込み指数など、Standardプランで取得可能な指数の四本値。
-- 「終値のみ提供」の指数はO/H/Lが空欄(NULL)で入ってくる(仕様書に明記)。
-- Premium限定の指数(配当込み指数の一部など)はStandard契約では取得できないため、
-- Bulkファイルにそもそも含まれない想定。
--------------------------------------------------------------------------------
CREATE TABLE index_price_daily (
    index_code   VARCHAR2(10 CHAR)  NOT NULL,
    price_date   DATE               NOT NULL,
    open_price   NUMBER(20,4),
    high_price   NUMBER(20,4),
    low_price    NUMBER(20,4),
    close_price  NUMBER(20,4),
    loaded_at    TIMESTAMP          DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_index_price_daily PRIMARY KEY (index_code, price_date)
);

COMMENT ON TABLE  index_price_daily              IS '指数四本値(TOPIX-17・東証業種別・配当込み指数等、日次)';
COMMENT ON COLUMN index_price_daily.index_code   IS '指数コード(Code)。INDEX_MASTER参照';
COMMENT ON COLUMN index_price_daily.price_date   IS '日付(Date)';
COMMENT ON COLUMN index_price_daily.open_price   IS '始値(O)。終値のみ提供の指数はNULL';
COMMENT ON COLUMN index_price_daily.high_price   IS '高値(H)。終値のみ提供の指数はNULL';
COMMENT ON COLUMN index_price_daily.low_price    IS '安値(L)。終値のみ提供の指数はNULL';
COMMENT ON COLUMN index_price_daily.close_price  IS '終値(C)';
COMMENT ON COLUMN index_price_daily.loaded_at    IS '取込日時';

CREATE INDEX ix_index_price_daily_date ON index_price_daily (price_date);


--------------------------------------------------------------------------------
-- 4. INDEX_MASTER (指数マスタ、参考データ)
--
-- API仕様書(/spec/idx-bars-daily/indexcodes、2026-09-06時点)を手動で転記した参考データ。
-- J-Quantsからマスタ配信APIがあるわけではないため、TAG_MASTERと同様に手動管理とする。
-- 新しい指数が追加された場合はこのテーブルにINSERTを追加すること。
-- premium_only='Y' の指数はStandardプランでは取得できない(INDEX_PRICE_DAILYには入らない)。
--------------------------------------------------------------------------------
CREATE TABLE index_master (
    index_code    VARCHAR2(10 CHAR)  NOT NULL,
    index_name    VARCHAR2(200 CHAR) NOT NULL,
    premium_only  VARCHAR2(1 CHAR)   DEFAULT 'N' NOT NULL,
    close_only    VARCHAR2(1 CHAR)   DEFAULT 'N' NOT NULL,
    CONSTRAINT pk_index_master PRIMARY KEY (index_code)
);

COMMENT ON TABLE  index_master               IS '指数マスタ(参考データ・手動管理)';
COMMENT ON COLUMN index_master.index_code    IS '指数コード';
COMMENT ON COLUMN index_master.index_name    IS '指数名称';
COMMENT ON COLUMN index_master.premium_only  IS 'Premiumプラン限定ならY(Standardでは取得不可)';
COMMENT ON COLUMN index_master.close_only    IS '終値のみ提供ならY';

INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0000', 'TOPIX', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0028', 'TOPIX Core30', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0029', 'TOPIX Large 70', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('002A', 'TOPIX 100', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('002B', 'TOPIX Mid400', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('002C', 'TOPIX 500', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('002D', 'TOPIX Small', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('002E', 'TOPIX 1000', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('002F', 'TOPIX Small500', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0040', '東証業種別 水産・農林業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0041', '東証業種別 鉱業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0042', '東証業種別 建設業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0043', '東証業種別 食料品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0044', '東証業種別 繊維製品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0045', '東証業種別 パルプ・紙', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0046', '東証業種別 化学', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0047', '東証業種別 医薬品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0048', '東証業種別 石油・石炭製品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0049', '東証業種別 ゴム製品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('004A', '東証業種別 ガラス・土石製品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('004B', '東証業種別 鉄鋼', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('004C', '東証業種別 非鉄金属', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('004D', '東証業種別 金属製品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('004E', '東証業種別 機械', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('004F', '東証業種別 電気機器', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0050', '東証業種別 輸送用機器', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0051', '東証業種別 精密機器', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0052', '東証業種別 その他製品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0053', '東証業種別 電気・ガス業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0054', '東証業種別 陸運業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0055', '東証業種別 海運業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0056', '東証業種別 空運業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0057', '東証業種別 倉庫・運輸関連業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0058', '東証業種別 情報・通信業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0059', '東証業種別 卸売業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('005A', '東証業種別 小売業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('005B', '東証業種別 銀行業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('005C', '東証業種別 証券・商品先物取引業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('005D', '東証業種別 保険業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('005E', '東証業種別 その他金融業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('005F', '東証業種別 不動産業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0060', '東証業種別 サービス業', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0070', '東証グロース市場250指数(旧:東証マザーズ指数)', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0075', 'REIT', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0080', 'TOPIX-17 食品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0081', 'TOPIX-17 エネルギー資源', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0082', 'TOPIX-17 建設・資材', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0083', 'TOPIX-17 素材・化学', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0084', 'TOPIX-17 医薬品', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0085', 'TOPIX-17 自動車・輸送機', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0086', 'TOPIX-17 鉄鋼・非鉄', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0087', 'TOPIX-17 機械', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0088', 'TOPIX-17 電機・精密', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0089', 'TOPIX-17 情報通信・サービスその他', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('008A', 'TOPIX-17 電力・ガス', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('008B', 'TOPIX-17 運輸・物流', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('008C', 'TOPIX-17 商社・卸売', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('008D', 'TOPIX-17 小売', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('008E', 'TOPIX-17 銀行', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('008F', 'TOPIX-17 金融(除く銀行)', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0090', 'TOPIX-17 不動産', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0500', '東証プライム市場指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0501', '東証スタンダード市場指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0502', '東証グロース市場指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0503', 'JPXプライム150指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('0504', 'JPXスタートアップ急成長100指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('8100', 'TOPIX バリュー', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('812C', 'TOPIX500 バリュー', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('812D', 'TOPIXSmall バリュー', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('8200', 'TOPIX グロース', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('822C', 'TOPIX500 グロース', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('822D', 'TOPIXSmall グロース', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('8501', '東証REIT オフィス指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('8502', '東証REIT 住宅指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('8503', '東証REIT 商業・物流等指数', 'N', 'N');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6000', '配当込みTOPIX', 'N', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B507', '配当込みJPX日経インデックス400', 'N', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6096', '税引後配当込みJPX日経インデックス400', 'N', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6095', '税引後配当込みTOPIX', 'N', 'Y');
-- 以下、配当込み系はPremiumプラン限定(データ取得不可・参考のみ)
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6028', '配当込みTOPIX Core30', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6029', '配当込みTOPIX Large70', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('602A', '配当込みTOPIX 100', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('602B', '配当込みTOPIX Mid400', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('602C', '配当込みTOPIX 500', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('602D', '配当込みTOPIX Small', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('602E', '配当込みTOPIX 1000', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6503', '配当込みJPXプライム150指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6504', '配当込みJPXスタートアップ急成長100指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B100', '配当込みTOPIX バリュー', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B200', '配当込みTOPIX グロース', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B12C', '配当込みTOPIX500 バリュー', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B22C', '配当込みTOPIX500 グロース', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B12D', '配当込みTOPIXSmall バリュー', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B22D', '配当込みTOPIXSmall グロース', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('6075', '配当込みREIT', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B500', '配当込み配当フォーカス100', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B501', '配当込み東証REIT オフィス指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B502', '配当込み東証REIT 住宅指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('B503', '配当込み東証REIT 商業・物流等指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('7000', '配当込み東証プライム市場指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('7001', '配当込み東証スタンダード市場指数', 'Y', 'Y');
INSERT INTO index_master (index_code, index_name, premium_only, close_only) VALUES ('7002', '配当込み東証グロース市場指数', 'Y', 'Y');
-- TOPIX-17配当込み・東証業種別配当込みはすべてPremium限定(6080系〜6090, 6040系〜6060)。
-- 件数が多く更新頻度も低いため、必要になった時点で追加する(Standardでは使わないため今回は割愛)。

COMMIT;


--------------------------------------------------------------------------------
-- 5. ステージングテーブル
--------------------------------------------------------------------------------
CREATE TABLE trading_calendar_stg (
    calendar_date  DATE,
    hol_div        VARCHAR2(1 CHAR),
    loaded_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE topix_price_daily_stg (
    price_date   DATE,
    open_price   NUMBER(20,4),
    high_price   NUMBER(20,4),
    low_price    NUMBER(20,4),
    close_price  NUMBER(20,4),
    loaded_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE index_price_daily_stg (
    index_code   VARCHAR2(10 CHAR),
    price_date   DATE,
    open_price   NUMBER(20,4),
    high_price   NUMBER(20,4),
    low_price    NUMBER(20,4),
    close_price  NUMBER(20,4),
    loaded_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE trading_calendar_stg   IS '取引カレンダーのステージング';
COMMENT ON TABLE topix_price_daily_stg  IS 'TOPIX四本値のステージング';
COMMENT ON TABLE index_price_daily_stg  IS '指数四本値のステージング';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name IN ('TRADING_CALENDAR','TOPIX_PRICE_DAILY','INDEX_PRICE_DAILY','INDEX_MASTER')
--  ORDER BY table_name;
--
-- SELECT endpoint_name, status, COUNT(*) AS files, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name IN ('/markets/calendar','/indices/bars/daily/topix','/indices/bars/daily')
-- GROUP BY endpoint_name, status
-- ORDER BY endpoint_name, status;
