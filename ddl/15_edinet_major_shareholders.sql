--------------------------------------------------------------------------------
-- 大株主状況（EDINET）関連テーブル (Tier 4 続き。大量保有報告書と同じ基盤を再利用)
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ: /v2/edinet/major-shareholders (Standardプラン以上)
--
-- 【大量保有報告書(14_large_volume_shareholders.sql)と同じ方式にしている理由】
--   このエンドポイントもBulk API非対応(公式仕様書に「API経由でのみご利用いただけます。
--   ファイルダウンロード（CSV／Bulk）には対応しておりません」と明記)。
--   個別API呼出し+pagination_keyページング、進捗管理は「日付単位」
--   (LOAD_PROGRESS.file_key に日付文字列'YYYY-MM-DD'を入れて流用、
--   endpoint_name='/edinet/major-shareholders')という、大量保有報告書と
--   全く同じ方式を踏襲する。詳細な設計理由(なぜステージングテーブルを
--   作らないか等)は14_large_volume_shareholders.sql冒頭コメントを参照
--   (このファイルでは重複説明を省く)。
--
-- 【テーブル構成】
--   EDINET_MAJOR_SHAREHOLDER         … 書類メタ(書類単位で1行)
--   EDINET_MAJOR_SHAREHOLDER_HOLDER  … Hldrs配列(大株主単位。通常上位10名、
--                                       同順位タイで11位以降もあり件数は固定でない)
--
--   子テーブルは親へのFKにON DELETE CASCADEを付けている
--   (提出日単位で親をDELETEするだけで子テーブルも連動して洗い替えられる)。
--
-- 【HLDR_RANKを代理キーではなく自然キーとして使っている理由】
--   大量保有報告書のHLDR_SEQ(配列インデックスの代理キー)と違い、こちらは
--   レスポンスのRank項目自体が「大株主の順位(1〜10、タイで11以降あり)」という
--   書類内で一意な値のため、そのまま主キーの一部に使える。配列インデックスで
--   代理キーを振る必要が無い。
--
-- 【CODEをFK(EQUITY_MASTERへの外部キー)にしている理由・注意点】
--   大量保有報告書と同じ方針で、マスタに存在しない銘柄コード(名証単独上場銘柄等)は
--   書類ごとスキップして報告する(loadInitial.js の processEdinetMajorShareholderDate 参照)。
--
-- 【実データ未確認であることについて】
--   Cowork(Claude)のdevice_bashからapi.jquants.comへの通信がegressで
--   遮断されているため、本DDL・edinetMapper.jsの追加分はAPI仕様書
--   (/spec/edinet-major-shareholders)の記載のみに基づいて設計している。
--   本番投入前に必ず次を実行し、実際のレスポンスが仕様書通りか確認すること:
--     node scripts/inspect-edinet-api.js major-shareholders --date 2025-06-20
--   (仕様書サンプルレスポンスの書類S100YA84の提出日が2026-06-11だが、
--    仕様書のQuery Parameters例にある2025-06-20でもまず試すこと)
--
-- 前提: 01〜04, 14 のDDLを実行済みであること(CODEがEQUITY_MASTERへの
--       外部キーを持つため。14を前提にしているのはLOAD_PROGRESSが
--       共通のテーブルであるため実行順に依存は無いが、Tier4の流れとして
--       14の直後に適用する想定)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. EDINET_MAJOR_SHAREHOLDER (書類メタ。書類単位でDocIdは一意)
--------------------------------------------------------------------------------
CREATE TABLE edinet_major_shareholder (
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
    cur_per_st       DATE,
    cur_per_en       DATE,
    loaded_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_edinet_major_shareholder PRIMARY KEY (doc_id),
    CONSTRAINT fk_edinet_major_shareholder_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE edinet_major_shareholder IS '大株主状況(有報・半期報告書・四半期報告書)の書類メタ(書類単位、DocIdで一意)';
COMMENT ON COLUMN edinet_major_shareholder.doc_id        IS 'EDINET書類管理番号(主キー)(DocId)';
COMMENT ON COLUMN edinet_major_shareholder.code          IS '提出会社の銘柄コード(Code)';
COMMENT ON COLUMN edinet_major_shareholder.edinet_code   IS '提出会社のEDINETコード(EdinetCode)';
COMMENT ON COLUMN edinet_major_shareholder.filer_name    IS '提出者名(会社名)(FilerName)';
COMMENT ON COLUMN edinet_major_shareholder.filer_name_en IS '提出者名(英語)(FilerNameEn)';
COMMENT ON COLUMN edinet_major_shareholder.doc_type_code IS '書類種別コード 120=有価証券報告書/140=四半期報告書/160=半期報告書(DocTypeCode)';
COMMENT ON COLUMN edinet_major_shareholder.sub_date      IS '提出日(SubDate)。取込時はこの日付単位で洗い替えする';
COMMENT ON COLUMN edinet_major_shareholder.sub_time      IS '提出時刻(HH:MM:SS)(SubTime)';
COMMENT ON COLUMN edinet_major_shareholder.per_st        IS '当事業年度の開始日(PerSt)';
COMMENT ON COLUMN edinet_major_shareholder.per_en        IS '当事業年度の終了日(PerEn)';
COMMENT ON COLUMN edinet_major_shareholder.cur_per_st    IS '当会計期間の開始日(CurPerSt)';
COMMENT ON COLUMN edinet_major_shareholder.cur_per_en    IS '当会計期間の終了日(CurPerEn)';
COMMENT ON COLUMN edinet_major_shareholder.loaded_at     IS '取込日時';

CREATE INDEX ix_edinet_major_shareholder_sub_date ON edinet_major_shareholder (sub_date);
CREATE INDEX ix_edinet_major_shareholder_code ON edinet_major_shareholder (code, sub_date);


--------------------------------------------------------------------------------
-- 2. EDINET_MAJOR_SHAREHOLDER_HOLDER (Hldrs配列。大株主単位)
--------------------------------------------------------------------------------
CREATE TABLE edinet_major_shareholder_holder (
    doc_id       VARCHAR2(20 CHAR)  NOT NULL,
    hldr_rank    NUMBER(4)          NOT NULL,  -- Hldrs[].Rank(書類内で一意な自然キー)
    hldr_name    VARCHAR2(400 CHAR),
    hldr_addr    VARCHAR2(400 CHAR),
    shs_held     NUMBER(24,4),
    shs_ratio    NUMBER(12,8),
    loaded_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_edinet_major_shareholder_holder PRIMARY KEY (doc_id, hldr_rank),
    CONSTRAINT fk_edinet_major_shareholder_holder_doc FOREIGN KEY (doc_id)
        REFERENCES edinet_major_shareholder (doc_id) ON DELETE CASCADE
);

COMMENT ON TABLE edinet_major_shareholder_holder IS '大株主明細(Hldrs配列を1行1株主に展開。通常上位10名、タイで11位以降もあり)';
COMMENT ON COLUMN edinet_major_shareholder_holder.doc_id    IS '書類管理番号(親テーブルへのFK)(DocId)';
COMMENT ON COLUMN edinet_major_shareholder_holder.hldr_rank IS '順位。1〜10、同順位タイで11以降あり(Rank)';
COMMENT ON COLUMN edinet_major_shareholder_holder.hldr_name IS '株主氏名又は名称(HldrName)';
COMMENT ON COLUMN edinet_major_shareholder_holder.hldr_addr IS '株主住所(HldrAddr)';
COMMENT ON COLUMN edinet_major_shareholder_holder.shs_held  IS '所有株式数(株)(ShsHeld)';
COMMENT ON COLUMN edinet_major_shareholder_holder.shs_ratio IS '発行済株式(自己株式を除く)に対する所有割合。小数表現(0.1881=18.81%)(ShsRatio)';
COMMENT ON COLUMN edinet_major_shareholder_holder.loaded_at IS '取込日時';

-- 株主名で複数書類を横断的に追う分析用(TO_SINGLE_BYTE()等での名寄せはSQL側で行う)
CREATE INDEX ix_edinet_major_shareholder_holder_name ON edinet_major_shareholder_holder (hldr_name);


--------------------------------------------------------------------------------
-- 3. 分析用ビュー
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_edinet_major_shareholder_detail AS
SELECT
    d.doc_id,
    d.code,
    d.edinet_code,
    d.filer_name,
    d.sub_date,
    d.doc_type_code,
    d.per_st,
    d.per_en,
    d.cur_per_st,
    d.cur_per_en,
    h.hldr_rank,
    h.hldr_name,
    h.hldr_addr,
    h.shs_held,
    h.shs_ratio
FROM edinet_major_shareholder d
JOIN edinet_major_shareholder_holder h ON h.doc_id = d.doc_id;

COMMENT ON TABLE v_edinet_major_shareholder_detail IS '大株主状況を書類×株主単位で1行に展開したビュー';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name LIKE 'EDINET_MAJOR_SHAREHOLDER%'
--  ORDER BY table_name;
--
-- SELECT status, COUNT(*) AS days, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name = '/edinet/major-shareholders'
-- GROUP BY status;
