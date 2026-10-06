--------------------------------------------------------------------------------
-- 相対モメンタムの横断面検証(銘柄間の優劣)
--
-- 問い: 「過去の騰落率が上位の銘柄は、その後(数週間〜1・2か月)、同業・同規模の銘柄より強いか」
--
-- 個人投資家が最も多く使う「相対的な強さ」(トレンドフォロー・順張り)を、これまでの需給系の
-- 検証(xsection_short_backtest.sql / xsection_long_backtest.sql)と同じ型で測る。
-- 需給系は市場全体では5指標とも不合格、銘柄間では LDTC・DTC が統計的には残ったが
-- 売買可能な流動性(1億円/日以上)で消えた。モメンタムは株価だけで作れる指標で、
-- 日本株では米国ほど強くなく、短期はむしろ反転(リバーサル)が効くという報告もある。
-- どちらの向きが出るかを事前に決めず、両側で判定する。
--
-- 前提: ddl/24_xsection_momentum_panel.sql で xs_mom_panel を作成済みであること。
--       CLAUDE_RO で流すなら ddl/24 末尾の権限付与も。
--
--------------------------------------------------------------------------------
-- 【検証する指標(判定に使う2つ)】 ← 結果を見る前に固定(2026-10-04)
--
--   MOM_12_1 = 4週前の終値 ÷ 52週前の終値 - 1。直近4週を除く12か月モメンタム(本命)
--   MOM_6_1  = 4週前の終値 ÷ 26週前の終値 - 1。直近4週を除く6か月モメンタム
--   群1 = 週内の最下位五分位(最も弱い)、群5 = 最上位五分位(最も強い)。
--   使えるのは2017年8月以降(52週分の履歴が要る)。MOM_6_1 は2017年2月以降。
--
--   先行リターンは 4週先・13週先を判定に使う(需給系の検証と同じ)。
--   **8週先は参考**(1〜2か月の保有に近いので並べて見る。判定に数えない)。
--   判定の本数は 2指標 × 2期間 = 4本。
--
-- 【合格の条件】 ← 結果を見る前に固定。1つでも落ちたら不合格。結果を見て条件を変えない
--
--   (a) 群1→5 の相対リターンがおおむね単調に並ぶ(2)
--   (b) 群5−群1 のスプレッドの t 値が絶対値 2.5 以上。4週・13週で同じ向き(3-1)
--       t 値は「重ならない週ごとのスプレッド」を1観測とした値(Fama-MacBeth の形)。
--       4本あり、2.5 だと全部が無関係でも1本が偶然超える確率は約5%。
--       向きは固定せず両側で判定する。**ただし順張り(群5が強い)で使えるのは正のときだけ。**
--       負(強い銘柄ほど弱い = 反転)なら、順張りの根拠にはならず、逆張りとして別の問いになる
--   (c) どの1年を除いても向きが残る(3-2)
--   (d) 業種内(17業種)で切り直しても向きが残り、4週・13週とも |t| ≥ 2.0(5)
--       業種の勢いに乗っているだけでなく、業種内の優劣としても効くか
--   (e) SIZE(5)・PBR(3)・REV(直近4週リターン、3)の層の中でも向きが残る(6)
--       時価総額の大きい銘柄・小さい銘柄の別、割安・割高の別、直近で下げた・上げた銘柄の別に関わらず
--   (f) 売買代金の下限(1億円/日以上、5億円/日以上)を付けた中で切り直しても、4週・13週とも
--       同じ向きで |t| ≥ 2.5(7)。需給系の検証で「統計的に有意」と「売買できる」が別だったため、
--       今回は最初から合格条件に入れる
--   (g) 地合い別(起点週の直近13週の市場平均リターンが正・負)の両方で向きが残る(8)
--       モメンタムは相場の急反転局面で大きく崩れる(モメンタム・クラッシュ)ので、
--       上昇相場一色のデータでも、下げた後の局面だけを取り出して確認する。
--       手元の下落局面の週数は少ない。週数も併記し、少なければ「検出できない」と読む
--
--   参考(判定に数えない): 8週先、群5のみの超過リターン、市場全体を引いた相対リターン(EXR_MKT。
--   業種モメンタムを含む)、業種内の差、重ならない標本の位相を変えた確認(9)。
--
--------------------------------------------------------------------------------
-- 【読むときの前提】
--   ・相対リターン EXR_IS は「同じ週・同じ17業種・同じ時価総額5分位」の等ウェイト平均との差(%)。
--     **業種の勢いは EXR_IS から引かれている。** 「強い業種を買う」効果は EXR_MKT 側で見る(3-1 の参考列)。
--   ・手元データは上昇相場の10年のみ(regime_bias_limits)。モメンタムは強気相場で出やすく、
--     弱気相場からの急反転で崩れる性質があるので、この制約が特に重い手法。
--   ・リターンは分割のみ調整。配当・優待落ちを含む。上場廃止銘柄は最後の終値まで(ddl/20)。
--   ・同じ週の銘柄同士は相関するので、銘柄数ではなく週数が独立観測の数。
--     4週先は約115週、13週先は約35週(2017年8月〜)。13週は検出力が低い。
--   ・4週・13週の結果を結果から選んで報告しない。判定は上の条件どおりに行う。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0-1. パネルの充足状況(年別)
--------------------------------------------------------------------------------
SELECT EXTRACT(YEAR FROM week_start)                          AS yr,
       COUNT(DISTINCT week_start)                             AS weeks,
       ROUND(COUNT(*) / COUNT(DISTINCT week_start))           AS stocks_per_week,
       ROUND(COUNT(mom_12_1)    / COUNT(*) * 100, 1)          AS pct_mom12,
       ROUND(COUNT(mom_6_1)     / COUNT(*) * 100, 1)          AS pct_mom6,
       ROUND(COUNT(turnover_oku)/ COUNT(*) * 100, 1)          AS pct_turnover,
       ROUND(COUNT(exr_is_4w)   / COUNT(*) * 100, 1)          AS pct_exr4,
       ROUND(COUNT(exr_is_8w)   / COUNT(*) * 100, 1)          AS pct_exr8,
       ROUND(COUNT(exr_is_13w)  / COUNT(*) * 100, 1)          AS pct_exr13,
       ROUND(MEDIAN(mom_12_1), 1)                             AS med_mom12,
       ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY mom_12_1), 0) AS p99_mom12
