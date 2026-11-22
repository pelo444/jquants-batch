--------------------------------------------------------------------------------
-- 個別チャート(/stockchart)の「調査対象」の一覧
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のための表か】
--   個別チャートで順に見ていく銘柄を、あらかじめ登録しておく。画面の一覧から選ぶと
--   その銘柄のチャートに切り替わり、前へ・次へで順に送れる。
--   一覧は1つ。並び順は登録した順(ADDED_AT、同じ時刻なら WATCH_ID)。
--
-- 【行の消し方】
--   画面で外した銘柄・全部消した銘柄は行ごと消す(作業用の一覧なので、いつ入れて外したかは残さない。
--   購入検討リストの JNL_CANDIDATE とはここが違う)。
--
-- 設計: Project 文書 claude/stock_chart_design.md
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. 表(GD_JQUANTS)
--------------------------------------------------------------------------------
CREATE TABLE jnl_chart_watch (
    watch_id    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        VARCHAR2(10)  NOT NULL,
    added_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_chart_watch_code_uk UNIQUE (code)
);

COMMENT ON TABLE jnl_chart_watch IS '個別チャート(/stockchart)の調査対象の一覧。並び順は ADDED_AT・WATCH_ID の昇順。外したら行ごと消す';
COMMENT ON COLUMN jnl_chart_watch.code IS '5桁コード(J-Quants と同じ)';
COMMENT ON COLUMN jnl_chart_watch.added_at IS '登録した日時(SYSTIMESTAMP、協定世界時)';

--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS)
--------------------------------------------------------------------------------
GRANT SELECT ON jnl_chart_watch TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行。先に SELECT USER FROM dual;)
--------------------------------------------------------------------------------
-- SELECT USER FROM dual;
CREATE OR REPLACE SYNONYM jnl_chart_watch FOR gd_jquants.jnl_chart_watch;
