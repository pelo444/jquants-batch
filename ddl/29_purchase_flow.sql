--------------------------------------------------------------------------------
-- 銘柄購入の流れ(購入検討リスト → 参考情報 → 損失回避チェック → 判断メモ)
-- 実行ユーザー: 1〜4節は GD_JQUANTS、5節は CLAUDE_RO
--
-- 【何のための表か】
--   Web の購入の流れ(設計は claude/purchase_flow_design.md)で、数日〜1週間かけて
--   検討する途中の状態と、判断した時点に見ていた値を残す。
--
-- 【表の構成】
--   JNL_CANDIDATE_LIST     購入検討リスト(名前付き・複数)。終えたリストも消さず CLOSED_AT を入れる
--   JNL_CANDIDATE          リストの中の銘柄。外しても行は消さず REMOVED_AT を入れる。
--                          同じリストで外していない同じ銘柄は1行だけ(一意索引)。外した後に
--                          入れ直すと新しい行になる(いつ入れて、いつ外したかが残る)。
--                          上限(1リスト20銘柄)は画面側で確認する
--   JNL_CHECK_RUN          損失回避チェックの「答えを保存」1回分。入力(総額・損切り幅・買値)を持つ。
--                          保存のたびに新しい行(上書きしない)。開き直すと最新の行の答えを読む
--   JNL_CHECK_ANSWER       人が判断する問いへの答え(RUN × 銘柄 × 問い)
--   JNL_DECISION_SNAPSHOT  判断メモを登録した時点の F・T の値と Ch10 の値(JSON)。
--                          JNL_DECISION は追記専用で列を足さないため別表にした
--
-- 【実行順序】
--   1〜4節を GD_JQUANTS で実行する。5節は CLAUDE_RO で接続し直して実行する
--   (GD_JQUANTS のままだと ORA-01471)。
--
-- 前提: ddl/26_trading_journal.sql(JNL_DECISION)を実行済み。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 購入検討リスト
--------------------------------------------------------------------------------

CREATE TABLE jnl_candidate_list (
    list_id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    list_name   VARCHAR2(100 CHAR)  NOT NULL,
    note        VARCHAR2(1000 CHAR),
    created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    closed_at   TIMESTAMP,
    CONSTRAINT jnl_candidate_list_name_uk UNIQUE (list_name)
);

COMMENT ON TABLE jnl_candidate_list IS '購入検討リスト(名前付き・複数)。検討を終えたら CLOSED_AT を入れる(行は消さない。プルダウンにも出し続ける)';
COMMENT ON COLUMN jnl_candidate_list.closed_at IS '検討を終えた日時。NULL = 検討中';

CREATE TABLE jnl_candidate (
    cand_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    list_id       NUMBER              NOT NULL REFERENCES jnl_candidate_list (list_id),
    code          VARCHAR2(10)        NOT NULL,
    added_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    added_from    VARCHAR2(10)        NOT NULL,
    added_detail  VARCHAR2(100 CHAR),
    removed_at    TIMESTAMP,
    note          VARCHAR2(500 CHAR),
    CONSTRAINT jnl_candidate_from_ck CHECK (added_from IN ('SECTOR', 'TAG', 'MANUAL'))
);

-- 外していない行だけで (LIST_ID, CODE) を一意にする(外した行は何行あってもよい)
CREATE UNIQUE INDEX jnl_candidate_active_uk ON jnl_candidate (
    CASE WHEN removed_at IS NULL THEN list_id END,
    CASE WHEN removed_at IS NULL THEN code END);

CREATE INDEX jnl_candidate_list_ix ON jnl_candidate (list_id, removed_at);

COMMENT ON TABLE jnl_candidate IS 'リストの中の銘柄。外しても行は消さず REMOVED_AT を入れる。上限20銘柄は画面側で確認';
COMMENT ON COLUMN jnl_candidate.code IS '5桁コード(J-Quants と同じ)';
COMMENT ON COLUMN jnl_candidate.added_from IS 'どこから追加したか。SECTOR=33業種の一覧、TAG=タグの一覧、MANUAL=手入力';
COMMENT ON COLUMN jnl_candidate.added_detail IS '追加元の詳細。SECTOR なら33業種コード、TAG ならタグ名(MANUAL は NULL)';
COMMENT ON COLUMN jnl_candidate.removed_at IS 'リストから外した日時。NULL = リストに入っている';


--------------------------------------------------------------------------------
-- 2. 損失回避チェックの答え
--------------------------------------------------------------------------------

