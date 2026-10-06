--------------------------------------------------------------------------------
-- 短期リバーサルの横断面検証(銘柄間の優劣)
--
-- 問い: 「直近4週で最も下げた銘柄は、その後(数週間〜1・2か月)、同業・同規模の銘柄より強いか」
--
-- xsection_momentum_backtest.sql(相対モメンタム)は、直近4週を飛ばした12-1・6-1を検証して
-- 4本とも不合格だった。モメンタムが直近4週を飛ばしているのは、1か月以内の騰落は逆戻りしやすい
-- (短期リバーサル)という文献に沿ったもの。こちらはその直近4週そのものを指標にする。
-- 日本株では順張りより反転が効くという報告がある。個人投資家の「押し目買い」「売られ過ぎの逆張り」の
-- 統計的な裏付けにあたる。
--
-- 前提: ddl/24_xsection_momentum_panel.sql で xs_mom_panel を作成済みであること。
--       ret_4w_past(過去4週の調整後リターン)、turnover_oku、mkt_ret_13w_past、exr_is_*/exr_mkt_*、
--       mom_12_1 はすべてそこにある。
--
--------------------------------------------------------------------------------
-- 【検証する指標】 ← 結果を見る前に固定(2026-10-04)
--
--   REV_4W = ret_4w_past = 起点の終値 ÷ 4週前の終値 - 1(調整後、%)。1つだけ。
--   群1 = 週内の最下位五分位(直近4週で最も下げた)、群5 = 最上位五分位(最も上げた)。
--   **反転スプレッド = 群1 − 群5**(正なら反転が効く = 下げた銘柄のほうがその後強い)。
--   モメンタムの検証の「群5−群1」とは符号を逆にしてある。以下、スプレッドはこの定義。
--
--   先行リターンは 4週先・8週先を判定に使う(保有数週間〜1・2か月に合わせる)。
--   **13週先は参考**(反転は時間とともに薄れるはずなので、13週で消えているかも見る)。
--   判定の本数は 1指標 × 2期間 = 2本。
--   向きは固定せず両側で判定する。**ただし逆張りで使えるのは反転スプレッドが正のときだけ。**
--   負(下げた銘柄ほど弱い = 1か月の順張り)なら、逆張りの根拠にならない。
--
-- 【合格の条件】 ← 結果を見る前に固定。1つでも落ちたら不合格。結果を見て条件を変えない
--
--   (a) 群1→5 の相対リターンがおおむね単調に並ぶ(2)
--   (b) 反転スプレッドの t 値が絶対値 2.5 以上。4週・8週で同じ向き(3-1)
--       t 値は「重ならない週ごとのスプレッド」を1観測とした値(Fama-MacBeth の形)。
--       2本あり、2.5 だと全部が無関係でも1本が偶然超える確率は約2.5%。
--   (c) どの1年を除いても向きが残る(3-2)
--   (d) 17業種内で切り直しても向きが残り、4週・8週とも |t| ≥ 2.0(4)
--   (e) SIZE(5)・PBR(3)・MOM_12_1(3)の層の中でも向きが残る(5)
--       小型株ほど反転が出やすい(売買の薄い銘柄の価格は買い気配・売り気配の間で跳ねる)ので、
--       SIZE の層の中で残ることが特に重要。MOM は「中期で勝ち組か負け組か」で反転の出方が違わないかを見る
--   (f) 売買代金の下限(1億円/日以上、5億円/日以上)を付けた中で切り直しても、4週・8週とも
--       同じ向きで |t| ≥ 2.5(6)。需給系・モメンタムの検証で「統計的に有意」と「売買できる」が
--       別だったため、最初から合格条件に入れる。反転は流動性の低い銘柄で出やすいので特に重い
--   (g) 地合い別(起点週の直近13週の市場平均リターン 正/負)の両方で向きが残る(7)
--       下落後の反発局面で反転が逆に振れる(負け組が大きく戻す/さらに売られる)かを見る。
--       手元の下落局面の週数は少ない。週数も併記し、少なければ「検出できない」と読む
--   (h) 優待クロスの時期(起点週が3月・9月、または2月・8月の後半)を除いても、4週のスプレッドの
--       向きが残り、平均が半分以上残る(8)。権利落ちの値下がり(配当・優待落ちはリターンに含まれる)が
--       「下げた銘柄」を機械的に作り、その後の戻しを反転として拾っていないかを見る。8週は標本が
--       半分ほど消えるので判定は4週で行い、t値より平均の大きさで比べる
--   (i) **1週遅れで入っても残る**(9)。起点週の終値ではなく、翌週の終値で入り、そこから4週保有した
--       相対リターンで測った反転スプレッド(群は起点週の順位のまま)が、同じ向きで、平均が3-1の4週の
--       半分以上残る。反転は直近の動きに強く依存し、起点の終値で約定できない現実とのずれが出やすい
--
--   参考(判定に数えない): 13週、群1のみの超過リターン(逆張りの買い側だけで取れる分)、
--   市場全体を引いた相対リターン(EXR_MKT)、重ならない標本の位相を変えた確認(10)、
--   往復コストを引いた後の大きさ(結果の読み方に記す)。
--
--------------------------------------------------------------------------------
-- 【読むときの前提】
--   ・相対リターン EXR_IS は「同じ週・同じ17業種・同じ時価総額5分位」の等ウェイト平均との差(%)。
--   ・手元データは上昇相場の10年のみ(regime_bias_limits)。
--   ・リターンは分割のみ調整。配当・優待落ちを含む。上場廃止銘柄は最後の終値まで。
--   ・**往復の売買コストは引いていない。** 反転は保有が短く回転が速いので、コストの影響が大きい。
--     4週ごとに入れ替えるなら年に約13往復。
--   ・同じ週の銘柄同士は相関するので、銘柄数ではなく週数が独立観測の数。
--     4週先は約125週、8週先は約62週、13週先は約40週。
--   ・4週・8週の結果を結果から選んで報告しない。判定は上の条件どおりに行う。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0. REV_4W と既知の要因との週ごとの順位相関(週平均)
--
-- 反転が「小型株」「流動性の低い銘柄」「中期の負け組」の言い換えになっていないかを見る。
-- 4週おきの週だけを使い、全指標がそろった銘柄だけで順位を付ける。
--------------------------------------------------------------------------------
WITH base AS (
    SELECT week_start, ret_4w_past, mom_12_1, mom_6_1, mcap_oku, pbr, turnover_oku
    FROM xs_mom_panel
    WHERE MOD(wk_idx, 4) = 0
      AND ret_4w_past IS NOT NULL AND mom_12_1 IS NOT NULL AND mom_6_1 IS NOT NULL
      AND mcap_oku IS NOT NULL AND pbr IS NOT NULL AND turnover_oku IS NOT NULL
),
r AS (
    SELECT week_start,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY ret_4w_past)  AS r_rev,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mom_12_1)     AS r12,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mom_6_1)      AS r6,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mcap_oku)     AS r_size,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY pbr)          AS r_pbr,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY turnover_oku) AS r_liq
    FROM base
),
c AS (
    SELECT week_start,
           CORR(r_rev, r12) AS rev_m12, CORR(r_rev, r6) AS rev_m6, CORR(r_rev, r_size) AS rev_size,
           CORR(r_rev, r_pbr) AS rev_pbr, CORR(r_rev, r_liq) AS rev_liq
    FROM r
    GROUP BY week_start
)
SELECT COUNT(*) AS n_weeks,
       ROUND(AVG(rev_m12), 3) AS rev_m12, ROUND(AVG(rev_m6), 3) AS rev_m6,
       ROUND(AVG(rev_size), 3) AS rev_size, ROUND(AVG(rev_pbr), 3) AS rev_pbr,
       ROUND(AVG(rev_liq), 3) AS rev_liq