FROM xs_mom_panel
GROUP BY EXTRACT(YEAR FROM week_start)
ORDER BY yr;


--------------------------------------------------------------------------------
-- 0-2. 指標と、既知の要因との週ごとの順位相関(週平均)
--
-- MOM が「小型株」「直近で下げた銘柄」「割安株」の言い換えになっていないかを見る。
-- 相関が±0.3を超えるものは、6 の層別で必ず向きが残るかを確認する。
-- MOM_12_1 と REV(直近4週リターン)は、直近を飛ばしているのでほぼ無相関のはず。
-- 4週おきの週だけを使い、全指標がそろった銘柄だけで順位を付ける。
--------------------------------------------------------------------------------
WITH base AS (
    SELECT week_start, mom_12_1, mom_6_1, ret_4w_past, mcap_oku, pbr, turnover_oku
    FROM xs_mom_panel
    WHERE MOD(wk_idx, 4) = 0
      AND mom_12_1 IS NOT NULL AND mom_6_1 IS NOT NULL AND ret_4w_past IS NOT NULL
      AND mcap_oku IS NOT NULL AND pbr IS NOT NULL AND turnover_oku IS NOT NULL
),
r AS (
    SELECT week_start,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mom_12_1)     AS r12,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mom_6_1)      AS r6,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY ret_4w_past)  AS r_rev,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mcap_oku)     AS r_size,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY pbr)          AS r_pbr,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY turnover_oku) AS r_liq
    FROM base
),
c AS (
    SELECT week_start,
           CORR(r12, r6)   AS m12_m6,   CORR(r12, r_rev)  AS m12_rev,
           CORR(r12, r_size) AS m12_size, CORR(r12, r_pbr) AS m12_pbr, CORR(r12, r_liq) AS m12_liq,
           CORR(r6, r_rev) AS m6_rev,   CORR(r6, r_size)  AS m6_size,
           CORR(r6, r_pbr) AS m6_pbr,   CORR(r6, r_liq)   AS m6_liq
    FROM r
    GROUP BY week_start
)
SELECT COUNT(*)                    AS n_weeks,
       ROUND(AVG(m12_m6), 3)   AS m12_m6,   ROUND(AVG(m12_rev), 3) AS m12_rev,
       ROUND(AVG(m12_size), 3) AS m12_size, ROUND(AVG(m12_pbr), 3) AS m12_pbr,
       ROUND(AVG(m12_liq), 3)  AS m12_liq,
       ROUND(AVG(m6_rev), 3)   AS m6_rev,   ROUND(AVG(m6_size), 3) AS m6_size,
       ROUND(AVG(m6_pbr), 3)   AS m6_pbr,   ROUND(AVG(m6_liq), 3)  AS m6_liq
