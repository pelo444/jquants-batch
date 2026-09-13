--------------------------------------------------------------------------------
-- 投資部門別情報・決算発表予定日関連テーブル (Tier 2)
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ(いずれもJ-Quants Standardプラン以上、Bulk API(CSV)で取得):
--   1. 投資部門別情報   /equities/investor-types → INVESTOR_TYPE_TRADING
--   2. 決算発表予定日   /fins/earnings-date      → EARNINGS_SCHEDULE
--
-- 【実データ未確認であることについて】
--   Tier 1と同じ理由(Claude(Cowork)のdevice_bashからapi.jquants.comへの通信が
--   egressで遮断されている)により、今回もinspect-bulk-csv.jsでの実データ確認が
--   できていない。本DDL・csvMapper.js・mergeSql.jsはAPI仕様書
--   (/spec/eq-investor-types, /spec/fin-earnings-date)の記載のみに基づいている。
--   ユーザーの手元で以下を必ず実行してから本番投入すること:
--     node scripts/inspect-bulk-csv.js investor-types earnings-date --rows 3
--   ヘッダー名や空欄表現がここでの想定と異なっていた場合は、csvMapper.jsの対応箇所を
--   実データに合わせて修正すること。
--
-- 前提: 01〜04 のDDLを実行済みであること(EARNINGS_SCHEDULEがEQUITY_MASTERへの
--       外部キーを持つため)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. INVESTOR_TYPE_TRADING (投資部門別情報)
--
-- 市場(Section)単位・週次(通常は週の最終営業日を終了日とする期間)の
-- 投資部門別売買状況。銘柄には紐づかない。金額は千円単位。
--
-- 【主キーに公表日を含めている理由】
--   2023年4月3日以降に公表された過誤訂正では、市場名・開始日・終了日が同一で
--   公表日が異なるレコードが追加される仕様(EQUITY_MARGIN_ALERTと同じパターン)。
--   公表日が新しい方が訂正後、古い方が訂正前。両方を保持するため、
--   (市場名, 開始日, 終了日) だけでは一意にならない。
--   最新の値を見たい場合は V_INVESTOR_TYPE_TRADING_LATEST を使う。
--
--   2023年4月2日以前の過誤訂正は訂正後のデータしか提供されないため、
--   この期間については訂正前後の区別が元々存在しない。
--
-- 【列名の付け方】
--   13部門(自己計/委託計/総計/個人/海外投資家/証券会社/投資信託/事業法人/
--   その他法人/生保・損保/都銀・地銀等/信託銀行/その他金融機関) ×
--   4指標(売/買/合計/差引) = 52列。
--   列名は "{部門の略号}_{指標}" とし、APIのフィールド名(例: PropSell)は
--   各列コメントに記載する。
--------------------------------------------------------------------------------
CREATE TABLE investor_type_trading (
    section      VARCHAR2(20 CHAR)  NOT NULL,
    st_date      DATE               NOT NULL,
    en_date      DATE               NOT NULL,
    pub_date     DATE               NOT NULL,
    prop_sell        NUMBER(20,2),
    prop_buy         NUMBER(20,2),
    prop_tot         NUMBER(20,2),
    prop_bal         NUMBER(20,2),
    brk_sell         NUMBER(20,2),
    brk_buy          NUMBER(20,2),
    brk_tot          NUMBER(20,2),
    brk_bal          NUMBER(20,2),
    tot_sell         NUMBER(20,2),
    tot_buy          NUMBER(20,2),
    tot_tot          NUMBER(20,2),
    tot_bal          NUMBER(20,2),
    ind_sell         NUMBER(20,2),
    ind_buy          NUMBER(20,2),
    ind_tot          NUMBER(20,2),
    ind_bal          NUMBER(20,2),
    frgn_sell        NUMBER(20,2),
    frgn_buy         NUMBER(20,2),
    frgn_tot         NUMBER(20,2),
    frgn_bal         NUMBER(20,2),
    sec_co_sell      NUMBER(20,2),
    sec_co_buy       NUMBER(20,2),
    sec_co_tot       NUMBER(20,2),
    sec_co_bal       NUMBER(20,2),
    inv_tr_sell      NUMBER(20,2),
    inv_tr_buy       NUMBER(20,2),
    inv_tr_tot       NUMBER(20,2),
    inv_tr_bal       NUMBER(20,2),
    bus_co_sell      NUMBER(20,2),
    bus_co_buy       NUMBER(20,2),
    bus_co_tot       NUMBER(20,2),
    bus_co_bal       NUMBER(20,2),
    oth_co_sell      NUMBER(20,2),
    oth_co_buy       NUMBER(20,2),
    oth_co_tot       NUMBER(20,2),
    oth_co_bal       NUMBER(20,2),
    ins_co_sell      NUMBER(20,2),
    ins_co_buy       NUMBER(20,2),
    ins_co_tot       NUMBER(20,2),
    ins_co_bal       NUMBER(20,2),
    bank_sell        NUMBER(20,2),
    bank_buy         NUMBER(20,2),
    bank_tot         NUMBER(20,2),
    bank_bal         NUMBER(20,2),
    trst_bnk_sell    NUMBER(20,2),
    trst_bnk_buy     NUMBER(20,2),
    trst_bnk_tot     NUMBER(20,2),
    trst_bnk_bal     NUMBER(20,2),
    oth_fin_sell     NUMBER(20,2),
    oth_fin_buy      NUMBER(20,2),
    oth_fin_tot      NUMBER(20,2),
    oth_fin_bal      NUMBER(20,2),
    loaded_at    TIMESTAMP          DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_investor_type_trading PRIMARY KEY (section, st_date, en_date, pub_date)
);

