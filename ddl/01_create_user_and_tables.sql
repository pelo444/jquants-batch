--------------------------------------------------------------------------------
-- J-Quants 株価データ格納用 DDL
-- 対象: Oracle Database 19c / OCI Autonomous Database (ATP)
--
-- 実行順序:
--   1. ADMIN権限のユーザー(ATPならADMIN、オンプレならSYS/システム管理者)で
--      本ファイル全体を実行する
--   2. 実行後、JQUANTSユーザーで接続し直してオブジェクトを確認する
--
-- 注意:
--   ・パスワードは仮の値です。実行前に必ず強固なパスワードに置き換えてください。
--   ・パスワードは平文でスクリプトに残さず、実行後は安全な方法で管理してください
--     (Claudeはパスワードの入力や管理は代行しません。ご自身で管理してください)。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. ユーザー作成
--------------------------------------------------------------------------------
CREATE USER gd_jquants IDENTIFIED BY "CHANGE_ME_STRONG_PASSWORD";

-- 基本権限
GRANT CREATE SESSION      TO gd_jquants;
GRANT CREATE TABLE        TO gd_jquants;
GRANT CREATE VIEW         TO gd_jquants;
GRANT CREATE SEQUENCE     TO gd_jquants;
GRANT CREATE PROCEDURE    TO gd_jquants;
GRANT CREATE TRIGGER      TO gd_jquants;
GRANT CREATE JOB          TO gd_jquants;  -- DBMS_SCHEDULERでバッチジョブを組む場合に必要

-- 表領域使用量の上限を撤廃(ATPの場合はDATA表領域に自動割当されるため通常はこれで十分)
GRANT UNLIMITED TABLESPACE TO gd_jquants;

-- 必要に応じてUTL_HTTP等を使う場合(将来的にPL/SQLから直接API叩く場合)は
-- ATPではネットワークACLの設定が別途必要です。現段階では未使用のため付与しません。

--------------------------------------------------------------------------------
-- 以降は gd_jquants ユーザーで接続して実行
--   例: CONNECT gd_jquants/"CHANGE_ME_STRONG_PASSWORD"@<接続文字列>
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 2. EQUITY_MASTER (銘柄マスタ・現在値)
--    運用ルール: 上場廃止になってもレコードは物理削除しない。
--    DELISTED_FLAG='Y' にするのみ(EQUITY_PRICE_DAILY / HIST からの参照を保つため)
--------------------------------------------------------------------------------
CREATE TABLE equity_master (
    code             VARCHAR2(10)   NOT NULL,
    co_name          VARCHAR2(500 CHAR) NOT NULL,
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
    as_of_date       DATE           NOT NULL,
    delisted_flag    VARCHAR2(1)    DEFAULT 'N' NOT NULL,
    updated_at       TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_equity_master PRIMARY KEY (code),
    CONSTRAINT ck_equity_master_delisted CHECK (delisted_flag IN ('Y','N'))
);

COMMENT ON TABLE equity_master IS '銘柄マスタ(現在値・上場廃止銘柄も論理削除で保持)';
COMMENT ON COLUMN equity_master.code            IS '銘柄コード(Code)';
COMMENT ON COLUMN equity_master.co_name         IS '会社名(CoName)';
COMMENT ON COLUMN equity_master.co_name_en      IS '会社名英語(CoNameEn)';
COMMENT ON COLUMN equity_master.sector17_code   IS '17業種コード(S17)';
COMMENT ON COLUMN equity_master.sector17_name   IS '17業種名(S17Nm)';
COMMENT ON COLUMN equity_master.sector33_code   IS '33業種コード(S33)';
COMMENT ON COLUMN equity_master.sector33_name   IS '33業種名(S33Nm)';
COMMENT ON COLUMN equity_master.scale_category  IS '規模区分(ScaleCat)';
COMMENT ON COLUMN equity_master.market_code     IS '市場区分コード(Mkt)';
COMMENT ON COLUMN equity_master.market_name     IS '市場区分名(MktNm)';
COMMENT ON COLUMN equity_master.margin_code     IS '信用区分コード(Mrgn)';
COMMENT ON COLUMN equity_master.margin_name     IS '信用区分名(MrgnNm)';
COMMENT ON COLUMN equity_master.prod_category   IS '商品区分(ProdCat)';
COMMENT ON COLUMN equity_master.as_of_date      IS 'この情報の基準日(Date)';
COMMENT ON COLUMN equity_master.delisted_flag   IS '上場廃止フラグ(Y/N、物理削除せず論理削除で管理)';
COMMENT ON COLUMN equity_master.updated_at      IS 'レコード更新日時(取込処理が更新)';