FROM c;


--------------------------------------------------------------------------------
-- 1. ベースライン(全銘柄、MOM_12_1 が計算できる銘柄だけ)
--
-- 横断面のベースラインは「相対リターンの平均 ≒ 0」。見るべきは中央値と PCT_BEAT で、
-- 2 以降の群の数字はこれと比べて読む。4週・13週は xsection_long_backtest.sql の 1 と
-- 対象が違う(MOM が計算できる2017年8月以降だけ)ので値は少し違う。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.mom_12_1, p.fwd_ret_4w AS ret, p.exr_is_4w AS exr_is, p.exr_mkt_4w AS exr_mkt
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.mom_12_1, p.fwd_ret_8w, p.exr_is_8w, p.exr_mkt_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.mom_12_1, p.fwd_ret_13w, p.exr_is_13w, p.exr_mkt_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL
)
SELECT h                                                          AS horizon_w,
       COUNT(DISTINCT week_start)                                 AS n_weeks,
       ROUND(COUNT(*) / COUNT(DISTINCT week_start))               AS stocks_per_week,
       ROUND(AVG(ret), 2)                                         AS avg_ret,
       ROUND(AVG(exr_is), 3)                                      AS avg_exr_is,
       ROUND(AVG(exr_mkt), 3)                                     AS avg_exr_mkt,
       ROUND(MEDIAN(exr_is), 2)                                   AS med_exr_is,
       ROUND(STDDEV(exr_is), 2)                                   AS sd_exr_is,
       ROUND(AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END) * 100, 1) AS pct_beat
FROM obs
WHERE mom_12_1 IS NOT NULL
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 2. 群ごとの相対リターン(条件 a: 単調性)
--
-- 週ごとに群の平均を出してから週をまたいで平均する。
-- VAL_FROM / VAL_TO は各週の群の最小・最大の平均(MOM は %)。
-- AVG_EXR_IS が主。AVG_EXR_MKT(業種・規模を引かない)と大きく違うなら、業種や規模の勢いが効いている。
-- AVG_RET(未調整)は参考。上昇相場の分が乗っているので判断に使わない。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.mom_12_1, p.mom_6_1,
           p.fwd_ret_4w AS ret, p.exr_is_4w AS exr_is, p.exr_mkt_4w AS exr_mkt
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.fwd_ret_8w, p.exr_is_8w, p.exr_mkt_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.fwd_ret_13w, p.exr_is_13w, p.exr_mkt_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL
),
grp AS (
    SELECT 'MOM_12_1' AS ind, o.h, o.week_start, o.ret, o.exr_is, o.exr_mkt, o.mom_12_1 AS val,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM obs o WHERE o.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', o.h, o.week_start, o.ret, o.exr_is, o.exr_mkt, o.mom_6_1,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_6_1, o.code)
    FROM obs o WHERE o.mom_6_1 IS NOT NULL
),
wg AS (
    SELECT ind, h, week_start, g,
           COUNT(*) AS n, AVG(exr_is) AS exr_is, AVG(exr_mkt) AS exr_mkt, AVG(ret) AS ret,
           AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END) AS beat,
           MIN(val) AS vmin, MAX(val) AS vmax
    FROM grp
    GROUP BY ind, h, week_start, g
)
SELECT ind, h                                                     AS horizon_w, g,
       COUNT(*)                                                   AS n_weeks,
       ROUND(AVG(n))                                              AS avg_stocks,
       ROUND(AVG(vmin), 1)                                        AS val_from,
       ROUND(AVG(vmax), 1)                                        AS val_to,
       ROUND(AVG(exr_is), 2)                                      AS avg_exr_is,
       ROUND(STDDEV(exr_is) / SQRT(COUNT(*)), 2)                  AS se_exr_is,
       ROUND(MEDIAN(exr_is), 2)                                   AS med_week_exr_is,
       ROUND(AVG(beat) * 100, 1)                                  AS pct_beat,
       ROUND(AVG(exr_mkt), 2)                                     AS avg_exr_mkt,
       ROUND(AVG(ret), 2)                                         AS avg_ret