COMMENT ON TABLE  investor_type_trading           IS '投資部門別情報(市場単位・週次、過誤訂正時は公表日違いで複数行)';
COMMENT ON COLUMN investor_type_trading.section   IS '市場名(Section)。市場区分の変遷は仕様書(/spec/eq-investor-types/section)参照';
COMMENT ON COLUMN investor_type_trading.st_date   IS '開始日(StDate)。集計期間の開始日';
COMMENT ON COLUMN investor_type_trading.en_date   IS '終了日(EnDate)。集計期間の終了日';
COMMENT ON COLUMN investor_type_trading.pub_date  IS '公表日(PubDate)。過誤訂正時は同一区間で複数行になる(2023/4/3以降の訂正分のみ)';
COMMENT ON COLUMN investor_type_trading.prop_sell        IS '自己計_売(PropSell)(千円)';
COMMENT ON COLUMN investor_type_trading.prop_buy         IS '自己計_買(PropBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.prop_tot         IS '自己計_合計(PropTot)(千円)';
COMMENT ON COLUMN investor_type_trading.prop_bal         IS '自己計_差引(PropBal)(千円)';
COMMENT ON COLUMN investor_type_trading.brk_sell         IS '委託計_売(BrkSell)(千円)';
COMMENT ON COLUMN investor_type_trading.brk_buy          IS '委託計_買(BrkBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.brk_tot          IS '委託計_合計(BrkTot)(千円)';
COMMENT ON COLUMN investor_type_trading.brk_bal          IS '委託計_差引(BrkBal)(千円)';
COMMENT ON COLUMN investor_type_trading.tot_sell         IS '総計_売(TotSell)(千円)';
COMMENT ON COLUMN investor_type_trading.tot_buy          IS '総計_買(TotBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.tot_tot          IS '総計_合計(TotTot)(千円)';
COMMENT ON COLUMN investor_type_trading.tot_bal          IS '総計_差引(TotBal)(千円)';
COMMENT ON COLUMN investor_type_trading.ind_sell         IS '個人_売(IndSell)(千円)';
COMMENT ON COLUMN investor_type_trading.ind_buy          IS '個人_買(IndBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.ind_tot          IS '個人_合計(IndTot)(千円)';
COMMENT ON COLUMN investor_type_trading.ind_bal          IS '個人_差引(IndBal)(千円)';
COMMENT ON COLUMN investor_type_trading.frgn_sell        IS '海外投資家_売(FrgnSell)(千円)';
COMMENT ON COLUMN investor_type_trading.frgn_buy         IS '海外投資家_買(FrgnBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.frgn_tot         IS '海外投資家_合計(FrgnTot)(千円)';
COMMENT ON COLUMN investor_type_trading.frgn_bal         IS '海外投資家_差引(FrgnBal)(千円)';
COMMENT ON COLUMN investor_type_trading.sec_co_sell      IS '証券会社_売(SecCoSell)(千円)';
COMMENT ON COLUMN investor_type_trading.sec_co_buy       IS '証券会社_買(SecCoBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.sec_co_tot       IS '証券会社_合計(SecCoTot)(千円)';
COMMENT ON COLUMN investor_type_trading.sec_co_bal       IS '証券会社_差引(SecCoBal)(千円)';
COMMENT ON COLUMN investor_type_trading.inv_tr_sell      IS '投資信託_売(InvTrSell)(千円)';
COMMENT ON COLUMN investor_type_trading.inv_tr_buy       IS '投資信託_買(InvTrBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.inv_tr_tot       IS '投資信託_合計(InvTrTot)(千円)';
COMMENT ON COLUMN investor_type_trading.inv_tr_bal       IS '投資信託_差引(InvTrBal)(千円)';
COMMENT ON COLUMN investor_type_trading.bus_co_sell      IS '事業法人_売(BusCoSell)(千円)';
COMMENT ON COLUMN investor_type_trading.bus_co_buy       IS '事業法人_買(BusCoBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.bus_co_tot       IS '事業法人_合計(BusCoTot)(千円)';
COMMENT ON COLUMN investor_type_trading.bus_co_bal       IS '事業法人_差引(BusCoBal)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_co_sell      IS 'その他法人_売(OthCoSell)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_co_buy       IS 'その他法人_買(OthCoBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_co_tot       IS 'その他法人_合計(OthCoTot)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_co_bal       IS 'その他法人_差引(OthCoBal)(千円)';
COMMENT ON COLUMN investor_type_trading.ins_co_sell      IS '生保・損保_売(InsCoSell)(千円)';
COMMENT ON COLUMN investor_type_trading.ins_co_buy       IS '生保・損保_買(InsCoBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.ins_co_tot       IS '生保・損保_合計(InsCoTot)(千円)';
COMMENT ON COLUMN investor_type_trading.ins_co_bal       IS '生保・損保_差引(InsCoBal)(千円)';
COMMENT ON COLUMN investor_type_trading.bank_sell        IS '都銀・地銀等_売(BankSell)(千円)';
COMMENT ON COLUMN investor_type_trading.bank_buy         IS '都銀・地銀等_買(BankBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.bank_tot         IS '都銀・地銀等_合計(BankTot)(千円)';
COMMENT ON COLUMN investor_type_trading.bank_bal         IS '都銀・地銀等_差引(BankBal)(千円)';
COMMENT ON COLUMN investor_type_trading.trst_bnk_sell    IS '信託銀行_売(TrstBnkSell)(千円)';
COMMENT ON COLUMN investor_type_trading.trst_bnk_buy     IS '信託銀行_買(TrstBnkBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.trst_bnk_tot     IS '信託銀行_合計(TrstBnkTot)(千円)';
COMMENT ON COLUMN investor_type_trading.trst_bnk_bal     IS '信託銀行_差引(TrstBnkBal)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_fin_sell     IS 'その他金融機関_売(OthFinSell)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_fin_buy      IS 'その他金融機関_買(OthFinBuy)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_fin_tot      IS 'その他金融機関_合計(OthFinTot)(千円)';
COMMENT ON COLUMN investor_type_trading.oth_fin_bal      IS 'その他金融機関_差引(OthFinBal)(千円)';
COMMENT ON COLUMN investor_type_trading.loaded_at IS '取込日時';

