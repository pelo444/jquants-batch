--------------------------------------------------------------------------------
-- 地合い条件付きルールの検証(下落後は逆張り、上昇局面は順張り)
--
-- 問い: 「直近の市場が下げた後は直近4週の負け組を買い(反転)、上昇局面では中期の勝ち組を買う
--        (順張り)」というルールは、同業・同規模の銘柄より強いか。
--
-- 【このルールはどこから来たか】
--   xsection_momentum_backtest.sql と xsection_reversal_backtest.sql は、全体では4本・2本とも
--   不合格だった。ただし起点週の地合い(直近13週の市場平均リターンが 正=UP / 負=DOWN)で割ると、
--   どちらの指標も UP で順張り、DOWN で反転という符号の入れ替わりが出た:
--     MOM_6_1(群5−群1)4週: UP +0.63pt(t 3.37)/ DOWN -0.57pt(t -1.52)
--     REV_4W (群1−群5)4週: UP -0.11pt(t -0.58)/ DOWN +0.86pt(t 2.30)
--   **つまりこのルールは、同じデータを見て事後に作ったもの。** 以下の検証の p 値・t 値は
--   そのまま信じてはいけない(いわゆる多重検定・データの使い回し)。そのために
--     ・合格の閾値を 2.5 でなく 3.0 に上げる
--     ・探した範囲(3指標 × UP/DOWN × 4週・8週)をそろえた循環シフト検定を置く
--     ・地合いが持続することによる実効的な観測数の少なさを、エピソード単位で数える
--     ・地合いの定義を変えても向きが残るかを見る(別の指標: 市場26週、TOPIX 13週)
--   を条件に入れた。それでも**手元のデータの中だけの検証**で、別の期間での確認にはならない。
--
-- 前提: ddl/24_xsection_momentum_panel.sql で xs_mom_panel を作成済みであること。
--
--------------------------------------------------------------------------------
-- 【ルールと標本】 ← 結果を見る前に固定(2026-10-04)
--
--   標本: 起点週は4週おき(MOD(wk_idx,4)=0)、保有4週(判定)。8週おき・8週保有は参考。
--         REV_4W・MOM_6_1・MOM_12_1・地合いがそろう週だけ(2017年8月以降、約118週)。
--   地合い: 起点週の「直近13週の全銘柄の等ウェイト平均リターン(mkt_ret_13w_past)」
--           0以上 = UP、負 = DOWN。閾値0は固定(動かさない)。起点週までの情報だけで決まる。
--   ルール:
--     UP   → MOM_6_1 が最上位の五分位(群5)を買う。スプレッド = 群5 − 群1
--     DOWN → REV_4W  が最下位の五分位(群1)を買う。スプレッド = 群1 − 群5
--   切替スプレッド SR = UP の週は MOM_6_1 の (群5−群1)、DOWN の週は REV_4W の (群1−群5)。
--   相対リターンは EXR_IS(同週・同17業種×同規模5分位の等ウェイト平均との差、%)。
--
-- 【合格の条件】 ← 結果を見る前に固定。(a)〜(f) すべて満たして初めて合格
--
--   (a) SR の平均が正で t ≥ 3.0(4週保有)。かつ UP の脚・DOWN の脚の平均がどちらも正
--       3.0 にしたのは、ルールを事後に選んだ(3指標 × 2つの状態 × 2つの期間を見た)ため
--   (b) 循環シフト検定(2)で p ≤ 0.05。次の2つの両方:
--       ・ルールの平均 SR(UP は MOM_6_1、DOWN は REV_4W に固定)
--       ・3指標(REV_4W・MOM_6_1・MOM_12_1)それぞれの「UP の週の(群5−群1)−DOWN の週の(群5−群1)」の
--         Welch t のうち最大のもの(指標を選んだ分の多重性を入れた版)
--       地合いの系列を時間軸に循環させてずらし(6週〜N-6週)、各ずらし方で同じ統計量を計算して
--       実際の値と比べる。地合いは持続するので、週をでたらめに並べ替える検定は使わない
--   (c) エピソード: 同じ地合いが続く週のまとまりを1エピソードとして数え、(3)で
--       どの1エピソードを除いても、その脚の平均が正で、全体の半分以上が残る。
--       DOWN のエピソードが3未満なら「検出できない」と読み、この条件は不合格とする
--   (d) 前半(〜2021年12月)・後半(2022年1月〜)の両方で SR の平均が正(4)
--   (e) 地合いの定義を変えても、SR の平均が正で t ≥ 2.0(5):
--       市場26週(全銘柄の等ウェイト平均の過去26週リターン ≥ 0)/ TOPIX の過去13週リターン ≥ 0
--   (f) 売買代金の下限(1億円/日以上、5億円/日以上)を付けて五分位を切り直しても、
--       SR の平均が正で t ≥ 2.5(6)
--
--   参考(判定に数えない): 8週保有、買い側だけ(UP の群5、DOWN の群1)の超過リターン、
--   常に MOM_6_1(群5−群1)/ 常に REV_4W(群1−群5)で持った場合、往復コスト控除後の大きさ。
--
--------------------------------------------------------------------------------
-- 【読むときの前提】
--   ・手元データは上昇相場の10年のみ(regime_bias_limits)。DOWN の週は40(4週保有)ほど。
--     地合いは持続するので、実効的な観測数はさらに少ない(エピソード数を見る)。
--   ・リターンは分割のみ調整。配当・優待落ちを含む。往復の売買コストは引いていない。
--   ・合格しても「この10年で効いた」の確認であって、ルールとして将来使える保証にはならない。
--     地合いの切替は、手遅れで入る(下落の底や上昇の天井)リスクがある。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 切替スプレッド SR(条件 a)と、買い側だけの超過リターン(参考)
--
-- UP_* は UP の週の MOM_6_1(群5−群1)、DN_* は DOWN の週の REV_4W(群1−群5)。
-- G5_UP は UP の週の MOM_6_1 群5のみの超過リターン、G1_DN は DOWN の週の REV_4W 群1のみ。
-- ALWAYS_* は地合いを使わず常にその指標で持った場合(参考)。
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
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.mom_12_1, o.code)    AS q_m12
    FROM obs o
),
wk AS (
    SELECT h, week_start, MIN(wk_idx) AS wk_idx,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS c_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) - AVG(CASE WHEN q_m6  = 1 THEN exr_is END) AS c_m6,
           AVG(CASE WHEN q_m12 = 5 THEN exr_is END) - AVG(CASE WHEN q_m12 = 1 THEN exr_is END) AS c_m12,
           AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS g1_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) AS g5_m6
    FROM rk
    GROUP BY h, week_start
),
sr AS (
    SELECT wk.*, CASE WHEN up = 1 THEN c_m6 ELSE -c_rev END AS sr,
           CASE WHEN up = 1 THEN g5_m6 ELSE g1_rev END AS lo
    FROM wk
)
SELECT h AS horizon_w, COUNT(*) AS n_weeks, SUM(up) AS n_up, COUNT(*) - SUM(up) AS n_down,
       ROUND(AVG(sr), 2) AS avg_sr,
       ROUND(AVG(sr) / NULLIF(STDDEV(sr) / SQRT(COUNT(*)), 0), 2) AS t_sr,
       ROUND(AVG(CASE WHEN sr > 0 THEN 1 ELSE 0 END) * 100, 1) AS pct_weeks_pos,
       ROUND(AVG(CASE WHEN up = 1 THEN c_m6 END), 2) AS avg_up_leg,
       ROUND(AVG(CASE WHEN up = 1 THEN c_m6 END) / NULLIF(STDDEV(CASE WHEN up = 1 THEN c_m6 END) / SQRT(SUM(up)), 0), 2) AS t_up_leg,
       ROUND(AVG(CASE WHEN up = 0 THEN -c_rev END), 2) AS avg_dn_leg,
       ROUND(AVG(CASE WHEN up = 0 THEN -c_rev END) / NULLIF(STDDEV(CASE WHEN up = 0 THEN -c_rev END) / SQRT(COUNT(*) - SUM(up)), 0), 2) AS t_dn_leg,
       ROUND(AVG(CASE WHEN up = 1 THEN g5_m6 END), 2) AS g5_up,
       ROUND(AVG(CASE WHEN up = 0 THEN g1_rev END), 2) AS g1_dn,
       ROUND(AVG(lo), 2) AS avg_long_only,
       ROUND(AVG(lo) / NULLIF(STDDEV(lo) / SQRT(COUNT(*)), 0), 2) AS t_long_only,
       ROUND(AVG(c_m6), 2) AS always_m6,
       ROUND(AVG(-c_rev), 2) AS always_rev
