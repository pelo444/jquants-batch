--------------------------------------------------------------------------------
-- 金融(300番台)タグの銘柄登録
--
-- 前提: ddl/05_tag_master.sql と ddl/07_tag_master_add_300.sql を実行済みであること。
--
-- 【100番台・200番台とのアプローチの違い】
--   銀行・保険は EQUITY_MASTER.SECTOR33_CODE で機械的に抽出できるため、
--   Web調査で銘柄コードを列挙するのではなく DBから直接抽出する。
--     ・上場80社超の地方銀行を手打ちする必要がなく、漏れが原理的に発生しない
--     ・銘柄コードの取り違えが起きない(DBの値をそのまま使うため)
--     ・新規上場・再編があっても再実行すれば追従する
--
--   明示的なリストが必要なのは「例外」だけに絞っている:
--     ・311(大手銀行)と313(ネット・決済系)に該当する銘柄
--     ・330(保険代理店)に該当する銘柄
--   最も数の多い312(地方銀行)は「銀行のうち311・313でないもの」として導出するので、
--   新しい地銀が上場しても自動的に含まれる。
--
-- 【抽出条件の要点】
--   ・SECTOR33_NAME(業種名)ではなく SECTOR33_CODE を使う。
--     業種名は表記ゆれの影響を受けるが、コード(銀行業=7050、保険業=7150)は安定している。
--   ・DELISTED_FLAG = 'N' で絞る。EQUITY_MASTER には過去10年分の上場廃止銘柄も
--     論理削除で残っているため、これがないと廃止済み銘柄が混入する
--     (例: 住信SBIネット銀行は2025年9月に上場廃止)。
--   ・日本銀行(83010)は除外する。売買されているのは株式ではなく出資証券のため。
--
-- 調査日: 2026-08-16 / 選定根拠は trend_analysis/finance_candidates_300.md を参照
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- STEP 0. 抽出対象の現状確認
--
-- まずDBの実際の値を確認する。SECTOR33_CODE が期待どおり入っているか、
-- 上場中と上場廃止がそれぞれ何件あるかを見てから先に進むこと。
--------------------------------------------------------------------------------
SELECT em.sector33_code,
       MAX(em.sector33_name)                                    AS sector33_name,
       COUNT(*)                                                 AS total,
       COUNT(CASE WHEN em.delisted_flag = 'N' THEN 1 END)       AS listed,
       COUNT(CASE WHEN em.delisted_flag = 'Y' THEN 1 END)       AS delisted
FROM equity_master em
WHERE em.sector33_code IN ('7050', '7150')
GROUP BY em.sector33_code
ORDER BY em.sector33_code;

-- 上場廃止として除外される銘柄の中身(意図せず現役銘柄が落ちていないか確認)
SELECT em.code, em.co_name, em.sector33_name, TO_CHAR(em.as_of_date, 'YYYY-MM-DD') AS as_of_date
FROM equity_master em
WHERE em.sector33_code IN ('7050', '7150')
  AND em.delisted_flag = 'Y'
ORDER BY em.sector33_code, em.code;


--------------------------------------------------------------------------------
-- STEP 1a. 例外リスト(明示的に分類が必要な銘柄のみ)
--
-- ここに載らない銀行は自動的に 312_bank_regional(地方銀行)になる。
-- 新しくネット銀行が上場した場合などは、このビューに1行足して再実行すればよい。
--
-- EXPECTED_NAME は STEP 1b のコード突合チェック用。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tag_manual_300 (code, tag_name, expected_name) AS
    -- 311 大手銀行・信託(金融庁の「主要行等」に相当)
    SELECT '83060', '311_bank_major', '三菱ＵＦＪフィナンシャル・グループ' FROM dual
    UNION ALL SELECT '83160', '311_bank_major', '三井住友フィナンシャルグループ' FROM dual
    UNION ALL SELECT '84110', '311_bank_major', 'みずほフィナンシャルグループ' FROM dual
    UNION ALL SELECT '83080', '311_bank_major', 'りそなホールディングス' FROM dual
    UNION ALL SELECT '83090', '311_bank_major', '三井住友トラストグループ' FROM dual
    -- SBI新生銀行は2023年に一度上場廃止となり、2025年12月17日に東証プライムへ再上場した。
    -- DBへの反映状況によっては STEP 1b で「上場廃止」または「コード未存在」になる。
    -- その場合はこの行を外してよい(STEP 4のMERGEでも自動的に除外される)。
    UNION ALL SELECT '83030', '311_bank_major', 'ＳＢＩ新生銀行' FROM dual
    UNION ALL SELECT '83040', '311_bank_major', 'あおぞら銀行' FROM dual
    UNION ALL SELECT '71820', '311_bank_major', 'ゆうちょ銀行' FROM dual
    -- 313 ネット・決済系銀行
    UNION ALL SELECT '58380', '313_bank_digital', '楽天銀行' FROM dual
    UNION ALL SELECT '84100', '313_bank_digital', 'セブン銀行' FROM dual
    -- 330 保険代理店・保険ショップ(JPX33業種では「保険業」に入るが引受会社ではない)
    UNION ALL SELECT '87980', '330_insurance_agency', 'アドバンスクリエイト' FROM dual
    UNION ALL SELECT '73880', '330_insurance_agency', 'ＦＰパートナー' FROM dual
    UNION ALL SELECT '73430', '330_insurance_agency', 'ブロードマインド' FROM dual
    UNION ALL SELECT '73250', '330_insurance_agency', 'アイリックコーポレーション' FROM dual
    UNION ALL SELECT '377A0', '330_insurance_agency', 'エージェントＩＧホールディングス' FROM dual;


