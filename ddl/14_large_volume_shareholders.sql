--------------------------------------------------------------------------------
-- 大量保有報告書（EDINET）関連テーブル (Tier 4 の最初の適用先)
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ: /v2/edinet/large-volume-shareholders (Standardプラン以上)
--
-- 【なぜTier1〜3までと根本的に取込方式が違うのか】
--   このエンドポイントはBulk API(CSV一括ダウンロード)に対応していない
--   (公式仕様書に「API経由でのみご利用いただけます。ファイルダウンロード
--   （CSV／Bulk）には対応しておりません」と明記)。個別にAPIを呼び出し、
--   `pagination_key` でページングする方式が必須になる。
--
--   また `edinet_code`/`code` を指定しない場合は「API実行日に提出された
--   全書類」しか返らないため、過去分を取得するには `date`(提出日)を
--   1日ずつ指定してループする必要がある。つまり進捗管理の粒度が
--   「Bulkファイル単位」ではなく「日付単位」になる
--   (LOAD_PROGRESS.file_key に日付文字列'YYYY-MM-DD'を入れて流用する。
--   テーブル自体はTier1〜3と共用でスキーマ変更は不要)。
--
-- 【ステージングテーブルを作らない理由】
--   Tier1〜3は「Bulk CSV(数千〜数万行)をステージング→MERGE」という
--   バルク指向の設計だったが、このエンドポイントは1日あたり数件〜数十件の
--   JSON書類を個別取得するだけで、データ量がまったく違う。ステージング
--   テーブルを介す必要が無いため、取得したJSONを直接
--   本表へDELETE(提出日単位の洗い替え)+INSERTする方式にした
--   (EQUITY_SHORT_POSITIONの「公表日単位の洗い替え」と同じ考え方だが、
--   対象が単一テーブルではなく親子関係にある5テーブル)。
--
-- 【テーブル構成(レスポンスのネスト構造をそのまま親子テーブルに分解)】
--   LARGE_VOLUME_SHAREHOLDER            … 書類メタ(書類単位で1行)
--   LARGE_VOLUME_SHAREHOLDER_HOLDER     … Hldrs配列(提出者・共同保有者単位)
--   LARGE_VOLUME_SHAREHOLDER_ACQ_DISP   … Hldrs[].AcqDisp配列(60日間の取得処分)
--   LARGE_VOLUME_SHAREHOLDER_BORROWING  … Hldrs[].BrwList配列(借入金の内訳)
--   LARGE_VOLUME_SHAREHOLDER_CREDITOR   … Hldrs[].CredList配列(借入先)
--
--   子テーブルはすべて親へのFKにON DELETE CASCADEを付けている。これにより
--   「提出日で親をDELETE」するだけで子・孫テーブルの該当行も連動して消え、
--   洗い替え処理が親テーブルのDELETE1文で完結する(子テーブルを
--   個別にDELETEする必要が無い)。
--
-- 【CODEをFK(EQUITY_MASTERへの外部キー)にしている理由・注意点】
--   Tier3までの補助データ(財務情報・決算発表予定日等)と同じ方針で、
--   マスタに存在しない銘柄コード(名証単独上場銘柄等)は書類ごと
--   スキップして報告する(loadInitial.js の skipUnknownCodesInDocs 参照)。
--
-- 【実データ未確認であることについて】
--   Tier3と同じ理由(Cowork(Claude)のdevice_bashからapi.jquants.comへの
--   通信がegressで遮断されている)により、本DDL・edinetMapper.jsは
--   API仕様書(/spec/edinet-large-volume-shareholders)の記載のみに基づいて
--   設計している。本番投入前に必ず次を実行し、実際のレスポンスが
--   仕様書通りか確認すること(手順はscripts/inspect-edinet-api.js冒頭コメント参照):
--     node scripts/inspect-edinet-api.js large-volume-shareholders --date 2025-07-07
--   (サンプルレスポンスにある書類 S100WBIV の提出日が2025-07-07)
--
-- 前提: 01〜04 のDDLを実行済みであること(CODEがEQUITY_MASTERへの
--       外部キーを持つため)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. LARGE_VOLUME_SHAREHOLDER (書類メタ。書類単位でDocIdは一意)
--------------------------------------------------------------------------------
CREATE TABLE large_volume_shareholder (
    doc_id                VARCHAR2(20 CHAR)  NOT NULL,
    code                  VARCHAR2(10 CHAR)  NOT NULL,
    edinet_code           VARCHAR2(20 CHAR),  -- NOT NULLにしない理由はテーブルコメント参照
    isr_name              VARCHAR2(400 CHAR),
    doc_type_code         VARCHAR2(10 CHAR)  NOT NULL,
    sub_date              DATE               NOT NULL,
    sub_time              VARCHAR2(10 CHAR),
    large_hldg_type_code  VARCHAR2(5 CHAR)   NOT NULL,
    doc_title             VARCHAR2(400 CHAR),
    chg_rsn               VARCHAR2(1000 CHAR),
    total_shs_held        NUMBER(24,4),
    total_shs_ratio       NUMBER(12,8),
    total_shs_ratio_last  NUMBER(12,8),
    total_out_stks        NUMBER(24,4),
    loaded_at             TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_large_volume_shareholder PRIMARY KEY (doc_id),
    CONSTRAINT fk_large_volume_shareholder_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE large_volume_shareholder IS '大量保有報告書・変更報告書の書類メタ(書類単位、DocIdで一意)。edinet_codeはNOT NULLにしていない(2026-09-06、初回投入の実データでEdinetCodeが空の書類が1件確認されたため。ORA-01400で判明)';
COMMENT ON COLUMN large_volume_shareholder.doc_id               IS 'EDINET書類管理番号(主キー)(DocId)';
COMMENT ON COLUMN large_volume_shareholder.code                 IS '発行者(保有対象銘柄)の銘柄コード(Code)';
COMMENT ON COLUMN large_volume_shareholder.edinet_code          IS '発行者のEDINETコード(EdinetCode)。ごく稀に空の書類がある(2026-09-06実データで発覚)ためNULL許容';
COMMENT ON COLUMN large_volume_shareholder.isr_name              IS '発行者名(IsrName)';
COMMENT ON COLUMN large_volume_shareholder.doc_type_code        IS '書類種別コード(350=大量保有報告書関連)(DocTypeCode)';
COMMENT ON COLUMN large_volume_shareholder.sub_date              IS '提出日(SubDate)。取込時はこの日付単位で洗い替えする';
COMMENT ON COLUMN large_volume_shareholder.sub_time              IS '提出時刻(HH:MM:SS)(SubTime)';
COMMENT ON COLUMN large_volume_shareholder.large_hldg_type_code IS '大量保有書類種別コード 1=大量保有報告書/2=変更報告書/3=変更報告書(短期大量譲渡)/4=大量保有報告書(特例対象株券等)/5=変更報告書(特例対象株券等)/0=不明(LargeHldgTypeCode)';
COMMENT ON COLUMN large_volume_shareholder.doc_title             IS '書類表題(DocTitle)';
COMMENT ON COLUMN large_volume_shareholder.chg_rsn               IS '報告義務発生日における変更事由(変更報告書のみ。長文は切り詰め)(ChgRsn)';
COMMENT ON COLUMN large_volume_shareholder.total_shs_held        IS '保有株券等の数の合計(株)(TotalShsHeld)';
COMMENT ON COLUMN large_volume_shareholder.total_shs_ratio       IS '株券等保有割合の合計。小数表現(0.1343=13.43%)(TotalShsRatio)';
COMMENT ON COLUMN large_volume_shareholder.total_shs_ratio_last  IS '直前の報告書に係る株券等保有割合の合計(変更報告書のみ)(TotalShsRatioLast)';
COMMENT ON COLUMN large_volume_shareholder.total_out_stks        IS '発行済株式等総数(株)(TotalOutStks)';
COMMENT ON COLUMN large_volume_shareholder.loaded_at             IS '取込日時';

-- 提出日単位での洗い替え(DELETE)・分析時の絞り込み用
CREATE INDEX ix_large_volume_shareholder_sub_date ON large_volume_shareholder (sub_date);
-- 銘柄単位で時系列を引く分析用
CREATE INDEX ix_large_volume_shareholder_code ON large_volume_shareholder (code, sub_date);


--------------------------------------------------------------------------------
-- 2. LARGE_VOLUME_SHAREHOLDER_HOLDER (Hldrs配列。提出者・共同保有者単位)
--------------------------------------------------------------------------------
CREATE TABLE large_volume_shareholder_holder (
    doc_id                VARCHAR2(20 CHAR)  NOT NULL,
    hldr_seq              NUMBER(4)          NOT NULL,  -- Hldrs配列のインデックス(1始まり)
    hldr_name              VARCHAR2(400 CHAR),
    hldr_name_en           VARCHAR2(400 CHAR),
    hldr_edinet_code       VARCHAR2(20 CHAR),
    hldr_code              VARCHAR2(10 CHAR),
    large_hldr_type_code   VARCHAR2(5 CHAR),
    large_hldr_type_raw    VARCHAR2(200 CHAR),
    hldg_purp              VARCHAR2(1000 CHAR),
    imp_prop                VARCHAR2(1000 CHAR),
    col_agr                 VARCHAR2(1000 CHAR),
    shs_held                NUMBER(24,4),
    shs_ratio               NUMBER(12,8),
    shs_ratio_last          NUMBER(12,8),
    own_fund                NUMBER(24,4),
    total_brw               NUMBER(24,4),
    total_other             NUMBER(24,4),
    other_brk                VARCHAR2(1000 CHAR),
    total_fund               NUMBER(24,4),
    loaded_at                TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_large_volume_shareholder_holder PRIMARY KEY (doc_id, hldr_seq),
    CONSTRAINT fk_large_volume_shareholder_holder_doc FOREIGN KEY (doc_id)
        REFERENCES large_volume_shareholder (doc_id) ON DELETE CASCADE
);

COMMENT ON TABLE large_volume_shareholder_holder IS '大量保有報告書の提出者・共同保有者明細(Hldrs配列を1行1保有者に展開)';
COMMENT ON COLUMN large_volume_shareholder_holder.doc_id               IS '書類管理番号(親テーブルへのFK)(DocId)';
COMMENT ON COLUMN large_volume_shareholder_holder.hldr_seq             IS 'Hldrs配列内の並び順(1始まり。自然キーが無いための代理キー)';
COMMENT ON COLUMN large_volume_shareholder_holder.hldr_name            IS '保有者の氏名又は名称(HldrName)';
COMMENT ON COLUMN large_volume_shareholder_holder.hldr_name_en         IS '保有者の名称(英語)(HldrNameEn)';
COMMENT ON COLUMN large_volume_shareholder_holder.hldr_edinet_code     IS '保有者のEDINETコード(HldrEdinetCode)';
COMMENT ON COLUMN large_volume_shareholder_holder.hldr_code            IS '保有者の銘柄コード(保有者が上場会社の場合等)(HldrCode)';
COMMENT ON COLUMN large_volume_shareholder_holder.large_hldr_type_code IS '保有者区分コード 1=個人/2=法人/0=不明(LargeHldrTypeCode)';
COMMENT ON COLUMN large_volume_shareholder_holder.large_hldr_type_raw  IS '保有者区分の書類記載生値(LargeHldrTypeRaw)';
COMMENT ON COLUMN large_volume_shareholder_holder.hldg_purp            IS '保有目的(長文は切り詰め)(HldgPurp)';
COMMENT ON COLUMN large_volume_shareholder_holder.imp_prop             IS '重要提案行為等(長文は切り詰め)(ImpProp)';
COMMENT ON COLUMN large_volume_shareholder_holder.col_agr              IS '担保契約等重要な契約(長文は切り詰め)(ColAgr)';
COMMENT ON COLUMN large_volume_shareholder_holder.shs_held              IS '保有株券等の数(株)(ShsHeld)';
COMMENT ON COLUMN large_volume_shareholder_holder.shs_ratio             IS '株券等保有割合。小数表現(0.0572=5.72%)(ShsRatio)';
COMMENT ON COLUMN large_volume_shareholder_holder.shs_ratio_last       IS '直前の報告書に係る株券等保有割合(変更報告書のみ)(ShsRatioLast)';
COMMENT ON COLUMN large_volume_shareholder_holder.own_fund             IS '取得資金のうち自己資金額(円)(OwnFund)';
COMMENT ON COLUMN large_volume_shareholder_holder.total_brw            IS '取得資金のうち借入金額計(円)(TotalBrw)';
COMMENT ON COLUMN large_volume_shareholder_holder.total_other          IS '取得資金のうちその他金額計(円)(TotalOther)';
COMMENT ON COLUMN large_volume_shareholder_holder.other_brk            IS 'その他金額計の内訳(長文は切り詰め)(OtherBrk)';
COMMENT ON COLUMN large_volume_shareholder_holder.total_fund           IS '取得資金合計(円)(TotalFund)';
COMMENT ON COLUMN large_volume_shareholder_holder.loaded_at            IS '取込日時';

-- 保有者(法人・個人)単位で複数書類を横断的に追う分析用
CREATE INDEX ix_large_volume_shareholder_holder_edinet ON large_volume_shareholder_holder (hldr_edinet_code);


--------------------------------------------------------------------------------
-- 3. LARGE_VOLUME_SHAREHOLDER_ACQ_DISP (Hldrs[].AcqDisp配列。直近60日間の取得・処分)
--------------------------------------------------------------------------------
CREATE TABLE large_volume_shareholder_acq_disp (
    doc_id           VARCHAR2(20 CHAR)  NOT NULL,
    hldr_seq         NUMBER(4)          NOT NULL,
    acq_seq          NUMBER(4)          NOT NULL,  -- AcqDisp配列のインデックス(1始まり)
    acq_date         DATE,
    sec_type         VARCHAR2(200 CHAR),
    shs              NUMBER(24,4),
    ratio            NUMBER(12,8),
    mkt              VARCHAR2(200 CHAR),
    mkt_code         VARCHAR2(5 CHAR),
    txn_type         VARCHAR2(200 CHAR),
    txn_type_code    VARCHAR2(5 CHAR),
    cptty            VARCHAR2(400 CHAR),
    price            NUMBER(24,4),
    price_raw        VARCHAR2(200 CHAR),
    loaded_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_large_volume_shareholder_acq_disp PRIMARY KEY (doc_id, hldr_seq, acq_seq),
    CONSTRAINT fk_large_volume_shareholder_acq_disp_h FOREIGN KEY (doc_id, hldr_seq)
        REFERENCES large_volume_shareholder_holder (doc_id, hldr_seq) ON DELETE CASCADE
);

COMMENT ON TABLE large_volume_shareholder_acq_disp IS '保有者ごとの直近60日間の取得又は処分の状況(AcqDisp配列)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.doc_id        IS '書類管理番号(親のFKの一部)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.hldr_seq      IS '保有者の並び順(親のFKの一部)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.acq_seq       IS 'AcqDisp配列内の並び順(1始まり)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.acq_date      IS '年月日(Date)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.sec_type      IS '株券等の種類(例: 普通株式)(SecType)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.shs           IS '数量(株)(Shs)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.ratio         IS '割合(%)(Ratio)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.mkt           IS '市場内外取引の別の書類記載生値(Mkt)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.mkt_code      IS '市場内外取引コード 1=市場内/2=市場外(MktCode)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.txn_type      IS '取得又は処分の別の書類記載生値(TxnType)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.txn_type_code IS '取得又は処分コード 1=取得/2=処分(TxnTypeCode)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.cptty         IS '譲渡の相手方(短期大量譲渡変更の書類でのみ記載)(Cptty)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.price         IS '単価(円)(Price)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.price_raw     IS '単価の生値(PriceRaw)';
COMMENT ON COLUMN large_volume_shareholder_acq_disp.loaded_at     IS '取込日時';


--------------------------------------------------------------------------------
-- 4. LARGE_VOLUME_SHAREHOLDER_BORROWING (Hldrs[].BrwList配列。借入金の内訳)
--------------------------------------------------------------------------------
CREATE TABLE large_volume_shareholder_borrowing (
    doc_id          VARCHAR2(20 CHAR)  NOT NULL,
    hldr_seq        NUMBER(4)          NOT NULL,
    brw_seq         NUMBER(4)          NOT NULL,  -- BrwList配列のインデックス(1始まり)
    brw_name        VARCHAR2(400 CHAR),
    brw_ind         VARCHAR2(200 CHAR),
    brw_rep         VARCHAR2(400 CHAR),
    brw_addr        VARCHAR2(400 CHAR),
    disc_brw_purp   VARCHAR2(5 CHAR),
    amt             NUMBER(24,4),
    loaded_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_large_volume_shareholder_borrowing PRIMARY KEY (doc_id, hldr_seq, brw_seq),
    CONSTRAINT fk_large_volume_shareholder_borrowing_h FOREIGN KEY (doc_id, hldr_seq)
        REFERENCES large_volume_shareholder_holder (doc_id, hldr_seq) ON DELETE CASCADE
);

COMMENT ON TABLE large_volume_shareholder_borrowing IS '保有者ごとの借入金の内訳(BrwList配列)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.doc_id        IS '書類管理番号(親のFKの一部)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.hldr_seq      IS '保有者の並び順(親のFKの一部)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.brw_seq       IS 'BrwList配列内の並び順(1始まり)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.brw_name      IS '名称(支店名を含む)(Name)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.brw_ind       IS '業種(Ind)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.brw_rep       IS '代表者氏名(Rep)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.brw_addr      IS '所在地(Addr)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.disc_brw_purp IS '借入目的の開示区分 1=銀行等に開示せず/2=銀行等に開示及び銀行等以外の借入(DiscBrwPurp)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.amt           IS '金額(円)(Amt)';
COMMENT ON COLUMN large_volume_shareholder_borrowing.loaded_at     IS '取込日時';


--------------------------------------------------------------------------------
-- 5. LARGE_VOLUME_SHAREHOLDER_CREDITOR (Hldrs[].CredList配列。借入先の名称等)
--------------------------------------------------------------------------------
CREATE TABLE large_volume_shareholder_creditor (
    doc_id      VARCHAR2(20 CHAR)  NOT NULL,
    hldr_seq    NUMBER(4)          NOT NULL,
    cred_seq    NUMBER(4)          NOT NULL,  -- CredList配列のインデックス(1始まり)
    cred_name   VARCHAR2(400 CHAR),
    cred_rep    VARCHAR2(400 CHAR),
    cred_addr   VARCHAR2(400 CHAR),
    loaded_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_large_volume_shareholder_creditor PRIMARY KEY (doc_id, hldr_seq, cred_seq),
    CONSTRAINT fk_large_volume_shareholder_creditor_h FOREIGN KEY (doc_id, hldr_seq)
        REFERENCES large_volume_shareholder_holder (doc_id, hldr_seq) ON DELETE CASCADE
);

COMMENT ON TABLE large_volume_shareholder_creditor IS '保有者ごとの借入先の名称等(CredList配列)';
COMMENT ON COLUMN large_volume_shareholder_creditor.doc_id     IS '書類管理番号(親のFKの一部)';
COMMENT ON COLUMN large_volume_shareholder_creditor.hldr_seq   IS '保有者の並び順(親のFKの一部)';
COMMENT ON COLUMN large_volume_shareholder_creditor.cred_seq   IS 'CredList配列内の並び順(1始まり)';
COMMENT ON COLUMN large_volume_shareholder_creditor.cred_name  IS '名称(支店名を含む)(Name)';
COMMENT ON COLUMN large_volume_shareholder_creditor.cred_rep   IS '代表者氏名(Rep)';
COMMENT ON COLUMN large_volume_shareholder_creditor.cred_addr  IS '所在地(Addr)';
COMMENT ON COLUMN large_volume_shareholder_creditor.loaded_at  IS '取込日時';


--------------------------------------------------------------------------------
-- 6. 分析用ビュー
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 書類×保有者を1行に展開した入口ビュー。
-- 「この銘柄の大量保有者は誰か」「この機関投資家がどの銘柄を報告しているか」
-- を素直に引ける形にしている(AcqDisp/BrwList/CredListまでは展開しない。
-- それらが要る分析は個別テーブルを直接JOINする)。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_large_volume_shareholder_detail AS
SELECT
    d.doc_id,
    d.code,
    d.edinet_code,
    d.isr_name,
    d.sub_date,
    d.doc_type_code,
    d.large_hldg_type_code,
    d.doc_title,
    d.chg_rsn,
    d.total_shs_held,
    d.total_shs_ratio,
    d.total_shs_ratio_last,
    d.total_out_stks,
    h.hldr_seq,
    h.hldr_name,
    h.hldr_name_en,
    h.hldr_edinet_code,
    h.hldr_code,
    h.large_hldr_type_code,
    h.large_hldr_type_raw,
    h.hldg_purp,
    h.shs_held,
    h.shs_ratio,
    h.shs_ratio_last
FROM large_volume_shareholder d
JOIN large_volume_shareholder_holder h ON h.doc_id = d.doc_id;

COMMENT ON TABLE v_large_volume_shareholder_detail IS '大量保有報告書を書類×保有者単位で1行に展開したビュー(AcqDisp/BrwList/CredListは含まない)';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name LIKE 'LARGE_VOLUME_SHAREHOLDER%'
--  ORDER BY table_name;
--
-- SELECT status, COUNT(*) AS days, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name = '/edinet/large-volume-shareholders'
-- GROUP BY status;