FROM c;


--------------------------------------------------------------------------------
-- 1. ベースライン(全銘柄、REV_4W が計算できる銘柄)
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.fwd_ret_4w AS ret, p.exr_is_4w AS exr_is, p.exr_mkt_4w AS exr_mkt
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.fwd_ret_8w, p.exr_is_8w, p.exr_mkt_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.fwd_ret_13w, p.exr_is_13w, p.exr_mkt_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL AND p.ret_4w_past IS NOT NULL
)
SELECT h AS horizon_w, COUNT(DISTINCT week_start) AS n_weeks,
       ROUND(COUNT(*) / COUNT(DISTINCT week_start)) AS stocks_per_week,
       ROUND(AVG(ret), 2) AS avg_ret, ROUND(AVG(exr_is), 3) AS avg_exr_is, ROUND(AVG(exr_mkt), 3) AS avg_exr_mkt,
       ROUND(MEDIAN(exr_is), 2) AS med_exr_is, ROUND(STDDEV(exr_is), 2) AS sd_exr_is,
       ROUND(AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END) * 100, 1) AS pct_beat
FROM obs
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 2. 群ごとの相対リターン(条件 a: 単調性)
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.ret_4w_past,
           p.fwd_ret_4w AS ret, p.exr_is_4w AS exr_is, p.exr_mkt_4w AS exr_mkt
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.ret_4w_past, p.fwd_ret_8w, p.exr_is_8w, p.exr_mkt_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.ret_4w_past, p.fwd_ret_13w, p.exr_is_13w, p.exr_mkt_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
grp AS (
    SELECT o.h, o.week_start, o.ret, o.exr_is, o.exr_mkt, o.ret_4w_past AS val,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs o
),
wg AS (
    SELECT h, week_start, g, COUNT(*) AS n, AVG(exr_is) AS exr_is, AVG(exr_mkt) AS exr_mkt, AVG(ret) AS ret,
           AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END) AS beat, MIN(val) AS vmin, MAX(val) AS vmax
    FROM grp
    GROUP BY h, week_start, g
)
SELECT h AS horizon_w, g, COUNT(*) AS n_weeks, ROUND(AVG(n)) AS avg_stocks,
       ROUND(AVG(vmin), 1) AS val_from, ROUND(AVG(vmax), 1) AS val_to,
       ROUND(AVG(exr_is), 2) AS avg_exr_is, ROUND(STDDEV(exr_is) / SQRT(COUNT(*)), 2) AS se_exr_is,
       ROUND(MEDIAN(exr_is), 2) AS med_week_exr_is, ROUND(AVG(beat) * 100, 1) AS pct_beat,
       ROUND(AVG(exr_mkt), 2) AS avg_exr_mkt, ROUND(AVG(ret), 2) AS avg_ret
