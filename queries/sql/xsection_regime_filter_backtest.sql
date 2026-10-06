--------------------------------------------------------------------------------
-- 「勝ち組・負け組を買い候補から外すふるい」の検証
--
-- 問い: 地合い条件付きルール(xsection_regime_rule_backtest.sql)で、ロング・ショートの差の大半は
--       「売る側の弱さ」から来ていた(買い側だけでは薄い)。ならば、売る側の群を買い候補から外せば、
--       買いだけの投資家でも、候補全体より良い結果になるか。
--
-- 【ふるいの定義】 ← 結果を見る前に固定(2026-10-04)
--   外す群(AVOID):
--     UP   の週(直近13週の市場平均リターン ≥ 0)→ MOM_6_1 が最下位の五分位(中期の負け組、q_m6=1)
--     DOWN の週(直近13週の市場平均リターン < 0)→ REV_4W が最上位の五分位(直近4週の勝ち組、q_rev=5)
--   残す群(KEPT): その週の標本のうち AVOID でない銘柄(約80%)。
--   標本・地合い・五分位の切り方は地合い条件付きルールの検証と同じ
--   (4週おきの起点週、保有4週が判定。8週は参考。2017年8月以降、118週)。
--
-- 【評価する量】(週ごとに出して週をまたいで平均する。相対リターンは EXR_IS)
--   GAP = (AVOID の EXR_IS の平均) − (KEPT の EXR_IS の平均)   ← 負なら AVOID が弱い
--   D   = (KEPT の平均) − (標本全体の平均)                      ← 買い側が KEPT から選ぶ場合の改善幅(pt)
--   無条件のふるい2つとも比べる:
--     BOTTOM_M6 = 地合いに関係なく MOM_6_1 の最下位五分位を常に外す
--     TOP_REV   = 地合いに関係なく REV_4W の最上位五分位を常に外す
--   SWITCHED が本番(上の AVOID の定義)。
--
-- 【この検証の位置づけ(必ず読むこと)】
--   「AVOID の群は弱い」という事実そのものは、地合い条件付きルールの検証で同じデータから
--   すでに見えている(買い側だけの超過 +0.25pt に対し、差が +0.69pt = 売る側が約 -0.44pt)。
--   したがって**統計的な裏付けは、新しい独立の証拠ではない**。この検証で新しく分かるのは
--     ・買い側にとっての改善幅の大きさ(D)
--     ・売買可能な流動性でも残るか(売る側の弱さは買い側の超過より流動性に強いか)
--     ・地合いで切り替える意味があるか(無条件のふるいより良いか)
--     ・大きく負ける確率が下がるか
--   の4点。事後に作ったルールなので、閾値は 2.5 でなく 3.0 に上げ、循環シフト検定と
--   別の地合い定義を入れた。**別の期間での確認ではない。**
--
-- 前提: ddl/24_xsection_momentum_panel.sql で xs_mom_panel を作成済みであること。
--
--------------------------------------------------------------------------------
-- 【合格の条件】 ← 結果を見る前に固定。(a)〜(g) すべて満たして初めて「ふるいとして有効」
--
--   (a) SWITCHED の GAP(4週)の平均が負で t ≤ -3.0。かつ UP の週・DOWN の週のどちらでも平均が負
--   (b) 循環シフト検定(2)で p ≤ 0.05。地合いの系列を循環させてずらし、各ずらし方で
--       SWITCHED の GAP の平均を計算して、実際の値(負)がずらした値より小さい(より負)かを見る
--   (c) どの1エピソードを除いても、その地合いの GAP の平均が負で、全体の半分以上が残る(3)
--   (d) 前半(〜2021年12月)・後半(2022年1月〜)の両方で GAP の平均が負(4)
--   (e) 地合いを市場26週・TOPIX 13週に変えても、GAP の平均が負で t ≤ -2.0(5)
--   (f) 売買代金の下限(1億円/日以上、5億円/日以上)を付けて五分位を切り直しても、
--       GAP の平均が負で t ≤ -2.5(6)
--   (g) SWITCHED の GAP の平均が、BOTTOM_M6・TOP_REV(無条件)のどちらよりも負(1)。
--       そうでなければ、地合いで切り替える意味は無く、単純な無条件のふるいで足りる
--
--   参考(判定に数えない): D の大きさ(買い側の改善幅)、8週、損失確率(AVOID と KEPT で
--   EXR_IS ≤ -10pt の割合・同業同規模の平均に勝った割合)、位相を変えた確認。
--
--------------------------------------------------------------------------------
-- 【読むときの前提】
--   ・D は小さい。AVOID が全体の約20%なので、D ≈ (GAP の絶対値)× 0.2 程度。
--     GAP が -0.4pt なら D は +0.1pt/4週ほど。買い側の選別の精度を上げる別の信号が無ければ、
--     ふるいだけで取れる超過リターンは小さい。
--   ・手元データは上昇相場の10年のみ。リターンは分割のみ調整、配当・優待落ちを含む。
--   ・ふるいは売買コストがほぼかからない(買わないだけ)が、買う側の候補が絞られるので、
--     分散が減る(同じ群に偏る)可能性がある。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. ふるいの GAP と D(条件 a・g)。4週・8週。
--
-- SCOPE: ALL = 全週、UP / DOWN = その地合いの週だけ(本番のふるいは UP で BOTTOM_M6、DOWN で TOP_REV)。
-- BOTTOM_M6 を DOWN の週に、TOP_REV を UP の週に当てた行は「地合いを無視した場合」の参考。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mom_12_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mom_12_1, p.mkt_ret_13w_past,
           p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM obs o
),
wk AS (
    SELECT h, week_start,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           AVG(exr_is) AS m_all,
           AVG(CASE WHEN q_m6 = 1 THEN exr_is END)  AS m_u,
           AVG(CASE WHEN q_m6 > 1 THEN exr_is END)  AS m_ku,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) AS m_d,
           AVG(CASE WHEN q_rev < 5 THEN exr_is END) AS m_kd
    FROM rk
    GROUP BY h, week_start
),
w2 AS (
    SELECT wk.*, m_u - m_ku AS gap_up, m_ku - m_all AS d_up, m_d - m_kd AS gap_dn, m_kd - m_all AS d_dn
    FROM wk
),
lg AS (
    SELECT h, 'BOTTOM_M6' AS filt, week_start, up, gap_up AS gap, d_up AS d FROM w2
    UNION ALL
    SELECT h, 'TOP_REV', week_start, up, gap_dn, d_dn FROM w2
    UNION ALL
    SELECT h, 'SWITCHED', week_start, up, CASE WHEN up = 1 THEN gap_up ELSE gap_dn END,
           CASE WHEN up = 1 THEN d_up ELSE d_dn END FROM w2
)
SELECT h AS horizon_w, filt, CASE WHEN up = 1 THEN 'UP' WHEN up = 0 THEN 'DOWN' ELSE 'ALL' END AS scope,
       COUNT(*) AS n_weeks,
       ROUND(AVG(gap), 2) AS avg_gap,
       ROUND(AVG(gap) / NULLIF(STDDEV(gap) / SQRT(COUNT(*)), 0), 2) AS t_gap,
       ROUND(AVG(d), 3) AS avg_d,
       ROUND(AVG(d) / NULLIF(STDDEV(d) / SQRT(COUNT(*)), 0), 2) AS t_d
