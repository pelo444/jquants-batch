--------------------------------------------------------------------------------
-- 空売り・信用取引の分析クエリ集
--
-- 前提: ddl/08_short_selling_tables.sql を実行し、取り込みが済んでいること。
--
-- 【2つの「空売り残高」の違い】
--   ・信用売残(EQUITY_MARGIN_INTEREST.SHRT_VOL)
--       証券会社経由の信用取引の売建。個人投資家が中心。全銘柄が対象。
--   ・空売り残高報告(EQUITY_SHORT_POSITION)
--       機関投資家等のポジション。残高割合0.5%以上の報告分のみ。信用取引に限らない。
--   機関投資家の空売りは信用取引を経由しないことが多く前者には現れない。
--   後者は0.5%未満が見えない。両方を並べて初めて全体像になる。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 取込状況の確認
--
-- まずこれを実行して、各データがどの期間まで入っているかを把握する。
-- 公開頻度が異なるため、最新日が揃わないのは正常。
--------------------------------------------------------------------------------
SELECT '業種別空売り比率' AS data_name,
       COUNT(*)                                  AS rows_cnt,
       TO_CHAR(MIN(ratio_date), 'YYYY-MM-DD')    AS from_date,
       TO_CHAR(MAX(ratio_date), 'YYYY-MM-DD')    AS to_date
FROM sector_short_ratio
UNION ALL
SELECT '信用取引残高',
       COUNT(*), TO_CHAR(MIN(app_date), 'YYYY-MM-DD'), TO_CHAR(MAX(app_date), 'YYYY-MM-DD')
FROM equity_margin_interest
UNION ALL
SELECT '日々公表信用取引残高',
       COUNT(*), TO_CHAR(MIN(app_date), 'YYYY-MM-DD'), TO_CHAR(MAX(app_date), 'YYYY-MM-DD')
FROM equity_margin_alert
UNION ALL
SELECT '空売り残高報告',
       COUNT(*), TO_CHAR(MIN(calc_date), 'YYYY-MM-DD'), TO_CHAR(MAX(calc_date), 'YYYY-MM-DD')
FROM equity_short_position;

-- 信用取引残高の金額項目がいつから入っているかの確認
-- (2026年9月25日申込分以降のみ提供される)
SELECT TO_CHAR(MIN(app_date), 'YYYY-MM-DD') AS first_date_with_value
FROM equity_margin_interest
WHERE shrt_val IS NOT NULL;


--------------------------------------------------------------------------------
-- 2. タグ指定の空売り状況一覧
--
-- 信用売残と空売り残高報告を1行に並べる。
-- MARGIN_RATIO(信用倍率) = 買残 ÷ 売残。低いほど売り長で、
-- 買い戻し(踏み上げ)が起きたときの上昇余地が大きいとされる。
--
-- タグ名は queries/sql/tagged_equity_list.sql で確認できる。
--------------------------------------------------------------------------------
SELECT v.code,
       v.co_name,
       v.market_name,
       v.sector33_name,
       TO_CHAR(v.margin_date, 'YYYY-MM-DD')  AS margin_date,
       v.margin_short_vol,
       v.margin_long_vol,
       v.margin_ratio,
       CASE v.iss_type
         WHEN '1' THEN '信用'
         WHEN '2' THEN '貸借'
         WHEN '3' THEN 'その他'
       END                                   AS iss_type_name,
       TO_CHAR(v.report_calc_date, 'YYYY-MM-DD') AS report_calc_date,
       v.report_reporter_count,
       v.report_short_shares,
       v.report_short_ratio_pct
FROM v_equity_short_overview v
WHERE EXISTS (
        SELECT 1 FROM favorite_tag f
        WHERE f.code = v.code
          AND f.tag_name IN ('130_semi_equip_material')   -- ← 見たいタグに変更する
      )
ORDER BY v.margin_ratio NULLS LAST;