--------------------------------------------------------------------------------
-- 3. EQUITY_MASTER_HIST (銘柄マスタ履歴)
--    日次バッチ取込のたびにその日のスナップショットを追記
--------------------------------------------------------------------------------
CREATE TABLE equity_master_hist (
    code             VARCHAR2(10)   NOT NULL,
    as_of_date       DATE           NOT NULL,
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
    loaded_at        TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_equity_master_hist PRIMARY KEY (code, as_of_date),
    CONSTRAINT fk_equity_master_hist_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE equity_master_hist IS '銘柄マスタ履歴(社名・市場区分・業種等の変更履歴)';
COMMENT ON COLUMN equity_master_hist.code            IS '銘柄コード(Code)';
COMMENT ON COLUMN equity_master_hist.as_of_date      IS 'この情報の基準日(Date)';
COMMENT ON COLUMN equity_master_hist.co_name         IS '会社名(CoName)';
COMMENT ON COLUMN equity_master_hist.co_name_en      IS '会社名英語(CoNameEn)';
COMMENT ON COLUMN equity_master_hist.sector17_code   IS '17業種コード(S17)';
COMMENT ON COLUMN equity_master_hist.sector17_name   IS '17業種名(S17Nm)';
COMMENT ON COLUMN equity_master_hist.sector33_code   IS '33業種コード(S33)';
COMMENT ON COLUMN equity_master_hist.sector33_name   IS '33業種名(S33Nm)';
COMMENT ON COLUMN equity_master_hist.scale_category  IS '規模区分(ScaleCat)';
COMMENT ON COLUMN equity_master_hist.market_code     IS '市場区分コード(Mkt)';
COMMENT ON COLUMN equity_master_hist.market_name     IS '市場区分名(MktNm)';
COMMENT ON COLUMN equity_master_hist.margin_code     IS '信用区分コード(Mrgn)';
COMMENT ON COLUMN equity_master_hist.margin_name     IS '信用区分名(MrgnNm)';
COMMENT ON COLUMN equity_master_hist.prod_category   IS '商品区分(ProdCat)';
COMMENT ON COLUMN equity_master_hist.loaded_at       IS '取込日時';

--------------------------------------------------------------------------------
-- 4. EQUITY_PRICE_DAILY (株価四本値)
--------------------------------------------------------------------------------
CREATE TABLE equity_price_daily (
    code             VARCHAR2(10)   NOT NULL,
    price_date       DATE           NOT NULL,
    open_price       NUMBER(12,2),
    high_price       NUMBER(12,2),
    low_price        NUMBER(12,2),
    close_price      NUMBER(12,2),
    upper_limit      NUMBER(1),
    lower_limit      NUMBER(1),
    volume           NUMBER(15),
    turnover_value   NUMBER(20,2),
    adj_factor       NUMBER(10,6),
    loaded_at        TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_equity_price_daily PRIMARY KEY (code, price_date),
    CONSTRAINT fk_equity_price_daily_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE equity_price_daily IS '株価四本値(日次)';
COMMENT ON COLUMN equity_price_daily.code             IS '銘柄コード(Code)';
COMMENT ON COLUMN equity_price_daily.price_date        IS '取引日(Date)';
COMMENT ON COLUMN equity_price_daily.open_price         IS '始値(O)';
COMMENT ON COLUMN equity_price_daily.high_price         IS '高値(H)';
COMMENT ON COLUMN equity_price_daily.low_price          IS '安値(L)';
COMMENT ON COLUMN equity_price_daily.close_price        IS '終値(C)';
COMMENT ON COLUMN equity_price_daily.upper_limit        IS 'ストップ高フラグ(UL、0/1)';
COMMENT ON COLUMN equity_price_daily.lower_limit        IS 'ストップ安フラグ(LL、0/1)';
COMMENT ON COLUMN equity_price_daily.volume             IS '出来高(Vo)';
COMMENT ON COLUMN equity_price_daily.turnover_value     IS '売買代金(Va)';
COMMENT ON COLUMN equity_price_daily.adj_factor         IS '調整係数(AdjFactor)。調整後の値が必要な場合は参照時にO/H/L/C/Voに乗じて算出する';
COMMENT ON COLUMN equity_price_daily.loaded_at          IS '取込日時';

-- 「その日の全銘柄」を引く日次バッチ処理・分析用インデックス
CREATE INDEX ix_equity_price_daily_date ON equity_price_daily (price_date);

--------------------------------------------------------------------------------
-- 5. FAVORITE_MASTER (お気に入りマスタ)
--------------------------------------------------------------------------------
CREATE TABLE favorite_master (
    code               VARCHAR2(10)   NOT NULL,
    is_watching        NUMBER(1)      DEFAULT 0 NOT NULL,
    is_buy_candidate   NUMBER(1)      DEFAULT 0 NOT NULL,
    ref_note1          VARCHAR2(500),
    ref_note2          VARCHAR2(500),
    ref_note3          VARCHAR2(500),
    ref_note4          VARCHAR2(500),
    created_at         TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at         TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_favorite_master PRIMARY KEY (code),
    CONSTRAINT fk_favorite_master_code FOREIGN KEY (code)
        REFERENCES equity_master (code),
    CONSTRAINT ck_favorite_master_watching CHECK (is_watching IN (0,1)),
    CONSTRAINT ck_favorite_master_buycand CHECK (is_buy_candidate IN (0,1))
);

COMMENT ON TABLE favorite_master IS 'お気に入りマスタ(フラグ+自由メモ)';
COMMENT ON COLUMN favorite_master.code              IS '銘柄コード(EQUITY_MASTER参照)';
COMMENT ON COLUMN favorite_master.is_watching       IS 'とりあえず気になる(0/1)';
COMMENT ON COLUMN favorite_master.is_buy_candidate  IS '買い候補(0/1)';
COMMENT ON COLUMN favorite_master.ref_note1         IS '参考１(自由メモ)';
COMMENT ON COLUMN favorite_master.ref_note2         IS '参考２(自由メモ)';
COMMENT ON COLUMN favorite_master.ref_note3         IS '参考３(自由メモ)';
COMMENT ON COLUMN favorite_master.ref_note4         IS '参考４(自由メモ)';
COMMENT ON COLUMN favorite_master.created_at        IS '登録日時';
COMMENT ON COLUMN favorite_master.updated_at        IS '更新日時';

--------------------------------------------------------------------------------
-- 6. FAVORITE_TAG (お気に入りタグ)
--------------------------------------------------------------------------------
CREATE TABLE favorite_tag (
    tag_id       NUMBER          GENERATED ALWAYS AS IDENTITY,
    code         VARCHAR2(10)    NOT NULL,
    tag_name     VARCHAR2(100)   NOT NULL,
    created_at   TIMESTAMP       DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_favorite_tag PRIMARY KEY (tag_id),
    CONSTRAINT fk_favorite_tag_code FOREIGN KEY (code)
        REFERENCES equity_master (code),
    CONSTRAINT uq_favorite_tag_code_name UNIQUE (code, tag_name)
);

COMMENT ON TABLE favorite_tag IS 'お気に入り銘柄への自由タグ付け(1銘柄に複数付与可)';
COMMENT ON COLUMN favorite_tag.tag_id      IS 'タグID(連番)';
COMMENT ON COLUMN favorite_tag.code        IS '銘柄コード(EQUITY_MASTER参照)';
COMMENT ON COLUMN favorite_tag.tag_name    IS 'タグ名(例:テーマ株、決算好調、割安など自由入力)';
COMMENT ON COLUMN favorite_tag.created_at  IS '登録日時';

--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables ORDER BY table_name;
-- SELECT constraint_name, constraint_type, table_name FROM user_constraints
--   WHERE table_name IN ('EQUITY_MASTER','EQUITY_MASTER_HIST','EQUITY_PRICE_DAILY',
--                         'FAVORITE_MASTER','FAVORITE_TAG')
--   ORDER BY table_name, constraint_type;