CREATE TABLE jnl_check_run (
    run_id           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    list_id          NUMBER              NOT NULL REFERENCES jnl_candidate_list (list_id),
    codes            VARCHAR2(100)       NOT NULL,
    amount_yen       NUMBER,
    swing_yen        NUMBER,
    stop_pcts        VARCHAR2(50),
    buy_prices_json  CLOB,
    run_at           TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_check_run_buy_ck CHECK (buy_prices_json IS JSON)
);

CREATE INDEX jnl_check_run_list_ix ON jnl_check_run (list_id, run_at);

COMMENT ON TABLE jnl_check_run IS '損失回避チェックの「答えを保存」1回分。保存のたびに新しい行(上書きしない)';
COMMENT ON COLUMN jnl_check_run.codes IS 'チェックした銘柄の5桁コード(カンマ区切り、最大5銘柄)';
COMMENT ON COLUMN jnl_check_run.amount_yen IS '総額(円)';
COMMENT ON COLUMN jnl_check_run.swing_yen IS '1週で動いてよい額(円)';
COMMENT ON COLUMN jnl_check_run.stop_pcts IS '損切り幅(%、カンマ区切り。例 10,15)';
COMMENT ON COLUMN jnl_check_run.buy_prices_json IS '銘柄ごとの買値(円)。例 {"99990": 4820}';

CREATE TABLE jnl_check_answer (
    run_id       NUMBER              NOT NULL REFERENCES jnl_check_run (run_id),
    code         VARCHAR2(10)        NOT NULL,
    question_id  VARCHAR2(20)        NOT NULL,
    answer       VARCHAR2(2000 CHAR),
    CONSTRAINT jnl_check_answer_pk PRIMARY KEY (run_id, code, question_id)
);

COMMENT ON TABLE jnl_check_answer IS '損失回避チェックの「人が判断する問い」への答え(RUN × 銘柄 × 問い)';
COMMENT ON COLUMN jnl_check_answer.question_id IS '問いの番号。Ch番号-連番(例 Ch1-1 = 次の行動への条件)。番号と文言の対応は src/lossChecks.js';


--------------------------------------------------------------------------------
-- 3. 判断した時点の値
--------------------------------------------------------------------------------

CREATE TABLE jnl_decision_snapshot (
    decision_id  NUMBER              PRIMARY KEY REFERENCES jnl_decision (decision_id),
    list_id      NUMBER              REFERENCES jnl_candidate_list (list_id),
    run_id       NUMBER              REFERENCES jnl_check_run (run_id),
    payload      CLOB                NOT NULL,
    created_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_decision_snapshot_ck CHECK (payload IS JSON)
);

COMMENT ON TABLE jnl_decision_snapshot IS '判断メモを登録した時点の F・T の値と Ch10 の値(JSON)。決算・株価は後で更新されるため、判断時に見ていた値はここにしか残らない';
COMMENT ON COLUMN jnl_decision_snapshot.payload IS '{"asOf": 基準日, "F": {...}, "T": {...}, "ch10": {...}}。中身の形は画面側(src/web)が決める';


--------------------------------------------------------------------------------
-- 4. CLAUDE_RO への権限(GD_JQUANTS で実行)
--------------------------------------------------------------------------------

GRANT SELECT ON jnl_candidate_list    TO claude_ro;
GRANT SELECT ON jnl_candidate         TO claude_ro;
GRANT SELECT ON jnl_check_run         TO claude_ro;
GRANT SELECT ON jnl_check_answer      TO claude_ro;
GRANT SELECT ON jnl_decision_snapshot TO claude_ro;


--------------------------------------------------------------------------------
-- 5. シノニム(CLAUDE_RO で接続し直して実行)
--   先に SELECT USER FROM dual; で CLAUDE_RO であることを確認する
--------------------------------------------------------------------------------

-- SELECT USER FROM dual;

CREATE OR REPLACE SYNONYM jnl_candidate_list    FOR gd_jquants.jnl_candidate_list;
CREATE OR REPLACE SYNONYM jnl_candidate         FOR gd_jquants.jnl_candidate;
CREATE OR REPLACE SYNONYM jnl_check_run         FOR gd_jquants.jnl_check_run;
CREATE OR REPLACE SYNONYM jnl_check_answer      FOR gd_jquants.jnl_check_answer;
CREATE OR REPLACE SYNONYM jnl_decision_snapshot FOR gd_jquants.jnl_decision_snapshot;