--------------------------------------------------------------------------------
-- STEP 1b. 【必須】例外リストの証券コード突合チェック
--
-- 例外リストだけはコードを手で書いているので、100・200番台と同じ突合を行う。
-- (地方銀行など導出で入る銘柄はDBの値をそのまま使うので突合は不要)
--
-- 想定社名は全角で書いてあるが、TO_SINGLE_BYTE で半角化して比較するので
-- 半角で書いても一致する。
--
-- 「コード未存在」が出た場合の想定:
--   ・377A0 エージェントIGホールディングスは名古屋証券取引所の単独上場のため、
--     J-Quantsの取得範囲に入っていない可能性が高い。その場合は無視してよい
--     (STEP 3のMERGEでも自動的に除外される)。
--   ・それ以外で出た場合はコードの取り違えを疑うこと。
--------------------------------------------------------------------------------
WITH chk AS (
    SELECT m.tag_name,
           m.code,
           m.expected_name,
           em.co_name       AS actual_name,
           em.delisted_flag,
           em.sector33_code,
           UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               TO_SINGLE_BYTE(m.expected_name),
               ' ',''), '　',''), '・',''), '･',''), '-',''), '−',''), '－','')) AS exp_norm,
           UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               TO_SINGLE_BYTE(em.co_name),
               ' ',''), '　',''), '・',''), '･',''), '-',''), '−',''), '－','')) AS act_norm
    FROM v_tag_manual_300 m
    LEFT JOIN equity_master em ON em.code = m.code
)
SELECT tag_name,
       code,
       expected_name,
       actual_name,
       sector33_code,
       delisted_flag,
       CASE
         WHEN actual_name IS NULL THEN 'コード未存在'
         WHEN delisted_flag = 'Y' THEN '上場廃止'
         -- 業種が想定と違うと STEP 2 の JOIN で黙って落ちるため、ここで検出する
         WHEN tag_name IN ('311_bank_major','313_bank_digital')
              AND sector33_code <> '7050' THEN '業種不一致(銀行業ではない)'
         WHEN tag_name = '330_insurance_agency'
              AND sector33_code <> '7150' THEN '業種不一致(保険業ではない)'
         WHEN act_norm LIKE '%' || exp_norm || '%'
           OR exp_norm LIKE '%' || act_norm || '%' THEN 'OK'
         ELSE '要確認'
       END AS judge
FROM chk
ORDER BY tag_name, code;


--------------------------------------------------------------------------------
-- STEP 2. タグ付与内容の算出
--
-- 310(全銀行)と320(保険引受)はsector33から導出し、
-- 311/313/330は例外リスト、312は「銀行のうち311・313でないもの」として導出する。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tag_candidate_300 (code, tag_name) AS
WITH bank AS (
    -- 上場中の銀行。日本銀行(83010)は出資証券のため除外
    SELECT em.code
    FROM equity_master em
    WHERE em.sector33_code = '7050'
      AND em.delisted_flag = 'N'
      AND em.code <> '83010'
      -- 個人が売買できない市場は対象外(rate_price_change.sql と同じ方針)。
      -- NULL <> '...' は UNKNOWN になり行が消えるため IS NULL を明示する。
      AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')
),
ins AS (
    -- 上場中の保険業
    SELECT em.code
    FROM equity_master em
    WHERE em.sector33_code = '7150'
      AND em.delisted_flag = 'N'
      AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')
)
-- 310: すべての銀行
SELECT b.code, '310_bank' FROM bank b
UNION ALL
-- 311 / 313: 例外リストで明示指定したもの
SELECT m.code, m.tag_name
FROM v_tag_manual_300 m
JOIN bank b ON b.code = m.code
WHERE m.tag_name IN ('311_bank_major', '313_bank_digital')
UNION ALL
-- 312: 銀行のうち311・313に該当しないもの(=地方銀行)を導出
SELECT b.code, '312_bank_regional'
FROM bank b
WHERE NOT EXISTS (
    SELECT 1 FROM v_tag_manual_300 m
    WHERE m.code = b.code
      AND m.tag_name IN ('311_bank_major', '313_bank_digital')
)
UNION ALL
-- 320: 保険業のうち代理店以外(=引受会社)
SELECT i.code, '320_insurance'
FROM ins i
WHERE NOT EXISTS (
    SELECT 1 FROM v_tag_manual_300 m
    WHERE m.code = i.code
      AND m.tag_name = '330_insurance_agency'
)
UNION ALL
-- 330: 保険代理店
SELECT m.code, m.tag_name
FROM v_tag_manual_300 m
JOIN ins i ON i.code = m.code
WHERE m.tag_name = '330_insurance_agency';


