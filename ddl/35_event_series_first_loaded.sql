--------------------------------------------------------------------------------
-- 材料(/events)の数字が「初めて入った時刻」を残す列
-- 実行ユーザー: GD_JQUANTS(CLAUDE_RO の権限・シノニムは表単位なので追加は不要)
--
-- 【何のための列か】
--   元のサイトでいつ頃更新されるか(src/eventSchedule.js)が合っているかを、後から確かめるため。
--   既存の LOADED_AT は値が変わるたびに書き換わるので、初めて入った時刻が分からない。
--   取込は VM の cron で日本時間 7:30 と 14:00 の1日2回なので、分かるのは「どの回で初めて入ったか」まで。
--
-- 【既存の行】
--   NULL のまま(初回投入でまとめて入れた行で、元のサイトの更新時刻とは関係が無いため)。
--
-- 【時刻帯】
--   LOADED_AT と同じく SYSTIMESTAMP(ATP では協定世界時)。画面で日本時間に直す。
--
-- 設計: Project 文書 claude/event_calendar_design.md
--------------------------------------------------------------------------------
ALTER TABLE ext_series_daily ADD (first_loaded_at TIMESTAMP);

COMMENT ON COLUMN ext_series_daily.first_loaded_at IS 'この日の値が初めて入った時刻(協定世界時)。2026-10 の初回投入分は NULL';
COMMENT ON COLUMN ext_series_daily.loaded_at IS '値が最後に入った・変わった時刻(協定世界時)';