FROM wg
GROUP BY h, g
ORDER BY h, g;


--------------------------------------------------------------------------------
-- 3-1. 反転スプレッド(群1−群5)(条件 b)
--
-- G1 は群1だけの超過リターン(逆張りの買い側だけで取れる分。参考)、T_G1 はその t 値。
-- S15_MKT は市場全体を引いた相対リターン(EXR_MKT)でのスプレッド(参考)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.ret_4w_past, p.exr_is_4w AS exr_is, p.exr_mkt_4w AS exr_mkt
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.ret_4w_past, p.exr_is_8w, p.exr_mkt_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.ret_4w_past, p.exr_is_13w, p.exr_mkt_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
grp AS (
    SELECT o.h, o.week_start, o.exr_is, o.exr_mkt,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs o
),
sp AS (
    SELECT h, week_start,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END)   AS s15,
           AVG(CASE WHEN g = 1 THEN exr_is END)                                          AS g1,
           AVG(CASE WHEN g = 5 THEN exr_is END)                                          AS g5,
           AVG(CASE WHEN g = 1 THEN exr_mkt END) - AVG(CASE WHEN g = 5 THEN exr_mkt END) AS s15_mkt
    FROM grp
    GROUP BY h, week_start
)
SELECT h AS horizon_w, COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15, ROUND(STDDEV(s15), 2) AS sd_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15,
       ROUND(AVG(CASE WHEN s15 > 0 THEN 1 WHEN s15 IS NOT NULL THEN 0 END) * 100, 1) AS pct_weeks_pos,
       ROUND(AVG(g1), 2) AS avg_g1, ROUND(AVG(g1) / NULLIF(STDDEV(g1) / SQRT(COUNT(g1)), 0), 2) AS t_g1,
       ROUND(AVG(g5), 2) AS avg_g5,
       ROUND(AVG(s15_mkt), 2) AS avg_s15_mkt,
       ROUND(AVG(s15_mkt) / NULLIF(STDDEV(s15_mkt) / SQRT(COUNT(s15_mkt)), 0), 2) AS t_s15_mkt
