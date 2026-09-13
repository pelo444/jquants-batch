--------------------------------------------------------------------------------
-- 第一階層: マクロ需給ダッシュボード
--
-- 市場全体の需給環境を週次で並べる。構成要素は4つ:
--   (1) 投資部門別のネット売買代金   INVESTOR_TYPE_TRADING   (週次)
--   (2) 裁定取引残高                 ARBITRAGE_BALANCE       (週次・JPXから手動取込)
--   (3) 市場全体の信用倍率           EQUITY_MARGIN_INTEREST  (週次 → 2026/9/25以降は日次)
--   (4) 市場全体の空売り比率         SECTOR_SHORT_RATIO      (日次 → 週次に集約)
--
-- 前提: ddl/12・ddl/08・ddl/11・ddl/17 を実行済みであること。
--       裁定残(ddl/17)はテーブルさえ作ってあれば、中身が空でも 7 は動く
--       (ARB_NET_OKU 列が NULL になるだけ)。テーブルが無いと 1 と 7 が
--       ORA-00942 で落ちる。
--
-- 【週の揃え方】
--   4つは公表日も基準日もバラバラなので、全て TRUNC(日付,'IW') = その週の月曜 に
--   正規化して突き合わせる。'IW' はISO週なのでNLS設定に依存しない
--   (NEXT_DAY(d,'FRI') は NLS_DATE_LANGUAGE で挙動が変わるため使わない)。
--
-- 【SECTION に何が入っているか】(2026-09-09 に実データで確認)
--
--   | SECTION     | 週数 | 期間                 | 内容            |
--   |-------------|------|----------------------|-----------------|
--   | TokyoNagoya | 524  | 〜2026-08-28(継続中) | 東証＋名証の合計 |
--   | TSEPrime    | 232  | 2022-04〜(継続中)    | プライム         |
--   | TSEStandard | 230  | 2022-04〜(継続中)    | スタンダード     |
--   | TSEGrowth   | 230  | 2022-04〜(継続中)    | グロース         |
--   | TSE1st      | 292  | 〜2022-04-01(終了)   | 旧・東証一部     |
--   | TSE2nd      | 292  | 〜2022-04-01(終了)   | 旧・東証二部     |
--   | TSEMothers  | 292  | 〜2022-04-01(終了)   | 旧・マザーズ     |
--   | TSEJASDAQ   | 292  | 〜2022-04-01(終了)   | 旧・JASDAQ       |
--
--   **2022年4月の市場区分再編で系列が切れている。**
--   TSE1st 等は2022-04-01で終わり、TSEPrime 等はそこから始まる。
--   TSEPrime を選んで4年半より前まで遡ると、**エラーにならずに黙って
--   NULL が並ぶ**。これが一番危ない失敗の仕方なので、長期で見るときは
--   再編をまたいで連続している TokyoNagoya を使うこと。
--
--   既定を TokyoNagoya にしてあるのはこのため。市場区分ごとの傾向を
--   見たいとき(プライムだけ海外勢が買い越している等)にだけ TSEPrime 等へ
--   切り替え、その場合は weeks_back を 232週以内に収めること。
--
--   なお TokyoNagoya は名証を含むぶん、他の3指標より範囲がわずかに広い
--   (裁定残=東証上場内国株、空売り比率=東証33業種、信用倍率=このSQLでは
--   プライム/スタンダード/グロースに限定)。名証の売買代金比率は小さいので
--   実用上は問題ないが、厳密な比較をするときは意識すること。
--
-- 【文脈列としてTOPIXだけでは足りない - グロース/バリューの乖離を併記する】
--   2026年7月、日経平均は -8.13% と4か月ぶりに大きく下げたが、TOPIXは +0.21% と
--   ほぼ横ばいだった。米SOX指数に連れた半導体・電子部品の下落を、
--   エネルギー・金融・自動車・商社といった大型バリューの上昇が打ち消したため。
--   TOPIXだけを置いていると、**この月に何が起きたのかが1つも見えない**。
--
--   日経平均は日本経済新聞社の指数でJ-Quantsの配信対象外(INDEX_MASTER は
--   JPX算出指数のみ102件)。そこで代わりに TOPIX グロース(8200) と
--   TOPIX バリュー(8100) の比率を置く。日経平均を入れるより現象を正確に測れる
--   (日経平均は値がさ株偏重という指数固有の癖が混じるため)。
--
--     GV_RATIO      … グロース ÷ バリュー。上昇=グロース優位、低下=バリュー優位
--     GV_RATIO_WOW  … その前週比(%)。マイナスが大きい週は「ハイテクが売られた週」
--     ELEC_WOW_PCT  … TOPIX-17 電機・精密(0088)の前週比(%)。半導体そのものの動き
--
--   使った指数はいずれも2016-09-01から10年分揃っていることを確認済み(2026-09-09)。
--
-- 【方向の見方】
--   本ダッシュボードは各指標の前週比(WOW)を数値で返す。色分けはHTML側の仕事。
--   ただし「増えたら強気」とは限らない点に注意:
--     海外投資家ネット  … プラス(買い越し)が需給の追い風
--     裁定買残ネット    … 増加は将来の解消売り圧力の蓄積。強気/弱気の両義的
--     信用倍率          … 低いほど売り長。踏み上げ余地が大きい
--                          ただし3月・9月は下記の季節性で必ず下がる
--     空売り比率        … 高いほど売り圧力が強い。極端な高水準は反転の目印にもなる
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 取込状況の確認
--
-- 最初にこれを流して、4データがどこまで入っているかを確認する。
-- 公表頻度が違うので最新日が揃わないのは正常。
--------------------------------------------------------------------------------
SELECT '投資部門別情報' AS data_name,
       COUNT(*)                                AS rows_cnt,
       TO_CHAR(MIN(en_date), 'YYYY-MM-DD')     AS from_date,
       TO_CHAR(MAX(en_date), 'YYYY-MM-DD')     AS to_date
