--------------------------------------------------------------------------------
-- 空売り・信用取引関連テーブル
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ(いずれもJ-Quants Standardプラン以上、Bulk API(CSV)で取得):
--   1. 業種別空売り比率     /markets/short-ratio        → SECTOR_SHORT_RATIO
--   2. 信用取引残高         /markets/margin-interest    → EQUITY_MARGIN_INTEREST
--   3. 日々公表信用取引残高 /markets/margin-alert       → EQUITY_MARGIN_ALERT
--   4. 空売り残高報告       /markets/short-sale-report  → EQUITY_SHORT_POSITION
--
-- 【「銘柄ごとの空売り残高」は2種類あることに注意】
--   ・EQUITY_MARGIN_INTEREST.SHRT_VOL … 信用取引の売建残高。個人投資家が中心。全銘柄。
--   ・EQUITY_SHORT_POSITION           … 機関投資家等の空売り残高報告。
--                                       残高割合0.5%以上の報告分のみで、信用取引に限らない。
--   機関投資家の空売りは信用取引を経由しないことが多いため前者には現れず、
--   後者は0.5%未満が見えない。両方を並べて初めて全体像になる。
--
-- 【発行済株式数について】
--   ※この節は Tier3・Tier4 の取込後に更新した(2026-09-07)。
--   本DDLを書いた時点では発行済株式数を持っていなかったが、その後に入った
--   以下の2つから取得できるようになっている:
--     ・FINANCIAL_SUMMARY.SH_OUT_FY        期末発行済株式数(自己株式を含む)
--       FINANCIAL_SUMMARY.TR_SH_FY         期末自己株式数
--     ・LARGE_VOLUME_SHAREHOLDER.TOTAL_OUT_STKS  書類時点の発行済株式総数
--   ただしどちらも決算・書類のタイミングでしか更新されないため、
--   日次の残高に掛け合わせるときは基準日のズレを承知して使うこと。
--
--   API側で計算済みの比率もあり、通常はこちらを優先する:
--     ・EQUITY_SHORT_POSITION.SHRT_POS_TO_SO (空売り残高割合)   … APIが計算済み
--     ・EQUITY_MARGIN_ALERT.SHRT_OUT_RATIO   (上場比)           … APIが計算済み
--     ・売残 ÷ 平均出来高 = days to cover                        … 出来高から算出可能
--
-- 【信用取引残高の2026年9月28日の仕様変更に対応済み】
--   同日より週次(金曜日付)から日次配信に変わり、金額6項目(*_VAL)が追加される。
--   本DDLは新仕様前提で作ってあるため、9/28以降もDDL変更は不要。
--   2026年9月24日以前の申込分では *_VAL は NULL のままとなる。
--
-- 【東証以外の取引所に単独上場している銘柄について】
--   空売り残高報告・信用取引残高には、東証以外に単独上場している銘柄が含まれる
--   ことがある(例: 3808 オーケーウェブ = 名古屋証券取引所の単独上場)。
--   J-Quantsの銘柄マスタは東証データのため、これらはEQUITY_MASTERに存在しない。
--   取込処理(loadInitial.js の skipUnknownCodes)は該当行をスキップし、
--   どの銘柄を落としたかをフェーズ終了時に報告する。
--   これは恒久的な差であり、データの異常ではない。
--
-- 前提: 01〜04 のDDLを実行済みであること(EQUITY_MASTERへの外部キーを張るため)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. SECTOR_SHORT_RATIO (業種別空売り比率)
--
-- 33業種単位のデータで、銘柄単位ではない。個別銘柄には
-- EQUITY_MASTER.SECTOR33_CODE 経由で結合する。
-- 金額は円単位(JPXのWebページは百万円単位に丸められているが、APIは円単位)。
--------------------------------------------------------------------------------
CREATE TABLE sector_short_ratio (
    s33_code          VARCHAR2(10 CHAR)  NOT NULL,
    ratio_date        DATE               NOT NULL,
    sell_ex_short_va  NUMBER(20,2),
    shrt_with_res_va  NUMBER(20,2),
    shrt_no_res_va    NUMBER(20,2),
    loaded_at         TIMESTAMP          DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_sector_short_ratio PRIMARY KEY (s33_code, ratio_date)
);