FROM lg
GROUP BY h, filt, GROUPING SETS ((up), ())
ORDER BY h, filt, scope;


--------------------------------------------------------------------------------
-- 2. 循環シフト検定(条件 b)。4週のみ。
--
-- 実際の地合いの系列を時間軸に循環させてずらし(6〜N-6週)、各ずらし方で SWITCHED の GAP の平均と
-- D の平均を計算する。実際の値がずらした値の分布のどこにあるかを p で示す
-- (p = (ずらした値で実際以下の数 + 1)/(ずらした数 + 1)。GAP は負ほど良いので「以下」を数える)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mkt_ret_13w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM obs o
),
wk AS (
    SELECT week_start,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           AVG(exr_is) AS m_all,
           AVG(CASE WHEN q_m6 = 1 THEN exr_is END)  AS m_u,
           AVG(CASE WHEN q_m6 > 1 THEN exr_is END)  AS m_ku,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) AS m_d,
           AVG(CASE WHEN q_rev < 5 THEN exr_is END) AS m_kd
    FROM rk
    GROUP BY week_start
),
sw AS (
    SELECT ROW_NUMBER() OVER (ORDER BY week_start) AS rn, up,
           m_u - m_ku AS gap_up, m_ku - m_all AS d_up, m_d - m_kd AS gap_dn, m_kd - m_all AS d_dn
    FROM wk
),
nn AS (
    SELECT COUNT(*) AS n FROM sw
),
ks AS (
    SELECT LEVEL + 5 AS k FROM dual CONNECT BY LEVEL <= (SELECT n FROM nn) - 11
    UNION ALL
    SELECT 0 FROM dual
),
sh AS (
    SELECT ks.k, a.gap_up, a.d_up, a.gap_dn, a.d_dn, b.up AS up_s
    FROM ks
    CROSS JOIN nn
    JOIN sw a ON 1 = 1
    JOIN sw b ON b.rn = MOD(a.rn - 1 + ks.k, nn.n) + 1
),
st AS (
    SELECT k,
           AVG(CASE WHEN up_s = 1 THEN gap_up ELSE gap_dn END) AS gap_mean,
           AVG(CASE WHEN up_s = 1 THEN d_up ELSE d_dn END)     AS d_mean
    FROM sh
    GROUP BY k
)
SELECT ROUND(a.gap_mean, 3) AS gap_mean, ROUND(a.d_mean, 3) AS d_mean,
       (SELECT COUNT(*) FROM st WHERE k > 0) AS n_null,
       (SELECT ROUND(AVG(gap_mean), 3) FROM st WHERE k > 0) AS null_avg_gap,
       (SELECT ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY gap_mean), 3) FROM st WHERE k > 0) AS null_p05_gap,
       (SELECT ROUND((COUNT(CASE WHEN gap_mean <= a.gap_mean THEN 1 END) + 1) / (COUNT(*) + 1), 3) FROM st WHERE k > 0) AS p_gap,
       (SELECT ROUND(AVG(d_mean), 3) FROM st WHERE k > 0) AS null_avg_d,
       (SELECT ROUND((COUNT(CASE WHEN d_mean >= a.d_mean THEN 1 END) + 1) / (COUNT(*) + 1), 3) FROM st WHERE k > 0) AS p_d