FROM sr
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 2. 循環シフト検定(条件 b)。4週保有のみ。
--
-- 実際の地合いの系列(UP/DOWN)を時間軸に循環させてずらし、各ずらし方でルールの平均 SR と
-- 「3指標それぞれの UP−DOWN の Welch t」の最大値を計算する。実際の値がずらした値の分布の
-- どこにあるかを p で示す(p = (ずらした値で実際以上の数 + 1)/(ずらした数 + 1))。
-- T_REV・T_M6・T_M12 は各指標の (群5−群1) の UP の週の平均 − DOWN の週の平均の Welch t。
-- T_MAX は3つの最大(指標を選んだ分の多重性を入れた統計量)、RULE_MEAN はルールの平均 SR。
-- K は循環させた週数(0 = 実際)。ずらし方は 6 〜 N-6 週。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mom_12_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
      AND p.mom_6_1 IS NOT NULL AND p.mom_12_1 IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
rk AS (
    SELECT o.*,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.ret_4w_past, o.code) AS q_rev,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_6_1, o.code)     AS q_m6,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.mom_12_1, o.code)    AS q_m12
    FROM obs o
),
wk AS (
    SELECT week_start,
           MAX(CASE WHEN mkt_ret_13w_past >= 0 THEN 1 ELSE 0 END) AS up,
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS c_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) - AVG(CASE WHEN q_m6  = 1 THEN exr_is END) AS c_m6,
           AVG(CASE WHEN q_m12 = 5 THEN exr_is END) - AVG(CASE WHEN q_m12 = 1 THEN exr_is END) AS c_m12
    FROM rk
    GROUP BY week_start
),
sw AS (
    SELECT ROW_NUMBER() OVER (ORDER BY week_start) AS rn, up, c_rev, c_m6, c_m12 FROM wk
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
    SELECT ks.k, a.c_rev, a.c_m6, a.c_m12, b.up AS up_s
    FROM ks
    CROSS JOIN nn
    JOIN sw a ON 1 = 1
    JOIN sw b ON b.rn = MOD(a.rn - 1 + ks.k, nn.n) + 1
),
st AS (
    SELECT k,
           (AVG(CASE WHEN up_s = 1 THEN c_rev END) - AVG(CASE WHEN up_s = 0 THEN c_rev END))
             / SQRT(VAR_SAMP(CASE WHEN up_s = 1 THEN c_rev END) / COUNT(CASE WHEN up_s = 1 THEN c_rev END)
                  + VAR_SAMP(CASE WHEN up_s = 0 THEN c_rev END) / COUNT(CASE WHEN up_s = 0 THEN c_rev END)) AS t_rev,
           (AVG(CASE WHEN up_s = 1 THEN c_m6 END) - AVG(CASE WHEN up_s = 0 THEN c_m6 END))
             / SQRT(VAR_SAMP(CASE WHEN up_s = 1 THEN c_m6 END) / COUNT(CASE WHEN up_s = 1 THEN c_m6 END)
                  + VAR_SAMP(CASE WHEN up_s = 0 THEN c_m6 END) / COUNT(CASE WHEN up_s = 0 THEN c_m6 END)) AS t_m6,
           (AVG(CASE WHEN up_s = 1 THEN c_m12 END) - AVG(CASE WHEN up_s = 0 THEN c_m12 END))
             / SQRT(VAR_SAMP(CASE WHEN up_s = 1 THEN c_m12 END) / COUNT(CASE WHEN up_s = 1 THEN c_m12 END)
                  + VAR_SAMP(CASE WHEN up_s = 0 THEN c_m12 END) / COUNT(CASE WHEN up_s = 0 THEN c_m12 END)) AS t_m12,
           AVG(CASE WHEN up_s = 1 THEN c_m6 ELSE -c_rev END) AS rule_mean,
           SUM(up_s) AS n_up_s
    FROM sh
    GROUP BY k
),
tm AS (
    SELECT st.*, GREATEST(t_rev, t_m6, t_m12) AS t_max FROM st
)
SELECT ROUND(a.t_rev, 2) AS t_rev, ROUND(a.t_m6, 2) AS t_m6, ROUND(a.t_m12, 2) AS t_m12,
       ROUND(a.t_max, 2) AS t_max, ROUND(a.rule_mean, 3) AS rule_mean,
       (SELECT COUNT(*) FROM tm WHERE k > 0) AS n_null,
       (SELECT ROUND(AVG(t_max), 2) FROM tm WHERE k > 0) AS null_avg_tmax,
       (SELECT ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t_max), 2) FROM tm WHERE k > 0) AS null_p95_tmax,
       (SELECT ROUND(AVG(rule_mean), 3) FROM tm WHERE k > 0) AS null_avg_rule,
       (SELECT ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY rule_mean), 3) FROM tm WHERE k > 0) AS null_p95_rule,
       (SELECT ROUND((COUNT(CASE WHEN t_max >= a.t_max THEN 1 END) + 1) / (COUNT(*) + 1), 3) FROM tm WHERE k > 0) AS p_tmax,
       (SELECT ROUND((COUNT(CASE WHEN rule_mean >= a.rule_mean THEN 1 END) + 1) / (COUNT(*) + 1), 3) FROM tm WHERE k > 0) AS p_rule,
       (SELECT ROUND((COUNT(CASE WHEN t_m6 >= a.t_m6 THEN 1 END) + 1) / (COUNT(*) + 1), 3) FROM tm WHERE k > 0) AS p_m6,
       (SELECT ROUND((COUNT(CASE WHEN t_rev >= a.t_rev THEN 1 END) + 1) / (COUNT(*) + 1), 3) FROM tm WHERE k > 0) AS p_rev
