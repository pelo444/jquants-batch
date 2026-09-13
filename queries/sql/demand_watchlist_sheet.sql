--------------------------------------------------------------------------------
-- 第二階層: ウォッチリスト銘柄の需給シート
--
-- 監視銘柄ごとの需給データを1行にまとめ、必要に応じて時系列に展開する。
--   ・大量保有報告書の提出状況と保有割合の推移  LARGE_VOLUME_SHAREHOLDER   (随時)
--   ・信用買残・売残の推移                      EQUITY_MARGIN_INTEREST     (週次→日次)
--   ・空売り残高の推移                          V_EQUITY_SHORT_POSITION_SUM(随時)
--   ・浮動株比率                                ※直接のデータは無い。近似で代用(6参照)
--   ・直近の出来高と20日平均出来高の比較        EQUITY_PRICE_DAILY         (日次)
--
-- 前提: ddl/08・ddl/13・ddl/14・ddl/15 を実行し、取り込みが済んでいること。
--
-- 【対象銘柄の指定方法】
--   既定は FAVORITE_MASTER.IS_WATCHING = 1。
--   タグで絞りたい場合は各クエリの TARGET CTE をコメントの通り差し替える。
--
-- 【割合の表現に注意】
--   J-Quants由来の保有割合・空売り残高割合は全て小数表現(0.0572 = 5.72%)。
--   本ファイルでは表示時に 100 を掛けて % に直している。しきい値を書くときに
--   0.05 と 5 を取り違えると桁が100倍ずれるので、比較は必ず小数側で行うこと。
--
-- 【分割の扱い】
--   EQUITY_MARGIN_INTEREST は分割の遡及調整が行われない(調整係数も無い)。
--   出来高(EQUITY_PRICE_DAILY.VOLUME)も生の株数。
--   期間内に分割があると株数の基準が途中で変わるため、各クエリは SPLIT_FLAG を
--   返す。'Y' の銘柄は残高・出来高の前後比較を鵜呑みにしないこと。
--
-- 【大量保有報告書のデータ期間(2026-09-13 実データで確認)】
--   取り込みは2021-07-01開始。全銘柄で4,215銘柄/65,311件、欠損は無い。
--   ウォッチ21銘柄は全銘柄に書類があり(594件)、大量保有の列は基本的に埋まる。
--   ただし0件になり得る理由は残る: 2021-07以前から保有し続けていて以降1度も
--   変更報告書を出していない大量保有者は、このテーブルに現れない。
--   **LVS_GRP_CNT = 0 は「大量保有者がいない」ではなく「この5年で動きが無かった」。**
--   ウォッチ銘柄を入れ替えたときは 1 の2本目で書類の有無を確認すること。
--
-- 【空売り残高報告が空になるのは正常(大型株ほど起きる)】
--   V_EQUITY_SHORT_POSITION_SUM は残高割合0.5%以上の報告分だけ。時価総額が大きい
--   銘柄ほど0.5%の金額が大きく、報告者が1人も出ない状態が普通にある。
--   SHORT_RATIO_PCT が NULL なのは「空売り残高ゼロ」ではなく「0.5%以上の報告が無い」。
--   グラフでは0でプロットせず線を切ること(残高系データ共通の仕様)。
--   ウォッチリストはプライムの大型株が中心のため、この列は欠測が多くなる。
--
-- 【この階層の位置づけ】
--   需給5指標の予測力は10年分で検証済みで、いずれも先行リターンの方向を
--   予測できなかった(queries/sql/demand_signal_backtest.sql)。
--   このシートは「いま何が起きているか」の描写と、注目銘柄を絞り込むフィルタとして
--   使う。単独の売買判断の根拠にはしない。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. ウォッチリストの確認
--
-- 何も返らなければ FAVORITE_MASTER が空。先にここを埋める必要がある。
--------------------------------------------------------------------------------
SELECT f.code,
       em.co_name,
       em.market_name,
       em.sector33_name,
       f.is_watching,
       f.is_buy_candidate,
       f.ref_note1
FROM favorite_master f
JOIN equity_master em ON em.code = f.code
WHERE f.is_watching = 1
ORDER BY f.code;

-- 大量保有報告書がウォッチ銘柄に何件あるかの確認。
-- 提供開始が2021-07-01と新しく、全銘柄でも書類数はそれほど多くない。
-- 0件なら 3・4 は空振りするので、先にこれを見ておく。
SELECT COUNT(DISTINCT l.code) AS codes_with_doc,
       COUNT(*)               AS docs_cnt,
       TO_CHAR(MIN(l.sub_date), 'YYYY-MM-DD') AS from_date,
       TO_CHAR(MAX(l.sub_date), 'YYYY-MM-DD') AS to_date