FROM investor_type_trading
UNION ALL
SELECT '信用取引残高',
       COUNT(*), TO_CHAR(MIN(app_date), 'YYYY-MM-DD'), TO_CHAR(MAX(app_date), 'YYYY-MM-DD')
FROM equity_margin_interest
UNION ALL
SELECT '業種別空売り比率',
       COUNT(*), TO_CHAR(MIN(ratio_date), 'YYYY-MM-DD'), TO_CHAR(MAX(ratio_date), 'YYYY-MM-DD')
FROM sector_short_ratio
UNION ALL
SELECT '裁定取引残高(手動取込)',
       COUNT(*), TO_CHAR(MIN(pos_date), 'YYYY-MM-DD'), TO_CHAR(MAX(pos_date), 'YYYY-MM-DD')
FROM arbitrage_balance;

-- SECTION の一覧。冒頭の表と突き合わせて、系列が終わっていないかを確認する。
-- TO_DATE が数年前で止まっている SECTION は2022年の市場区分再編で終了した系列。
SELECT section,
       COUNT(*)                            AS rows_cnt,
       TO_CHAR(MAX(en_date), 'YYYY-MM-DD') AS to_date
FROM investor_type_trading
GROUP BY section
ORDER BY rows_cnt DESC;


--------------------------------------------------------------------------------
-- 2. 投資部門別ネット売買代金(週次・主要部門)
--
-- BAL(差引) がネット。プラスが買い越し、マイナスが売り越し。
-- 元データの単位は千円なので 100000 で割って億円にする。
-- 過誤訂正があるため V_INVESTOR_TYPE_TRADING_LATEST(公表日が最新の行)を使う。
--
-- 【使い方】 params の section を 1 の結果に合わせて変更する。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 'TokyoNagoya' AS section,  -- 冒頭の一覧を参照。長期で見るならここは変えない
           52            AS weeks_back
    FROM dual
)
SELECT TO_CHAR(v.st_date, 'YYYY-MM-DD')            AS st_date,
       TO_CHAR(v.en_date, 'YYYY-MM-DD')            AS en_date,
       ROUND(v.frgn_bal    / 100000, 0)            AS frgn_oku,      -- 海外投資家
       ROUND(v.ind_bal     / 100000, 0)            AS ind_oku,       -- 個人
       ROUND(v.trst_bnk_bal/ 100000, 0)            AS trst_bnk_oku,  -- 信託銀行(年金等)
       ROUND(v.inv_tr_bal  / 100000, 0)            AS inv_tr_oku,    -- 投資信託
       ROUND(v.bus_co_bal  / 100000, 0)            AS bus_co_oku,    -- 事業法人(自社株買い)
       ROUND(v.prop_bal    / 100000, 0)            AS prop_oku,      -- 証券会社の自己売買
       ROUND(v.sec_co_bal  / 100000, 0)            AS sec_co_oku,    -- 証券会社(委託)
       -- 海外投資家の4週移動平均。単週のブレを均して基調を見るため
       ROUND(AVG(v.frgn_bal) OVER (ORDER BY v.en_date
                                   ROWS BETWEEN 3 PRECEDING AND CURRENT ROW)
             / 100000, 0)                          AS frgn_oku_ma4
