--------------------------------------------------------------------------------
-- FAVORITE_MASTER に銘柄を手で登録する（コードを直接指定する版）
--
-- 実行ユーザー: GD_JQUANTS
--   ※ claude-query.js (CLAUDE_RO) では実行できない。SELECT専用のため。
--
-- 使い分け:
--   タグ(sheres_held 等)から一括で監視にする → favorite_master_set_watching_by_tag.sql
--   タグに関係なく個別に足す/フラグを変える   → このファイル
--
-- 編集するのは STEP 1〜2 の src ブロック（3か所とも同じ内容にする）だけ。
--   code             … 4桁でも5桁でもよい（'7203' → '72030' に自動変換）
--   is_watching      … 1/0。NULL なら既存値を変えない（新規行は 0）
--   is_buy_candidate … 1/0。NULL なら既存値を変えない（新規行は 0）
--   note             … REF_NOTE1 に入れるメモ。既存行は REF_NOTE1 が空のときだけ書く
--
-- なぜ INSERT ではなく MERGE か:
--   FAVORITE_MASTER は主キーが CODE の1行1銘柄。既に行がある銘柄を INSERT すると
--   ORA-00001 で落ち、DELETE→INSERT にすると REF_NOTE1〜4 の手書きメモが消える。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- STEP 1. 登録前の確認
--
-- 見るところ:
--   co_name が NULL        … コード違い（EQUITY_MASTER に無い → STEP 2 で FK 違反）
--   delisted_flag = 'Y'    … 上場廃止銘柄
--   action                 … INSERT(新規) / UPDATE(既存行のフラグ変更) / KEEP(変化なし)
--------------------------------------------------------------------------------
WITH src_raw AS (
    --     code     is_watching  is_buy_candidate  note
    SELECT '7203' AS code, 1 AS is_watching, NULL AS is_buy_candidate, 'メモ例' AS note FROM dual UNION ALL
    SELECT '285A',         1,                1,                         NULL             FROM dual
),
src AS (
    SELECT CASE WHEN LENGTH(TRIM(code)) = 4 THEN UPPER(TRIM(code)) || '0'
                ELSE UPPER(TRIM(code)) END AS code,
           is_watching, is_buy_candidate, note
    FROM src_raw
)
SELECT s.code,
       em.co_name,
       em.market_name,
       em.delisted_flag,
       f.is_watching      AS is_watching_now,
       s.is_watching      AS is_watching_new,
       f.is_buy_candidate AS is_buy_candidate_now,
       s.is_buy_candidate AS is_buy_candidate_new,
       f.ref_note1        AS ref_note1_now,
       CASE WHEN em.code IS NULL THEN 'ERROR:NO_EQUITY'
            WHEN f.code  IS NULL THEN 'INSERT'
            WHEN NVL(s.is_watching, f.is_watching)           = f.is_watching
             AND NVL(s.is_buy_candidate, f.is_buy_candidate) = f.is_buy_candidate
             AND (f.ref_note1 IS NOT NULL OR s.note IS NULL) THEN 'KEEP'
            ELSE 'UPDATE' END AS action
FROM src s
LEFT JOIN equity_master   em ON em.code = s.code
LEFT JOIN favorite_master f  ON f.code  = s.code
ORDER BY action, s.code;


--------------------------------------------------------------------------------
-- STEP 2. 登録（MERGE）
--
-- ・equity_master に INNER JOIN しているので、コード違いの行はエラーにならず
--   黙ってスキップされる。STEP 1 で ERROR:NO_EQUITY が無いことを先に確かめる。
-- ・同じコードを src に2回書くと ORA-30926 で落ちる。
--------------------------------------------------------------------------------
MERGE INTO favorite_master tgt
USING (
    WITH src_raw AS (
        SELECT '7203' AS code, 1 AS is_watching, NULL AS is_buy_candidate, 'メモ例' AS note FROM dual UNION ALL
        SELECT '285A',         1,                1,                         NULL             FROM dual
    )
    SELECT em.code, r.is_watching, r.is_buy_candidate, r.note
    FROM src_raw r
    JOIN equity_master em
      ON em.code = CASE WHEN LENGTH(TRIM(r.code)) = 4 THEN UPPER(TRIM(r.code)) || '0'
                        ELSE UPPER(TRIM(r.code)) END
) src
ON (tgt.code = src.code)
WHEN MATCHED THEN
    UPDATE SET tgt.is_watching      = NVL(src.is_watching,      tgt.is_watching),
               tgt.is_buy_candidate = NVL(src.is_buy_candidate, tgt.is_buy_candidate),
               tgt.ref_note1        = NVL(tgt.ref_note1, src.note),
               tgt.updated_at       = SYSTIMESTAMP
WHEN NOT MATCHED THEN
    INSERT (code, is_watching, is_buy_candidate, ref_note1)
    VALUES (src.code, NVL(src.is_watching, 0), NVL(src.is_buy_candidate, 0), src.note);


--------------------------------------------------------------------------------
-- STEP 3. 登録後の確認（COMMIT する前に見る）
--------------------------------------------------------------------------------
SELECT f.code, em.co_name, f.is_watching, f.is_buy_candidate,
       f.ref_note1, f.created_at, f.updated_at
FROM favorite_master f
LEFT JOIN equity_master em ON em.code = f.code
WHERE f.updated_at >= SYSTIMESTAMP - INTERVAL '10' MINUTE
ORDER BY f.code;


--------------------------------------------------------------------------------
-- STEP 4. 確定
--------------------------------------------------------------------------------
COMMIT;
-- おかしければ COMMIT の代わりに: ROLLBACK;


--------------------------------------------------------------------------------
-- 付録. 1銘柄だけ新規で足す最小の INSERT（行が無いと分かっているとき）
--   code は5桁（証券コード4桁 + '0'）。既に行があると ORA-00001。
--------------------------------------------------------------------------------
-- INSERT INTO favorite_master (code, is_watching, is_buy_candidate, ref_note1)
-- VALUES ('72030', 1, 0, 'メモ');
-- COMMIT;
