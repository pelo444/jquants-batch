--------------------------------------------------------------------------------
-- タグ付き銘柄の一覧・サマリ
--
-- 前提: ddl/05_tag_master.sql を実行済みであること(TAG_MASTER と V_EQUITY_TAG)。
--
-- タグ体系:
--   TAG_TYPE='CLASS' … 番号付きの分類体系(3桁固定・10刻み、上位1桁が大分類)
--   TAG_TYPE='THEME' … 番号なしの個別テーマ
--
-- 1銘柄に複数タグを付与できるため、タグ別の銘柄数を単純合計しても
-- ユニーク銘柄数にはならない点に注意(重複してカウントされる)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. タグ別の銘柄数サマリ
--
-- 定義したのに銘柄が1つも付いていないタグも見えるよう、TAG_MASTER 起点の
-- 外部結合にしている(ピックアップ作業の進捗確認用)。
--------------------------------------------------------------------------------
SELECT tm.tag_code,
       tm.tag_name,
       tm.major_label_ja,
       tm.tag_label_ja,
       COUNT(ft.code) AS code_count
FROM tag_master tm
LEFT JOIN favorite_tag ft ON ft.tag_name = tm.tag_name
WHERE tm.is_active = 1
GROUP BY tm.tag_code, tm.tag_name, tm.major_label_ja, tm.tag_label_ja
ORDER BY tm.tag_code NULLS LAST, tm.tag_name;


--------------------------------------------------------------------------------
-- 2. 大分類別のユニーク銘柄数
--
-- 同じ大分類の中で複数タグが付いた銘柄を二重に数えないよう DISTINCT で数える。
--------------------------------------------------------------------------------
SELECT NVL(v.major_code, '-')            AS major_code,
       NVL(v.major_label_ja, '(テーマ)') AS major_label_ja,
       COUNT(DISTINCT v.code)            AS uniq_codes
FROM v_equity_tag v
WHERE v.is_active = 1
GROUP BY v.major_code, v.major_label_ja
ORDER BY v.major_code NULLS LAST;   -- テーマ(番号なし)を末尾に置く


--------------------------------------------------------------------------------
-- 3. タグ付き銘柄の一覧(分類順)
--
-- JPX33業種を併記しているのは、タグと業種のズレを確認するため。
-- 例えば140(電力・DCインフラ)に「建設業」「電気機器」が混じるのは想定どおりで、
-- 業種分類では拾えない切り口であることの裏付けになる。
--------------------------------------------------------------------------------
SELECT v.tag_code,
       v.tag_label_ja,
       v.code,
       v.co_name,
       v.market_name,
       v.sector33_name,
       TO_CHAR(v.tagged_at, 'YYYY-MM-DD') AS tagged_at
FROM v_equity_tag v
WHERE v.is_active = 1
--  AND v.major_code = '100'          -- 大分類で絞る場合
--  AND v.tag_name = '130_semi_equip_material'   -- 単一タグで絞る場合
ORDER BY v.tag_code NULLS LAST, v.tag_name, v.code;


--------------------------------------------------------------------------------
-- 4. 複数タグが付いている銘柄
--
-- AIバリューチェーンは1社が複数段にまたがることが多い
-- (例: 総合電機が半導体・装置・応用サービスをすべて手掛ける)。
-- どの銘柄がテーマをまたいでいるかを把握しておくと、
-- 「AI関連株が上がった」ときにどの段が効いているのかの切り分けがしやすい。
--------------------------------------------------------------------------------
SELECT v.code,
       MAX(v.co_name)      AS co_name,
       MAX(v.sector33_name) AS sector33_name,
       COUNT(*)            AS tag_count,
       LISTAGG(NVL(v.tag_code, v.tag_name), ', ')
           WITHIN GROUP (ORDER BY v.tag_code NULLS LAST, v.tag_name) AS tags,
       LISTAGG(v.tag_label_ja, ' / ')
           WITHIN GROUP (ORDER BY v.tag_code NULLS LAST, v.tag_name) AS tag_labels
FROM v_equity_tag v
WHERE v.is_active = 1
GROUP BY v.code
HAVING COUNT(*) > 1
ORDER BY tag_count DESC, v.code;


--------------------------------------------------------------------------------
-- 5. タグと JPX33業種の対応状況
--
-- 銀行(310)・保険(320)のように業種でも取れる分類は、
-- タグの付け漏れを業種側から検算できる。
-- 下は「業種は銀行業なのに310タグが付いていない銘柄」を洗い出す例。
--
-- 業種の判定には SECTOR33_CODE を使う(銀行業=7050、保険業=7150)。
-- 業種名は表記ゆれの影響を受けるが、コードは安定しているため。
--------------------------------------------------------------------------------
SELECT em.code,
       em.co_name,
       em.sector33_name,
       em.market_name
FROM equity_master em
WHERE em.sector33_code = '7050'
  AND em.delisted_flag = 'N'
  AND em.code <> '83010'          -- 日本銀行は出資証券のため対象外
  -- 付け漏れの検出が目的なので、市場名がNULLの銘柄を落とさないようにする
  -- (NULL <> '...' は UNKNOWN となり、単純な <> だと行が消える)
  AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')
  AND NOT EXISTS (
        SELECT 1 FROM favorite_tag ft
        WHERE ft.code = em.code
          AND ft.tag_name = '310_bank'
      )
ORDER BY em.code;


--------------------------------------------------------------------------------
-- 6. 上場廃止銘柄にタグが残っていないかの点検
--
-- EQUITY_MASTER は上場廃止銘柄を物理削除せず DELISTED_FLAG='Y' で保持している。
-- 一方 FAVORITE_TAG のタグは上場廃止時に自動では消えないため、
-- 放置すると「もう売買できない銘柄」が集計やチャートに混ざり続ける。
--
-- 定期的に(日次バッチの後などに)実行して、出てきた銘柄を判断すること。
--   ・過去の値動きを追う目的でタグを残すなら、そのままでよい
--   ・現在の投資候補として使うなら、DELETEするか別タグへ退避する
--------------------------------------------------------------------------------
SELECT ft.code,
       em.co_name,
       em.sector33_name,
       TO_CHAR(em.as_of_date, 'YYYY-MM-DD') AS last_as_of_date,
       LISTAGG(ft.tag_name, ', ') WITHIN GROUP (ORDER BY ft.tag_name) AS tags
FROM favorite_tag ft
JOIN equity_master em ON em.code = ft.code
WHERE em.delisted_flag = 'Y'
GROUP BY ft.code, em.co_name, em.sector33_name, em.as_of_date
ORDER BY ft.code;

-- 削除する場合の例(対象を上のクエリで確認してから実行すること)
-- DELETE FROM favorite_tag ft
-- WHERE EXISTS (SELECT 1 FROM equity_master em
--               WHERE em.code = ft.code AND em.delisted_flag = 'Y');
-- COMMIT;
