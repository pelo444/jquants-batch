--------------------------------------------------------------------------------
-- 判断(JNL_DECISION)とメモ(JNL_NOTE)の「情報源」に POLICY(基本方針)を足す
-- 実行ユーザー: GD_JQUANTS(列もオブジェクトも増えないので、CLAUDE_RO への GRANT は不要)
--
-- 【なぜ】
--   その場で見聞きしたことではなく、前もって決めておいた自分の方針にもとづく判断・メモを
--   区別するため。既存の分類は外から入ってきた情報の出どころで、自分の方針を書く先が無かった。
--
-- 【既存の行】
--   影響なし。制約を作り直すだけで、入っている値は変わらない。
--
-- 【画面側】
--   src/web/journalQuery.js の SOURCES と src/web/public/journal.js の LABELS.source に
--   同じ値がある。片方だけ変えると、画面で選べても保存でエラーになる(またはその逆)。
--------------------------------------------------------------------------------
ALTER TABLE jnl_decision DROP CONSTRAINT jnl_decision_source_ck;

ALTER TABLE jnl_decision ADD CONSTRAINT jnl_decision_source_ck CHECK (idea_source IN (
    'OWN_SCREEN', 'POLICY', 'NEWS', 'SNS', 'DISCLOSURE', 'MEDIA', 'PERSON', 'APP', 'OTHER'));

ALTER TABLE jnl_note DROP CONSTRAINT jnl_note_source_ck;

ALTER TABLE jnl_note ADD CONSTRAINT jnl_note_source_ck CHECK (idea_source IN (
    'OWN_SCREEN', 'POLICY', 'NEWS', 'SNS', 'DISCLOSURE', 'MEDIA', 'PERSON', 'APP', 'OTHER'));

COMMENT ON COLUMN jnl_decision.idea_source IS '情報源。POLICY=基本方針(2026-11-15 追加)';
COMMENT ON COLUMN jnl_note.idea_source IS '情報源。POLICY=基本方針(2026-11-15 追加)';