FROM large_volume_shareholder l
WHERE EXISTS (SELECT 1 FROM favorite_master f
              WHERE f.code = l.code AND f.is_watching = 1);


--------------------------------------------------------------------------------
-- 2. 【本命】需給シート 一枚もの(ウォッチ銘柄 × 最新断面)
--
-- 1銘柄1行。HTML側はこれをそのまま表にする。
--
-- 【20日平均出来高の取り方】
--   直近日を含めずに、その前の20営業日の平均を分母にしている。
--   直近日を含めると急増した当日の出来高が平均を押し上げ、倍率が鈍るため。
--
-- 【大量保有は「提出者グループごとの最新」を足し上げる(2026-09-13 実データを見て変更)】
--   ウォッチ銘柄には5年で594件、1銘柄あたり平均28件あった。ほとんどが変更報告書で、
--   複数の提出者グループが並行して報告している。「銘柄の直近1件」だけを見ると
--   たまたま最後に報告したグループの保有割合しか映らず、他グループの保有が消える。
--   提出者ごとに最新の1件を取り、そのうえで合計する。
--
--   ・LVS_TOTAL_PCT が高い(50%前後)ことは、それ自体では異常ではない。
--     SHIFT の 58.6% を 7 で分解したところ、内訳は創業者の丹下大 33.18% +
--     機関投資家4者で、二重計上ではなく実態だった(2026-09-13)。
--     オーナー系・親子上場の銘柄では普通に高く出る。%の水準に閾値を引いて
--     警告を出すのはやめた(誤検知になる)。
--   ・代わりに効くのは**鮮度**。同じ分解で、ゴールドマン・サックス証券の 5.05% が
--     1,514日前(2022-07-22)の報告のまま「保有中」として合計に乗っていた。
--     報告義務が切れた後は更新されないため、古い報告ほど実態と乖離する。
--     LVS_GRP_CNT_STALE(params.lvs_stale_days、既定365日)で何グループが古いかを示す。
--   ・共同保有者が別々に報告していると重複して足し込まれる余地は残る。
--     **水準そのものより「グループ数」と「直近の変化」を見ること。** 内訳は 7。
--   ・最新報告で5%未満に落ちたグループは退出済みとして合計から外す(PARAMS.LVS_MIN_RATIO)。
--     ただし最後の報告のあとに5%未満へ売り切った分は報告義務が無く、見えない。
--
-- 【LVS_GRP_CNT = 0 は「大量保有者がいない」ではない】
--   取り込みは2021-07-01開始。それ以前から保有していて以降1度も変更報告書を
--   出していない大量保有者は、DBに存在しない。0 は「この5年で動きが無かった」。
--
-- 【MARGIN_SEASON_WARN】
--   3月・9月の権利付最終日前の週は、優待・配当のつなぎ売り(クロス取引)で信用売残が
--   1.5〜2倍に膨らむ。MARGIN_RATIO の低下を「売り長への転換」と読むと誤る。
--   該当しうる申込日に 'CROSS' を立てる。立っている週は前週比ではなく前年同期と比べる。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 0.05  AS lvs_min_ratio,   -- 大量保有者として数える下限(5% = 報告義務の基準)
           0.005 AS short_min_ratio, -- 空売り残高の報告義務基準(0.5%)
           365   AS lvs_stale_days   -- 大量保有の最終報告がこれより古いと「古い」扱い
    FROM dual
),
target AS (
    SELECT f.code
    FROM favorite_master f
    WHERE f.is_watching = 1
    -- タグで絞る場合はここを差し替える:
    -- SELECT t.code FROM favorite_tag t WHERE t.tag_name IN ('130_semi_equip_material')
),
px AS (
    -- 走査量を抑えるため直近4か月だけを見る(20営業日の平均に十分足りる)
    SELECT p.code,
           p.price_date,
           p.close_price,
           p.volume,
           AVG(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           -- 平均に使えた営業日数。20未満なら「20日平均」ではない(上場直後など)
           COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
               OVER (PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)           AS split_flag,
           ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
    FROM equity_price_daily p
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
      AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
),
px_latest AS (
    SELECT code, price_date, close_price, volume, avg_vol_20d, avg_vol_n, split_flag
    FROM px WHERE rn = 1
),
mgn AS (
    -- 最新2時点の信用残。前週比(または前日比)を出すため2行取る
    SELECT code,
           MAX(CASE WHEN rn = 1 THEN app_date END)  AS app_date,
           MAX(CASE WHEN rn = 1 THEN long_vol END)  AS long_vol,
           MAX(CASE WHEN rn = 1 THEN shrt_vol END)  AS shrt_vol,
           MAX(CASE WHEN rn = 2 THEN app_date END)  AS app_date_prev,
           MAX(CASE WHEN rn = 2 THEN long_vol END)  AS long_vol_prev,
           MAX(CASE WHEN rn = 2 THEN shrt_vol END)  AS shrt_vol_prev
    FROM (
        SELECT m.code, m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
          AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -6)
    )
    WHERE rn <= 2
    GROUP BY code
),
sp AS (
    -- 最新2時点の空売り残高報告(銘柄×計算日の合算)
    SELECT code,
           MAX(CASE WHEN rn = 1 THEN calc_date END)         AS calc_date,
           MAX(CASE WHEN rn = 1 THEN total_shrt_ratio END)  AS shrt_ratio,
           MAX(CASE WHEN rn = 1 THEN total_shrt_shares END) AS shrt_shares,
           MAX(CASE WHEN rn = 1 THEN reporter_count END)    AS reporter_count,
           MAX(CASE WHEN rn = 2 THEN total_shrt_ratio END)  AS shrt_ratio_prev
    FROM (
        SELECT v.code, v.calc_date, v.total_shrt_ratio, v.total_shrt_shares,
               v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = v.code)
    )
    WHERE rn <= 2
    GROUP BY code
),
lvs_grp AS (
    -- 提出者グループごとの最新1件。
    --
    -- 【TOTAL_SHS_RATIO は2割の書類でNULL。補完は保有者1名の書類に限る】
    --   ウォッチ21銘柄の594件中、親に保有割合が入っているのは426件(2026-09-13)。
    --   NULLの書類でも子テーブル(保有者明細)の SHS_RATIO は埋まっている。
    --
    --   ただし **子の合計で親を再現できるとは限らない**。親が入っている426件で
    --   検算したところ、62件で一致せず最大13.72ポイントずれた。共同保有者が
    --   同じ株を重複して計上し、親の合計欄では重複を除いているためと思われる。
    --
    --   【この補完は検算を通ったのではない。構造的な理由で採っている】
    --   保有者数で層別したところ、594件は次の3つにしか分かれなかった:
    --     親あり  / 保有者2名以上 … 426件
    --     親NULL / 保有者1名     … 116件
    --     親NULL / 保有者2名以上 …  52件
    --   **「親あり かつ 保有者1名」は0件**。つまり親の合計欄は共同保有者がいる
    --   ときだけ埋まる(1名なら本人の割合が答えなので冗長)。その結果、
    --   1名の書類で親子が一致するかを確かめる標本が存在しない。
    --   それでも1名に限って補完してよい理由は、合計＝本人の割合で算術的に
    --   曖昧さが無く、ズレの原因である重複計上が1名では起こり得ないため。
    --   検証したのではなく構造から言えるだけ、という区別は残しておくこと。
    --
    --   → 保有者1名の書類だけ補完する(LVS_RATIO_IMPUTED = 'Y')。
    --     2名以上でNULLの52件は補完せずNULLのまま出し、LVS_GRP_CNT_NORATIO で
    --     何グループが割合不明かを示す。LVS_LAST_DIRECTION は '割合なし'。
    --
    --   COALESCE を使うのは、NVL と違って第1引数が非NULLなら第2引数を評価しない
    --   ため(NULLの書類だけスカラー副問合せが走る)。
    --   NULLを0とみなさないこと。保有割合0%と「割合の記載が無い」は別物で、
    --   0にすると LVS_TOTAL_PCT が実態より小さく出る。
    --
    -- 【取り違え注意】LARGE_VOLUME_SHAREHOLDER.EDINET_CODE / ISR_NAME は
    --   「発行者」(= 対象銘柄の会社)であって提出者ではない(ddl/14 の列コメント)。
    --   提出者は子テーブルの HLDR_SEQ = 1 の行(HLDR_EDINET_CODE / HLDR_NAME)。
    --   親側のコードでグルーピングすると全書類が1グループに潰れる。
    --
    --   個人の提出者は HLDR_EDINET_CODE が NULL になり得るため氏名で代替する。
    --   氏名も NULL の書類があれば、それらは1グループに混ざる(実害が出たら要見直し)。
    SELECT code, grp_key, grp_name, sub_date, doc_id, ratio_imputed,
           total_shs_ratio, total_shs_ratio_last, total_out_stks, large_hldg_type_code
    FROM (
        SELECT l.code,
               NVL(h.hldr_edinet_code, h.hldr_name)  AS grp_key,
               h.hldr_name                           AS grp_name,
               l.sub_date, l.doc_id,
               l.total_out_stks, l.large_hldg_type_code,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio,
               COALESCE(l.total_shs_ratio_last,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio_last,
               CASE WHEN l.total_shs_ratio IS NULL
                     AND (SELECT COUNT(*) FROM large_volume_shareholder_holder hh
                          WHERE hh.doc_id = l.doc_id) = 1
                    THEN 'Y' END                                           AS ratio_imputed,
               ROW_NUMBER() OVER (
                   PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)                AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)
    )
    WHERE rn = 1
),
lvs AS (
    SELECT g.code,
           COUNT(CASE WHEN g.total_shs_ratio >= p.lvs_min_ratio THEN 1 END) AS grp_cnt,
           SUM(CASE WHEN g.total_shs_ratio >= p.lvs_min_ratio
                    THEN g.total_shs_ratio END)                            AS total_ratio,
           COUNT(*)                                                        AS grp_cnt_all,
           MAX(g.sub_date)                                                 AS last_sub_date,
           MAX(g.grp_name) KEEP (DENSE_RANK LAST
                                 ORDER BY g.sub_date, g.doc_id)            AS last_grp_name,
           MAX(g.total_shs_ratio) KEEP (DENSE_RANK LAST
                                 ORDER BY g.sub_date, g.doc_id)            AS last_ratio,
           MAX(g.total_shs_ratio_last) KEEP (DENSE_RANK LAST
                                 ORDER BY g.sub_date, g.doc_id)            AS last_ratio_prev,
           MAX(g.total_out_stks) KEEP (DENSE_RANK LAST
                                 ORDER BY g.sub_date, g.doc_id)            AS total_out_stks,
           MAX(g.ratio_imputed)                                            AS ratio_imputed,
           COUNT(CASE WHEN g.total_shs_ratio IS NULL THEN 1 END)            AS grp_cnt_noratio,
           COUNT(CASE WHEN g.total_shs_ratio >= p.lvs_min_ratio
                       AND g.sub_date < TRUNC(SYSDATE) - p.lvs_stale_days
                      THEN 1 END)                                          AS grp_cnt_stale
    FROM lvs_grp g
    CROSS JOIN params p
    GROUP BY g.code
)
SELECT em.code,
       em.co_name,
       em.market_name,
       em.sector33_name,
       -- 出来高
       TO_CHAR(px_latest.price_date, 'YYYY-MM-DD')                  AS price_date,
       px_latest.close_price,
       px_latest.volume,
       ROUND(px_latest.avg_vol_20d)                                 AS avg_vol_20d,
       px_latest.avg_vol_n                                          AS avg_vol_n,
       ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
       NVL(px_latest.split_flag, 'N')                               AS split_flag,
       -- 信用取引残高
       TO_CHAR(mgn.app_date, 'YYYY-MM-DD')                          AS margin_date,
       mgn.long_vol                                                 AS margin_long_vol,
       mgn.shrt_vol                                                 AS margin_shrt_vol,
       ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)             AS margin_ratio,
       mgn.long_vol - mgn.long_vol_prev                             AS margin_long_chg,
       mgn.shrt_vol - mgn.shrt_vol_prev                             AS margin_shrt_chg,
       ROUND(mgn.shrt_vol / NULLIF(px_latest.avg_vol_20d, 0), 2)    AS margin_shrt_dtc,
       CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
             AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
            THEN 'CROSS' END                                        AS margin_season_warn,
       -- 空売り残高報告(0.5%以上の報告分のみ)
       TO_CHAR(sp.calc_date, 'YYYY-MM-DD')                          AS short_calc_date,
       ROUND(sp.shrt_ratio * 100, 2)                                AS short_ratio_pct,
       ROUND((sp.shrt_ratio - sp.shrt_ratio_prev) * 100, 2)         AS short_ratio_chg_pt,
       sp.reporter_count,
       ROUND(sp.shrt_shares / NULLIF(px_latest.avg_vol_20d, 0), 2)  AS short_dtc,
       TRUNC(SYSDATE) - sp.calc_date                                AS short_days_since,
       CASE WHEN sp.calc_date IS NULL              THEN '報告なし'
            WHEN sp.shrt_ratio >= p.short_min_ratio THEN '残高あり'
            ELSE '報告終了' END                                      AS short_status,
       -- 大量保有報告書(提出者グループごとの最新を集約)
       NVL(lvs.grp_cnt, 0)                                          AS lvs_grp_cnt,
       NVL(lvs.grp_cnt_all, 0)                                      AS lvs_grp_cnt_all,
       -- 割合不明のグループ数。LVS_TOTAL_PCT はこの分だけ過小になっている
       NVL(lvs.grp_cnt_noratio, 0)                                  AS lvs_grp_cnt_noratio,
       -- 最終報告が1年以上前のグループ数。多いほど LVS_TOTAL_PCT は過去の姿
       NVL(lvs.grp_cnt_stale, 0)                                    AS lvs_grp_cnt_stale,
       NVL(lvs.ratio_imputed, 'N')                                  AS lvs_ratio_imputed,
       ROUND(lvs.total_ratio * 100, 2)                              AS lvs_total_pct,
       TO_CHAR(lvs.last_sub_date, 'YYYY-MM-DD')                     AS lvs_last_sub_date,
       lvs.last_grp_name                                            AS lvs_last_holder,
       ROUND(lvs.last_ratio * 100, 2)                               AS lvs_last_ratio_pct,
       ROUND((lvs.last_ratio - lvs.last_ratio_prev) * 100, 2)       AS lvs_last_chg_pt,
       -- 【NULLをELSEで飲み込まないこと】TOTAL_SHS_RATIO が NULL の書類が実在する
       --   (2026-09-13 実データで確認)。素直にCASEを書くと NULL 同士の比較が
       --   全て偽になり、最後の ELSE '変化なし' に落ちて「変化なし」と嘘をつく。
       --   demand_backtest_results.md の AVG(CASE WHEN x > 0 ...) と同じ壊れ方。
       CASE
         WHEN lvs.last_sub_date IS NULL              THEN NULL
         WHEN lvs.last_ratio IS NULL                 THEN '割合なし'
         WHEN lvs.last_ratio_prev IS NULL            THEN '新規'
         WHEN lvs.last_ratio > lvs.last_ratio_prev   THEN '買い増し'
         WHEN lvs.last_ratio < lvs.last_ratio_prev   THEN '売り減らし'
         ELSE '変化なし'
       END                                                          AS lvs_last_direction,
       -- 【その書類時点の発行済株式数】直近書類が分割前なら旧株数が返る。
       --   SHIFTの2022年の書類は17,811,114、2026年の書類は267,500,670で15倍違う。
       --   現在の発行済株式数が要るときは FINANCIAL_SUMMARY.SH_OUT_FY を使う(6参照)。
       lvs.total_out_stks                                           AS lvs_out_stks_at_doc
