--------------------------------------------------------------------------------
-- 政策保有株式（EDINET）関連テーブル (Tier 4 続き。大量保有報告書と同じ基盤を再利用)
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ: /v2/edinet/cross-shareholdings (Standardプラン以上)
--
-- 【個別API呼出し方式であることについて】
--   大量保有報告書(14_large_volume_shareholders.sql)・大株主状況
--   (15_edinet_major_shareholders.sql)と同じくBulk API非対応。
--   個別API呼出し+pagination_keyページング、進捗管理は「日付単位」
--   (LOAD_PROGRESS.file_key に日付文字列'YYYY-MM-DD'を入れて流用、
--   endpoint_name='/edinet/cross-shareholdings')という同じ方式を踏襲する。
--   共通部分の設計理由は14番の冒頭コメントを参照(重複説明は省く)。
--
-- 【これまでで最も深い3階層のネスト構造をどう分解したか】
--   レスポンスは 書類 → (Report/Largest/SecondLargestの3スコープ) →
--   (Spec[]/Deem[]の銘柄配列) という3階層になっている
--   (Largest/SecondLargestは親会社が無い会社ではnullになる)。
--   これを2段の子テーブルに分解した:
--
--   EDINET_CROSS_SHAREHOLDING          … 書類メタ(書類単位で1行)
--   EDINET_CROSS_SHAREHOLDING_HOLDER   … Report/Largest/SecondLargestの
--                                         スコープ単位(1書類につき最大3行。
--                                         null のスコープは行を作らない)
--   EDINET_CROSS_SHAREHOLDING_STOCK    … Spec[]/Deem[]の銘柄単位
--                                         (1スコープにつき0〜数十行)
--
--   HOLDERテーブルの主キーを代理キー(hldr_seq)ではなく
--   SCOPE_TYPE('REPORT'/'LARGEST'/'SECOND_LARGEST')という3値の自然キーに
--   しているのは、この3つがレスポンス上固定のキー名(Report/Largest/
--   SecondLargest)であり、配列ではなく常に同じ意味を持つため。
--   STOCKテーブルは配列(Spec[]・Deem[])なので、大量保有報告書と同じ
--   代理キー(stock_seq、配列インデックス+1)を振る。STOCK_TYPE
--   ('SPEC'/'DEEM')でSpec由来かDeem由来かを区別する(同じ列構成のため
--   テーブルを分けず1本にまとめた)。
--
--   子テーブルは親へのFKにON DELETE CASCADEを付けている(提出日単位で
--   親をDELETEするだけで孫テーブルまで連動して洗い替えられる)。
--
-- 【自由記述欄をCLOBではなくVARCHAR2+切り詰めにしている理由】
--   HoldRat(保有目的等)・SpecFn/DeemFn(注釈、HTML)・ListedIncRsn/
--   NonListedIncRsn(増加理由)は長文になり得るが、大量保有報告書の
--   HldgPurp/ImpProp/ColAgr等と同じ「自由記述はclampText()で切り詰めて
--   例外で止めない」方針を踏襲する(4.2節(4)参照)。CLOBは本プロジェクトで
--   前例が無く、bulkInsert(executeMany)のバインド方式を専用に作り込む
--   必要が出るため、既存の切り詰め方式との一貫性を優先した。分析上
--   末尾が切れて困る場合は、DocIdでEDINET提出書類そのものを参照すればよい。
--
-- 【CODEをFK(EQUITY_MASTERへの外部キー)にしている箇所】
--   書類メタのCODE(提出会社)のみ。HOLDER.hldr_code(保有主体側)や
--   STOCK.isr_code(保有先銘柄)は、非上場会社や連結子会社が入り得るため
--   FKを持たない(大量保有報告書のhldr_codeと同じ扱い)。
--   マスタに存在しない提出会社コードは書類ごとスキップして報告する
--   (loadInitial.js の processEdinetCrossShareholdingDate 参照)。
--
-- 【実データ未確認であることについて】
--   Cowork(Claude)のdevice_bashからapi.jquants.comへの通信がegressで
--   遮断されているため、本DDL・edinetMapper.jsの追加分はAPI仕様書
--   (/spec/edinet-cross-shareholdings)の記載のみに基づいて設計している。
--   本番投入前に必ず次を実行し、実際のレスポンスが仕様書通りか確認すること:
--     node scripts/inspect-edinet-api.js cross-shareholdings --date 2025-06-20
--
-- 前提: 01〜04, 14 のDDLを実行済みであること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. EDINET_CROSS_SHAREHOLDING (書類メタ。書類単位でDocIdは一意)
--------------------------------------------------------------------------------
CREATE TABLE edinet_cross_shareholding (
    doc_id           VARCHAR2(20 CHAR)  NOT NULL,
    code             VARCHAR2(10 CHAR)  NOT NULL,
    edinet_code      VARCHAR2(20 CHAR),
    filer_name       VARCHAR2(400 CHAR),
    filer_name_en    VARCHAR2(400 CHAR),
    doc_type_code    VARCHAR2(10 CHAR)  NOT NULL,
    sub_date         DATE               NOT NULL,
    sub_time         VARCHAR2(10 CHAR),
    per_st           DATE,
    per_en           DATE,
    loaded_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_edinet_cross_shareholding PRIMARY KEY (doc_id),
    CONSTRAINT fk_edinet_cross_shareholding_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE edinet_cross_shareholding IS '政策保有株式(有価証券報告書)の書類メタ(書類単位、DocIdで一意)';
COMMENT ON COLUMN edinet_cross_shareholding.doc_id        IS 'EDINET書類管理番号(主キー)(DocId)';
COMMENT ON COLUMN edinet_cross_shareholding.code          IS '提出会社の銘柄コード(Code)';
COMMENT ON COLUMN edinet_cross_shareholding.edinet_code   IS '提出会社のEDINETコード(EdinetCode)';
COMMENT ON COLUMN edinet_cross_shareholding.filer_name    IS '提出者名(会社名・和文)(FilerName)';
COMMENT ON COLUMN edinet_cross_shareholding.filer_name_en IS '提出者名(英文)(FilerNameEn)';
COMMENT ON COLUMN edinet_cross_shareholding.doc_type_code IS '書類種別コード 120=有価証券報告書(DocTypeCode)';
COMMENT ON COLUMN edinet_cross_shareholding.sub_date      IS '提出日(SubDate)。取込時はこの日付単位で洗い替えする';
COMMENT ON COLUMN edinet_cross_shareholding.sub_time      IS '提出時刻(HH:MM:SS)(SubTime)';
COMMENT ON COLUMN edinet_cross_shareholding.per_st        IS '対象事業年度の開始日(PerSt)';
COMMENT ON COLUMN edinet_cross_shareholding.per_en        IS '対象事業年度の終了日(PerEn)';
COMMENT ON COLUMN edinet_cross_shareholding.loaded_at     IS '取込日時';

CREATE INDEX ix_edinet_cross_shareholding_sub_date ON edinet_cross_shareholding (sub_date);
CREATE INDEX ix_edinet_cross_shareholding_code ON edinet_cross_shareholding (code, sub_date);


--------------------------------------------------------------------------------
-- 2. EDINET_CROSS_SHAREHOLDING_HOLDER (Report/Largest/SecondLargestスコープ単位)
--------------------------------------------------------------------------------
CREATE TABLE edinet_cross_shareholding_holder (
    doc_id                  VARCHAR2(20 CHAR)  NOT NULL,
    scope_type              VARCHAR2(20 CHAR)  NOT NULL,  -- REPORT/LARGEST/SECOND_LARGEST
    hldr_name               VARCHAR2(400 CHAR),
    hldr_code               VARCHAR2(10 CHAR),
    hldr_edinet_code        VARCHAR2(20 CHAR),
    listed_iss              NUMBER(10),
    listed_book_val         NUMBER(24,4),
    listed_inc_iss          NUMBER(10),
    listed_inc_acq_cost     NUMBER(24,4),
    listed_dec_iss          NUMBER(10),
    listed_dec_sale_amt     NUMBER(24,4),
    listed_inc_rsn          VARCHAR2(1000 CHAR),
    non_listed_iss          NUMBER(10),
    non_listed_book_val     NUMBER(24,4),
    non_listed_inc_iss      NUMBER(10),
    non_listed_inc_acq_cost NUMBER(24,4),
    non_listed_dec_iss      NUMBER(10),
    non_listed_dec_sale_amt NUMBER(24,4),
    non_listed_inc_rsn      VARCHAR2(1000 CHAR),
    spec_fn                 VARCHAR2(1000 CHAR),
    deem_fn                 VARCHAR2(1000 CHAR),
    loaded_at               TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_edinet_cross_shareholding_holder PRIMARY KEY (doc_id, scope_type),
    CONSTRAINT ck_edinet_cross_shareholding_holder_scope CHECK (scope_type IN ('REPORT', 'LARGEST', 'SECOND_LARGEST')),
    CONSTRAINT fk_edinet_cross_shareholding_holder_doc FOREIGN KEY (doc_id)
        REFERENCES edinet_cross_shareholding (doc_id) ON DELETE CASCADE
);

COMMENT ON TABLE edinet_cross_shareholding_holder IS '提出会社自身(REPORT)/連結最大保有会社(LARGEST)/連結第二最大保有会社(SECOND_LARGEST)の保有ブロック。1書類につき最大3行(親会社が無ければLARGEST/SECOND_LARGESTの行自体が無い)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.doc_id                  IS '書類管理番号(親テーブルへのFK)(DocId)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.scope_type              IS '保有主体の区分。REPORT=提出会社自身/LARGEST=連結最大保有会社/SECOND_LARGEST=連結第二最大保有会社(レスポンスのReport/Largest/SecondLargestキー名に対応)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.hldr_name               IS '当該保有主体の会社名(HldrName)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.hldr_code               IS '当該保有主体の証券コード(HldrCode)。非上場等でnullのことがある';
COMMENT ON COLUMN edinet_cross_shareholding_holder.hldr_edinet_code        IS '当該保有主体のEDINETコード(HldrEdinetCode)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_iss              IS '上場 銘柄数(ListedIss)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_book_val         IS '上場 貸借対照表計上額合計(円)(ListedBookVal)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_inc_iss          IS '上場 株式数が増加した銘柄数(ListedIncIss)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_inc_acq_cost     IS '上場 増加に係る取得価額合計(円)(ListedIncAcqCost)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_dec_iss          IS '上場 株式数が減少した銘柄数(ListedDecIss)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_dec_sale_amt     IS '上場 減少に係る売却価額合計(円)(ListedDecSaleAmt)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.listed_inc_rsn          IS '上場 株式数が増加した理由(長文は切り詰め)(ListedIncRsn)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_iss          IS '非上場 銘柄数(NonListedIss)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_book_val     IS '非上場 貸借対照表計上額合計(円)(NonListedBookVal)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_inc_iss      IS '非上場 株式数が増加した銘柄数(NonListedIncIss)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_inc_acq_cost IS '非上場 増加に係る取得価額合計(円)(NonListedIncAcqCost)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_dec_iss      IS '非上場 株式数が減少した銘柄数(NonListedDecIss)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_dec_sale_amt IS '非上場 減少に係る売却価額合計(円)(NonListedDecSaleAmt)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.non_listed_inc_rsn      IS '非上場 株式数が増加した理由(長文は切り詰め)(NonListedIncRsn)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.spec_fn                 IS '特定投資株式の注釈。HTML文字列(長文は切り詰め)(SpecFn)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.deem_fn                 IS 'みなし保有株式の注釈。HTML文字列(長文は切り詰め)(DeemFn)';
COMMENT ON COLUMN edinet_cross_shareholding_holder.loaded_at               IS '取込日時';


--------------------------------------------------------------------------------
-- 3. EDINET_CROSS_SHAREHOLDING_STOCK (Spec[]/Deem[]の銘柄単位。1本のテーブルにまとめる)
--------------------------------------------------------------------------------
CREATE TABLE edinet_cross_shareholding_stock (
    doc_id                VARCHAR2(20 CHAR)  NOT NULL,
    scope_type            VARCHAR2(20 CHAR)  NOT NULL,
    stock_type            VARCHAR2(10 CHAR)  NOT NULL,  -- SPEC=特定投資株式 / DEEM=みなし保有株式
    stock_seq             NUMBER(4)          NOT NULL,  -- Spec[]/Deem[]配列内の並び順(1始まり)
    isr_name              VARCHAR2(400 CHAR),
    isr_code              VARCHAR2(10 CHAR),
    isr_edinet_code       VARCHAR2(20 CHAR),
    cur_shs               NUMBER(24,4),
    pri_shs                NUMBER(24,4),
    cur_book_val           NUMBER(24,4),
    pri_book_val           NUMBER(24,4),
    cur_shs_not_disc       VARCHAR2(80 CHAR),
    pri_shs_not_disc       VARCHAR2(80 CHAR),
    cur_book_val_not_disc  VARCHAR2(80 CHAR),
    pri_book_val_not_disc  VARCHAR2(80 CHAR),
    hold_rat                VARCHAR2(1000 CHAR),
    isr_holds                VARCHAR2(80 CHAR),
    isr_holds_code            VARCHAR2(5 CHAR),
    loaded_at                 TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_edinet_cross_shareholding_stock PRIMARY KEY (doc_id, scope_type, stock_type, stock_seq),
    CONSTRAINT ck_edinet_cross_shareholding_stock_type CHECK (stock_type IN ('SPEC', 'DEEM')),
    CONSTRAINT fk_edinet_cross_shareholding_stock_h FOREIGN KEY (doc_id, scope_type)
        REFERENCES edinet_cross_shareholding_holder (doc_id, scope_type) ON DELETE CASCADE
);

COMMENT ON TABLE edinet_cross_shareholding_stock IS '保有ブロック(REPORT/LARGEST/SECOND_LARGEST)ごとの特定投資株式(SPEC)・みなし保有株式(DEEM)の銘柄明細。Spec[]とDeem[]は列構成が同じため1本のテーブルにまとめ、STOCK_TYPEで区別する';
COMMENT ON COLUMN edinet_cross_shareholding_stock.doc_id               IS '書類管理番号(親のFKの一部)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.scope_type           IS '保有主体の区分(親のFKの一部)。REPORT/LARGEST/SECOND_LARGEST';
COMMENT ON COLUMN edinet_cross_shareholding_stock.stock_type           IS 'SPEC=特定投資株式(Spec[]由来) / DEEM=みなし保有株式(Deem[]由来)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.stock_seq            IS 'Spec[]またはDeem[]配列内の並び順(1始まり。自然キーが無いための代理キー)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.isr_name             IS '保有先銘柄名(IsrName)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.isr_code             IS '保有先の銘柄コード。IsrNameから名寄せされた値(IsrCode)。非上場等でnullのことがある。EQUITY_MASTERへのFKは持たない(保有先は非上場・上場廃止・海外企業等も含むため)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.isr_edinet_code      IS '保有先のEDINETコード。IsrNameから名寄せされた値(IsrEdinetCode)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.cur_shs              IS '当事業年度の株式数(株)(CurShs)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.pri_shs              IS '前事業年度の株式数(株)(PriShs)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.cur_book_val         IS '当事業年度の貸借対照表計上額(円)(CurBookVal)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.pri_book_val         IS '前事業年度の貸借対照表計上額(円)(PriBookVal)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.cur_shs_not_disc     IS '当期株式数の非開示マーカー生値。例: */＊/※/（注N）(CurShsNotDisc)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.pri_shs_not_disc     IS '前期株式数の非開示マーカー生値(PriShsNotDisc)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.cur_book_val_not_disc IS '当期BS計上額の非開示マーカー生値(CurBookValNotDisc)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.pri_book_val_not_disc IS '前期BS計上額の非開示マーカー生値(PriBookValNotDisc)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.hold_rat              IS '保有目的・業務提携の概要・定量効果・増加理由の複合テキスト(長文は切り詰め)(HoldRat)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.isr_holds             IS '当社の株式の保有の有無。生データ。例: 有/無/無(注)３(IsrHolds)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.isr_holds_code        IS '当社の株式の保有の有無を3値に正規化。1=有/0=無/2=判定不能(IsrHoldsCode)';
COMMENT ON COLUMN edinet_cross_shareholding_stock.loaded_at             IS '取込日時';

-- 保有先銘柄で複数書類を横断的に追う分析用(誰が自社株を政策保有しているか等)
CREATE INDEX ix_edinet_cross_shareholding_stock_isr_code ON edinet_cross_shareholding_stock (isr_code);


--------------------------------------------------------------------------------
-- 4. 分析用ビュー
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 書類×保有ブロックを1行に展開した入口ビュー(Spec/Deemの銘柄明細までは展開しない。
-- 「この会社は政策保有株式をどれだけ持っているか」の概観に使う)。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_edinet_cross_shareholding_overview AS
SELECT
    d.doc_id,
    d.code,
    d.edinet_code,
    d.filer_name,
    d.sub_date,
    d.per_st,
    d.per_en,
    h.scope_type,
    h.hldr_name,
    h.hldr_code,
    h.listed_iss,
    h.listed_book_val,
    h.non_listed_iss,
    h.non_listed_book_val
FROM edinet_cross_shareholding d
JOIN edinet_cross_shareholding_holder h ON h.doc_id = d.doc_id;

COMMENT ON TABLE v_edinet_cross_shareholding_overview IS '政策保有株式を書類×保有ブロック(REPORT/LARGEST/SECOND_LARGEST)単位で1行に展開した概観ビュー';

--------------------------------------------------------------------------------
-- 「どの会社がどの銘柄を政策保有しているか」を素直に引ける入口ビュー
-- (REPORTスコープ=提出会社自身の保有分のみに絞っている。連結子会社側の
--  保有(LARGEST/SECOND_LARGEST)まで含めたい場合はSTOCKテーブルを直接JOINする)。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_edinet_cross_shareholding_stock_detail AS
SELECT
    d.doc_id,
    d.code AS holder_code,
    d.filer_name AS holder_name,
    d.sub_date,
    s.stock_type,
    s.isr_name,
    s.isr_code,
    s.cur_shs,
    s.pri_shs,
    s.cur_book_val,
    s.pri_book_val,
    s.hold_rat,
    s.isr_holds_code
FROM edinet_cross_shareholding d
JOIN edinet_cross_shareholding_stock s
    ON s.doc_id = d.doc_id AND s.scope_type = 'REPORT';

COMMENT ON TABLE v_edinet_cross_shareholding_stock_detail IS '提出会社自身(REPORT)が政策保有する銘柄を1行1銘柄に展開したビュー';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name LIKE 'EDINET_CROSS_SHAREHOLDING%'
--  ORDER BY table_name;
--
-- SELECT status, COUNT(*) AS days, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name = '/edinet/cross-shareholdings'
-- GROUP BY status;
