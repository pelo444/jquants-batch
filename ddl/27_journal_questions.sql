--------------------------------------------------------------------------------
-- 調べたいこと(/journal の「調べたいこと」タブ)
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のための表か】
--   判断やメモを書いている途中で出てきた「調べたいこと」を書き留め、
--   自分で調べるか Claude に頼むかを決め、答えを同じ行に残す。
--   判断(JNL_DECISION)と違って編集できる(状態・担当・答えは後から変わるもの)。
--
-- 【Claude に頼むときの流れ】(docs/JOURNAL.md)
--   1. 担当を「Claude」にして書く
--   2. Claude に「調べたいことを見て」と頼む。Claude は CLAUDE_RO で
--      ASSIGNEE='CLAUDE' AND STATUS IN ('OPEN','DOING') の行を読み、調べた結果を
--      journal_work/answers.json に書く(長いものは project doc にして ANSWER_REF に名前を入れる)
--   3. 画面の「Claude の回答を取り込む」で、答えが空の行だけに入る(自分で書いた答えは上書きしない)
--
-- 前提: ddl/26_trading_journal.sql を実行済み(JNL_DECISION・JNL_NOTE がある)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 表
--------------------------------------------------------------------------------

CREATE TABLE jnl_question (
    question_id   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asked_date    DATE                NOT NULL,
    question      VARCHAR2(2000 CHAR) NOT NULL,
    background    VARCHAR2(4000 CHAR),
    codes         VARCHAR2(400),
    decision_id   NUMBER              REFERENCES jnl_decision (decision_id),
    note_id       NUMBER              REFERENCES jnl_note (note_id) ON DELETE SET NULL,
    assignee      VARCHAR2(10)        NOT NULL,
    status        VARCHAR2(10)        DEFAULT 'OPEN' NOT NULL,
    priority      NUMBER(1)           DEFAULT 2 NOT NULL,
    answer        CLOB,
    answer_ref    VARCHAR2(1000 CHAR),
    answered_by   VARCHAR2(10),
    answered_at   TIMESTAMP,
    created_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_question_assignee_ck CHECK (assignee IN ('SELF', 'CLAUDE')),
    CONSTRAINT jnl_question_status_ck CHECK (status IN ('OPEN', 'DOING', 'DONE', 'DROPPED')),
    CONSTRAINT jnl_question_priority_ck CHECK (priority BETWEEN 1 AND 3),
    CONSTRAINT jnl_question_answered_by_ck CHECK (answered_by IN ('SELF', 'CLAUDE'))
);

CREATE INDEX jnl_question_status_ix ON jnl_question (status, assignee);
CREATE INDEX jnl_question_decision_ix ON jnl_question (decision_id);
CREATE INDEX jnl_question_note_ix ON jnl_question (note_id);

COMMENT ON TABLE jnl_question IS '調べたいこと。判断やメモを書く途中で出た問いと、その答え。編集可';
COMMENT ON COLUMN jnl_question.question IS '何を知りたいか(1つの行に1つの問い)';
COMMENT ON COLUMN jnl_question.background IS 'なぜ知りたいか・答えをどう使うか(調べる範囲を決めるため)';
COMMENT ON COLUMN jnl_question.codes IS '関連銘柄の5桁コード(カンマ区切り)';
COMMENT ON COLUMN jnl_question.decision_id IS 'この問いが出た判断(任意)';
COMMENT ON COLUMN jnl_question.note_id IS 'この問いが出たメモ(任意。メモを消すと NULL になる)';
COMMENT ON COLUMN jnl_question.assignee IS 'SELF=自分で調べる、CLAUDE=Claude に頼む';
COMMENT ON COLUMN jnl_question.status IS 'OPEN=未着手、DOING=調査中、DONE=答えが出た、DROPPED=調べないことにした';
COMMENT ON COLUMN jnl_question.priority IS '1=高、2=中、3=低';
COMMENT ON COLUMN jnl_question.answer IS '答え。Claude の答えは画面の取込で、空の行にだけ入る';
COMMENT ON COLUMN jnl_question.answer_ref IS '答えの出典・詳細の置き場所(URL、project doc 名など)';


--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS で実行)
--------------------------------------------------------------------------------

GRANT SELECT ON jnl_question TO claude_ro;


--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行)
--   先に SELECT USER FROM dual; で CLAUDE_RO であることを確認する
--------------------------------------------------------------------------------

-- SELECT USER FROM dual;

CREATE OR REPLACE SYNONYM jnl_question FOR gd_jquants.jnl_question;