FROM equity_master em
CROSS JOIN params p
JOIN target                ON target.code    = em.code
LEFT JOIN px_latest        ON px_latest.code = em.code
LEFT JOIN mgn              ON mgn.code       = em.code
LEFT JOIN sp               ON sp.code        = em.code
LEFT JOIN lvs              ON lvs.code       = em.code
ORDER BY vol_vs_20d DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 3. 個別銘柄の需給時系列(信用残・空売り残・出来高を週次で並べる)
--
-- 2 の一枚ものが「今どうなっているか」なのに対し、これは「どう変わってきたか」。
-- 銘柄詳細ページのグラフ元データとして使う。
--
-- 【使い方】 params の code を変更する(5桁。4桁で入力しない)。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT '68570' AS code,      -- ← 見たい銘柄に変更する(5桁)
           104     AS weeks_back -- 約2年
    FROM dual
),
wk_price AS (
    -- 週次に集約: 週末終値・週間出来高合計
    SELECT TRUNC(p.price_date, 'IW')                             AS week_start,
           SUM(p.volume)                                         AS week_volume,
           MAX(p.close_price) KEEP (DENSE_RANK LAST
                                    ORDER BY p.price_date)       AS week_close,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)         AS split_flag
    FROM equity_price_daily p
    CROSS JOIN params
    WHERE p.code = params.code
      AND p.price_date > TRUNC(SYSDATE) - params.weeks_back * 7
    GROUP BY TRUNC(p.price_date, 'IW')
),
wk_margin AS (
    -- 信用残は週次(2026/9/25以降は日次)。日次になった後も週の最終申込日を採る
    SELECT week_start, app_date, long_vol, shrt_vol
    FROM (
        SELECT TRUNC(m.app_date, 'IW') AS week_start,
               m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        CROSS JOIN params
        WHERE m.code = params.code
          AND m.app_date > TRUNC(SYSDATE) - params.weeks_back * 7
    )
    WHERE rn = 1
),
wk_short AS (
    SELECT week_start, calc_date, total_shrt_ratio, reporter_count, total_shrt_shares
    FROM (
        SELECT TRUNC(v.calc_date, 'IW') AS week_start,
               v.calc_date, v.total_shrt_ratio, v.reporter_count, v.total_shrt_shares,
               ROW_NUMBER() OVER (PARTITION BY TRUNC(v.calc_date, 'IW')
                                  ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        CROSS JOIN params
        WHERE v.code = params.code
          AND v.calc_date > TRUNC(SYSDATE) - params.weeks_back * 7
    )
    WHERE rn = 1
),
wk_lvs AS (
    -- その週に提出された大量保有報告書の件数と、最後の保有割合
    SELECT TRUNC(l.sub_date, 'IW')                                  AS week_start,
           COUNT(*)                                                 AS lvs_docs,
           MAX(l.total_shs_ratio) KEEP (DENSE_RANK LAST
                                        ORDER BY l.sub_date, l.doc_id) AS lvs_ratio
    FROM large_volume_shareholder l
    CROSS JOIN params
    WHERE l.code = params.code
      AND l.sub_date > TRUNC(SYSDATE) - params.weeks_back * 7
    GROUP BY TRUNC(l.sub_date, 'IW')
)
SELECT TO_CHAR(wp.week_start, 'YYYY-MM-DD')                     AS week_start,
       wp.week_close,
       wp.week_volume,
       NVL(wp.split_flag, 'N')                                  AS split_flag,
       wm.long_vol                                              AS margin_long_vol,
       wm.shrt_vol                                              AS margin_shrt_vol,
       ROUND(wm.long_vol / NULLIF(wm.shrt_vol, 0), 2)           AS margin_ratio,
       ROUND(ws.total_shrt_ratio * 100, 2)                      AS short_ratio_pct,
       ws.reporter_count,
       ws.total_shrt_shares                                     AS short_shares,
       NVL(wl.lvs_docs, 0)                                      AS lvs_docs,
       ROUND(wl.lvs_ratio * 100, 2)                             AS lvs_ratio_pct
FROM wk_price wp
LEFT JOIN wk_margin wm ON wm.week_start = wp.week_start
LEFT JOIN wk_short  ws ON ws.week_start = wp.week_start
LEFT JOIN wk_lvs    wl ON wl.week_start = wp.week_start
ORDER BY wp.week_start DESC;


--------------------------------------------------------------------------------
-- 4. 大量保有報告書の提出履歴(提出者ごとの保有割合の推移)
--
-- 1つの書類 = 1つの提出者グループ(提出者 + 共同保有者)。
-- TOTAL_SHS_RATIO_LAST は変更報告書にしか入らないため、
-- 新規の大量保有報告書では NULL になる(欠損ではない)。
--
-- DOC_TYPE_CODE と LARGE_HLDG_TYPE_CODE の意味は
-- ddl/14_large_volume_shareholders.sql 冒頭コメントを参照。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT '68570' AS code FROM dual   -- ← 見たい銘柄に変更する(5桁)
)
SELECT TO_CHAR(l.sub_date, 'YYYY-MM-DD')                        AS sub_date,
       h.hldr_seq,
       h.hldr_name,
       l.doc_type_code,
       l.large_hldg_type_code,
       ROUND(h.shs_ratio * 100, 2)                              AS holder_ratio_pct,
       ROUND(h.shs_ratio_last * 100, 2)                         AS holder_ratio_last_pct,
       ROUND((h.shs_ratio - h.shs_ratio_last) * 100, 2)         AS holder_ratio_chg_pt,
       ROUND(l.total_shs_ratio * 100, 2)                        AS total_ratio_pct,
       ROUND(l.total_shs_ratio_last * 100, 2)                   AS total_ratio_last_pct,
       h.shs_held,
       l.total_out_stks,
       SUBSTR(h.hldg_purp, 1, 120)                              AS hldg_purp_head,
       l.doc_id
