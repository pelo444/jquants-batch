--------------------------------------------------------------------------------
-- FAVORITE_MASTER の監視フラグをタグから一括登録する
--
-- 実行ユーザー: GD_JQUANTS
--   ※ claude-query.js (CLAUDE_RO) では実行できない。SELECT専用のため。
--
-- 何をするか:
--   FAVORITE_TAG.TAG_NAME = 'sheres_held' の銘柄を FAVORITE_MASTER に
--   IS_WATCHING = 1 で登録する。行が無ければ INSERT、あれば UPDATE。
--
-- なぜ MERGE か:
--   FAVORITE_MASTER は主キーが CODE の1行1銘柄で、IS_WATCHING 以外に
--   IS_BUY_CANDIDATE や REF_NOTE1〜4 を持つ。既に行がある銘柄を INSERT で
--   上書きすると、手で書いたメモが消える。既存行は IS_WATCHING だけを
--   更新し、他の列には触らない。
--
-- 追加であり、同期ではない:
--   タグから外れた銘柄の IS_WATCHING は 0 に戻らない。
--   タグと完全に一致させたい場合は 付録A も実行する。
--
-- タグ名を変えるとき:
--   このファイル内の 'sheres_held' を全置換する（STEP 0/1/2/3 と付録Aに出てくる）。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- STEP 0. タグ名の確認
--
-- タグ名は FAVORITE_TAG.TAG_NAME → TAG_MASTER.TAG_NAME の外部キーなので、
-- TAG_MASTER 側にも同じ綴りで存在しているはず。ここが 0 件なら綴り違い。
--------------------------------------------------------------------------------
SELECT m.tag_name, m.tag_type, m.tag_label_ja, m.is_active,
       (SELECT COUNT(*) FROM favorite_tag t WHERE t.tag_name = m.tag_name) AS codes_cnt
FROM tag_master m
WHERE m.tag_name = 'sheres_held';


--------------------------------------------------------------------------------
-- STEP 1. 登録前の確認（対象銘柄と、いまの FAVORITE_MASTER の状態）
--
-- ACTION 列の読み方:
--   INSERT … FAVORITE_MASTER に行が無い（新規追加される）
--   UPDATE … 行はあるが IS_WATCHING <> 1（1に変わる）
--   KEEP   … 既に IS_WATCHING = 1（何も変わらない）
--------------------------------------------------------------------------------
SELECT t.code,
       em.co_name,
       em.market_name,
       em.sector33_name,
       em.delisted_flag,
       f.is_watching      AS is_watching_now,
       f.is_buy_candidate AS is_buy_candidate_now,
       CASE WHEN f.code IS NULL   THEN 'INSERT'
            WHEN f.is_watching = 1 THEN 'KEEP'
            ELSE 'UPDATE' END AS action
FROM (SELECT DISTINCT code FROM favorite_tag WHERE tag_name = 'sheres_held') t
LEFT JOIN equity_master  em ON em.code = t.code
LEFT JOIN favorite_master f ON f.code  = t.code
ORDER BY action, t.code;


--------------------------------------------------------------------------------
-- STEP 2. 登録（MERGE）
--
-- ・DISTINCT は必須ではない（FAVORITE_TAG は UNIQUE(code, tag_name) なので
--   1タグ内で重複しない）が、USING 側が1銘柄1行であることを明示しておく。
--   MERGE は同一行を2度更新すると ORA-30926 で落ちるため、ここは崩さない。
-- ・UPDATE 側の WHERE は「既に 1 の行の UPDATED_AT を無意味に動かさない」ため。
-- ・REF_NOTE1 は新規行にだけ出所を残す。既存行のメモは書き換えない。
--   メモを付けたくない場合は下の 'tag:sheres_held' を NULL に変える。
--------------------------------------------------------------------------------
MERGE INTO favorite_master tgt
USING (
    SELECT DISTINCT code
    FROM favorite_tag
    WHERE tag_name = 'sheres_held'
) src
ON (tgt.code = src.code)
WHEN MATCHED THEN
    UPDATE SET tgt.is_watching = 1,
               tgt.updated_at  = SYSTIMESTAMP
    WHERE tgt.is_watching <> 1
WHEN NOT MATCHED THEN
    INSERT (code, is_watching, is_buy_candidate, ref_note1)
    VALUES (src.code, 1, 0, 'tag:sheres_held');


