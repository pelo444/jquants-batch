--------------------------------------------------------------------------------
-- 投資部門別情報・決算発表予定日の分析クエリ集
--
-- 前提: ddl/12_investor_types_and_earnings_date.sql を実行し、取り込みが済んでいること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 取込状況の確認
--------------------------------------------------------------------------------
SELECT '投資部門別情報' AS data_name,
       COUNT(*)                                 AS rows_cnt,
       TO_CHAR(MIN(en_date), 'YYYY-MM-DD')      AS from_date,
       TO_CHAR(MAX(en_date), 'YYYY-MM-DD')      AS to_date
FROM investor_type_trading
UNION ALL
SELECT '決算発表予定日',
       COUNT(*), TO_CHAR(MIN(pub_date), 'YYYY-MM-DD'), TO_CHAR(MAX(pub_date), 'YYYY-MM-DD')
FROM earnings_schedule;

-- 投資部門別情報の市場名一覧(Sectionにどんな値が入っているか確認)
SELECT section, COUNT(*) AS rows_cnt,
       TO_CHAR(MIN(en_date), 'YYYY-MM-DD') AS from_date,
       TO_CHAR(MAX(en_date), 'YYYY-MM-DD') AS to_date
FROM investor_type_trading
GROUP BY section
ORDER BY section;


--------------------------------------------------------------------------------
-- 2. 海外投資家・個人の売買動向(市場別・直近12週)
--
-- 海外投資家(FRGN)と個人(IND)の売買差引(BAL)の推移。
-- プラスが買い越し、マイナスが売り越し。単位は千円。
-- 過誤訂正後の最新値のみを見るため V_INVESTOR_TYPE_TRADING_LATEST を使う。
--------------------------------------------------------------------------------
SELECT v.section,
       TO_CHAR(v.st_date, 'YYYY-MM-DD') AS st_date,
       TO_CHAR(v.en_date, 'YYYY-MM-DD') AS en_date,
       ROUND(v.frgn_bal / 100000, 1)    AS frgn_bal_oku_yen,
       ROUND(v.ind_bal  / 100000, 1)    AS ind_bal_oku_yen,
       ROUND(v.tot_bal  / 100000, 1)    AS tot_bal_oku_yen
FROM v_investor_type_trading_latest v
WHERE v.section = 'TSEPrime'                    -- ← 見たい市場名に変更する
ORDER BY v.en_date DESC
FETCH FIRST 12 ROWS ONLY;


--------------------------------------------------------------------------------
-- 3. タグ指定銘柄の直近の決算発表予定
--
-- 「現在有効な予定」だけを見るため V_EARNINGS_SCHEDULE_LATEST を使う。
-- 予定日が未定(NULL)の銘柄は末尾に表示される。
--
-- タグ名は queries/sql/tagged_equity_list.sql で確認できる。
--------------------------------------------------------------------------------
SELECT v.code,
       em.co_name,
       v.fq_name,
       TO_CHAR(v.sch_date, 'YYYY-MM-DD')  AS sch_date,
       TO_CHAR(v.pub_date, 'YYYY-MM-DD')  AS pub_date
FROM v_earnings_schedule_latest v
JOIN equity_master em ON em.code = v.code
WHERE EXISTS (
        SELECT 1 FROM favorite_tag f
        WHERE f.code = v.code
          AND f.tag_name IN ('130_semi_equip_material')   -- ← 見たいタグに変更する
      )
ORDER BY v.sch_date NULLS LAST, v.code;


--------------------------------------------------------------------------------
-- 4. 直近◯日以内に決算発表予定の全銘柄
--------------------------------------------------------------------------------
SELECT v.code,
       em.co_name,
       em.market_name,
       v.fq_name,
       TO_CHAR(v.sch_date, 'YYYY-MM-DD') AS sch_date
FROM v_earnings_schedule_latest v
JOIN equity_master em ON em.code = v.code
WHERE em.delisted_flag = 'N'
  AND v.sch_date BETWEEN TRUNC(SYSDATE) AND TRUNC(SYSDATE) + 14   -- ← 期間はお好みで
ORDER BY v.sch_date, v.code;


--------------------------------------------------------------------------------
-- 5. 決算発表予定日の変更履歴(特定銘柄)
--
-- 「未定」から確定、確定後の変更などの履歴をすべて見る。
-- 過去の値は消えないため、公表日の古い順に並べれば変遷が追える。
--------------------------------------------------------------------------------
SELECT e.fq_name,
       TO_CHAR(e.pub_date, 'YYYY-MM-DD')  AS pub_date,
       NVL(TO_CHAR(e.sch_date, 'YYYY-MM-DD'), '(未定)') AS sch_date
FROM earnings_schedule e
WHERE e.code = '86970'                            -- ← 見たい銘柄コード(5桁)に変更する
ORDER BY e.fq_name, e.pub_date;