FROM large_volume_shareholder l
JOIN large_volume_shareholder_holder h ON h.doc_id = l.doc_id
CROSS JOIN params
WHERE l.code = params.code
ORDER BY l.sub_date DESC, l.doc_id DESC, h.hldr_seq;


--------------------------------------------------------------------------------
-- 5. 直近に大量保有報告書が出たウォッチ銘柄
--
-- 「随時更新」の項目なので、一覧側では日付順に並べて拾えるようにしておく。
--------------------------------------------------------------------------------
SELECT TO_CHAR(l.sub_date, 'YYYY-MM-DD')                        AS sub_date,
       l.code,
       em.co_name,
       h.hldr_name,
       l.doc_type_code,
       ROUND(l.total_shs_ratio * 100, 2)                        AS total_ratio_pct,
       ROUND(l.total_shs_ratio_last * 100, 2)                   AS total_ratio_last_pct,
       CASE
         WHEN l.total_shs_ratio_last IS NULL THEN '新規'
         WHEN l.total_shs_ratio > l.total_shs_ratio_last THEN '買い増し'
         WHEN l.total_shs_ratio < l.total_shs_ratio_last THEN '売り減らし'
         ELSE '変化なし'
       END                                                      AS direction
FROM large_volume_shareholder l
JOIN equity_master em ON em.code = l.code
LEFT JOIN large_volume_shareholder_holder h
       ON h.doc_id = l.doc_id AND h.hldr_seq = 1