-- 「その市場の全期間」を引く分析用。公表日単位のレコードもここに含まれる。
CREATE INDEX ix_investor_type_trading_pub ON investor_type_trading (pub_date);


--------------------------------------------------------------------------------
-- 2. EARNINGS_SCHEDULE (決算発表予定日)
--
-- 銘柄ごとの決算発表予定日。予定日の変更・未定の履歴も含めて公表日単位で
-- 提供される(過去のデータは削除されず、変更のたびに新しい行が追加される)。
--
-- 【主キーの考え方】
--   (銘柄, 決算期末, 決算区分, 公表日) を主キーとする。決算期末(FYE)を
--   含めているのは、稀に決算期変更が起きた場合に(銘柄, 決算区分)だけでは
--   異なる決算期のスケジュールが衝突しうるため。
--
-- 【「現在有効な予定」を見たい場合】
--   仕様書に明記の通り、scheduled_date検索は「各銘柄・各決算区分で最後に
--   公表されたレコードのみ」がヒットする、つまり決算期末(FYE)をまたいでも
--   銘柄×決算区分単位で最新指す。これに合わせ、V_EARNINGS_SCHEDULE_LATEST は
--   (銘柄, 決算区分)単位でパーティションする(決算期末は含めない)。
--
-- 【未定について】
--   予定日が「未定」の場合、SchDateは空文字で提供される→sch_dateはNULLになる。
--   「未定」から予定日が確定した場合や、確定後に変更された場合は、それぞれ
--   新しい公表日のレコードとして追加される(過去の値は消えない)。
--
-- 【補助データとして扱う理由】
--   決算発表予定日を報告する義務があるのは東証上場会社等で、REIT等も対象。
--   J-Quantsの銘柄マスタ(EQUITY_MASTER)は基本的に東証データだが、念のため
--   空売り関連と同様にEQUITY_MASTERに無い銘柄コードはスキップする方針とする
--   (loadInitial.js の skipUnknownCodes)。
--------------------------------------------------------------------------------
CREATE TABLE earnings_schedule (
    code        VARCHAR2(10)        NOT NULL,
    fye         VARCHAR2(4 CHAR)    NOT NULL,
    fq_name     VARCHAR2(2 CHAR)    NOT NULL,
    pub_date    DATE                NOT NULL,
    sch_date    DATE,
    co_name     VARCHAR2(500 CHAR),
    co_name_en  VARCHAR2(500 CHAR),
    loaded_at   TIMESTAMP           DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_earnings_schedule PRIMARY KEY (code, fye, fq_name, pub_date),
    CONSTRAINT fk_earnings_schedule_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE  earnings_schedule              IS '決算発表予定日(変更・未定の履歴を含む・公表日単位)';
COMMENT ON COLUMN earnings_schedule.code         IS '銘柄コード(EQUITY_MASTER参照)';
COMMENT ON COLUMN earnings_schedule.fye          IS '決算期末(FYE、MMDD)。月日のみで年を含まず毎年出現する';
COMMENT ON COLUMN earnings_schedule.fq_name      IS '決算区分(FQName) 1Q/2Q/3Q/FY';
COMMENT ON COLUMN earnings_schedule.pub_date     IS '公表日(PubDate)。この予定日が公表・変更された日';
COMMENT ON COLUMN earnings_schedule.sch_date     IS '決算発表予定日(SchDate)。未定の場合はNULL';
COMMENT ON COLUMN earnings_schedule.co_name      IS '会社名(CoName)。PubDate時点のもの';
COMMENT ON COLUMN earnings_schedule.co_name_en   IS '会社名英語(CoNameEn)。PubDate時点のもの';
COMMENT ON COLUMN earnings_schedule.loaded_at    IS '取込日時';

-- 「直近の決算発表予定」を引く分析用(未定=NULLは末尾に来るようNULLS LAST推奨)
CREATE INDEX ix_earnings_schedule_sch_date ON earnings_schedule (sch_date);
-- V_EARNINGS_SCHEDULE_LATEST の PARTITION BY (code, fq_name) を高速化
CREATE INDEX ix_earnings_schedule_code_fq  ON earnings_schedule (code, fq_name, pub_date);


--------------------------------------------------------------------------------
-- 3. ステージングテーブル
--------------------------------------------------------------------------------
CREATE TABLE investor_type_trading_stg (
    section      VARCHAR2(20 CHAR),
    st_date      DATE,
    en_date      DATE,
    pub_date     DATE,
    prop_sell        NUMBER(20,2),
    prop_buy         NUMBER(20,2),
    prop_tot         NUMBER(20,2),
    prop_bal         NUMBER(20,2),
    brk_sell         NUMBER(20,2),
    brk_buy          NUMBER(20,2),
    brk_tot          NUMBER(20,2),
    brk_bal          NUMBER(20,2),
    tot_sell         NUMBER(20,2),
    tot_buy          NUMBER(20,2),
    tot_tot          NUMBER(20,2),
    tot_bal          NUMBER(20,2),
    ind_sell         NUMBER(20,2),
    ind_buy          NUMBER(20,2),
    ind_tot          NUMBER(20,2),
    ind_bal          NUMBER(20,2),
    frgn_sell        NUMBER(20,2),
    frgn_buy         NUMBER(20,2),
    frgn_tot         NUMBER(20,2),
    frgn_bal         NUMBER(20,2),
    sec_co_sell      NUMBER(20,2),
    sec_co_buy       NUMBER(20,2),
    sec_co_tot       NUMBER(20,2),
    sec_co_bal       NUMBER(20,2),
    inv_tr_sell      NUMBER(20,2),
    inv_tr_buy       NUMBER(20,2),
    inv_tr_tot       NUMBER(20,2),
    inv_tr_bal       NUMBER(20,2),
    bus_co_sell      NUMBER(20,2),
    bus_co_buy       NUMBER(20,2),
    bus_co_tot       NUMBER(20,2),
    bus_co_bal       NUMBER(20,2),
    oth_co_sell      NUMBER(20,2),
    oth_co_buy       NUMBER(20,2),
    oth_co_tot       NUMBER(20,2),
    oth_co_bal       NUMBER(20,2),
    ins_co_sell      NUMBER(20,2),
    ins_co_buy       NUMBER(20,2),
    ins_co_tot       NUMBER(20,2),
    ins_co_bal       NUMBER(20,2),
    bank_sell        NUMBER(20,2),
    bank_buy         NUMBER(20,2),
    bank_tot         NUMBER(20,2),
    bank_bal         NUMBER(20,2),
    trst_bnk_sell    NUMBER(20,2),
    trst_bnk_buy     NUMBER(20,2),
    trst_bnk_tot     NUMBER(20,2),
    trst_bnk_bal     NUMBER(20,2),
    oth_fin_sell     NUMBER(20,2),
    oth_fin_buy      NUMBER(20,2),
    oth_fin_tot      NUMBER(20,2),
    oth_fin_bal      NUMBER(20,2),
    loaded_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE earnings_schedule_stg (
    code        VARCHAR2(10),
    fye         VARCHAR2(4 CHAR),
    fq_name     VARCHAR2(2 CHAR),
    pub_date    DATE,
    sch_date    DATE,
    co_name     VARCHAR2(500 CHAR),
    co_name_en  VARCHAR2(500 CHAR),
    loaded_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE investor_type_trading_stg  IS '投資部門別情報のステージング';
COMMENT ON TABLE earnings_schedule_stg      IS '決算発表予定日のステージング';


--------------------------------------------------------------------------------
-- 4. 分析用ビュー(過誤訂正後の最新値のみ)
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 投資部門別情報の最新版のみ
--
-- 過誤訂正で同一区間(市場・開始日・終了日)に複数の公表日が存在する場合、
-- 公表日が最も新しい行だけを返す。訂正前の値も見たい場合は
-- INVESTOR_TYPE_TRADING を直接参照すること。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_investor_type_trading_latest AS
SELECT *
FROM (
    SELECT t.*,
           ROW_NUMBER() OVER (PARTITION BY t.section, t.st_date, t.en_date
                              ORDER BY t.pub_date DESC) AS rn
    FROM investor_type_trading t
)
WHERE rn = 1;

COMMENT ON TABLE v_investor_type_trading_latest IS '投資部門別情報(過誤訂正後の最新値のみ)';


--------------------------------------------------------------------------------
-- 決算発表予定日の最新版のみ(現在有効な予定)
--
-- 仕様書の scheduled_date 検索と同じ単位(銘柄×決算区分)でパーティションする。
-- 決算期末(FYE)はパーティションに含めない。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_earnings_schedule_latest AS
SELECT *
FROM (
    SELECT e.*,
           ROW_NUMBER() OVER (PARTITION BY e.code, e.fq_name
                              ORDER BY e.pub_date DESC) AS rn
    FROM earnings_schedule e
)
WHERE rn = 1;

COMMENT ON TABLE v_earnings_schedule_latest IS '決算発表予定日(現在有効な予定のみ・銘柄×決算区分単位)';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name IN ('INVESTOR_TYPE_TRADING','EARNINGS_SCHEDULE')
--  ORDER BY table_name;
--
-- SELECT endpoint_name, status, COUNT(*) AS files, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name IN ('/equities/investor-types','/fins/earnings-date')
-- GROUP BY endpoint_name, status
-- ORDER BY endpoint_name, status;