FROM v_investor_type_trading_latest v
CROSS JOIN params
WHERE v.section = params.section
  AND v.en_date > TRUNC(SYSDATE) - params.weeks_back * 7
ORDER BY v.en_date DESC;


--------------------------------------------------------------------------------
-- 3. 市場全体の信用倍率(週次)
--
-- 【なぜ株数の単純合計ではダメか】
--   信用倍率は本来「買残 ÷ 売残」で銘柄単位の指標。市場全体に拡張するとき、
--   全銘柄の株数をそのまま合計すると、株価1万円の銘柄も100円の銘柄も
--   同じ1株として扱うことになり、低位株の残高に引きずられる。
--   そこで申込日時点の終値を掛けて金額に換算してから合計する。
--   (EQUITY_MARGIN_INTEREST の *_VAL 列は2026/9/25申込分以降しか無いため、
--    過去に遡って比較するにはこの自前換算が必要)
--
-- 【対象銘柄】
--   市場区分がプライム/スタンダード/グロースの銘柄に限定する。
--   ETF・REITは市場区分「その他」に入るため、これで自然に除外される。
--
-- 【3月・9月の権利付最終日の週は信用売残が急増する - 誤読しないこと】
--   実データで確認(2026-09-09):
--     2025-09-22週  信用売残 15,324億円  信用倍率 2.62
--     2026-03-23週  信用売残 15,331億円  信用倍率 3.22
--     平常時        信用売残  8,000〜10,000億円  信用倍率 5〜7
--   どちらも権利付最終日の直前の週。株主優待・配当を取るための
--   つなぎ売り(クロス取引)が集中し、売残が一時的に1.5〜2倍に膨らむ。
--   実需の売り圧力ではなく、権利落ち後に反対売買で消える。
--
--   **信用倍率の低下を「売り長への転換」と読んではいけない週がある**、
--   ということ。日本株では毎年必ず起きる季節性なので、
--   3月末・9月末の前後は前年同期と比べる(前週比では判断しない)。
--   第三階層の「信用倍率1倍割れ」シグナルも同じ理由で
--   この2つの時期は誤検知しやすい(demand_signal_detection.sql 参照)。
--
-- 【株価との結合について】
--   APP_DATE(通常は金曜)が非営業日だとその週の行が丸ごと落ちる。
--   CODES_CNT が他の週と比べて極端に少ない/0の週は結合できていないサイン。
--   4 の診断クエリで確認すること。
--
--   なお、そもそも APP_DATE が存在しない週がある。この場合 7 の結果は
--   信用取引の列だけが NULL になり、CODES_CNT は 0 ではなく空欄になる。
--   「0件だった」のではなく「集計対象の行が1つも無かった」という違い。
--   結合の失敗(CODES_CNT が極端に小さい)と区別するときはこれを見る。
--
-- 【営業日が少ない週は信用取引残高が公表されない - 欠測は正常】
--   2026-09-09 に全期間を調べた結果、信用残が1件も無い週は10年で13週あり、
--   **その全てが営業日2日以下の週**(GWまたは年末年始)だった:
--     2017-05-01(2日) 2018-01-01(2日) 2018-04-30(2日) 2018-12-31(1日)
--     2019-12-30(1日) 2020-05-04(2日) 2021-05-03(2日) 2022-05-02(2日)
--     2023-05-01(2日) 2024-01-01(2日) 2024-12-30(1日) 2025-12-29(2日)
--     2026-05-04(2日)
--   GWが欠測する年としない年があるのは、その年のGW週の営業日数の違いで説明がつく。
--   取り込み漏れではなく、JPXが公表していない。
--
--   **これは「残高がゼロになった」ではなく「集計・公表されていない」**。
--   J-Quantsの仕様書にも「対象日にレコードが存在しないことは、値がゼロで
--   あることを意味しません」と明記されている(残高系データ共通の注意)。
--   グラフを描くときは0でプロットせず、線を切ること。
--
--   欠測週を洗い直したいときのクエリ:
--     WITH wk AS (SELECT TRUNC(calendar_date,'IW') AS week_start,
--                        MAX(calendar_date) AS last_td, COUNT(*) AS td
--                 FROM trading_calendar WHERE hol_div IN ('1','2')
--                   AND calendar_date <= TRUNC(SYSDATE)
--                 GROUP BY TRUNC(calendar_date,'IW')),
--          mg AS (SELECT DISTINCT TRUNC(app_date,'IW') AS week_start
--                 FROM equity_margin_interest)
--     SELECT wk.week_start, wk.last_td, wk.td
--     FROM wk LEFT JOIN mg ON mg.week_start = wk.week_start
--     WHERE mg.week_start IS NULL
--       AND wk.week_start >= (SELECT MIN(TRUNC(app_date,'IW'))
--                             FROM equity_margin_interest)
--     ORDER BY wk.week_start;
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 52 AS weeks_back FROM dual
),
mgn AS (
    SELECT m.app_date,
           SUM(m.long_vol * p.close_price)  AS long_val,
           SUM(m.shrt_vol * p.close_price)  AS shrt_val,
           SUM(m.long_vol)                  AS long_vol,
           SUM(m.shrt_vol)                  AS shrt_vol,
           COUNT(*)                         AS codes_cnt
    FROM equity_margin_interest m
    CROSS JOIN params
    JOIN equity_master em
      ON em.code = m.code
     AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
    JOIN equity_price_daily p
      ON p.code = m.code
     AND p.price_date = m.app_date
    WHERE m.app_date > TRUNC(SYSDATE) - params.weeks_back * 7
      AND p.close_price IS NOT NULL
    GROUP BY m.app_date
)
SELECT TO_CHAR(app_date, 'YYYY-MM-DD')                       AS app_date,
       ROUND(long_val / 100000000, 0)                        AS long_oku,
       ROUND(shrt_val / 100000000, 0)                        AS shrt_oku,
       ROUND(long_val / NULLIF(shrt_val, 0), 2)              AS margin_ratio_val,
       ROUND(long_vol / NULLIF(shrt_vol, 0), 2)              AS margin_ratio_vol,
       ROUND((long_val - LAG(long_val) OVER (ORDER BY app_date))
             / 100000000, 0)                                 AS long_wow_oku,
       ROUND((shrt_val - LAG(shrt_val) OVER (ORDER BY app_date))
             / 100000000, 0)                                 AS shrt_wow_oku,
       codes_cnt