--------------------------------------------------------------------------------
-- STEP 3. 登録後の確認（COMMIT する前に見る）
--
-- 1本目: 件数の突き合わせ。TAGGED と WATCHING が一致していること。
--        （付録Aを実行していない場合、タグ以外の銘柄を手で監視にしていれば
--          WATCHING の方が多くなる。その差は WATCHING_NOT_TAGGED に出る）
--------------------------------------------------------------------------------
SELECT (SELECT COUNT(DISTINCT code) FROM favorite_tag
        WHERE tag_name = 'sheres_held')                     AS tagged,
       (SELECT COUNT(*) FROM favorite_master
        WHERE is_watching = 1)                              AS watching,
       (SELECT COUNT(*) FROM favorite_master f
        WHERE f.is_watching = 1
          AND NOT EXISTS (SELECT 1 FROM favorite_tag t
                          WHERE t.code = f.code
                            AND t.tag_name = 'sheres_held')) AS watching_not_tagged,
       (SELECT COUNT(*) FROM favorite_tag t
        WHERE t.tag_name = 'sheres_held'
          AND NOT EXISTS (SELECT 1 FROM favorite_master f
                          WHERE f.code = t.code
                            AND f.is_watching = 1))         AS tagged_not_watching
FROM dual;

-- 2本目: 監視銘柄の一覧（demand_watchlist_sheet.sql の 1 と同じ形）
SELECT f.code, em.co_name, em.market_name, em.sector33_name,
       f.is_watching, f.is_buy_candidate, f.ref_note1
FROM favorite_master f
LEFT JOIN equity_master em ON em.code = f.code
WHERE f.is_watching = 1
ORDER BY f.code;


--------------------------------------------------------------------------------
-- STEP 4. 確定
--------------------------------------------------------------------------------
COMMIT;

-- STEP 3 の結果がおかしければ COMMIT の代わりに:
-- ROLLBACK;


--------------------------------------------------------------------------------
-- 付録A. タグと完全に同期させる（タグから外れた銘柄の監視を解除する）
--
-- STEP 2 は追加しかしない。タグを正とし、タグに無い銘柄の IS_WATCHING を
-- 0 に落としたい場合だけ実行する。行は消さない（メモや買い候補フラグを
-- 残すため）。
--------------------------------------------------------------------------------
-- UPDATE favorite_master f
--    SET f.is_watching = 0,
--        f.updated_at  = SYSTIMESTAMP
--  WHERE f.is_watching = 1
--    AND NOT EXISTS (SELECT 1 FROM favorite_tag t
--                    WHERE t.code = f.code
--                      AND t.tag_name = 'sheres_held');
-- COMMIT;


--------------------------------------------------------------------------------
-- 付録B. TAG_MASTER に 'sheres_held' の定義が無い場合
--
-- 2026-09-13 時点で、このタグの定義は ddl/ のどのファイルにも入っていない
-- （リポジトリを grep して確認）。DBに直接 INSERT したものと思われる。
-- このままだと DB を作り直したときに復元できないので、ddl/20_*.sql として
-- 下記を残しておくこと（05〜07 と同じ MERGE 形式。重複実行しても安全）。
--
-- 番号を持たないタグは tag_type='THEME'、tag_code/major_code は NULL
-- （ddl/05_tag_master.sql の ck_tag_master_code_rule）。
--------------------------------------------------------------------------------
-- MERGE INTO tag_master t
-- USING (
--     SELECT 'sheres_held' AS tag_name, 'THEME' AS tag_type,
--            CAST(NULL AS VARCHAR2(3 CHAR)) AS tag_code,
--            CAST(NULL AS VARCHAR2(3 CHAR)) AS major_code,
--            CAST(NULL AS VARCHAR2(100 CHAR)) AS major_label_ja,
--            '保有銘柄' AS tag_label_ja,
--            '自分が現に保有している銘柄。値動きの要因による分類ではなく保有状態を表すフラグとして使う。FAVORITE_MASTER.IS_WATCHING の供給元。' AS description
--     FROM dual
-- ) s
-- ON (t.tag_name = s.tag_name)
-- WHEN MATCHED THEN UPDATE SET
--     t.tag_type       = s.tag_type,
--     t.tag_label_ja   = s.tag_label_ja,
--     t.description    = s.description,
--     t.updated_at     = SYSTIMESTAMP
-- WHEN NOT MATCHED THEN INSERT (
--     tag_name, tag_type, tag_code, major_code, major_label_ja, tag_label_ja, description
-- ) VALUES (
--     s.tag_name, s.tag_type, s.tag_code, s.major_code, s.major_label_ja, s.tag_label_ja, s.description
-- );
-- COMMIT;
