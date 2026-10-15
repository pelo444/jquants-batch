--------------------------------------------------------------------------------
-- 売買記録から作るタグ(騰落率一覧・chart.js・需給画面で使える)
-- 実行ユーザー: GD_JQUANTS
--
-- 【何のための表か】
--   売買記録(/journal)の約定・判断から、次の3つのタグを自動で付け直す。
--     jnl_held           保有中           約定から計算した保有(現物・信用買)が残っている銘柄
--     jnl_held_past      過去に保有       約定はあるが、今は保有していない銘柄
--     jnl_passed         見送った銘柄     判断で「見送り」にした銘柄(訂正済みの判断は除く。後で買っても残る)
--   付け直しは画面側(src/web/journalTags.js)が行う。約定の取込・判断の記録のたびに自動、
--   保有タブの「タグを更新」でも手動で実行できる。
--
-- 【手で付けないこと】
--   この3つのタグの FAVORITE_TAG は、付け直しのたびに約定・判断と同じ内容に揃える
--   (足りない行を足し、余分な行を消す)。手で足した行は次の付け直しで消える。
--   手で管理したい銘柄は別のタグ(sheres_held など)を使う。
--
-- 【画面での並び】
--   THEME 型(番号なし)だが MAJOR_LABEL_JA に「売買記録」を入れてあり、騰落率一覧では
--   「テーマ(番号なし)」とは別のグループとして表示される(app.js の renderTagGroups)。
--
-- 前提: ddl/05_tag_master.sql(TAG_MASTER)、ddl/26_trading_journal.sql を実行済み。
--------------------------------------------------------------------------------

MERGE INTO tag_master t
USING (
    SELECT 'jnl_held' AS tag_name, '保有中' AS tag_label_ja,
           '売買記録の約定から計算した保有(現物・信用買)が残っている銘柄。/journal が自動で付け直す。手で付けないこと' AS description
    FROM dual
    UNION ALL
    SELECT 'jnl_held_past', '過去に保有',
           '売買記録に約定があるが、今は保有していない銘柄。/journal が自動で付け直す。手で付けないこと'
    FROM dual
    UNION ALL
    SELECT 'jnl_passed', '見送った銘柄',
           '売買記録の判断で「見送り」にした銘柄(訂正済みの判断は除く。後で買っても残る)。/journal が自動で付け直す。手で付けないこと'
    FROM dual
) s
ON (t.tag_name = s.tag_name)
WHEN MATCHED THEN UPDATE SET
    t.tag_label_ja   = s.tag_label_ja,
    t.description    = s.description,
    t.major_label_ja = '売買記録',
    t.is_active      = 1,
    t.updated_at     = SYSTIMESTAMP
WHEN NOT MATCHED THEN INSERT (tag_name, tag_type, tag_code, major_code, major_label_ja, tag_label_ja, description, is_active)
    VALUES (s.tag_name, 'THEME', NULL, NULL, '売買記録', s.tag_label_ja, s.description, 1);

COMMIT;

-- 確認
-- SELECT tag_name, tag_type, major_label_ja, tag_label_ja FROM tag_master WHERE tag_name LIKE 'jnl\_%' ESCAPE '\';