FROM wg
GROUP BY ind, h, g
ORDER BY ind, h, g;


--------------------------------------------------------------------------------
-- 3-1. 群5−群1 のスプレッド(条件 b)
--
-- 週ごとに (群5の平均) − (群1の平均) を1観測とし、その平均・標準偏差・t値を出す。
-- G5 は群5だけの超過リターン(買い側だけで取れる分。参考)、T_G5 はその t 値。
-- S51_MKT は市場全体を引いた相対リターン(EXR_MKT)でのスプレッド。業種モメンタムを含む(参考)。
-- 判定は MOM_12_1・MOM_6_1 × 4週・13週の4本。8週は参考。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.mom_12_1, p.mom_6_1,
           p.exr_is_4w AS exr_is, p.exr_mkt_4w AS exr_mkt
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.exr_is_8w, p.exr_mkt_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.exr_is_13w, p.exr_mkt_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL
),
grp AS (
    SELECT 'MOM_12_1' AS ind, o.h, o.week_start, o.exr_is, o.exr_mkt,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM obs o WHERE o.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', o.h, o.week_start, o.exr_is, o.exr_mkt,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_6_1, o.code)
    FROM obs o WHERE o.mom_6_1 IS NOT NULL
),
sp AS (
    SELECT ind, h, week_start,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END)   AS s51,
           AVG(CASE WHEN g = 5 THEN exr_is END)                                          AS g5,
           AVG(CASE WHEN g = 1 THEN exr_is END)                                          AS g1,
           AVG(CASE WHEN g = 5 THEN exr_mkt END) - AVG(CASE WHEN g = 1 THEN exr_mkt END) AS s51_mkt
    FROM grp
    GROUP BY ind, h, week_start
)
SELECT ind, h                                                        AS horizon_w,
       COUNT(s51)                                                    AS n_weeks,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(STDDEV(s51), 2)                                         AS sd_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51,
       ROUND(AVG(CASE WHEN s51 > 0 THEN 1 WHEN s51 IS NOT NULL THEN 0 END) * 100, 1) AS pct_weeks_pos,
       ROUND(AVG(g5), 2)                                             AS avg_g5,
       ROUND(AVG(g5) / NULLIF(STDDEV(g5) / SQRT(COUNT(g5)), 0), 2)   AS t_g5,
       ROUND(AVG(g1), 2)                                             AS avg_g1,
       ROUND(AVG(s51_mkt), 2)                                        AS avg_s51_mkt,
       ROUND(AVG(s51_mkt) / NULLIF(STDDEV(s51_mkt) / SQRT(COUNT(s51_mkt)), 0), 2) AS t_s51_mkt
FROM sp
GROUP BY ind, h
ORDER BY ind, h;


--------------------------------------------------------------------------------
-- 3-2. スプレッドの年別内訳(条件 c: 時間の塊)
--
-- AVG_S51 … その年の週ごとスプレッドの平均(年内の週数は N_WEEKS)
-- AVG_EXCL_YEAR … その年を除いた残りの期間の平均。符号が変わる年があれば不合格。
-- 4週・13週のみ(判定の対象)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.exr_is_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL
),
grp AS (
    SELECT 'MOM_12_1' AS ind, o.h, o.week_start, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM obs o WHERE o.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', o.h, o.week_start, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_6_1, o.code)
    FROM obs o WHERE o.mom_6_1 IS NOT NULL
),
sp AS (
    SELECT ind, h, week_start, EXTRACT(YEAR FROM week_start) AS yr,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END) AS s51
    FROM grp
    GROUP BY ind, h, week_start
),
yy AS (
    SELECT ind, h, yr, COUNT(*) AS n, SUM(s51) AS sm, AVG(s51) AS av
    FROM sp
    GROUP BY ind, h, yr
),
tt AS (
    SELECT ind, h, SUM(n) AS n_all, SUM(sm) AS sm_all FROM yy GROUP BY ind, h
)
SELECT y.ind, y.h AS horizon_w, y.yr, y.n AS n_weeks,
       ROUND(y.av, 2)                                              AS avg_s51,
       ROUND((t.sm_all - y.sm) / NULLIF(t.n_all - y.n, 0), 2)      AS avg_excl_year,
       ROUND(t.sm_all / t.n_all, 2)                                AS avg_all