FROM tm a
WHERE a.k = 0;


--------------------------------------------------------------------------------
-- 3. エピソード別(条件 c)。4週保有のみ。
--
-- 同じ地合いが続く起点週のまとまりを1エピソードとする(4週おきの標本で、UP/DOWN が切り替わるたびに区切る)。
-- LEG_MEAN = そのエピソードの SR の平均(UP のときは MOM_6_1 群5−群1、DOWN のときは REV_4W 群1−群5)。
-- LOO_STATE_MEAN = そのエピソードを除いた、同じ地合いの脚の平均(全体は ALL_STATE_MEAN)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mom_12_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
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
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS c_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) - AVG(CASE WHEN q_m6  = 1 THEN exr_is END) AS c_m6
    FROM rk
    GROUP BY week_start
),
w2 AS (
    SELECT wk.*, CASE WHEN up = 1 THEN c_m6 ELSE -c_rev END AS sr,
           CASE WHEN up = LAG(up) OVER (ORDER BY week_start) THEN 0 ELSE 1 END AS chg
    FROM wk
),
w3 AS (
    SELECT w2.*, SUM(chg) OVER (ORDER BY week_start ROWS UNBOUNDED PRECEDING) AS ep
    FROM w2
),
ep AS (
    SELECT ep, MAX(up) AS up, MIN(week_start) AS d_from, MAX(week_start) AS d_to, COUNT(*) AS n_weeks,
           ROUND(AVG(mkt13), 1) AS avg_mkt13, SUM(sr) AS sm, AVG(sr) AS leg_mean
    FROM w3
    GROUP BY ep
)
SELECT ep, CASE WHEN up = 1 THEN 'UP' ELSE 'DOWN' END AS state, d_from, d_to, n_weeks, avg_mkt13,
       ROUND(leg_mean, 2) AS leg_mean,
       ROUND((SUM(sm) OVER (PARTITION BY up) - sm) / NULLIF(SUM(n_weeks) OVER (PARTITION BY up) - n_weeks, 0), 2) AS loo_state_mean,
       ROUND(SUM(sm) OVER (PARTITION BY up) / SUM(n_weeks) OVER (PARTITION BY up), 2) AS all_state_mean