--------------------------------------------------------------------------------
-- 3. Days to cover(買い戻しに何日かかるか)
--
-- 売残 ÷ 直近20営業日の平均出来高。
-- 発行済株式数を持っていないため対発行済株式数比率は出せないが、
-- この指標は出来高から計算でき、実務でもよく使われる。
-- 値が大きいほど買い戻しに時間がかかり、踏み上げが起きやすいとされる。
--
-- 信用取引残高は分割の遡及調整が行われないため、期間中に分割があった銘柄では
-- 売残と出来高の株数基準がずれる。SPLIT_FLAG が 'Y' の銘柄は解釈に注意すること。
--------------------------------------------------------------------------------
WITH latest_margin AS (
    SELECT code, app_date, shrt_vol, long_vol
    FROM (
        SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
    )
    WHERE rn = 1
),
avg_vol AS (
    -- 直近20営業日の平均出来高。売買が無かった日(出来高0)も分母に含める。
    SELECT p.code,
           AVG(p.volume)                                        AS avg_volume_20d,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)        AS split_flag
    FROM (
        SELECT d.code, d.volume, d.adj_factor,
               ROW_NUMBER() OVER (PARTITION BY d.code ORDER BY d.price_date DESC) AS rn
        FROM equity_price_daily d
        WHERE d.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -3)   -- 走査量を抑えるための絞り込み
    ) p
    WHERE p.rn <= 20
    GROUP BY p.code
)
SELECT em.code,
       em.co_name,
       em.market_name,
       TO_CHAR(lm.app_date, 'YYYY-MM-DD')                       AS margin_date,
       lm.shrt_vol,
       lm.long_vol,
       ROUND(lm.long_vol / NULLIF(lm.shrt_vol, 0), 2)           AS margin_ratio,
       ROUND(av.avg_volume_20d)                                 AS avg_volume_20d,
       ROUND(lm.shrt_vol / NULLIF(av.avg_volume_20d, 0), 1)     AS days_to_cover,
       NVL(av.split_flag, 'N')                                  AS split_flag
FROM latest_margin lm
JOIN equity_master em ON em.code = lm.code
JOIN avg_vol       av ON av.code = lm.code
WHERE em.delisted_flag = 'N'
  AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')
  AND lm.shrt_vol > 0
  AND av.avg_volume_20d > 0
ORDER BY days_to_cover DESC NULLS LAST
FETCH FIRST 50 ROWS ONLY;


--------------------------------------------------------------------------------
-- 4. 空売り残高報告が増えている銘柄
--
-- 各報告者について、直近の残高割合(ShrtPosToSO)と、その前回報告時の割合
-- (PrevRptRatio)の差を見る。APIが前回値を持っているので自己結合が不要。
--
-- 空売り残高報告は「報告があった日」しかデータが無い点に注意。
-- レコードが存在しないことは残高がゼロであることを意味しない。
--------------------------------------------------------------------------------
SELECT p.code,
       em.co_name,
       em.market_name,
       TO_CHAR(p.calc_date, 'YYYY-MM-DD')             AS calc_date,
       TO_CHAR(p.prev_rpt_date, 'YYYY-MM-DD')         AS prev_date,
       p.ss_name,
       p.fund_name,
       ROUND(p.shrt_pos_to_so  * 100, 3)              AS ratio_pct,
       ROUND(p.prev_rpt_ratio  * 100, 3)              AS prev_ratio_pct,
       ROUND((p.shrt_pos_to_so - p.prev_rpt_ratio) * 100, 3) AS diff_pct,
       p.shrt_pos_shares
FROM equity_short_position p
JOIN equity_master em ON em.code = p.code
WHERE p.calc_date >= ADD_MONTHS(TRUNC(SYSDATE), -1)
  AND p.prev_rpt_ratio IS NOT NULL
  AND p.shrt_pos_to_so > p.prev_rpt_ratio        -- 積み増している報告のみ
ORDER BY diff_pct DESC NULLS LAST
FETCH FIRST 50 ROWS ONLY;


--------------------------------------------------------------------------------
-- 5. 銘柄別の空売り残高報告の推移
--
-- 1銘柄について、誰がどれだけ積んでいるかを時系列で見る。
-- SS_NAME は取引参加者から報告されたものをそのまま格納しているため、
-- 同一主体でも日本語名と英語名が混在する。名寄せは利用側で行う必要がある。
--------------------------------------------------------------------------------
SELECT TO_CHAR(p.calc_date, 'YYYY-MM-DD')        AS calc_date,
       p.ss_name,
       p.fund_name,
       ROUND(p.shrt_pos_to_so * 100, 3)          AS ratio_pct,
       p.shrt_pos_shares
FROM equity_short_position p
WHERE p.code = '68570'                            -- ← 見たい銘柄コード(5桁)に変更する
ORDER BY p.calc_date DESC, ratio_pct DESC;

