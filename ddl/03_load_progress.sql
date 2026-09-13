--------------------------------------------------------------------------------
-- 初回投入バッチ 進捗管理テーブル DDL
-- 対象: Oracle Database 19c / OCI Autonomous Database (ATP)
-- 実行ユーザー: GD_JQUANTS
--
-- 設計方針:
--   ・Bulk API(/v2/bulk/list, /v2/bulk/get)から取得できるファイル単位(Key)で
--     進捗を管理する。銘柄単位・日付単位ではなく「ファイル単位」なので、
--     historical(月次)・live(日次)を問わず同じ構造で扱える。
--   ・再実行時は、STATUS='SUCCESS'のKeyをスキップして未処理分だけ処理する
--     ことで、途中失敗からの再開が自然に実現できる。
--------------------------------------------------------------------------------

CREATE TABLE load_progress (
    endpoint_name    VARCHAR2(100)   NOT NULL,   -- 例: '/equities/bars/daily'
    file_key         VARCHAR2(500)   NOT NULL,   -- bulk/listのKey(例: 'equities/bars/daily/historical/2026/equities_bars_daily_202607.csv.gz')
    status           VARCHAR2(20)    DEFAULT 'PENDING' NOT NULL,  -- PENDING / SUCCESS / FAILED
    row_count        NUMBER,
    started_at       TIMESTAMP,
    finished_at      TIMESTAMP,
    error_message    VARCHAR2(4000),
    updated_at       TIMESTAMP       DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_load_progress PRIMARY KEY (endpoint_name, file_key),
    CONSTRAINT ck_load_progress_status CHECK (status IN ('PENDING','SUCCESS','FAILED'))
);

COMMENT ON TABLE load_progress IS '初回投入バッチ(Bulk API)のファイル単位の進捗管理。再実行時はSUCCESS済みKeyをスキップする';
COMMENT ON COLUMN load_progress.endpoint_name  IS '対象エンドポイント名(bulk/listのendpointパラメータと同じ値)';
COMMENT ON COLUMN load_progress.file_key       IS 'bulk/listで得られるファイルのKey(一意識別子)';
COMMENT ON COLUMN load_progress.status         IS '処理状態(PENDING=未処理 / SUCCESS=成功 / FAILED=失敗)';
COMMENT ON COLUMN load_progress.row_count      IS 'そのファイルから読み込んだ行数';
COMMENT ON COLUMN load_progress.started_at     IS '処理開始日時';
COMMENT ON COLUMN load_progress.finished_at    IS '処理終了日時(成功・失敗いずれも記録)';
COMMENT ON COLUMN load_progress.error_message  IS '失敗時のエラーメッセージ';
COMMENT ON COLUMN load_progress.updated_at     IS 'レコード更新日時';

-- 未処理・失敗分だけを素早く抽出するためのインデックス
CREATE INDEX ix_load_progress_status ON load_progress (endpoint_name, status);

--------------------------------------------------------------------------------
-- 想定される運用クエリ
--------------------------------------------------------------------------------
-- 未処理のファイル一覧を取得(バッチ起動時に bulk/list の結果と突き合わせて使用):
--   SELECT file_key FROM load_progress
--   WHERE endpoint_name = '/equities/bars/daily' AND status = 'SUCCESS';
--   → bulk/list の結果からこの一覧に無い Key だけを処理対象とする
--
-- 処理開始時に PENDING で登録(MERGEで冪等に):
--   MERGE INTO load_progress t
--   USING (SELECT '/equities/bars/daily' AS endpoint_name, :file_key AS file_key FROM dual) s
--   ON (t.endpoint_name = s.endpoint_name AND t.file_key = s.file_key)
--   WHEN NOT MATCHED THEN
--     INSERT (endpoint_name, file_key, status, started_at)
--     VALUES (s.endpoint_name, s.file_key, 'PENDING', SYSTIMESTAMP);
--
-- 成功時:
--   UPDATE load_progress
--   SET status = 'SUCCESS', row_count = :row_count, finished_at = SYSTIMESTAMP,
--       updated_at = SYSTIMESTAMP
--   WHERE endpoint_name = :endpoint_name AND file_key = :file_key;
--
-- 失敗時:
--   UPDATE load_progress
--   SET status = 'FAILED', error_message = :error_message, finished_at = SYSTIMESTAMP,
--       updated_at = SYSTIMESTAMP
--   WHERE endpoint_name = :endpoint_name AND file_key = :file_key;