--------------------------------------------------------------------------------
-- STEP 3. 【必須】付与内容のプレビュー
--
-- 投入前に、どの銘柄にどのタグが付くかを必ず目視すること。
-- 特に 312_bank_regional に大手やネット銀行が紛れていないかを確認する。
--------------------------------------------------------------------------------
-- タグ別の件数
SELECT c.tag_name, COUNT(*) AS cnt
FROM v_tag_candidate_300 c
GROUP BY c.tag_name
ORDER BY c.tag_name;

-- 銘柄一覧(細分タグ順)
SELECT c.tag_name,
       c.code,
       em.co_name,
       em.market_name,
       em.sector33_name
FROM v_tag_candidate_300 c
JOIN equity_master em ON em.code = c.code
WHERE c.tag_name <> '310_bank'   -- 310は全銀行なので細分タグ側だけを見る
ORDER BY c.tag_name, c.code;


--------------------------------------------------------------------------------
-- STEP 4. FAVORITE_TAG へ投入
--
-- MERGEにしてあるので再実行しても重複エラーにならない。
-- EQUITY_MASTER と TAG_MASTER の両方にJOINして、どちらの外部キーも満たす行だけを対象にする
-- (未登録タグが1件でもあるとFK違反でMERGE全体がロールバックするため)。
--------------------------------------------------------------------------------
MERGE INTO favorite_tag t
USING (
    SELECT c.code, c.tag_name
    FROM v_tag_candidate_300 c
    JOIN equity_master em ON em.code = c.code
    JOIN tag_master   tm ON tm.tag_name = c.tag_name
) s
ON (t.code = s.code AND t.tag_name = s.tag_name)
WHEN NOT MATCHED THEN
    INSERT (code, tag_name) VALUES (s.code, s.tag_name);

COMMIT;


--------------------------------------------------------------------------------
-- STEP 5. 投入結果の確認
--------------------------------------------------------------------------------
-- タグ別の登録件数
SELECT tm.tag_code, tm.tag_label_ja, COUNT(ft.code) AS code_count
FROM tag_master tm
LEFT JOIN favorite_tag ft ON ft.tag_name = tm.tag_name
WHERE tm.major_code = '300'
GROUP BY tm.tag_code, tm.tag_label_ja
ORDER BY tm.tag_code;

-- 310_bank の件数と 311+312+313 の合計が一致するか(細分の付け漏れ・重複の検算)
SELECT (SELECT COUNT(*) FROM favorite_tag WHERE tag_name = '310_bank')          AS bank_total,
       (SELECT COUNT(*) FROM favorite_tag
         WHERE tag_name IN ('311_bank_major','312_bank_regional','313_bank_digital')) AS bank_detail_total
FROM dual;

-- 銀行に細分タグが2つ以上付いていないか(排他であるべき)
SELECT ft.code, MAX(em.co_name) AS co_name, LISTAGG(ft.tag_name, ', ') WITHIN GROUP (ORDER BY ft.tag_name) AS tags
FROM favorite_tag ft
JOIN equity_master em ON em.code = ft.code
WHERE ft.tag_name IN ('311_bank_major','312_bank_regional','313_bank_digital')
GROUP BY ft.code
HAVING COUNT(*) > 1;


--------------------------------------------------------------------------------
-- STEP 6. 再実行と保守について
--
-- ・銀行・保険の新規上場や上場廃止があった場合は、日次バッチでEQUITY_MASTERが
--   更新された後にこのファイルのSTEP 2〜4を再実行すれば追従する。
--   ただし上場廃止銘柄のタグは自動では消えないので、下のクエリで検出して削除すること。
--
-- 上場廃止になったのにタグが残っている銘柄の検出(300番台に限らず全タグが対象)
-- SELECT ft.code, em.co_name, ft.tag_name
-- FROM favorite_tag ft
-- JOIN equity_master em ON em.code = ft.code
-- WHERE em.delisted_flag = 'Y'
-- ORDER BY ft.code, ft.tag_name;
--
-- ・新しくネット銀行が上場した場合など、例外リストの変更は STEP 1a のビューを直す。
--   例外リストから外した銘柄は312に移るが、投入済みの313タグは自動では消えない。
--   下のクエリで「候補に無いのに登録されている300番台タグ」を検出して削除すること。
--
-- SELECT ft.code, ft.tag_name
-- FROM favorite_tag ft
-- JOIN tag_master tm ON tm.tag_name = ft.tag_name
-- WHERE tm.major_code = '300'
--   AND NOT EXISTS (SELECT 1 FROM v_tag_candidate_300 c
--                   WHERE c.code = ft.code AND c.tag_name = ft.tag_name);
--------------------------------------------------------------------------------