WHERE EXISTS (SELECT 1 FROM favorite_master f
              WHERE f.code = l.code AND f.is_watching = 1)
  AND l.sub_date >= TRUNC(SYSDATE) - 180
ORDER BY l.sub_date DESC, l.code;


--------------------------------------------------------------------------------
-- 6. 疑似浮動株比率
--
-- 【重要: これはJPXの公式な浮動株比率ではない】
--   J-Quantsは浮動株比率も浮動株数も配信していない(API仕様書のデータ一覧に無い)。
--   ここでは手元のデータから近似値を作る。
--
--     浮動株比率 ≈ (1 - 自己株式比率) × (1 - 上位株主の保有割合合計)
--
--   ・自己株式比率  = FINANCIAL_SUMMARY.TR_SH_FY / SH_OUT_FY
--                     (期末自己株式数 ÷ 期末発行済株式数)
--   ・上位株主割合  = EDINET_MAJOR_SHAREHOLDER_HOLDER.SHS_RATIO の合計
--                     (有価証券報告書の大株主状況。通常は上位10名)
--   SHS_RATIO の分母は「発行済株式から自己株式を除いた数」なので、
--   自己株式比率と単純に足し引きせず、掛け算で入れ子にしている。
--
-- 【この近似の限界(見誤らないために)】
--   1. 上位10名には信託口(日本マスタートラスト等)が含まれる。実質は年金・投信の
--      保有で市場に出てくる株なのに、固定株として差し引かれる。→ 過小評価になる
--   2. 更新頻度は有価証券報告書ベースで年1回。書籍の言う「四半期に一度」には届かない
--   3. 上位10名より下の安定株主(取引先の持ち合いなど)は拾えない。→ 過大評価になる
--   1と3は逆方向に効くため、絶対値の精度は期待できない。
--   使い道は「銘柄間の相対比較」と「経年での変化の方向」に限ること。
--
--   なお 3 の持ち合いは EDINET_CROSS_SHAREHOLDING_STOCK(政策保有株式)から
--   「その銘柄を政策保有している会社」を逆引きできる。精度を上げたくなったら
--   そちらを足し込む(本クエリでは未使用。まず近似の当たり外れを見てから決める)。
--------------------------------------------------------------------------------
WITH target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
fs AS (
    -- 最新の財務情報から発行済株式数・自己株式数
    SELECT code, sh_out_fy, tr_sh_fy, cur_per_en
    FROM (
        SELECT f.code, f.sh_out_fy, f.tr_sh_fy, f.cur_per_en,
               ROW_NUMBER() OVER (PARTITION BY f.code
                                  ORDER BY f.disc_date DESC, f.disc_no DESC) AS rn
        FROM financial_summary f
        WHERE f.sh_out_fy IS NOT NULL
          AND f.sh_out_fy > 0
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = f.code)
    )
    WHERE rn = 1
),
ms_doc AS (
    -- 最新の大株主状況の書類
    SELECT code, doc_id, sub_date, per_en
    FROM (
        SELECT d.code, d.doc_id, d.sub_date, d.per_en,
               ROW_NUMBER() OVER (PARTITION BY d.code
                                  ORDER BY d.sub_date DESC, d.doc_id DESC) AS rn
        FROM edinet_major_shareholder d
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = d.code)
    )
    WHERE rn = 1
),
ms AS (
    SELECT m.code,
           m.sub_date,
           COUNT(*)          AS holder_cnt,
           SUM(h.shs_ratio)  AS top_holder_ratio
    FROM ms_doc m
    JOIN edinet_major_shareholder_holder h ON h.doc_id = m.doc_id
    GROUP BY m.code, m.sub_date
)
SELECT em.code,
       em.co_name,
       TO_CHAR(fs.cur_per_en, 'YYYY-MM-DD')                     AS fin_period_end,
       fs.sh_out_fy                                             AS shares_outstanding,
       fs.tr_sh_fy                                              AS treasury_shares,
       ROUND(fs.tr_sh_fy / NULLIF(fs.sh_out_fy, 0) * 100, 2)    AS treasury_pct,
       TO_CHAR(ms.sub_date, 'YYYY-MM-DD')                       AS ms_sub_date,
       ms.holder_cnt,
       ROUND(ms.top_holder_ratio * 100, 2)                      AS top_holder_pct,
       ROUND((1 - NVL(fs.tr_sh_fy, 0) / NULLIF(fs.sh_out_fy, 0))
             * (1 - ms.top_holder_ratio) * 100, 2)              AS pseudo_float_pct