FROM yy y
JOIN tt t ON t.ind = y.ind AND t.h = y.h
ORDER BY y.ind, y.h, y.yr;


--------------------------------------------------------------------------------
-- 4. 群5(最も強い五分位)の業種構成
--
-- 群5が特定の業種の寄せ集めなら、「業種モメンタム」を見ているだけの可能性がある(5 で確認)。
-- SHARE_G5 … 群5の銘柄のうち、その17業種が占める割合(%、週ごとに出して平均)
-- SHARE_ALL … 全銘柄のうちの割合(%)。SHARE_G5 が大きく上回る業種が偏りの原因。
-- 4週おきの標本、MOM_12_1。33業種名は同じ17業種コードの代表名(MIN)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.code, p.sector17_code, p.sector33_name, p.mom_12_1
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.mom_12_1 IS NOT NULL
),
grp AS (
    SELECT o.*, NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM obs o
),
wk AS (
    SELECT week_start, sector17_code,
           COUNT(*)                          AS n_all,
           COUNT(CASE WHEN g = 5 THEN 1 END) AS n_g5,
           COUNT(CASE WHEN g = 1 THEN 1 END) AS n_g1,
           MIN(sector33_name)                AS sample_name
    FROM grp
    GROUP BY week_start, sector17_code
),
tot AS (
    SELECT week_start, SUM(n_all) AS t_all, SUM(n_g5) AS t_g5, SUM(n_g1) AS t_g1 FROM wk GROUP BY week_start
)
SELECT w.sector17_code,
       MIN(w.sample_name)                               AS sample_name,
       ROUND(AVG(w.n_all / t.t_all) * 100, 1)           AS share_all,
       ROUND(AVG(w.n_g5  / t.t_g5)  * 100, 1)           AS share_g5,
       ROUND(AVG(w.n_g1  / t.t_g1)  * 100, 1)           AS share_g1
FROM wk w
JOIN tot t ON t.week_start = w.week_start
GROUP BY w.sector17_code
ORDER BY share_g5 - share_all DESC;


--------------------------------------------------------------------------------
-- 5. 17業種内で切り直した群5−群1(条件 d)
--
-- 各週・各17業種の中で五分位に切る(業種の中の優劣だけを見る)。
-- 週ごとに、各業種の (群5−群1) を銘柄数で重み付けして平均し、1観測とする。
-- 業種の銘柄数が少なく五分位に切れない(10銘柄未満)業種は使わない。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.mom_12_1, p.mom_6_1, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.sector17_code, p.mom_12_1, p.mom_6_1, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.mom_12_1, p.mom_6_1, p.exr_is_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL
),
grp AS (
    SELECT 'MOM_12_1' AS ind, o.h, o.week_start, o.sector17_code, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start, o.sector17_code ORDER BY o.mom_12_1, o.code) AS g,
           COUNT(*) OVER (PARTITION BY o.h, o.week_start, o.sector17_code) AS n_ind
    FROM obs o WHERE o.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', o.h, o.week_start, o.sector17_code, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start, o.sector17_code ORDER BY o.mom_6_1, o.code),
           COUNT(*) OVER (PARTITION BY o.h, o.week_start, o.sector17_code)
    FROM obs o WHERE o.mom_6_1 IS NOT NULL
),
si AS (
    SELECT ind, h, week_start, sector17_code, MAX(n_ind) AS n_ind,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END) AS s51
    FROM grp
    WHERE n_ind >= 10
    GROUP BY ind, h, week_start, sector17_code
),
sp AS (
    SELECT ind, h, week_start, SUM(s51 * n_ind) / SUM(n_ind) AS s51
    FROM si
    WHERE s51 IS NOT NULL
    GROUP BY ind, h, week_start
)
SELECT ind, h                                                        AS horizon_w,
       COUNT(s51)                                                    AS n_weeks,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(STDDEV(s51), 2)                                         AS sd_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51,
       ROUND(AVG(CASE WHEN s51 > 0 THEN 1 ELSE 0 END) * 100, 1)      AS pct_weeks_pos
FROM sp
GROUP BY ind, h
ORDER BY ind, h;