FROM sp
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 3-2. スプレッドの年別内訳(条件 c)
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.ret_4w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.ret_4w_past, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
grp AS (
    SELECT o.h, o.week_start, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs o
),
sp AS (
    SELECT h, week_start, EXTRACT(YEAR FROM week_start) AS yr,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15
    FROM grp
    GROUP BY h, week_start
),
yy AS (
    SELECT h, yr, COUNT(*) AS n, SUM(s15) AS sm, AVG(s15) AS av FROM sp GROUP BY h, yr
),
tt AS (
    SELECT h, SUM(n) AS n_all, SUM(sm) AS sm_all FROM yy GROUP BY h
)
SELECT y.h AS horizon_w, y.yr, y.n AS n_weeks,
       ROUND(y.av, 2) AS avg_s15,
       ROUND((t.sm_all - y.sm) / NULLIF(t.n_all - y.n, 0), 2) AS avg_excl_year,
       ROUND(t.sm_all / t.n_all, 2) AS avg_all
FROM yy y
JOIN tt t ON t.h = y.h
ORDER BY y.h, y.yr;


--------------------------------------------------------------------------------
-- 4. 17業種内で切り直した反転スプレッド(条件 d)
--
-- 各週・各17業種の中で五分位に切る。週ごとに、各業種の (群1−群5) を銘柄数で重み付けして
-- 平均し、1観測とする。業種の銘柄数が10未満の業種は使わない。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.ret_4w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.sector17_code, p.ret_4w_past, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.ret_4w_past, p.exr_is_13w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 13) = 0 AND p.exr_is_13w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
grp AS (
    SELECT o.h, o.week_start, o.sector17_code, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start, o.sector17_code ORDER BY o.ret_4w_past, o.code) AS g,
           COUNT(*) OVER (PARTITION BY o.h, o.week_start, o.sector17_code) AS n_ind
    FROM obs o
),
si AS (
    SELECT h, week_start, sector17_code, MAX(n_ind) AS n_ind,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15
    FROM grp
    WHERE n_ind >= 10
    GROUP BY h, week_start, sector17_code
),
sp AS (
    SELECT h, week_start, SUM(s15 * n_ind) / SUM(n_ind) AS s15
    FROM si
    WHERE s15 IS NOT NULL
    GROUP BY h, week_start
)
SELECT h AS horizon_w, COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15, ROUND(STDDEV(s15), 2) AS sd_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15,
       ROUND(AVG(CASE WHEN s15 > 0 THEN 1 ELSE 0 END) * 100, 1) AS pct_weeks_pos
FROM sp
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 5. 層別(条件 e): SIZE(5)・PBR(3)・MOM_12_1(3) の層の中で切り直した反転スプレッド
--
-- MOM_Q は MOM_12_1 の週内3分位(1=中期の負け組、3=勝ち組)。
-- 4週・8週のみ(判定の対象)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.size_q, p.pbr_q, p.mom_12_1, p.ret_4w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.size_q, p.pbr_q, p.mom_12_1, p.ret_4w_past, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
o2 AS (
    SELECT o.*,
           CASE WHEN o.mom_12_1 IS NOT NULL THEN
                NTILE(3) OVER (PARTITION BY o.h, o.week_start,
                               CASE WHEN o.mom_12_1 IS NULL THEN 0 ELSE 1 END
                               ORDER BY o.mom_12_1, o.code) END AS mom_q
    FROM obs o
),
lay AS (
    SELECT 'SIZE' AS layer_name, TO_CHAR(size_q) AS layer_val, o2.* FROM o2 WHERE size_q IS NOT NULL
    UNION ALL
    SELECT 'PBR', TO_CHAR(pbr_q), o2.* FROM o2 WHERE pbr_q IS NOT NULL
    UNION ALL
    SELECT 'MOM', TO_CHAR(mom_q), o2.* FROM o2 WHERE mom_q IS NOT NULL
),
grp AS (
    SELECT l.layer_name, l.layer_val, l.h, l.week_start, l.exr_is,
           NTILE(5) OVER (PARTITION BY l.layer_name, l.layer_val, l.h, l.week_start ORDER BY l.ret_4w_past, l.code) AS g
    FROM lay l
),
sp AS (
    SELECT layer_name, layer_val, h, week_start,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15
    FROM grp
    GROUP BY layer_name, layer_val, h, week_start
)
SELECT layer_name, layer_val, h AS horizon_w, COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15
FROM sp
GROUP BY layer_name, layer_val, h
ORDER BY layer_name, layer_val, h;