FROM ep
ORDER BY ep;


--------------------------------------------------------------------------------
-- 4. 前半・後半(条件 d)。4週保有。分割は2022年1月。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mom_12_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
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
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS c_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) - AVG(CASE WHEN q_m6  = 1 THEN exr_is END) AS c_m6
    FROM rk
    GROUP BY week_start
),
sr AS (
    SELECT wk.*, CASE WHEN week_start < DATE '2022-01-01' THEN 'H1' ELSE 'H2' END AS half,
           CASE WHEN up = 1 THEN c_m6 ELSE -c_rev END AS sr
    FROM wk
)
SELECT half, CASE WHEN up = 1 THEN 'UP' WHEN up = 0 THEN 'DOWN' ELSE 'ALL' END AS state,
       COUNT(*) AS n_weeks, ROUND(AVG(sr), 2) AS avg_sr,
       ROUND(AVG(sr) / NULLIF(STDDEV(sr) / SQRT(COUNT(*)), 0), 2) AS t_sr
FROM sr
GROUP BY GROUPING SETS ((half, up), (half))
ORDER BY half, state;


--------------------------------------------------------------------------------
-- 5. 地合いの定義を変えた確認(条件 e)。4週保有。
--
--   BASE   : 全銘柄の過去13週の等ウェイト平均リターン ≥ 0(本番の定義)
--   EW26   : 全銘柄の過去26週の等ウェイト平均リターン(xs_weekly_panel の mom_26w の週平均)≥ 0
--   TOPIX13: TOPIX の過去13週リターン(起点週の最終営業日の終値÷13週前の最終営業日の終値)≥ 0
-- 定義が違うと UP/DOWN の週の振り分けが変わる。N_UP / N_DOWN で違いを見る。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.ret_4w_past, p.mom_6_1, p.mom_12_1, p.mkt_ret_13w_past,
           p.exr_is_4w AS exr_is
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
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS c_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) - AVG(CASE WHEN q_m6  = 1 THEN exr_is END) AS c_m6
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
    SELECT 'BASE' AS def, w.week_start, w.up_base AS up, w.c_rev, w.c_m6 FROM wk w
    UNION ALL
    SELECT 'EW26', w.week_start, CASE WHEN e.mkt26 >= 0 THEN 1 ELSE 0 END, w.c_rev, w.c_m6
    FROM wk w JOIN ew26 e ON e.week_start = w.week_start
    UNION ALL
    SELECT 'TOPIX13', w.week_start, CASE WHEN t.topix13 >= 0 THEN 1 ELSE 0 END, w.c_rev, w.c_m6
    FROM wk w JOIN tpx t ON t.wk_idx = w.wk_idx
),
sr AS (
    SELECT st.*, CASE WHEN up = 1 THEN c_m6 ELSE -c_rev END AS sr FROM st
)
SELECT def, COUNT(*) AS n_weeks, SUM(up) AS n_up, COUNT(*) - SUM(up) AS n_down,
       ROUND(AVG(sr), 2) AS avg_sr,
       ROUND(AVG(sr) / NULLIF(STDDEV(sr) / SQRT(COUNT(*)), 0), 2) AS t_sr,
       ROUND(AVG(CASE WHEN up = 1 THEN c_m6 END), 2) AS avg_up_leg,
       ROUND(AVG(CASE WHEN up = 0 THEN -c_rev END), 2) AS avg_dn_leg