-- 同じ銘柄の合計推移(報告者数と合計割合)
SELECT TO_CHAR(v.calc_date, 'YYYY-MM-DD')        AS calc_date,
       v.reporter_count,
       ROUND(v.total_shrt_ratio * 100, 3)        AS total_ratio_pct,
       v.total_shrt_shares
FROM v_equity_short_position_sum v
WHERE v.code = '68570'                            -- ← 見たい銘柄コード(5桁)に変更する
ORDER BY v.calc_date DESC;


--------------------------------------------------------------------------------
-- 6. 業種別空売り比率の直近推移
--
-- 個別銘柄ではなく地合いの把握用。
-- WITH_RESTRICTION_PCT が高い = 直近下落局面でも売られている、の目安
-- (価格規制はトリガー抵触後にかかるため)。
--------------------------------------------------------------------------------
SELECT TO_CHAR(v.ratio_date, 'YYYY-MM-DD')  AS ratio_date,
       v.s33_code,
       MAX(em.sector33_name)                AS sector33_name,
       ROUND(v.short_va / 100000000, 1)     AS short_oku_yen,
       v.short_ratio_pct,
       v.with_restriction_pct
FROM v_sector_short_ratio v
LEFT JOIN equity_master em ON em.sector33_code = v.s33_code
WHERE v.ratio_date >= (SELECT MAX(ratio_date) - 7 FROM sector_short_ratio)
GROUP BY v.ratio_date, v.s33_code, v.short_va, v.short_ratio_pct, v.with_restriction_pct
ORDER BY v.ratio_date DESC, v.short_ratio_pct DESC;


--------------------------------------------------------------------------------
-- 7. 日々公表銘柄の現況
--
-- 日々公表銘柄に指定されること自体が過熱シグナル。
-- 過誤訂正で同一申込日に複数の公表日が存在しうるため、最新版だけを返す
-- ビュー(V_EQUITY_MARGIN_ALERT_LATEST)を使う。
--------------------------------------------------------------------------------
SELECT a.code,
       em.co_name,
       TO_CHAR(a.app_date, 'YYYY-MM-DD')   AS app_date,
       a.shrt_out,
       a.shrt_out_chg,
       a.shrt_out_ratio,
       a.long_out,
       a.long_out_chg,
       a.sl_ratio,
       -- 公表理由を読める形にする
       TRIM(
         CASE WHEN a.reason_restricted        = '1' THEN '規制中 '   END ||
         CASE WHEN a.reason_daily_publication = '1' THEN '日々公表 ' END ||
         CASE WHEN a.reason_monitoring        = '1' THEN '監視中 '   END ||
         CASE WHEN a.reason_restricted_by_jsf = '1' THEN '日証金規制 ' END ||
         CASE WHEN a.reason_precaution_by_jsf = '1' THEN '日証金注意 ' END ||
         CASE WHEN a.reason_unclear_or_sec_alert = '1' THEN '注意銘柄 ' END
       )                                    AS pub_reasons
FROM v_equity_margin_alert_latest a
JOIN equity_master em ON em.code = a.code
WHERE a.app_date = (SELECT MAX(app_date) FROM equity_margin_alert)
ORDER BY a.sl_ratio DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 8. 過誤訂正があった日々公表データの確認
--
-- 同一の(銘柄, 申込日)に公表日が複数あるものが訂正の発生した行。
-- 訂正前後で値がどう変わったかを見る。
--------------------------------------------------------------------------------
SELECT a.code,
       em.co_name,
       TO_CHAR(a.app_date, 'YYYY-MM-DD') AS app_date,
       COUNT(*)                          AS versions,
       -- 訂正が極端に多い場合でも ORA-01489 で落ちないようにする
       LISTAGG(TO_CHAR(a.pub_date, 'MM-DD') || ':' || a.shrt_out, ' → '
               ON OVERFLOW TRUNCATE '…' WITHOUT COUNT)
         WITHIN GROUP (ORDER BY a.pub_date) AS shrt_out_history
FROM equity_margin_alert a
JOIN equity_master em ON em.code = a.code
GROUP BY a.code, em.co_name, a.app_date
HAVING COUNT(*) > 1
ORDER BY a.app_date DESC, a.code
FETCH FIRST 50 ROWS ONLY;