--------------------------------------------------------------------------------
-- 6. 売買代金の下限を付けた中で切り直した反転スプレッド(条件 f)
--
-- 起点週の直近4週の1日平均売買代金(TURNOVER_OKU)が下限以上の銘柄だけで五分位を切り直す。
-- 下限: なし / 0.5億円/日 / 1億円/日 / 5億円/日。
-- AVG_G1 は群1だけの超過リターン(逆張りの買い側。参考)、AVG_TURNOVER_G1 は群1の売買代金の
-- 中央値の週平均(億円/日)。判定は 1億円/日 と 5億円/日 の両方で、4週・8週とも同じ向きで |t| ≥ 2.5。
--------------------------------------------------------------------------------
WITH floors AS (
    SELECT 0 AS fl FROM dual UNION ALL SELECT 0.5 FROM dual UNION ALL SELECT 1 FROM dual UNION ALL SELECT 5 FROM dual
),
obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.turnover_oku, p.ret_4w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL AND p.turnover_oku IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.turnover_oku, p.ret_4w_past, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL AND p.turnover_oku IS NOT NULL
),
fo AS (
    SELECT f.fl, o.* FROM obs o JOIN floors f ON o.turnover_oku >= f.fl
),
grp AS (
    SELECT o.fl, o.h, o.week_start, o.exr_is, o.turnover_oku,
           NTILE(5) OVER (PARTITION BY o.fl, o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM fo o
),
sp AS (
    SELECT fl, h, week_start,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15,
           AVG(CASE WHEN g = 1 THEN exr_is END) AS g1,
           MEDIAN(CASE WHEN g = 1 THEN turnover_oku END) AS to_g1,
           COUNT(*) AS n
    FROM grp
    GROUP BY fl, h, week_start
)
SELECT fl AS floor_oku, h AS horizon_w, COUNT(s15) AS n_weeks, ROUND(AVG(n)) AS avg_stocks,
       ROUND(AVG(s15), 2) AS avg_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15,
       ROUND(AVG(g1), 2) AS avg_g1, ROUND(AVG(to_g1), 2) AS avg_turnover_g1
FROM sp
GROUP BY fl, h
ORDER BY fl, h;


--------------------------------------------------------------------------------
-- 7. 地合い別(条件 g): 起点週の直近13週の市場平均リターンが 正(UP)/ 負(DOWN)の週に分けたスプレッド
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.ret_4w_past, p.exr_is_4w AS exr_is,
           CASE WHEN p.mkt_ret_13w_past >= 0 THEN 'UP' ELSE 'DOWN' END AS mkt_state
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.ret_4w_past, p.exr_is_8w,
           CASE WHEN p.mkt_ret_13w_past >= 0 THEN 'UP' ELSE 'DOWN' END
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL AND p.mkt_ret_13w_past IS NOT NULL
),
grp AS (
    SELECT o.h, o.week_start, o.mkt_state, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs o
),
sp AS (
    SELECT h, week_start, mkt_state,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15
    FROM grp
    GROUP BY h, week_start, mkt_state
)
SELECT h AS horizon_w, mkt_state, COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15
FROM sp
GROUP BY h, mkt_state
ORDER BY h, mkt_state;