COMMENT ON TABLE  sector_short_ratio                   IS '業種別空売り比率(33業種単位・日次)';
COMMENT ON COLUMN sector_short_ratio.s33_code          IS '33業種コード(S33)';
COMMENT ON COLUMN sector_short_ratio.ratio_date        IS '日付(Date)';
COMMENT ON COLUMN sector_short_ratio.sell_ex_short_va  IS '実注文の売買代金(SellExShortVa、円)';
COMMENT ON COLUMN sector_short_ratio.shrt_with_res_va  IS '価格規制有りの空売り売買代金(ShrtWithResVa、円)';
COMMENT ON COLUMN sector_short_ratio.shrt_no_res_va    IS '価格規制無しの空売り売買代金(ShrtNoResVa、円)';
COMMENT ON COLUMN sector_short_ratio.loaded_at         IS '取込日時';

-- 「その日の全業種」を引く分析用
CREATE INDEX ix_sector_short_ratio_date ON sector_short_ratio (ratio_date);


--------------------------------------------------------------------------------
-- 2. EQUITY_MARGIN_INTEREST (信用取引残高)
--
-- 2026年9月24日以前: 週末時点(通常は金曜日付)。金額項目(*_VAL)はNULL。
-- 2026年9月25日以降: 日次。金額項目も提供される。
--
-- コーポレートアクションが発生しても遡及調整は行われない(株価と違い調整係数も無い)。
-- 分割前後をまたぐ比較をする場合は EQUITY_PRICE_DAILY.ADJ_FACTOR を見て自分で判断すること。
--------------------------------------------------------------------------------
CREATE TABLE equity_margin_interest (
    code          VARCHAR2(10)      NOT NULL,
    app_date      DATE              NOT NULL,
    iss_type      VARCHAR2(2 CHAR),
    -- 株数(全期間で提供)
    shrt_vol      NUMBER(20),
    long_vol      NUMBER(20),
    shrt_neg_vol  NUMBER(20),
    long_neg_vol  NUMBER(20),
    shrt_std_vol  NUMBER(20),
    long_std_vol  NUMBER(20),
    -- 金額(2026年9月25日申込分以降のみ。それ以前はNULL)
    shrt_val      NUMBER(20,2),
    long_val      NUMBER(20,2),
    shrt_neg_val  NUMBER(20,2),
    long_neg_val  NUMBER(20,2),
    shrt_std_val  NUMBER(20,2),
    long_std_val  NUMBER(20,2),
    loaded_at     TIMESTAMP         DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_equity_margin_interest PRIMARY KEY (code, app_date),
    CONSTRAINT fk_equity_margin_interest_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE  equity_margin_interest              IS '信用取引残高(2026/9/24以前は週末時点、9/25以降は日次)';
COMMENT ON COLUMN equity_margin_interest.code         IS '銘柄コード(EQUITY_MASTER参照)';
COMMENT ON COLUMN equity_margin_interest.app_date     IS '申込日付(Date)。信用取引残高の基準時点';
COMMENT ON COLUMN equity_margin_interest.iss_type     IS '銘柄区分(IssType) 1:信用銘柄 2:貸借銘柄 3:その他';
COMMENT ON COLUMN equity_margin_interest.shrt_vol     IS '売合計信用残高(株数)';
COMMENT ON COLUMN equity_margin_interest.long_vol     IS '買合計信用残高(株数)';
COMMENT ON COLUMN equity_margin_interest.shrt_neg_vol IS '一般信用取引売残高(株数)';
COMMENT ON COLUMN equity_margin_interest.long_neg_vol IS '一般信用取引買残高(株数)';
COMMENT ON COLUMN equity_margin_interest.shrt_std_vol IS '制度信用取引売残高(株数)';
COMMENT ON COLUMN equity_margin_interest.long_std_vol IS '制度信用取引買残高(株数)';
COMMENT ON COLUMN equity_margin_interest.shrt_val     IS '売合計信用残高(金額)。2026/9/25申込分以降のみ';
COMMENT ON COLUMN equity_margin_interest.long_val     IS '買合計信用残高(金額)。2026/9/25申込分以降のみ';
COMMENT ON COLUMN equity_margin_interest.shrt_neg_val IS '一般信用取引売残高(金額)。2026/9/25申込分以降のみ';
COMMENT ON COLUMN equity_margin_interest.long_neg_val IS '一般信用取引買残高(金額)。2026/9/25申込分以降のみ';
COMMENT ON COLUMN equity_margin_interest.shrt_std_val IS '制度信用取引売残高(金額)。2026/9/25申込分以降のみ';
COMMENT ON COLUMN equity_margin_interest.long_std_val IS '制度信用取引買残高(金額)。2026/9/25申込分以降のみ';
COMMENT ON COLUMN equity_margin_interest.loaded_at    IS '取込日時';

-- 「その日の全銘柄」を引く日次バッチ・分析用
CREATE INDEX ix_equity_margin_interest_date ON equity_margin_interest (app_date);


--------------------------------------------------------------------------------
-- 3. EQUITY_MARGIN_ALERT (日々公表信用取引残高)
--
-- 東証または日本証券金融が日次公表を必要と認めた銘柄のみが収録される。
-- 日々公表銘柄に指定されること自体が過熱シグナルでもある。
--
-- 【主キーに公表日を含めている理由】
--   過誤訂正が生じると、申込日が同一で公表日が異なるレコードが追加される。
--   公表日が新しい方が訂正後、古い方が訂正前。両方を保持する仕様のため、
--   (銘柄, 申込日) だけでは一意にならない。
--   最新の値を見たい場合は V_EQUITY_MARGIN_ALERT_LATEST を使う。
--
-- 【前日比・上場比がNULLになるケース】
--   ・前日比(*_CHG)   … 前日に公表されていない銘柄はAPIが「-」を返す → NULL
--   ・上場比(*_RATIO) … ETFはAPIが「*」を返す → NULL
--   いずれも「値が無い」ことを意味し、ゼロではない。
--------------------------------------------------------------------------------
CREATE TABLE equity_margin_alert (
    code                        VARCHAR2(10)      NOT NULL,
    app_date                    DATE              NOT NULL,
    pub_date                    DATE              NOT NULL,
    -- 公表の理由(APIではPubReasonという入れ子オブジェクト。'0'/'1'の6項目に展開)
    reason_restricted           VARCHAR2(1 CHAR),
    reason_daily_publication    VARCHAR2(1 CHAR),
    reason_monitoring           VARCHAR2(1 CHAR),
    reason_restricted_by_jsf    VARCHAR2(1 CHAR),
    reason_precaution_by_jsf    VARCHAR2(1 CHAR),
    reason_unclear_or_sec_alert VARCHAR2(1 CHAR),
    -- 残高
    shrt_out                    NUMBER(20),
    shrt_out_chg                NUMBER(20),
    shrt_out_ratio              NUMBER(12,4),
    long_out                    NUMBER(20),
    long_out_chg                NUMBER(20),
    long_out_ratio              NUMBER(12,4),
    sl_ratio                    NUMBER(12,4),
    shrt_neg_out                NUMBER(20),
    shrt_neg_out_chg            NUMBER(20),
    shrt_std_out                NUMBER(20),
    shrt_std_out_chg            NUMBER(20),
    long_neg_out                NUMBER(20),
    long_neg_out_chg            NUMBER(20),
    long_std_out                NUMBER(20),
    long_std_out_chg            NUMBER(20),
    tse_mrgn_reg_cls            VARCHAR2(10 CHAR),
    loaded_at                   TIMESTAMP         DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_equity_margin_alert PRIMARY KEY (code, app_date, pub_date),
    CONSTRAINT fk_equity_margin_alert_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE  equity_margin_alert                             IS '日々公表信用取引残高(日々公表銘柄のみ)';
COMMENT ON COLUMN equity_margin_alert.code                        IS '銘柄コード(EQUITY_MASTER参照)';
COMMENT ON COLUMN equity_margin_alert.app_date                    IS '申込日(AppDate)。信用取引残高の基準時点';
COMMENT ON COLUMN equity_margin_alert.pub_date                    IS '公表日(PubDate)。過誤訂正時は同一申込日で複数行になる';
COMMENT ON COLUMN equity_margin_alert.reason_restricted           IS '公表理由:規制中(0/1)';
COMMENT ON COLUMN equity_margin_alert.reason_daily_publication    IS '公表理由:日々公表(0/1)';
COMMENT ON COLUMN equity_margin_alert.reason_monitoring           IS '公表理由:監視中(0/1)';
COMMENT ON COLUMN equity_margin_alert.reason_restricted_by_jsf    IS '公表理由:日証金による規制(0/1)';
COMMENT ON COLUMN equity_margin_alert.reason_precaution_by_jsf    IS '公表理由:日証金による注意喚起(0/1)';
COMMENT ON COLUMN equity_margin_alert.reason_unclear_or_sec_alert IS '公表理由:不明確または注意銘柄(0/1)';
COMMENT ON COLUMN equity_margin_alert.shrt_out                    IS '売合計信用残高(株数)';
COMMENT ON COLUMN equity_margin_alert.shrt_out_chg                IS '前日比 売合計信用残高(株)。前日未公表ならNULL';
COMMENT ON COLUMN equity_margin_alert.shrt_out_ratio              IS '上場比 売合計信用残高(%)。ETFはNULL';
COMMENT ON COLUMN equity_margin_alert.long_out                    IS '買合計信用残高(株数)';
COMMENT ON COLUMN equity_margin_alert.long_out_chg                IS '前日比 買合計信用残高(株)。前日未公表ならNULL';
COMMENT ON COLUMN equity_margin_alert.long_out_ratio              IS '上場比 買合計信用残高(%)。ETFはNULL';
COMMENT ON COLUMN equity_margin_alert.sl_ratio                    IS '取組比率(%) 売合計÷買合計×100';
COMMENT ON COLUMN equity_margin_alert.tse_mrgn_reg_cls            IS '東証信用貸借規制区分(TSEMrgnRegCls)';
COMMENT ON COLUMN equity_margin_alert.loaded_at                   IS '取込日時';

CREATE INDEX ix_equity_margin_alert_pub  ON equity_margin_alert (pub_date);
CREATE INDEX ix_equity_margin_alert_app  ON equity_margin_alert (app_date);


--------------------------------------------------------------------------------
-- 4. EQUITY_SHORT_POSITION (空売り残高報告)
--
-- 「有価証券の取引等の規制に関する内閣府令」に基づく報告のうち、
-- 残高割合が0.5%以上のもの。報告者(ファンド)単位の明細をそのまま保持する。
--
-- 【代理キーを使っている理由】
--   同一の (公表日, 計算日, 銘柄) に複数の報告者の行が入る。報告者を識別する
--   SSName / DICName / FundName は任意項目で空になることがあり、NULLを含む列は
--   一意制約が期待どおり働かない(OracleではNULL同士は重複とみなされない)ため、
--   これらを自然キーにできない。
--   そこで代理キー(POSITION_ID)を主キーとし、取込は「公表日単位の洗い替え」
--   (DELETE→INSERT)で冪等性を担保する。詳細は mergeSql.js の
--   replaceShortPosition() を参照。
--
-- 【SSNameについて】
--   取引参加者から報告されたものをそのまま記載しているため、
--   同一主体でも日本語名称と英語名称が混在する。名寄せは利用側で行う必要がある。
--------------------------------------------------------------------------------
CREATE TABLE equity_short_position (
    position_id     NUMBER              GENERATED ALWAYS AS IDENTITY,
    disc_date       DATE                NOT NULL,
    calc_date       DATE                NOT NULL,
    code            VARCHAR2(10)        NOT NULL,
    ss_name         VARCHAR2(1000 CHAR),
    ss_addr         VARCHAR2(1000 CHAR),
    dic_name        VARCHAR2(1000 CHAR),
    dic_addr        VARCHAR2(1000 CHAR),
    fund_name       VARCHAR2(1000 CHAR),
    shrt_pos_to_so  NUMBER(12,6),
    shrt_pos_shares NUMBER(20),
    shrt_pos_units  NUMBER(20),
    prev_rpt_date   DATE,
    prev_rpt_ratio  NUMBER(12,6),
    notes           VARCHAR2(1000 CHAR),
    loaded_at       TIMESTAMP           DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_equity_short_position PRIMARY KEY (position_id),
    CONSTRAINT fk_equity_short_position_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE  equity_short_position                 IS '空売り残高報告(残高割合0.5%以上・報告者単位の明細)';
COMMENT ON COLUMN equity_short_position.position_id     IS '代理キー(連番)';
COMMENT ON COLUMN equity_short_position.disc_date       IS '公表日(DiscDate)';
COMMENT ON COLUMN equity_short_position.calc_date       IS '計算日(CalcDate)。残高の基準時点';
COMMENT ON COLUMN equity_short_position.code            IS '銘柄コード(EQUITY_MASTER参照)';
COMMENT ON COLUMN equity_short_position.ss_name         IS '商号・名称・氏名(SSName)。日本語/英語表記が混在';
COMMENT ON COLUMN equity_short_position.ss_addr         IS '住所・所在地(SSAddr)';
COMMENT ON COLUMN equity_short_position.dic_name        IS '委託者・投資一任契約の相手方の商号(DICName)';
COMMENT ON COLUMN equity_short_position.dic_addr        IS '委託者・投資一任契約の相手方の住所(DICAddr)';
COMMENT ON COLUMN equity_short_position.fund_name       IS '信託財産・運用財産の名称(FundName)';
COMMENT ON COLUMN equity_short_position.shrt_pos_to_so  IS '空売り残高割合(ShrtPosToSO)。0.0053=0.53%';
COMMENT ON COLUMN equity_short_position.shrt_pos_shares IS '空売り残高数量(株)';
COMMENT ON COLUMN equity_short_position.shrt_pos_units  IS '空売り残高売買単位数';
COMMENT ON COLUMN equity_short_position.prev_rpt_date   IS '直近計算年月日(PrevRptDate)';
COMMENT ON COLUMN equity_short_position.prev_rpt_ratio  IS '直近空売り残高割合(PrevRptRatio)';
COMMENT ON COLUMN equity_short_position.notes           IS '備考(Notes)。訂正報告の理由などの自由記述。1000文字で切り詰め(末尾「…」)';
-- 文字列長の上限について:
--   VARCHAR2(n CHAR) は AL32UTF8 では最大 n×4 バイトを確保する。
--   MAX_STRING_SIZE=STANDARD の環境では 4000 バイトが上限のため、
--   このDDLでは 1000 CHAR を超える指定をしていない(超えると ORA-00910)。
--
--   実データでは、提出様式の桁揃えのための空白がそのまま入ってくる。
--   2021年4月の訂正報告では 本文123文字 + 空白950文字 = 1073文字 だった。
--   取込側(csvMapper.js の clampText)で
--     (1) 連続空白を1つに詰める  (2) それでも超える場合は1000文字で切り詰める
--   という正規化をしているため、この桁でオーバーフローすることはない。
--   したがってこの列を CLOB にしたり 4000 BYTE に広げたりする必要は無い。
--   同じ正規化は ss_name / ss_addr / dic_name / dic_addr / fund_name にも
--   かかっている(商号に桁揃えの空白が入ると、同一報告者が別名として
--   集計されてしまうため)。
COMMENT ON COLUMN equity_short_position.loaded_at       IS '取込日時';

CREATE INDEX ix_esp_code_calc ON equity_short_position (code, calc_date);
CREATE INDEX ix_esp_disc_date ON equity_short_position (disc_date);
CREATE INDEX ix_esp_calc_date ON equity_short_position (calc_date);


--------------------------------------------------------------------------------
-- 5. ステージングテーブル
--
-- 02_staging_tables.sql と同じ方針。制約を張らずCSVをそのまま受けてから
-- 本番テーブルへMERGE(または洗い替え)する。
-- 日付はDATE型で受け、取込側で TO_DATE(?, 'YYYY-MM-DD') を通す。
--------------------------------------------------------------------------------
CREATE TABLE sector_short_ratio_stg (
    s33_code          VARCHAR2(10 CHAR),
    ratio_date        DATE,
    sell_ex_short_va  NUMBER(20,2),
    shrt_with_res_va  NUMBER(20,2),
    shrt_no_res_va    NUMBER(20,2),
    loaded_at         TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE equity_margin_interest_stg (
    code          VARCHAR2(10),
    app_date      DATE,
    iss_type      VARCHAR2(2 CHAR),
    shrt_vol      NUMBER(20),
    long_vol      NUMBER(20),
    shrt_neg_vol  NUMBER(20),
    long_neg_vol  NUMBER(20),
    shrt_std_vol  NUMBER(20),
    long_std_vol  NUMBER(20),
    shrt_val      NUMBER(20,2),
    long_val      NUMBER(20,2),
    shrt_neg_val  NUMBER(20,2),
    long_neg_val  NUMBER(20,2),
    shrt_std_val  NUMBER(20,2),
    long_std_val  NUMBER(20,2),
    loaded_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE equity_margin_alert_stg (
    code                        VARCHAR2(10),
    app_date                    DATE,
    pub_date                    DATE,
    reason_restricted           VARCHAR2(1 CHAR),
    reason_daily_publication    VARCHAR2(1 CHAR),
    reason_monitoring           VARCHAR2(1 CHAR),
    reason_restricted_by_jsf    VARCHAR2(1 CHAR),
    reason_precaution_by_jsf    VARCHAR2(1 CHAR),
    reason_unclear_or_sec_alert VARCHAR2(1 CHAR),
    shrt_out                    NUMBER(20),
    shrt_out_chg                NUMBER(20),
    shrt_out_ratio              NUMBER(12,4),
    long_out                    NUMBER(20),
    long_out_chg                NUMBER(20),
    long_out_ratio              NUMBER(12,4),
    sl_ratio                    NUMBER(12,4),
    shrt_neg_out                NUMBER(20),
    shrt_neg_out_chg            NUMBER(20),
    shrt_std_out                NUMBER(20),
    shrt_std_out_chg            NUMBER(20),
    long_neg_out                NUMBER(20),
    long_neg_out_chg            NUMBER(20),
    long_std_out                NUMBER(20),
    long_std_out_chg            NUMBER(20),
    tse_mrgn_reg_cls            VARCHAR2(10 CHAR),
    loaded_at                   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE equity_short_position_stg (
    disc_date       DATE,
    calc_date       DATE,
    code            VARCHAR2(10),
    ss_name         VARCHAR2(1000 CHAR),
    ss_addr         VARCHAR2(1000 CHAR),
    dic_name        VARCHAR2(1000 CHAR),
    dic_addr        VARCHAR2(1000 CHAR),
    fund_name       VARCHAR2(1000 CHAR),
    shrt_pos_to_so  NUMBER(12,6),
    shrt_pos_shares NUMBER(20),
    shrt_pos_units  NUMBER(20),
    prev_rpt_date   DATE,
    prev_rpt_ratio  NUMBER(12,6),
    notes           VARCHAR2(1000 CHAR),
    loaded_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE sector_short_ratio_stg      IS '業種別空売り比率のステージング';
COMMENT ON TABLE equity_margin_interest_stg  IS '信用取引残高のステージング';
COMMENT ON TABLE equity_margin_alert_stg     IS '日々公表信用取引残高のステージング';
COMMENT ON TABLE equity_short_position_stg   IS '空売り残高報告のステージング';


--------------------------------------------------------------------------------
-- 6. 分析用ビュー
--
-- 派生指標(信用倍率など)は実体化せずビューで計算する。
-- 単純な計算式を保存すると、元データの訂正時に更新漏れが起きるため。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 業種別空売り比率(比率を計算済み)
--
-- 空売り比率 = 空売り代金 ÷ 総売り代金
-- 総売り代金 = 実注文 + 価格規制有りの空売り + 価格規制無しの空売り
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sector_short_ratio AS
SELECT r.s33_code,
       r.ratio_date,
       r.sell_ex_short_va,
       r.shrt_with_res_va,
       r.shrt_no_res_va,
       r.shrt_with_res_va + r.shrt_no_res_va                       AS short_va,
       r.sell_ex_short_va + r.shrt_with_res_va + r.shrt_no_res_va  AS total_sell_va,
       ROUND(
         (r.shrt_with_res_va + r.shrt_no_res_va) * 100 /
         NULLIF(r.sell_ex_short_va + r.shrt_with_res_va + r.shrt_no_res_va, 0)
       , 2)                                                        AS short_ratio_pct,
       -- 価格規制有りの比率が高い = 直近下落局面でも売られている、の目安
       ROUND(
         r.shrt_with_res_va * 100 /
         NULLIF(r.shrt_with_res_va + r.shrt_no_res_va, 0)
       , 2)                                                        AS with_restriction_pct
FROM sector_short_ratio r;

COMMENT ON TABLE v_sector_short_ratio IS '業種別空売り比率(空売り比率を計算済み)';


--------------------------------------------------------------------------------
-- 空売り残高報告を銘柄×計算日で集計したもの
--
-- 報告者単位の明細を、銘柄として見たいときに使う。
-- REPORTER_COUNT は「何者が0.5%以上の空売りを報告しているか」で、
-- 数が増えているほど売り方の関心が強いことを示す。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_equity_short_position_sum AS
SELECT p.code,
       p.calc_date,
       MAX(p.disc_date)             AS disc_date,
       COUNT(*)                     AS reporter_count,
       SUM(p.shrt_pos_shares)       AS total_shrt_shares,
       SUM(p.shrt_pos_to_so)        AS total_shrt_ratio,
       MAX(p.shrt_pos_to_so)        AS max_reporter_ratio
FROM equity_short_position p
GROUP BY p.code, p.calc_date;

COMMENT ON TABLE v_equity_short_position_sum IS '空売り残高報告を銘柄×計算日で集計(報告者数・残高合計)';


--------------------------------------------------------------------------------
-- 日々公表信用取引残高の最新版のみ
--
-- 過誤訂正で同一申込日に複数の公表日が存在するため、公表日が最も新しい行だけを返す。
-- 訂正前の値も見たい場合は EQUITY_MARGIN_ALERT を直接参照すること。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_equity_margin_alert_latest AS
SELECT *
FROM (
    SELECT a.*,
           ROW_NUMBER() OVER (PARTITION BY a.code, a.app_date ORDER BY a.pub_date DESC) AS rn
    FROM equity_margin_alert a
)
WHERE rn = 1;

COMMENT ON TABLE v_equity_margin_alert_latest IS '日々公表信用取引残高(過誤訂正後の最新値のみ)';


--------------------------------------------------------------------------------
-- 銘柄ごとの空売り状況サマリ
--
-- 性質の違う2つのデータを1行に並べる。
--   ・信用売残(MARGIN_*)     … 全銘柄・個人中心
--   ・空売り残高報告(REPORT_*) … 0.5%以上・機関投資家中心
-- どちらか一方がNULLでも行は残す(該当データが無いことに意味があるため)。
--
-- MARGIN_RATIO(信用倍率) = 買残 ÷ 売残。
--   低いほど売り長で、踏み上げ(ショートスクイーズ)の余地があるとされる。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_equity_short_overview AS
SELECT em.code,
       em.co_name,
       em.market_name,
       em.sector33_code,
       em.sector33_name,
       mi.app_date                                        AS margin_date,
       mi.shrt_vol                                        AS margin_short_vol,
       mi.long_vol                                        AS margin_long_vol,
       ROUND(mi.long_vol / NULLIF(mi.shrt_vol, 0), 2)     AS margin_ratio,
       mi.iss_type,
       sp.calc_date                                       AS report_calc_date,
       sp.reporter_count                                  AS report_reporter_count,
       sp.total_shrt_shares                               AS report_short_shares,
       ROUND(sp.total_shrt_ratio * 100, 3)                AS report_short_ratio_pct
FROM equity_master em
LEFT JOIN (
    -- 銘柄ごとの最新の信用取引残高
    SELECT code, app_date, shrt_vol, long_vol, iss_type
    FROM (
        SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
    )
    WHERE rn = 1
) mi ON mi.code = em.code
LEFT JOIN (
    -- 銘柄ごとの最新の空売り残高報告(集計後)
    SELECT code, calc_date, reporter_count, total_shrt_shares, total_shrt_ratio
    FROM (
        SELECT v.*, ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
    )
    WHERE rn = 1
) sp ON sp.code = em.code
WHERE em.delisted_flag = 'N';

COMMENT ON TABLE v_equity_short_overview IS '銘柄ごとの空売り状況サマリ(信用売残と空売り残高報告を並記)';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name IN ('SECTOR_SHORT_RATIO','EQUITY_MARGIN_INTEREST',
--                       'EQUITY_MARGIN_ALERT','EQUITY_SHORT_POSITION')
--  ORDER BY table_name;
--
-- 取込状況(エンドポイント別)
-- SELECT endpoint_name, status, COUNT(*) AS files, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name LIKE '/markets/%'
-- GROUP BY endpoint_name, status
-- ORDER BY endpoint_name, status;
