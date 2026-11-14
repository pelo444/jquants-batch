--------------------------------------------------------------------------------
-- 判断(JNL_DECISION)の「理由の分類」に SHALLOW(深堀り不足)を足す
-- 実行ユーザー: GD_JQUANTS(列もオブジェクトも増えないので、CLAUDE_RO への GRANT は不要)
--
-- 【なぜ】
--   調べ方が足りないまま買った・売ったことを、後から数えられるようにするため。
--   既存の分類は「何を見て決めたか」で、「決め方そのものが足りなかった」を書く先が無かった。
--
-- 【既存の行】
--   影響なし。制約を作り直すだけで、入っている値は変わらない。
--
-- 【画面側】
--   src/web/journalQuery.js の REASONS と src/web/public/journal.js の LABELS.reason に
--   同じ値がある。片方だけ変えると、画面で選べても保存でエラーになる(またはその逆)。
--------------------------------------------------------------------------------
ALTER TABLE jnl_decision DROP CONSTRAINT jnl_decision_reason_ck;

ALTER TABLE jnl_decision ADD CONSTRAINT jnl_decision_reason_ck CHECK (reason_cat IN (
    'EARNINGS', 'DIP', 'MOMENTUM', 'NEWS', 'THEME', 'VALUE', 'DIVIDEND',
    'RECOMMEND', 'REBALANCE', 'STOPLOSS', 'TAKEPROFIT', 'SHALLOW', 'OTHER'));

COMMENT ON COLUMN jnl_decision.reason_cat IS '理由の分類。SHALLOW=深堀り不足(2026-11-15 追加)';