FROM sr
GROUP BY def
ORDER BY def;


--------------------------------------------------------------------------------
-- 6. 売買代金の下限を付けて五分位を切り直した SR(条件 f)。4週保有。
--
-- 起点週の直近4週の1日平均売買代金(TURNOVER_OKU)が下限以上の銘柄だけで五分位を切り直す。
-- 地合いの判定は全銘柄ベース(本番の定義のまま)。
-- G5_UP / G1_DN は買い側だけ(UP の週は MOM_6_1 群5、DOWN の週は REV_4W 群1)の超過リターン。
--------------------------------------------------------------------------------
WITH floors AS (
    SELECT 0 AS fl FROM dual UNION ALL SELECT 1 FROM dual UNION ALL SELECT 5 FROM dual
),
obs AS (
    SELECT p.week_start, p.wk_idx, p.code, p.turnover_oku, p.ret_4w_past, p.mom_6_1, p.mom_12_1,
           p.mkt_ret_13w_past, p.exr_is_4w AS exr_is
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
           AVG(CASE WHEN q_rev = 5 THEN exr_is END) - AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS c_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) - AVG(CASE WHEN q_m6  = 1 THEN exr_is END) AS c_m6,
           AVG(CASE WHEN q_rev = 1 THEN exr_is END) AS g1_rev,
           AVG(CASE WHEN q_m6  = 5 THEN exr_is END) AS g5_m6,
           COUNT(*) AS n
    FROM rk
    GROUP BY fl, week_start
),
sr AS (
    SELECT wk.*, CASE WHEN up = 1 THEN c_m6 ELSE -c_rev END AS sr,
           CASE WHEN up = 1 THEN g5_m6 ELSE g1_rev END AS lo
    FROM wk
)
SELECT fl AS floor_oku, COUNT(*) AS n_weeks, ROUND(AVG(n)) AS avg_stocks,
       ROUND(AVG(sr), 2) AS avg_sr,
       ROUND(AVG(sr) / NULLIF(STDDEV(sr) / SQRT(COUNT(*)), 0), 2) AS t_sr,
       ROUND(AVG(CASE WHEN up = 1 THEN c_m6 END), 2) AS avg_up_leg,
       ROUND(AVG(CASE WHEN up = 0 THEN -c_rev END), 2) AS avg_dn_leg,
       ROUND(AVG(CASE WHEN up = 1 THEN g5_m6 END), 2) AS g5_up,
       ROUND(AVG(CASE WHEN up = 0 THEN g1_rev END), 2) AS g1_dn,
       ROUND(AVG(lo), 2) AS avg_long_only,
       ROUND(AVG(lo) / NULLIF(STDDEV(lo) / SQRT(COUNT(*)), 0), 2) AS t_long_only
FROM sr
GROUP BY fl
ORDER BY fl;