FROM st a
WHERE a.k = 0;


--------------------------------------------------------------------------------
-- 3-1. エピソード別(条件 c)。4週のみ。
--
-- 同じ地合いが続く起点週のまとまりを1エピソードとする。LEG_GAP = そのエピソードの SWITCHED の GAP の平均。
-- LOO_STATE_GAP = そのエピソードを除いた、同じ地合いの GAP の平均(全体は ALL_STATE_GAP)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mkt_ret_13w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM obs o
),
wk AS (
    SELECT week_start,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           MAX(mkt_ret_13w_past) AS mkt13,
           AVG(CASE WHEN q_m6 = 1 THEN exr_is END) - AVG(CASE WHEN q_m6 > 1 THEN exr_is END)   AS gap_up,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev < 5 THEN exr_is END) AS gap_dn
    FROM rk
    GROUP BY week_start
),
w2 AS (
    SELECT wk.*, CASE WHEN up = 1 THEN gap_up ELSE gap_dn END AS gap,
           CASE WHEN up = LAG(up) OVER (ORDER BY week_start) THEN 0 ELSE 1 END AS chg
    FROM wk
),
w3 AS (
    SELECT w2.*, SUM(chg) OVER (ORDER BY week_start ROWS UNBOUNDED PRECEDING) AS ep
    FROM w2
),
ep AS (
    SELECT ep, MAX(up) AS up, MIN(week_start) AS d_from, MAX(week_start) AS d_to, COUNT(*) AS n_weeks,
           ROUND(AVG(mkt13), 1) AS avg_mkt13, SUM(gap) AS sm, AVG(gap) AS leg_gap
    FROM w3
    GROUP BY ep
)
SELECT ep, CASE WHEN up = 1 THEN 'UP' ELSE 'DOWN' END AS state, d_from, d_to, n_weeks, avg_mkt13,
       ROUND(leg_gap, 2) AS leg_gap,
       ROUND((SUM(sm) OVER (PARTITION BY up) - sm) / NULLIF(SUM(n_weeks) OVER (PARTITION BY up) - n_weeks, 0), 2) AS loo_state_gap,
       ROUND(SUM(sm) OVER (PARTITION BY up) / SUM(n_weeks) OVER (PARTITION BY up), 2) AS all_state_gap
FROM ep
ORDER BY ep;


--------------------------------------------------------------------------------
-- 3-2. エピソード単位の集計(条件 c の補足)
--------------------------------------------------------------------------------
-- 3-1 の ep CTE を、エピソード単位の平均・t に集約する。
-- (SQL は 3-1 と同じ obs / rk / wk / w2 / w3 / ep を使い、末尾だけ次のものに替える)
--   SELECT CASE WHEN up = 1 THEN 'UP' ELSE 'DOWN' END AS state, COUNT(*) AS n_episodes,
--          ROUND(AVG(leg_gap), 2) AS avg_ep_gap,
--          ROUND(AVG(leg_gap) / NULLIF(STDDEV(leg_gap) / SQRT(COUNT(*)), 0), 2) AS t_ep,
--          SUM(CASE WHEN leg_gap < 0 THEN 1 ELSE 0 END) AS n_ep_neg
--   FROM ep GROUP BY up ORDER BY state