FROM mgn
ORDER BY app_date DESC;


--------------------------------------------------------------------------------
-- 4. 3 の結合診断(株価と結合できなかった申込日を洗い出す)
--
-- 3 で CODES_CNT が落ち込む週があったらこれを流す。
-- MISSING_PRICE が多い申込日は、その日が非営業日である可能性が高い。
--------------------------------------------------------------------------------
SELECT TO_CHAR(m.app_date, 'YYYY-MM-DD')                        AS app_date,
       TO_CHAR(m.app_date, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH')   AS dow,
       COUNT(*)                                                 AS margin_rows,
       COUNT(p.code)                                            AS matched_price,
       COUNT(*) - COUNT(p.code)                                 AS missing_price
FROM equity_margin_interest m
LEFT JOIN equity_price_daily p
       ON p.code = m.code
      AND p.price_date = m.app_date
WHERE m.app_date > TRUNC(SYSDATE) - 365
GROUP BY m.app_date
HAVING COUNT(*) - COUNT(p.code) > COUNT(*) * 0.1
ORDER BY m.app_date DESC;


--------------------------------------------------------------------------------
-- 5. 市場全体の空売り比率(週次)
--
-- 33業種を全て足し上げれば市場全体になる。金額(円)ベース。
--   空売り比率 = 空売り代金 ÷ (実注文の売り代金 + 空売り代金)
-- 価格規制有り(SHRT_WITH_RES_VA)は、直近の下落幅が一定を超えた銘柄への空売り。
-- 下落局面で構成比が上がるので、比率の水準だけでなく内訳も見ると質が分かる。
--------------------------------------------------------------------------------
SELECT TO_CHAR(TRUNC(r.ratio_date, 'IW'), 'YYYY-MM-DD')      AS week_start,
       COUNT(DISTINCT r.ratio_date)                          AS days_cnt,
       ROUND(SUM(r.shrt_with_res_va + r.shrt_no_res_va)
             / NULLIF(SUM(r.sell_ex_short_va + r.shrt_with_res_va
                          + r.shrt_no_res_va), 0) * 100, 2)  AS short_ratio_pct,
       ROUND(SUM(r.shrt_with_res_va)
             / NULLIF(SUM(r.shrt_with_res_va + r.shrt_no_res_va), 0) * 100, 2)
                                                             AS with_restriction_pct,
       ROUND(SUM(r.sell_ex_short_va + r.shrt_with_res_va + r.shrt_no_res_va)
             / 100000000, 0)                                 AS sell_total_oku
FROM sector_short_ratio r
WHERE r.ratio_date > TRUNC(SYSDATE) - 52 * 7
GROUP BY TRUNC(r.ratio_date, 'IW')
ORDER BY week_start DESC;


--------------------------------------------------------------------------------
-- 6. 業種別の空売り比率(直近週・上位)
--
-- 市場全体だけ見ていると「どこが売られているか」が消える。
-- 33業種のまま出せるのは、書籍のダッシュボードより一段細かい情報になる。
--------------------------------------------------------------------------------
WITH latest_week AS (
    SELECT MAX(TRUNC(ratio_date, 'IW')) AS week_start FROM sector_short_ratio
),
sector_name AS (
    -- 業種名は1業種1行に潰してから結合する。EQUITY_MASTER をそのまま結合すると
    -- 1業種に数百銘柄あるぶんだけ SECTOR_SHORT_RATIO の行が複製され、
    -- 売買代金の合計が銘柄数倍に膨らむ(比率は分母分子とも同じ倍率なので気づきにくい)
    SELECT sector33_code, MIN(sector33_name) AS sector33_name
    FROM equity_master
    WHERE sector33_code IS NOT NULL
    GROUP BY sector33_code
)
SELECT r.s33_code,
       MAX(sn.sector33_name)                                  AS sector33_name,
       ROUND(SUM(r.shrt_with_res_va + r.shrt_no_res_va)
             / NULLIF(SUM(r.sell_ex_short_va + r.shrt_with_res_va
                          + r.shrt_no_res_va), 0) * 100, 2)   AS short_ratio_pct,
       ROUND(SUM(r.sell_ex_short_va + r.shrt_with_res_va + r.shrt_no_res_va)
             / 100000000, 0)                                  AS sell_total_oku
FROM sector_short_ratio r
CROSS JOIN latest_week w
LEFT JOIN sector_name sn ON sn.sector33_code = r.s33_code
WHERE TRUNC(r.ratio_date, 'IW') = w.week_start
GROUP BY r.s33_code
ORDER BY short_ratio_pct DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 7. 【本命】マクロ需給ダッシュボード 一枚もの
--
-- 4データを週単位で横に並べ、各列の前週比(_WOW)を添える。
-- HTML側はこの結果をそのまま表にして、_WOW の符号で色を付ければよい。
--
-- 骨格(WK)は取引カレンダーの営業日から作る。データが無い週も行として残るため、
-- 「まだ公表されていない」のか「取込漏れ」なのかを見分けられる。
--
-- 【使い方】 params の section と weeks_back を変更する。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 'TokyoNagoya' AS section,  -- 冒頭の一覧を参照。長期で見るならここは変えない
           52            AS weeks_back
    FROM dual
),
wk AS (
    SELECT DISTINCT TRUNC(c.calendar_date, 'IW') AS week_start
    FROM trading_calendar c
    CROSS JOIN params
    WHERE c.hol_div IN ('1', '2')
      AND c.calendar_date <= TRUNC(SYSDATE)
      AND c.calendar_date >  TRUNC(SYSDATE) - params.weeks_back * 7
),
inv AS (
    SELECT TRUNC(v.en_date, 'IW')  AS week_start,
           SUM(v.frgn_bal)         AS frgn_bal,
           SUM(v.ind_bal)          AS ind_bal,
           SUM(v.trst_bnk_bal)     AS trst_bnk_bal,
           SUM(v.bus_co_bal)       AS bus_co_bal
    FROM v_investor_type_trading_latest v
    CROSS JOIN params
    WHERE v.section = params.section
      AND v.en_date > TRUNC(SYSDATE) - params.weeks_back * 7
    GROUP BY TRUNC(v.en_date, 'IW')
),
mgn AS (
    SELECT TRUNC(m.app_date, 'IW')              AS week_start,
           MAX(m.app_date)                      AS app_date,
           SUM(m.long_vol * p.close_price)      AS long_val,
           SUM(m.shrt_vol * p.close_price)      AS shrt_val,
           COUNT(*)                             AS codes_cnt
    FROM equity_margin_interest m
    CROSS JOIN params
    JOIN equity_master em
      ON em.code = m.code
     AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
    JOIN equity_price_daily p
      ON p.code = m.code
     AND p.price_date = m.app_date
    WHERE m.app_date > TRUNC(SYSDATE) - params.weeks_back * 7
      AND p.close_price IS NOT NULL
    GROUP BY TRUNC(m.app_date, 'IW')
),
ssr AS (
    SELECT TRUNC(r.ratio_date, 'IW')                        AS week_start,
           SUM(r.shrt_with_res_va + r.shrt_no_res_va)       AS short_va,
           SUM(r.sell_ex_short_va + r.shrt_with_res_va
               + r.shrt_no_res_va)                          AS sell_total_va
    FROM sector_short_ratio r
    CROSS JOIN params
    WHERE r.ratio_date > TRUNC(SYSDATE) - params.weeks_back * 7
    GROUP BY TRUNC(r.ratio_date, 'IW')
),
arb AS (
    SELECT TRUNC(a.pos_date, 'IW')                 AS week_start,
           MAX(a.buy_tot_val  - a.sell_tot_val)    AS net_val,
           MAX(a.buy_tot_val)                      AS buy_val
    FROM arbitrage_balance a
    CROSS JOIN params
    WHERE a.pos_date > TRUNC(SYSDATE) - params.weeks_back * 7
    GROUP BY TRUNC(a.pos_date, 'IW')
),
idx AS (
    -- 週末のグロース/バリュー/電機・精密の終値。
    -- TOPIXだけでは見えない「中で何が売られたか」を捉えるための文脈列(冒頭参照)。
    SELECT week_start,
           MAX(CASE WHEN index_code = '8200' THEN close_price END) AS growth_close,
           MAX(CASE WHEN index_code = '8100' THEN close_price END) AS value_close,
           MAX(CASE WHEN index_code = '0088' THEN close_price END) AS elec_close
    FROM (
        SELECT TRUNC(i.price_date, 'IW') AS week_start,
               i.index_code,
               i.close_price,
               ROW_NUMBER() OVER (PARTITION BY i.index_code, TRUNC(i.price_date, 'IW')
                                  ORDER BY i.price_date DESC) AS rn
        FROM index_price_daily i
        CROSS JOIN params
        WHERE i.index_code IN ('8100', '8200', '0088')
          AND i.price_date > TRUNC(SYSDATE) - params.weeks_back * 7
    )
    WHERE rn = 1
    GROUP BY week_start
),
tpx AS (
    -- 週末のTOPIX終値。需給の変化と値動きを同じ行で見るための文脈列
    SELECT week_start, close_price
    FROM (
        SELECT TRUNC(t.price_date, 'IW') AS week_start,
               t.close_price,
               ROW_NUMBER() OVER (PARTITION BY TRUNC(t.price_date, 'IW')
                                  ORDER BY t.price_date DESC) AS rn
        FROM topix_price_daily t
        CROSS JOIN params
        WHERE t.price_date > TRUNC(SYSDATE) - params.weeks_back * 7
    )
    WHERE rn = 1
),
joined AS (
    SELECT wk.week_start,
           tpx.close_price                                  AS topix_close,
           idx.growth_close / NULLIF(idx.value_close, 0)    AS gv_ratio,
           idx.elec_close,
           inv.frgn_bal,
           inv.ind_bal,
           inv.trst_bnk_bal,
           inv.bus_co_bal,
           arb.net_val                                      AS arb_net_val,
           mgn.long_val / NULLIF(mgn.shrt_val, 0)           AS margin_ratio,
           mgn.long_val                                     AS margin_long_val,
           mgn.shrt_val                                     AS margin_shrt_val,
           mgn.codes_cnt                                    AS margin_codes_cnt,
           ssr.short_va / NULLIF(ssr.sell_total_va, 0) * 100 AS short_ratio_pct
    FROM wk
    LEFT JOIN inv ON inv.week_start = wk.week_start
    LEFT JOIN mgn ON mgn.week_start = wk.week_start
    LEFT JOIN ssr ON ssr.week_start = wk.week_start
    LEFT JOIN arb ON arb.week_start = wk.week_start
    LEFT JOIN tpx ON tpx.week_start = wk.week_start
    LEFT JOIN idx ON idx.week_start = wk.week_start
)
SELECT TO_CHAR(week_start, 'YYYY-MM-DD')                        AS week_start,
       ROUND(topix_close, 2)                                    AS topix_close,
       ROUND((topix_close / NULLIF(LAG(topix_close)
              OVER (ORDER BY week_start), 0) - 1) * 100, 2)      AS topix_wow_pct,
       -- グロース/バリューの乖離。TOPIXの中で何が売られたかを見る
       ROUND(gv_ratio, 4)                                       AS gv_ratio,
       ROUND((gv_ratio / NULLIF(LAG(gv_ratio)
              OVER (ORDER BY week_start), 0) - 1) * 100, 2)      AS gv_ratio_wow,
       ROUND((elec_close / NULLIF(LAG(elec_close)
              OVER (ORDER BY week_start), 0) - 1) * 100, 2)      AS elec_wow_pct,
       -- 投資部門別ネット(億円)
       ROUND(frgn_bal     / 100000, 0)                          AS frgn_oku,
       ROUND(ind_bal      / 100000, 0)                          AS ind_oku,
       ROUND(trst_bnk_bal / 100000, 0)                          AS trst_bnk_oku,
       ROUND(bus_co_bal   / 100000, 0)                          AS bus_co_oku,
       ROUND((frgn_bal - LAG(frgn_bal) OVER (ORDER BY week_start))
             / 100000, 0)                                       AS frgn_wow_oku,
       -- 裁定取引残高ネット(億円)
       ROUND(arb_net_val / 100000000, 0)                        AS arb_net_oku,
       ROUND((arb_net_val - LAG(arb_net_val) OVER (ORDER BY week_start))
             / 100000000, 0)                                    AS arb_net_wow_oku,
       -- 市場全体の信用倍率
       ROUND(margin_ratio, 2)                                   AS margin_ratio,
       ROUND(margin_ratio - LAG(margin_ratio) OVER (ORDER BY week_start), 2)
                                                                AS margin_ratio_wow,
       ROUND(margin_long_val / 100000000, 0)                    AS margin_long_oku,
       ROUND(margin_shrt_val / 100000000, 0)                    AS margin_shrt_oku,
       margin_codes_cnt,
       -- 市場全体の空売り比率
       ROUND(short_ratio_pct, 2)                                AS short_ratio_pct,
       ROUND(short_ratio_pct - LAG(short_ratio_pct) OVER (ORDER BY week_start), 2)
                                                                AS short_ratio_wow
FROM joined
ORDER BY week_start DESC;