FROM equity_master em
JOIN target ON target.code = em.code
LEFT JOIN fs ON fs.code = em.code
LEFT JOIN ms ON ms.code = em.code
ORDER BY pseudo_float_pct NULLS LAST;


--------------------------------------------------------------------------------
-- 7. 現在の大量保有者(提出者グループごとの最新断面) ※1銘柄
--
-- 4 が「全書類の履歴」なのに対し、これは「いま誰が何%持っていることになっているか」。
-- 銘柄詳細ページの見出しに使う。2 の LVS_GRP_CNT / LVS_TOTAL_PCT の内訳でもある。
--
-- ・5%未満に落ちた提出者も STATUS='退出' として残す。消すと売り抜けが見えなくなる。
-- ・提出者の同定は HLDR_SEQ = 1 の HLDR_EDINET_CODE(無ければ氏名)。
--   親テーブルの EDINET_CODE / ISR_NAME は発行者なので使えない(2 のコメント参照)。
-- ・DAYS_SINCE が大きいグループは、報告義務が無い範囲で既に動いている可能性がある。
--   「最後に報告した時点の値」であって現在値ではない。SHIFTのゴールドマン・サックス
--   証券は1,514日前の5.05%のまま「保有中」に居座っていた(2026-09-13)。
-- ・TOTAL_OUT_STKS は書類ごとに違う。分割前の書類には旧株数が入っている
--   (SHIFT: 2022年の書類17,811,114 / 2026年の書類267,500,670)。
--   SHARES_HELD を銘柄間や時系列で比べるときは、この列で割ってから比べること。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT '68570' AS code,      -- ← 見たい銘柄に変更する(5桁)
           0.05    AS lvs_min_ratio
    FROM dual
),
grp AS (
    SELECT grp_name, sub_date, doc_id, large_hldg_type_code, docs_cnt, ratio_imputed,
           total_shs_ratio, total_shs_ratio_last, total_shs_held, total_out_stks
    FROM (
        SELECT h.hldr_name                                      AS grp_name,
               l.sub_date, l.doc_id, l.large_hldg_type_code,
               l.total_shs_held, l.total_out_stks,
               -- 2 と同じ補完(保有者1名の書類に限る。理由は2のコメント参照)
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))               AS total_shs_ratio,
               COALESCE(l.total_shs_ratio_last,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))               AS total_shs_ratio_last,
               CASE WHEN l.total_shs_ratio IS NULL
                     AND (SELECT COUNT(*) FROM large_volume_shareholder_holder hh
                          WHERE hh.doc_id = l.doc_id) = 1
                    THEN 'Y' END                                    AS ratio_imputed,
               COUNT(*) OVER (PARTITION BY NVL(h.hldr_edinet_code, h.hldr_name))
                                                                AS docs_cnt,
               ROW_NUMBER() OVER (
                   PARTITION BY NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)      AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        CROSS JOIN params p
        WHERE l.code = p.code
    )
    WHERE rn = 1
)
SELECT grp.grp_name                                             AS holder_name,
       CASE WHEN grp.total_shs_ratio >= p.lvs_min_ratio
            THEN '保有中' ELSE '退出' END                        AS status,
       ROUND(grp.total_shs_ratio * 100, 2)                      AS ratio_pct,
       ROUND(grp.total_shs_ratio_last * 100, 2)                 AS ratio_last_pct,
       ROUND((grp.total_shs_ratio - grp.total_shs_ratio_last) * 100, 2)
                                                                AS ratio_chg_pt,
       grp.total_shs_held                                       AS shares_held,
       TO_CHAR(grp.sub_date, 'YYYY-MM-DD')                      AS last_sub_date,
       TRUNC(SYSDATE) - grp.sub_date                            AS days_since,
       grp.docs_cnt,
       NVL(grp.ratio_imputed, 'N')                              AS ratio_imputed,
       grp.large_hldg_type_code,
       grp.total_out_stks,
       grp.doc_id
FROM grp
CROSS JOIN params p
ORDER BY status, ratio_pct DESC NULLS LAST;