--------------------------------------------------------------------------------
-- 4. 前半・後半(条件 d)。4週。分割は2022年1月。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mkt_ret_13w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM obs o
),
wk AS (
    SELECT week_start,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           AVG(CASE WHEN q_m6 = 1 THEN exr_is END) - AVG(CASE WHEN q_m6 > 1 THEN exr_is END)   AS gap_up,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev < 5 THEN exr_is END) AS gap_dn
    FROM rk
    GROUP BY week_start
),
w2 AS (
    SELECT wk.*, CASE WHEN week_start < DATE '2022-01-01' THEN 'H1' ELSE 'H2' END AS half,
           CASE WHEN up = 1 THEN gap_up ELSE gap_dn END AS gap
    FROM wk
)
SELECT half, CASE WHEN up = 1 THEN 'UP' WHEN up = 0 THEN 'DOWN' ELSE 'ALL' END AS state,
       COUNT(*) AS n_weeks, ROUND(AVG(gap), 2) AS avg_gap,
       ROUND(AVG(gap) / NULLIF(STDDEV(gap) / SQRT(COUNT(*)), 0), 2) AS t_gap
FROM w2
GROUP BY GROUPING SETS ((half, up), (half))
ORDER BY half, state;


--------------------------------------------------------------------------------
-- 5. 地合いの定義を変えた確認(条件 e)。4週。
--   BASE: 市場13週(本番)/ EW26: 全銘柄の過去26週の等ウェイト平均リターン ≥ 0 /
--   TOPIX13: TOPIX の過去13週リターン ≥ 0
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mkt_ret_13w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM obs o
),
wk AS (
    SELECT week_start, MIN(wk_idx) AS wk_idx,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up_base,
           AVG(CASE WHEN q_m6 = 1 THEN exr_is END) - AVG(CASE WHEN q_m6 > 1 THEN exr_is END)   AS gap_up,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev < 5 THEN exr_is END) AS gap_dn
    FROM rk
    GROUP BY week_start
),
ew26 AS (
    SELECT week_start, AVG(mom_26w) AS mkt26 FROM xs_weekly_panel WHERE mom_26w IS NOT NULL GROUP BY week_start
),
bd AS (
    SELECT DISTINCT wk_idx, last_bd FROM xs_weekly_panel
),
tpx AS (
    SELECT b.wk_idx, t1.close_price / NULLIF(t0.close_price, 0) - 1 AS topix13
    FROM bd b
    JOIN bd b0 ON b0.wk_idx = b.wk_idx - 13
    JOIN topix_price_daily t1 ON t1.price_date = b.last_bd
    JOIN topix_price_daily t0 ON t0.price_date = b0.last_bd
),
st AS (
    SELECT 'BASE' AS def, w.week_start, w.up_base AS up, w.gap_up, w.gap_dn FROM wk w
    UNION ALL
    SELECT 'EW26', w.week_start, CASE WHEN e.mkt26 >= 0 THEN 1 ELSE 0 END, w.gap_up, w.gap_dn
    FROM wk w JOIN ew26 e ON e.week_start = w.week_start
    UNION ALL
    SELECT 'TOPIX13', w.week_start, CASE WHEN t.topix13 >= 0 THEN 1 ELSE 0 END, w.gap_up, w.gap_dn
    FROM wk w JOIN tpx t ON t.wk_idx = w.wk_idx
),
g AS (
    SELECT st.*, CASE WHEN up = 1 THEN gap_up ELSE gap_dn END AS gap FROM st
)
SELECT def, COUNT(*) AS n_weeks, SUM(up) AS n_up, COUNT(*) - SUM(up) AS n_down,
       ROUND(AVG(gap), 2) AS avg_gap,
       ROUND(AVG(gap) / NULLIF(STDDEV(gap) / SQRT(COUNT(*)), 0), 2) AS t_gap,
       ROUND(AVG(CASE WHEN up = 1 THEN gap_up END), 2) AS gap_up_leg,
       ROUND(AVG(CASE WHEN up = 0 THEN gap_dn END), 2) AS gap_dn_leg
FROM g
GROUP BY def
ORDER BY def;