--------------------------------------------------------------------------------
-- 6. 層別(条件 e): SIZE(5)・PBR(3)・REV(3) の層の中で切り直した群5−群1
--
-- 週ごと・層ごとに五分位を切り直し、層ごとに週ごとスプレッドの平均と t 値を出す。
-- REV_Q は過去4週リターンの週内3分位(1=直近で最も下げた)。PBR が NULL の銘柄は PBR 層から外れる。
-- 4週・13週のみ(判定の対象)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.size_q, p.pbr_q, p.mom_12_1, p.mom_6_1, p.ret_4w_past,
           p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.size_q, p.pbr_q, p.mom_12_1, p.mom_6_1, p.ret_4w_past, p.exr_is_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL
),
o2 AS (
    SELECT o.*,
           CASE WHEN o.ret_4w_past IS NOT NULL THEN
                NTILE(3) OVER (PARTITION BY o.h, o.week_start,
                               CASE WHEN o.ret_4w_past IS NULL THEN 0 ELSE 1 END
                               ORDER BY o.ret_4w_past, o.code) END AS rev_q
    FROM obs o
),
lay AS (
    SELECT 'SIZE' AS layer_name, TO_CHAR(size_q) AS layer_val, o2.* FROM o2 WHERE size_q IS NOT NULL
    UNION ALL
    SELECT 'PBR', TO_CHAR(pbr_q), o2.* FROM o2 WHERE pbr_q IS NOT NULL
    UNION ALL
    SELECT 'REV', TO_CHAR(rev_q), o2.* FROM o2 WHERE rev_q IS NOT NULL
),
grp AS (
    SELECT 'MOM_12_1' AS ind, l.layer_name, l.layer_val, l.h, l.week_start, l.exr_is,
           NTILE(5) OVER (PARTITION BY l.layer_name, l.layer_val, l.h, l.week_start ORDER BY l.mom_12_1, l.code) AS g
    FROM lay l WHERE l.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', l.layer_name, l.layer_val, l.h, l.week_start, l.exr_is,
           NTILE(5) OVER (PARTITION BY l.layer_name, l.layer_val, l.h, l.week_start ORDER BY l.mom_6_1, l.code)
    FROM lay l WHERE l.mom_6_1 IS NOT NULL
),
sp AS (
    SELECT ind, layer_name, layer_val, h, week_start,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END) AS s51
    FROM grp
    GROUP BY ind, layer_name, layer_val, h, week_start
)
SELECT ind, layer_name, layer_val, h                                 AS horizon_w,
       COUNT(s51)                                                    AS n_weeks,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51
FROM sp
GROUP BY ind, layer_name, layer_val, h
ORDER BY ind, layer_name, layer_val, h;


--------------------------------------------------------------------------------
-- 7. 売買代金の下限を付けた中で切り直した群5−群1(条件 f)
--
-- 起点週の直近4週の1日平均売買代金(TURNOVER_OKU)が下限以上の銘柄だけで五分位を切り直す。
-- 下限: なし / 0.5億円/日 / 1億円/日 / 5億円/日 / 10億円/日。
-- AVG_TURNOVER_G5 は群5の売買代金の中央値の週平均(億円/日)、AVG_STOCKS は週あたりの銘柄数。
-- 判定は 1億円/日 と 5億円/日 の両方で、4週・13週とも同じ向きで |t| ≥ 2.5。
--------------------------------------------------------------------------------
WITH floors AS (
    SELECT 0 AS fl FROM dual UNION ALL SELECT 0.5 FROM dual UNION ALL SELECT 1 FROM dual
    UNION ALL SELECT 5 FROM dual UNION ALL SELECT 10 FROM dual
),
obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.turnover_oku, p.mom_12_1, p.mom_6_1, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.turnover_oku IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.turnover_oku, p.mom_12_1, p.mom_6_1, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.turnover_oku IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.turnover_oku, p.mom_12_1, p.mom_6_1, p.exr_is_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL AND p.turnover_oku IS NOT NULL
),
fo AS (
    SELECT f.fl, o.*
    FROM obs o
    JOIN floors f ON o.turnover_oku >= f.fl
),
grp AS (
    SELECT 'MOM_12_1' AS ind, o.fl, o.h, o.week_start, o.exr_is, o.turnover_oku,
           NTILE(5) OVER (PARTITION BY o.fl, o.h, o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM fo o WHERE o.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', o.fl, o.h, o.week_start, o.exr_is, o.turnover_oku,
           NTILE(5) OVER (PARTITION BY o.fl, o.h, o.week_start ORDER BY o.mom_6_1, o.code)
    FROM fo o WHERE o.mom_6_1 IS NOT NULL
),
sp AS (
    SELECT ind, fl, h, week_start,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END) AS s51,
           AVG(CASE WHEN g = 5 THEN exr_is END)                                        AS g5,
           MEDIAN(CASE WHEN g = 5 THEN turnover_oku END)                               AS to_g5,
           COUNT(*)                                                                    AS n
    FROM grp
    GROUP BY ind, fl, h, week_start
)
SELECT ind, fl AS floor_oku, h                                       AS horizon_w,
       COUNT(s51)                                                    AS n_weeks,
       ROUND(AVG(n))                                                 AS avg_stocks,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51,
       ROUND(AVG(g5), 2)                                             AS avg_g5,
       ROUND(AVG(to_g5), 2)                                          AS avg_turnover_g5