--------------------------------------------------------------------------------
-- 8. 優待クロスの時期を除いたスプレッド(条件 h)
--
-- 起点の週が 3月・9月、または 2月・8月の後半 のものを除いて 3-1 と同じ計算をする。
-- 3-1 と比べてスプレッドが大きく縮むなら、権利落ちの効果だった。判定は4週(8週は参考)。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.ret_4w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 4) = 0 AND p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, p.week_start, p.code, p.ret_4w_past, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE MOD(p.wk_idx, 8) = 0 AND p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
obs_f AS (
    SELECT * FROM obs
    WHERE EXTRACT(MONTH FROM week_start) NOT IN (3, 9)
      AND NOT (EXTRACT(MONTH FROM week_start) IN (2, 8) AND EXTRACT(DAY FROM week_start) >= 15)
),
grp AS (
    SELECT o.h, o.week_start, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs_f o
),
sp AS (
    SELECT h, week_start,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15
    FROM grp
    GROUP BY h, week_start
)
SELECT h AS horizon_w, COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15
FROM sp
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 9. 1週遅れで入った場合(条件 i)
--
-- 群は起点週 t の終値で決める(3-1 と同じ)。リターンは t+1 週の終値から t+5 週の終値まで(4週保有)。
-- 相対リターンは、同じ週・同じ17業種×同じ時価総額5分位の等ウェイト平均との差(EXR_IS と同じ作り)。
-- t+1 週・t+5 週のどちらかに行が無い銘柄(上場廃止など)は使わない。
-- 起点の標本は 4週おき(MOD(wk_idx,4)=0)。
--------------------------------------------------------------------------------
WITH lag AS (
    SELECT p.week_start, p.wk_idx, p.code, p.sector17_code, p.size_q, p.adj_close,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 1 FOLLOWING AND 1 FOLLOWING) AS px_f1,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 5 FOLLOWING AND 5 FOLLOWING) AS px_f5
    FROM xs_weekly_panel p
),
l2 AS (
    SELECT l.week_start, l.wk_idx, l.code, l.sector17_code, l.size_q,
           CASE WHEN l.px_f1 > 0 AND l.px_f5 IS NOT NULL THEN (l.px_f5 / l.px_f1 - 1) * 100 END AS ret_lag
    FROM lag l
),
l3 AS (
    SELECT l2.*,
           COUNT(l2.ret_lag) OVER (PARTITION BY l2.week_start, l2.sector17_code, l2.size_q) AS peers,
           AVG(l2.ret_lag)   OVER (PARTITION BY l2.week_start, l2.sector17_code, l2.size_q) AS avg_is
    FROM l2
),
obs AS (
    SELECT m.week_start, m.code, m.ret_4w_past, l3.ret_lag - l3.avg_is AS exr_lag
    FROM xs_mom_panel m
    JOIN l3 ON l3.code = m.code AND l3.week_start = m.week_start
    WHERE MOD(m.wk_idx, 4) = 0 AND m.ret_4w_past IS NOT NULL
      AND l3.ret_lag IS NOT NULL AND l3.size_q IS NOT NULL AND l3.peers >= 5
),
grp AS (
    SELECT o.week_start, o.exr_lag,
           NTILE(5) OVER (PARTITION BY o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs o
),
sp AS (
    SELECT week_start,
           AVG(CASE WHEN g = 1 THEN exr_lag END) - AVG(CASE WHEN g = 5 THEN exr_lag END) AS s15,
           AVG(CASE WHEN g = 1 THEN exr_lag END) AS g1
    FROM grp
    GROUP BY week_start
)
SELECT COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15,
       ROUND(AVG(g1), 2) AS avg_g1
FROM sp;


--------------------------------------------------------------------------------
-- 10. 位相を変えた確認(参考)
--
-- 3-1 は MOD(wk_idx, h) = 0 の週だけを使った。起点週をずらしても同じかを見る。
-- 4週先は位相0〜3、8週先は位相0〜7。
--------------------------------------------------------------------------------
WITH obs AS (
    SELECT 4 AS h, MOD(p.wk_idx, 4) AS ph, p.week_start, p.code, p.ret_4w_past, p.exr_is_4w AS exr_is
    FROM xs_mom_panel p
    WHERE p.exr_is_4w IS NOT NULL AND p.ret_4w_past IS NOT NULL
    UNION ALL
    SELECT 8, MOD(p.wk_idx, 8), p.week_start, p.code, p.ret_4w_past, p.exr_is_8w
    FROM xs_mom_panel p
    WHERE p.exr_is_8w IS NOT NULL AND p.ret_4w_past IS NOT NULL
),
grp AS (
    SELECT o.h, o.ph, o.week_start, o.exr_is,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.ret_4w_past, o.code) AS g
    FROM obs o
),
sp AS (
    SELECT h, ph, week_start,
           AVG(CASE WHEN g = 1 THEN exr_is END) - AVG(CASE WHEN g = 5 THEN exr_is END) AS s15
    FROM grp
    GROUP BY h, ph, week_start
)
SELECT h AS horizon_w, ph AS phase, COUNT(s15) AS n_weeks,
       ROUND(AVG(s15), 2) AS avg_s15,
       ROUND(AVG(s15) / NULLIF(STDDEV(s15) / SQRT(COUNT(s15)), 0), 2) AS t_s15
FROM sp
GROUP BY h, ph
ORDER BY h, ph;