--------------------------------------------------------------------------------
-- 6. 売買代金の下限を付けて五分位を切り直した GAP(条件 f)。4週。
--
-- 起点週の直近4週の1日平均売買代金(TURNOVER_OKU)が下限以上の銘柄だけで、五分位と KEPT/AVOID を作り直す。
-- 地合いの判定は全銘柄ベース(本番のまま)。D は KEPT から選ぶ場合の改善幅。
--------------------------------------------------------------------------------
WITH floors AS (
    SELECT 0 AS fl FROM dual UNION ALL SELECT 1 FROM dual UNION ALL SELECT 5 FROM dual
),
obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.turnover_oku, p.ret_4w_past, p.mom_6_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
      AND p.turnover_oku IS NOT NULL
),
fo AS (
    SELECT f.fl, o.* FROM obs o JOIN floors f ON o.turnover_oku >= f.fl
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.fl, o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.fl, o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM fo o
),
wk AS (
    SELECT fl, week_start,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           AVG(exr_is) AS m_all,
           AVG(CASE WHEN q_m6 = 1 THEN exr_is END)  AS m_u,
           AVG(CASE WHEN q_m6 > 1 THEN exr_is END)  AS m_ku,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) AS m_d,
           AVG(CASE WHEN q_rev < 5 THEN exr_is END) AS m_kd,
           COUNT(*) AS n
    FROM rk
    GROUP BY fl, week_start
),
w2 AS (
    SELECT wk.*, CASE WHEN up = 1 THEN m_u - m_ku ELSE m_d - m_kd END AS gap,
           CASE WHEN up = 1 THEN m_ku - m_all ELSE m_kd - m_all END AS d
    FROM wk
)
SELECT fl AS floor_oku, COUNT(*) AS n_weeks, ROUND(AVG(n)) AS avg_stocks,
       ROUND(AVG(gap), 2) AS avg_gap,
       ROUND(AVG(gap) / NULLIF(STDDEV(gap) / SQRT(COUNT(*)), 0), 2) AS t_gap,
       ROUND(AVG(CASE WHEN up = 1 THEN m_u - m_ku END), 2) AS gap_up_leg,
       ROUND(AVG(CASE WHEN up = 0 THEN m_d - m_kd END), 2) AS gap_dn_leg,
       ROUND(AVG(d), 3) AS avg_d,
       ROUND(AVG(d) / NULLIF(STDDEV(d) / SQRT(COUNT(*)), 0), 2) AS t_d
FROM w2
GROUP BY fl
ORDER BY fl;


--------------------------------------------------------------------------------
-- 7. 損失確率(参考)。4週。AVOID と KEPT の銘柄ごとの分布。
--
-- 週ごとに、AVOID・KEPT それぞれで「EXR_IS ≤ -10pt の割合」「同業同規模の平均に勝った割合」「平均」「標準偏差」を
-- 出し、週をまたいで平均する。下限なしと1億円/日以上。
--------------------------------------------------------------------------------
WITH floors AS (
    SELECT 0 AS fl FROM dual UNION ALL SELECT 1 FROM dual
),
obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.turnover_oku, p.ret_4w_past, p.mom_6_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
      AND p.turnover_oku IS NOT NULL
),
fo AS (
    SELECT f.fl, o.* FROM obs o JOIN floors f ON o.turnover_oku >= f.fl
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.fl, o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.fl, o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6
    FROM fo o
),
fl AS (
    SELECT rk.*,
           CASE WHEN (mkt_ret_13w_past >= 0 AND q_m6 = 1) OR (mkt_ret_13w_past < 0 AND q_rev = 5)
                THEN 'AVOID' ELSE 'KEPT' END AS grp
    FROM rk
),
wk AS (
    SELECT fl, grp, week_start, COUNT(*) AS n, AVG(exr_is) AS m, STDDEV(exr_is) AS sd,
           AVG(CASE WHEN exr_is <= -10 THEN 1 ELSE 0 END) AS p_big_loss,
           AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END) AS p_beat
    FROM fl
    GROUP BY fl, grp, week_start
)
SELECT fl AS floor_oku, grp, COUNT(*) AS n_weeks, ROUND(AVG(n)) AS avg_stocks,
       ROUND(AVG(m), 3) AS avg_exr_is, ROUND(AVG(sd), 2) AS avg_sd,
       ROUND(AVG(p_big_loss) * 100, 2) AS pct_exr_le_m10,
       ROUND(AVG(p_beat) * 100, 2) AS pct_beat
FROM wk
GROUP BY fl, grp
ORDER BY fl, grp;