FROM sp
GROUP BY ind, fl, h
ORDER BY ind, fl, h;


--------------------------------------------------------------------------------
-- 8. 地合い別(条件 g): 起点週の直近13週の市場平均リターンが 正 / 負 の週に分けたスプレッド
--
-- MKT_STATE: 'UP' = 直近13週の全銘柄の等ウェイト平均リターンが0以上、'DOWN' = 負。
-- モメンタムは下落後の急反転で崩れる性質がある。N_WEEKS が少ない状態は「検出できない」と読む。
-- 4週・13週のみ(判定の対象)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.exr_is_4w AS exr_is,
           CASE WHEN p.mkt_ret_13w_past >= 0 THEN 'UP' ELSE 'DOWN' END AS mkt_state
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.mom_12_1, p.mom_6_1, p.exr_is_13w,
           CASE WHEN p.mkt_ret_13w_past >= 0 THEN 'UP' ELSE 'DOWN' END
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
grp AS (
    SELECT 'MOM_12_1' AS ind, o.h, o.week_start, o.mkt_state, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM obs o WHERE o.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 'MOM_6_1', o.h, o.week_start, o.mkt_state, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_6_1, o.code)
    FROM obs o WHERE o.mom_6_1 IS NOT NULL
),
sp AS (
    SELECT ind, h, week_start, mkt_state,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END) AS s51
    FROM grp
    GROUP BY ind, h, week_start, mkt_state
)
SELECT ind, h                                                        AS horizon_w, mkt_state,
       COUNT(s51)                                                    AS n_weeks,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51
FROM sp
GROUP BY ind, h, mkt_state
ORDER BY ind, h, mkt_state;


--------------------------------------------------------------------------------
-- 9. 位相を変えた確認(参考): 重ならない標本の取り方を変えても同じか
--
-- 3-1 は MOD(wk_idx, h) = 0 の週だけを使った。起点の週をずらしても向きが同じかを見る。
-- 4週先は位相0〜3、13週先は位相0〜12。MOM_12_1 のみ。
-- 位相によって t 値が大きくぶれるなら、3-1 の値は標本の取り方に依存している。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, MOD(p.wk_idx, 4) AS ph, p.week_start, p.code, p.mom_12_1, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE p.exr_is_4w IS NOT NULL AND p.mom_12_1 IS NOT NULL
    UNION ALL
    SELECT 13, MOD(p.wk_idx, 13), p.week_start, p.code, p.mom_12_1, p.exr_is_13w
    FROM xs_mom_panel p
    WHERE p.exr_is_13w IS NOT NULL AND p.mom_12_1 IS NOT NULL
),
grp AS (
    SELECT o.h, o.ph, o.week_start, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_12_1, o.code) AS g
    FROM obs o
),
sp AS (
    SELECT h, ph, week_start,
           AVG(CASE WHEN g = 5 THEN exr_is END) - AVG(CASE WHEN g = 1 THEN exr_is END) AS s51
    FROM grp
    GROUP BY h, ph, week_start
)
SELECT h AS horizon_w, ph AS phase,
       COUNT(s51)                                                    AS n_weeks,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51
FROM sp
GROUP BY h, ph
ORDER BY h, ph;
