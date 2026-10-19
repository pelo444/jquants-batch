--------------------------------------------------------------------------------
-- 日々の確認(/daily)の「確認した」日時
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のための表か】
--   日々の確認の画面は「前回確認した日時から今まで」に入ったデータを出す。
--   画面の主ボタン「確認した」を押すたびに1行足す。一番新しい SEEN_AT が「前回確認した日時」。
--   行は消さない(いつ見たかの記録として残す)。
--
-- 【時刻】
--   SEEN_AT は DB の SYSTIMESTAMP(協定世界時)。各表の LOADED_AT も同じ時計なので、
--   「前回確認のあとに取り込まれた行」を DB の中で比べられる。画面には日本時間に直して出す。
--
-- 設計: Project 文書 claude/daily_page_design.md
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. 表(GD_JQUANTS)
--------------------------------------------------------------------------------
CREATE TABLE jnl_daily_seen (
    seen_id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seen_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX jnl_daily_seen_at_ix ON jnl_daily_seen (seen_at);

COMMENT ON TABLE jnl_daily_seen IS '日々の確認(/daily)で「確認した」を押した日時。一番新しい行が前回確認した日時';
COMMENT ON COLUMN jnl_daily_seen.seen_at IS '押した日時(SYSTIMESTAMP、協定世界時)。各表の LOADED_AT と比べる';

--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS)
--------------------------------------------------------------------------------
GRANT SELECT ON jnl_daily_seen TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行。先に SELECT USER FROM dual;)
--------------------------------------------------------------------------------
-- SELECT USER FROM dual;
CREATE OR REPLACE SYNONYM jnl_daily_seen FOR gd_jquants.jnl_daily_seen;
