--------------------------------------------------------------------------------
-- 空売りの横断面検証(銘柄間の優劣)
--
-- 問い: 「空売りが多い銘柄は、その後、同業・同規模の銘柄より弱いか」
--
-- demand_signal_backtest.sql は「TOPIX が上がるか下がるか」(時系列)を問い、
-- 5指標とも不合格だった。こちらは「A社とB社のどちらが相対的に強いか」(横断面)。
-- 米国では空売り残高比率の高い銘柄群の相対リターンが低いことが繰り返し
-- 確認されている(Asquith, Pathak & Ritter 2005 / Boehmer, Jones & Zhang 2008)。
-- 効果は貸株が取りにくい銘柄・小型株に集中し、大型株では弱い。
-- 日本での蓄積は少なく、0.5%以上しか報告されない粗さもあるので、効くかは分からない。
--
-- 前提: ddl/20_xsection_weekly_panel.sql で xs_weekly_panel を作成済みであること。
--       CLAUDE_RO で流すなら同ファイル末尾の権限付与も。
--
--------------------------------------------------------------------------------
-- 【検証する3つの指標】
--
--   SI  … 機関投資家の空売り残高割合(0.5%以上の報告を報告者ごとに持ち越して合計)。
--          個人の報告は含まない(名前でも前回報告の情報でも個人を区別できなかった。ddl/20 参照)。
--          米国の short interest に最も近いが、0.5%未満は見えない。
--          群0「報告なし」が全体の大半を占める。0 ではなく「見えない」。
--   MSR … 信用売残 ÷ 発行済株式数。個人中心。全貸借銘柄で連続的に取れる。
--   DTC … 信用売残 ÷ 直近4週の1日平均出来高。
--          signal_threshold_calibration で「銘柄間のばらつきが大きすぎて絶対値の
--          しきい値には使えない」とした指標だが、横断面の順位は銘柄間の差そのものを
--          使うので、ここでは使える(問いが違うと使える指標も違う)。
--
--   米国の文献が扱うのは SI に当たるもの。MSR・DTC は個人の信用売りが中心で、
--   日本では逆張りの個人が多いため、**向きは事前に決めない(両側)**。
--
--------------------------------------------------------------------------------
-- 【合格の条件を、結果を見る前に決めておく】
--
--   (a) 群1→5 の相対リターンがおおむね単調に並ぶ(2で見る)
--   (b) 群5−群1 のスプレッドの t 値が絶対値2以上。4週・13週で同じ向き(3-1)
--       t 値は「重ならない週ごとのスプレッド」を1観測とした値(Fama-MacBeth の形)。
--       同じ週の銘柄同士は相関するので、銘柄数ではなく週数を独立観測とみなす。
--       13週先は約38観測、4週先は約125観測しかない。
--   (c) 年別に見て、特定の1〜2年だけで作られていない。どの1年を除いても向きが残る(3-2)
--   (d) 業種内で切り直しても残る(5)。群5が特定の業種の寄せ集めなら(4)で分かる
--   (e) PBR・モメンタムの層の中でも向きが残る(6)。空売りで切ったつもりが
--       「割高株か割安株か」「負けている株か」で切っていた、を否定する
--
--   (a)〜(e) のどれかで落ちたら不合格。条件を変えて出るまで試さない。
--
--   SI は (6) の SIZE 層で小型ほど強く出るなら先行研究と整合する。
--   大型だけで出る/全層で同じ強さ、なら別の何かを拾っている疑い。
--
--------------------------------------------------------------------------------
-- 【読むときの前提】
--   ・相対リターン EXR_IS は「同じ週・同じ17業種・同じ時価総額5分位」の等ウェイト平均との差(%)。
--     市場全体が上がった分は引いてある。ただしこの10年が上昇相場一色だったことは変わらない
--     (regime_bias_limits)。下落相場で同じ関係が続くかはこのデータでは確かめられない。
--   ・リターンは右に裾が長い(小型株の急騰)。平均の相対リターンが0でも、中央値は負で、
--     「業種・規模平均に勝った銘柄の割合」は50%を下回るのが普通。1 のベースラインと比べる。
--   ・上場廃止銘柄は最後の終値までのリターン。倒産時の損失は過小に出る(ddl/20)。
--   ・空売り報告は計算日から180日で失効させている。半年動かない大口の残高は落ちる。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0-1. 【副産物の確認】既存ビューの「最新計算日の合計」と「報告者ごとの持ち越し合計」の差
--
-- V_EQUITY_SHORT_POSITION_SUM は銘柄×計算日の合計なので、その日に報告した
-- 報告者の分しか入らない。第二階層・第三階層(S4)は最新計算日の行を
-- 「最新の空売り残高」として読んでいる。持ち越し合計とどれだけずれるかを測る。
-- パネルを使わないので、ddl/20 より前に流せる。
--
-- 【2026-09-16 修正】初版は報告者キーを生の名前で作っていたため、
--   ・全角/半角・大文字/小文字の表記ゆれで同じ報告者が二重に数えられ(過大)
--   ・'個人' がすべて同じキーに潰れて別人の報告が前の報告を打ち切っていた(過小)
--   キーを UPPER(TO_SINGLE_BYTE()) でそろえた。個人は前回報告の情報でつなぐ方法も試したが
--   13%がつながらず断念(ddl/20 冒頭)。**比べる両側とも個人を除く**。ビューそのものではなく、
--   ビューと同じ読み方(最新計算日の行の合計)を個人抜きで再現して、読み方の差だけを測る。
--   初版の結果: 2,328銘柄中1,552が0.1pt以上ずれ、平均 持ち越し1.394% / ビュー0.869%。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 180 AS short_stale_days FROM dual
),
iv AS (
    -- 機関: 表記ゆれをそろえた報告者キーで次の報告を探す
    SELECT s.code, s.shrt_pos_to_so, s.calc_date,
           LEAD(s.disc_date) OVER (
               PARTITION BY s.code,
                            UPPER(TO_SINGLE_BYTE(NVL(s.ss_name,   '-'))),
                            UPPER(TO_SINGLE_BYTE(NVL(s.dic_name,  '-'))),
                            UPPER(TO_SINGLE_BYTE(NVL(s.fund_name, '-')))
               ORDER BY s.calc_date, s.disc_date, s.position_id) AS next_disc
    FROM equity_short_position s
    WHERE NVL(s.ss_name, '-') <> '個人'
),
carry AS (
    SELECT i.code, SUM(i.shrt_pos_to_so) AS si_carry, COUNT(*) AS n_carry
    FROM iv i
    CROSS JOIN params p
    WHERE i.next_disc IS NULL
      AND i.shrt_pos_to_so >= 0.005
      AND i.calc_date >= TRUNC(SYSDATE) - p.short_stale_days
    GROUP BY i.code
),
lv AS (
    -- ビューと同じ読み方(最新計算日の行の合計)を、個人を除いて再現する
    SELECT code, total_shrt_ratio, reporter_count
    FROM (
        SELECT s.code, SUM(s.shrt_pos_to_so) AS total_shrt_ratio, COUNT(*) AS reporter_count,
               ROW_NUMBER() OVER (PARTITION BY s.code ORDER BY s.calc_date DESC) AS rn
        FROM equity_short_position s
        CROSS JOIN params p
        WHERE NVL(s.ss_name, '-') <> '個人'
          AND s.calc_date >= TRUNC(SYSDATE) - p.short_stale_days
        GROUP BY s.code, s.calc_date
    )
    WHERE rn = 1
),
j AS (
    SELECT NVL(c.code, l.code) AS code,
           NVL(c.si_carry, 0)          AS si_carry,
           NVL(l.total_shrt_ratio, 0)  AS si_view
    FROM carry c
    FULL OUTER JOIN lv l ON l.code = c.code
)
SELECT COUNT(*)                                                             AS codes,
       COUNT(CASE WHEN ABS(si_carry - si_view) >= 0.001 THEN 1 END)         AS n_diff_ge_01pt,
       COUNT(CASE WHEN ABS(si_carry - si_view) >= 0.01  THEN 1 END)         AS n_diff_ge_1pt,
       ROUND(AVG(si_carry) * 100, 3)                                        AS avg_carry_pct,
       ROUND(AVG(si_view)  * 100, 3)                                        AS avg_view_pct,
       ROUND(MAX(si_carry - si_view) * 100, 2)                              AS max_undercount_pt
FROM j;


--------------------------------------------------------------------------------
-- 0-2. 同じく、ずれの大きい銘柄(上位30)
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 180 AS short_stale_days FROM dual
),
iv AS (
    -- 機関: 表記ゆれをそろえた報告者キーで次の報告を探す
    SELECT s.code, s.shrt_pos_to_so, s.calc_date,
           LEAD(s.disc_date) OVER (
               PARTITION BY s.code,
                            UPPER(TO_SINGLE_BYTE(NVL(s.ss_name,   '-'))),
                            UPPER(TO_SINGLE_BYTE(NVL(s.dic_name,  '-'))),
                            UPPER(TO_SINGLE_BYTE(NVL(s.fund_name, '-')))
               ORDER BY s.calc_date, s.disc_date, s.position_id) AS next_disc
    FROM equity_short_position s
    WHERE NVL(s.ss_name, '-') <> '個人'
),
carry AS (
    SELECT i.code, SUM(i.shrt_pos_to_so) AS si_carry, COUNT(*) AS n_carry
    FROM iv i
    CROSS JOIN params p
    WHERE i.next_disc IS NULL
      AND i.shrt_pos_to_so >= 0.005
      AND i.calc_date >= TRUNC(SYSDATE) - p.short_stale_days
    GROUP BY i.code
),
lv AS (
    -- ビューと同じ読み方(最新計算日の行の合計)を、個人を除いて再現する
    SELECT code, calc_date, total_shrt_ratio, reporter_count
    FROM (
        SELECT s.code, s.calc_date, SUM(s.shrt_pos_to_so) AS total_shrt_ratio, COUNT(*) AS reporter_count,
               ROW_NUMBER() OVER (PARTITION BY s.code ORDER BY s.calc_date DESC) AS rn
        FROM equity_short_position s
        CROSS JOIN params p
        WHERE NVL(s.ss_name, '-') <> '個人'
          AND s.calc_date >= TRUNC(SYSDATE) - p.short_stale_days
        GROUP BY s.code, s.calc_date
    )
    WHERE rn = 1
)
SELECT NVL(c.code, l.code)                                   AS code,
       SUBSTR(em.co_name, 1, 30)                             AS co_name,
       TO_CHAR(l.calc_date, 'YYYY-MM-DD')                    AS view_calc_date,
       ROUND(NVL(l.total_shrt_ratio, 0) * 100, 2)            AS view_pct,
       l.reporter_count                                      AS view_reporters,
       ROUND(NVL(c.si_carry, 0) * 100, 2)                    AS carry_pct,
       c.n_carry                                             AS carry_reporters
FROM carry c
FULL OUTER JOIN lv l ON l.code = c.code
LEFT JOIN equity_master em ON em.code = NVL(c.code, l.code)
ORDER BY ABS(NVL(c.si_carry, 0) - NVL(l.total_shrt_ratio, 0)) DESC
FETCH FIRST 30 ROWS ONLY;


--------------------------------------------------------------------------------
-- 1. ベースライン(全銘柄)
--
-- 横断面のベースラインは「相対リターンの平均 ≒ 0」。平均が0から大きく外れていたら
-- パネルの作り方がおかしい。見るべきは中央値と PCT_BEAT(業種・規模平均に勝った割合)で、
-- 2 以降の群の数字はこれと比べて読む(50%と比べない)。
--------------------------------------------------------------------------------
WITH obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
)
SELECT h                                                          AS horizon_w,
       COUNT(DISTINCT week_start)                                 AS n_weeks,
       ROUND(COUNT(*) / COUNT(DISTINCT week_start))               AS stocks_per_week,
       ROUND(AVG(ret), 2)                                         AS avg_ret,
       ROUND(AVG(exr_ind), 3)                                     AS avg_exr_ind,
       ROUND(AVG(exr_is), 3)                                      AS avg_exr_is,
       ROUND(MEDIAN(exr_is), 2)                                   AS med_exr_is,
       ROUND(STDDEV(exr_is), 2)                                   AS sd_exr_is,
       ROUND(AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END) * 100, 1) AS pct_beat
FROM obs
GROUP BY h
ORDER BY h;


--------------------------------------------------------------------------------
-- 2. 指標の群ごとの相対リターン(条件 a: 単調性)
--
-- 週ごとに群の平均を出してから週をまたいで平均する(銘柄数の多い週に引っ張られない)。
-- VAL_FROM / VAL_TO は各週の群の最小・最大の平均(SI・MSR は %、DTC は日数)。
-- N_WEEKS が群によって違うときは、群ごとに別の時期を見ていることになるので注意。
--
-- AVG_EXR_IS が主。AVG_EXR_IND(業種のみ調整)と大きく違うなら、規模の違いが効いている。
-- AVG_RET(未調整)は参考。上昇相場の分が乗っているので判断に使わない。
--------------------------------------------------------------------------------
WITH obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- 群 0 = 報告なし(SI)/売残ゼロ(MSR・DTC)。1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    SELECT 'SI' AS ind, o.*, o.si_ratio * 100 AS val,
           CASE WHEN o.si_ratio IS NULL THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.si_ratio IS NULL THEN 0 ELSE 1 END
                                    ORDER BY o.si_ratio) END AS g
    FROM obs o
    WHERE o.si_covered = 'Y'
    UNION ALL
    SELECT 'MSR', o.*, o.msr * 100,
           CASE WHEN o.msr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.msr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.msr) END
    FROM obs o
    WHERE o.msr IS NOT NULL
    UNION ALL
    SELECT 'DTC', o.*, o.dtc,
           CASE WHEN o.dtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.dtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.dtc) END
    FROM obs o
    WHERE o.dtc IS NOT NULL
),
wg AS (
    SELECT ind, h, week_start, g,
           COUNT(*)                                               AS n,
           AVG(exr_is)                                            AS exr_is,
           AVG(exr_ind)                                           AS exr_ind,
           AVG(ret)                                               AS ret,
           AVG(CASE WHEN exr_is > 0 THEN 1 ELSE 0 END)            AS beat,
           MIN(val)                                               AS vmin,
           MAX(val)                                               AS vmax
    FROM grp
    GROUP BY ind, h, week_start, g
)
SELECT ind, h                                                     AS horizon_w, g,
       COUNT(*)                                                   AS n_weeks,
       ROUND(AVG(n))                                              AS avg_stocks,
       MIN(n)                                                     AS min_stocks,
       ROUND(AVG(vmin), 3)                                        AS val_from,
       ROUND(AVG(vmax), 3)                                        AS val_to,
       ROUND(AVG(exr_is), 2)                                      AS avg_exr_is,
       ROUND(STDDEV(exr_is) / SQRT(COUNT(*)), 2)                  AS se_exr_is,
       ROUND(MEDIAN(exr_is), 2)                                   AS med_week_exr_is,
       ROUND(AVG(beat) * 100, 1)                                  AS pct_beat,
       ROUND(AVG(exr_ind), 2)                                     AS avg_exr_ind,
       ROUND(AVG(ret), 2)                                         AS avg_ret
FROM wg
GROUP BY ind, h, g
ORDER BY ind, h, g;


--------------------------------------------------------------------------------
-- 3-1. 群5−群1 のスプレッド(条件 b)
--
-- 週ごとに (群5の平均) − (群1の平均) を1観測とし、その平均・標準偏差・t値を出す。
-- どちらかの群が MIN_N 銘柄未満の週は使わない。
-- S50 は 群5 − 群0(報告なし/売残ゼロ)。SI では「報告が出ていること」自体の効果を見る。
-- PCT_WEEKS_NEG は分母を「スプレッドが計算できた週」に揃えてある
-- (AVG(CASE ... ELSE 0) で NULL を負け扱いにした過去の失敗を繰り返さないため)。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- 群 0 = 報告なし(SI)/売残ゼロ(MSR・DTC)。1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    SELECT 'SI' AS ind, o.*, o.si_ratio * 100 AS val,
           CASE WHEN o.si_ratio IS NULL THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.si_ratio IS NULL THEN 0 ELSE 1 END
                                    ORDER BY o.si_ratio) END AS g
    FROM obs o
    WHERE o.si_covered = 'Y'
    UNION ALL
    SELECT 'MSR', o.*, o.msr * 100,
           CASE WHEN o.msr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.msr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.msr) END
    FROM obs o
    WHERE o.msr IS NOT NULL
    UNION ALL
    SELECT 'DTC', o.*, o.dtc,
           CASE WHEN o.dtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.dtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.dtc) END
    FROM obs o
    WHERE o.dtc IS NOT NULL
),
sp AS (
    SELECT g.ind, g.h, g.week_start,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_is END)
                   - AVG(CASE WHEN g.g = 1 THEN g.exr_is END) END AS s51,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 0 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_is END)
                   - AVG(CASE WHEN g.g = 0 THEN g.exr_is END) END AS s50,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_ind END)
                   - AVG(CASE WHEN g.g = 1 THEN g.exr_ind END) END AS s51_ind
    FROM grp g
    CROSS JOIN params p
    GROUP BY g.ind, g.h, g.week_start
)
SELECT ind, h                                                        AS horizon_w,
       COUNT(s51)                                                    AS n_weeks_51,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(STDDEV(s51), 2)                                         AS sd_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51,
       ROUND(AVG(CASE WHEN s51 < 0 THEN 1 WHEN s51 IS NOT NULL THEN 0 END) * 100, 1)
                                                                     AS pct_weeks_neg_51,
       COUNT(s50)                                                    AS n_weeks_50,
       ROUND(AVG(s50), 2)                                            AS avg_s50,
       ROUND(AVG(s50) / NULLIF(STDDEV(s50) / SQRT(COUNT(s50)), 0), 2) AS t_s50,
       ROUND(AVG(s51_ind), 2)                                        AS avg_s51_ind_only
FROM sp
GROUP BY ind, h
ORDER BY ind, h;


--------------------------------------------------------------------------------
-- 3-2. スプレッドの年別内訳(条件 c: 時間の塊)
--
-- 時系列の検証では「週と週ではなく年と年を比べていた」ことで候補が消えた。
-- 横断面でも、スプレッドの合計が特定の1〜2年から来ていないかを見る。
-- PCT_OF_TOTAL … 全期間のスプレッド合計のうち、その年が占める割合(%)。
--                符号が混ざると100%を超える年が出る。そうなったら「その年が全部」と読む。
-- AVG_EXCL_YEAR … その年を除いた残りの期間の平均。符号が変わる年があれば不合格。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- 群 0 = 報告なし(SI)/売残ゼロ(MSR・DTC)。1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    SELECT 'SI' AS ind, o.*, o.si_ratio * 100 AS val,
           CASE WHEN o.si_ratio IS NULL THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.si_ratio IS NULL THEN 0 ELSE 1 END
                                    ORDER BY o.si_ratio) END AS g
    FROM obs o
    WHERE o.si_covered = 'Y'
    UNION ALL
    SELECT 'MSR', o.*, o.msr * 100,
           CASE WHEN o.msr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.msr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.msr) END
    FROM obs o
    WHERE o.msr IS NOT NULL
    UNION ALL
    SELECT 'DTC', o.*, o.dtc,
           CASE WHEN o.dtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.dtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.dtc) END
    FROM obs o
    WHERE o.dtc IS NOT NULL
),
sp AS (
    SELECT g.ind, g.h, g.week_start,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_is END)
                   - AVG(CASE WHEN g.g = 1 THEN g.exr_is END) END AS s51
    FROM grp g
    CROSS JOIN params p
    GROUP BY g.ind, g.h, g.week_start
),
yr AS (
    SELECT ind, h, EXTRACT(YEAR FROM week_start) AS yr,
           COUNT(s51) AS n, SUM(s51) AS sum_s51, AVG(s51) AS avg_s51
    FROM sp
    GROUP BY ind, h, EXTRACT(YEAR FROM week_start)
),
tot AS (
    SELECT ind, h, SUM(n) AS n_all, SUM(sum_s51) AS sum_all
    FROM yr
    GROUP BY ind, h
)
SELECT y.ind, y.h                                                    AS horizon_w, y.yr,
       y.n                                                           AS n_weeks,
       ROUND(y.avg_s51, 2)                                           AS avg_s51,
       ROUND(y.sum_s51 / NULLIF(t.sum_all, 0) * 100, 1)              AS pct_of_total,
       ROUND((t.sum_all - NVL(y.sum_s51, 0)) / NULLIF(t.n_all - y.n, 0), 2) AS avg_excl_year
FROM yr y
JOIN tot t ON t.ind = y.ind AND t.h = y.h
ORDER BY y.ind, y.h, y.yr;


--------------------------------------------------------------------------------
-- 4. 群5の業種の偏り(条件 d の下見)
--
-- SHARE_ALL … その指標が取れる全銘柄週のうち、その業種の割合(%)
-- SHARE_Q5  … 群5のうち、その業種の割合(%)
-- RATIO     … SHARE_Q5 / SHARE_ALL。2を超える業種が群5の上位を占めるなら、
--             空売りではなく業種で切っている疑いが強い。5 の業種内切り直しで確かめる。
-- 4週先の観測で数える(群の顔ぶれは先行期間に依存しないので、週数の多いほうを使う)。
--------------------------------------------------------------------------------
WITH obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- 群 0 = 報告なし(SI)/売残ゼロ(MSR・DTC)。1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    SELECT 'SI' AS ind, o.*, o.si_ratio * 100 AS val,
           CASE WHEN o.si_ratio IS NULL THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.si_ratio IS NULL THEN 0 ELSE 1 END
                                    ORDER BY o.si_ratio) END AS g
    FROM obs o
    WHERE o.si_covered = 'Y'
    UNION ALL
    SELECT 'MSR', o.*, o.msr * 100,
           CASE WHEN o.msr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.msr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.msr) END
    FROM obs o
    WHERE o.msr IS NOT NULL
    UNION ALL
    SELECT 'DTC', o.*, o.dtc,
           CASE WHEN o.dtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.dtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.dtc) END
    FROM obs o
    WHERE o.dtc IS NOT NULL
),
cnt AS (
    SELECT ind, sector33_name,
           COUNT(*)                                   AS n_all,
           COUNT(CASE WHEN g = 5 THEN 1 END)          AS n_q5
    FROM grp
    WHERE h = 4
    GROUP BY ind, sector33_name
),
r AS (
    SELECT c.ind, c.sector33_name,
           RATIO_TO_REPORT(c.n_all) OVER (PARTITION BY c.ind) * 100 AS share_all,
           RATIO_TO_REPORT(c.n_q5)  OVER (PARTITION BY c.ind) * 100 AS share_q5
    FROM cnt c
),
rk AS (
    SELECT r.*,
           ROW_NUMBER() OVER (PARTITION BY r.ind ORDER BY r.share_q5 DESC) AS rn
    FROM r
)
SELECT ind, rn, sector33_name,
       ROUND(share_all, 1)                              AS share_all,
       ROUND(share_q5, 1)                               AS share_q5,
       ROUND(share_q5 / NULLIF(share_all, 0), 2)        AS ratio
FROM rk
WHERE rn <= 10
ORDER BY ind, rn;


--------------------------------------------------------------------------------
-- 5. 業種内で切り直したスプレッド(条件 d)
--
-- 2・3 の5分位は全銘柄の中の順位なので、群5に特定の業種が偏り得る。
-- ここでは「同じ週・同じ17業種の中で」5分位を切り直し、各群の業種構成を揃える。
-- 業種内で値のある銘柄が MIN_CELL 未満の業種・週はその業種を除く。
-- GLOBAL(3-1 と同じ切り方)と IN_SECTOR を並べる。IN_SECTOR で消えるなら業種効果だった。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n, 10 AS min_cell FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
v AS (
    SELECT 'SI' AS ind, o.h, o.week_start, o.sector17_code, o.exr_is, o.si_ratio AS x
    FROM obs o WHERE o.si_covered = 'Y' AND o.si_ratio IS NOT NULL
    UNION ALL
    SELECT 'MSR', o.h, o.week_start, o.sector17_code, o.exr_is, o.msr
    FROM obs o WHERE o.msr > 0
    UNION ALL
    SELECT 'DTC', o.h, o.week_start, o.sector17_code, o.exr_is, o.dtc
    FROM obs o WHERE o.dtc > 0
),
gq AS (
    SELECT v.*,
           NTILE(5) OVER (PARTITION BY v.ind, v.h, v.week_start ORDER BY v.x)                 AS g_global,
           NTILE(5) OVER (PARTITION BY v.ind, v.h, v.week_start, v.sector17_code ORDER BY v.x) AS g_sec,
           COUNT(*) OVER (PARTITION BY v.ind, v.h, v.week_start, v.sector17_code)             AS cell_n
    FROM v
),
sp AS (
    SELECT q.ind, q.h, q.week_start,
           CASE WHEN COUNT(CASE WHEN q.g_global = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN q.g_global = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN q.g_global = 5 THEN q.exr_is END)
                   - AVG(CASE WHEN q.g_global = 1 THEN q.exr_is END) END            AS s_global,
           CASE WHEN COUNT(CASE WHEN q.g_sec = 5 AND q.cell_n >= p.min_cell THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN q.g_sec = 1 AND q.cell_n >= p.min_cell THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN q.g_sec = 5 AND q.cell_n >= p.min_cell THEN q.exr_is END)
                   - AVG(CASE WHEN q.g_sec = 1 AND q.cell_n >= p.min_cell THEN q.exr_is END) END AS s_sec
    FROM gq q
    CROSS JOIN params p
    GROUP BY q.ind, q.h, q.week_start
)
SELECT ind, h                                                                 AS horizon_w,
       COUNT(s_global)                                                        AS n_weeks_global,
       ROUND(AVG(s_global), 2)                                                AS avg_s51_global,
       ROUND(AVG(s_global) / NULLIF(STDDEV(s_global) / SQRT(COUNT(s_global)), 0), 2) AS t_global,
       COUNT(s_sec)                                                           AS n_weeks_in_sector,
       ROUND(AVG(s_sec), 2)                                                   AS avg_s51_in_sector,
       ROUND(AVG(s_sec) / NULLIF(STDDEV(s_sec) / SQRT(COUNT(s_sec)), 0), 2)   AS t_in_sector
FROM sp
GROUP BY ind, h
ORDER BY ind, h;


--------------------------------------------------------------------------------
-- 6. 層別のスプレッド(条件 e と、効果がどこに集中するか)
--
-- LAYER = SIZE(時価総額5分位、1=小型)/ PBR(3分位、1=低PBR)/ MOM(過去26週リターン3分位、1=負け組)。
-- 各層の中で指標の5分位を切り直し、群5−群1 を出す。
--
-- 読み方:
--   ・PBR・MOM の全層で向きが同じなら、割安/割高やモメンタムの言い換えではない。
--     1つの層だけで出ていたら、その層の性質を拾っている疑い。
--   ・SI が SIZE=1,2(小型)で強く 4,5(大型)で弱いなら先行研究と整合する。
--   ・層の中の銘柄数が少ないので、N_WEEKS と T 値を必ず一緒に見る。1層ずつの t 値は
--     全体より小さくなるのが普通で、「層ごとに有意か」ではなく「向きが揃うか」を見る。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
v AS (
    SELECT 'SI' AS ind, o.h, o.week_start, o.exr_is, o.si_ratio AS x, o.size_q, o.pbr_q, o.mom_q
    FROM obs o WHERE o.si_covered = 'Y' AND o.si_ratio IS NOT NULL
    UNION ALL
    SELECT 'MSR', o.h, o.week_start, o.exr_is, o.msr, o.size_q, o.pbr_q, o.mom_q
    FROM obs o WHERE o.msr > 0
    UNION ALL
    SELECT 'DTC', o.h, o.week_start, o.exr_is, o.dtc, o.size_q, o.pbr_q, o.mom_q
    FROM obs o WHERE o.dtc > 0
),
lay AS (
    SELECT ind, h, week_start, exr_is, x, 'SIZE' AS layer, size_q AS lv FROM v WHERE size_q IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, exr_is, x, 'PBR', pbr_q FROM v WHERE pbr_q IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, exr_is, x, 'MOM', mom_q FROM v WHERE mom_q IS NOT NULL
),
gq AS (
    SELECT l.*,
           NTILE(5) OVER (PARTITION BY l.ind, l.h, l.week_start, l.layer, l.lv ORDER BY l.x) AS g
    FROM lay l
),
sp AS (
    SELECT q.ind, q.h, q.layer, q.lv, q.week_start,
           COUNT(CASE WHEN q.g = 5 THEN 1 END)                                AS n5,
           CASE WHEN COUNT(CASE WHEN q.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN q.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN q.g = 5 THEN q.exr_is END)
                   - AVG(CASE WHEN q.g = 1 THEN q.exr_is END) END             AS s51
    FROM gq q
    CROSS JOIN params p
    GROUP BY q.ind, q.h, q.layer, q.lv, q.week_start
)
SELECT ind, h                                                          AS horizon_w, layer, lv,
       COUNT(s51)                                                      AS n_weeks,
       ROUND(AVG(n5))                                                  AS avg_stocks_q5,
       ROUND(AVG(s51), 2)                                              AS avg_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2)  AS t_s51
FROM sp
GROUP BY ind, h, layer, lv
ORDER BY ind, h, layer, lv;

--------------------------------------------------------------------------------
-- 7. 優待クロスの時期を除いたスプレッド(3-1 の頑健性確認。2026-09-16 追加)
--
-- 疑い: 3月・9月の権利付最終日の前は、つなぎ売り(優待クロス)で信用売残が一時的に
-- 膨らむ(demand_data_seasonality)。その銘柄は MSR・DTC の群5に入り、直後の権利落ちで
-- 株価が下がる。このパネルのリターンは分割しか調整しておらず配当・優待落ちを含むので、
-- 「群5が負ける」が権利落ちで機械的に作られている可能性がある。
-- この仮説は MSR・DTC で「群1〜4が平らで群5だけ沈む」形と、年ごとに偏らず毎年出る形の
-- 両方を説明できてしまう。
--
-- 確かめ方: 起点の週が 2月後半〜3月 / 8月後半〜9月 のものを除いて 3-1 と同じ計算をする。
-- 3-1 と比べて MSR・DTC のスプレッドが大きく縮むなら、権利落ちの効果だった。
-- SI(機関の空売り)はつなぎ売りと関係ないので、ほぼ変わらないはず(対照として見る)。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.si_covered, p.si_ratio, p.msr, p.dtc,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
obs_f AS (
    -- 起点の週が3月・9月、または2月・8月の後半なら使わない
    SELECT *
    FROM obs
    WHERE EXTRACT(MONTH FROM week_start) NOT IN (3, 9)
      AND NOT (EXTRACT(MONTH FROM week_start) IN (2, 8) AND EXTRACT(DAY FROM week_start) >= 15)
),
grp AS (
    -- 群 0 = 報告なし(SI)/売残ゼロ(MSR・DTC)。1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    SELECT 'SI' AS ind, o.*, o.si_ratio * 100 AS val,
           CASE WHEN o.si_ratio IS NULL THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.si_ratio IS NULL THEN 0 ELSE 1 END
                                    ORDER BY o.si_ratio) END AS g
    FROM obs_f o
    WHERE o.si_covered = 'Y'
    UNION ALL
    SELECT 'MSR', o.*, o.msr * 100,
           CASE WHEN o.msr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.msr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.msr) END
    FROM obs_f o
    WHERE o.msr IS NOT NULL
    UNION ALL
    SELECT 'DTC', o.*, o.dtc,
           CASE WHEN o.dtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.dtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.dtc) END
    FROM obs_f o
    WHERE o.dtc IS NOT NULL
),
sp AS (
    SELECT g.ind, g.h, g.week_start,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_is END)
                   - AVG(CASE WHEN g.g = 1 THEN g.exr_is END) END AS s51,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 0 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_is END)
                   - AVG(CASE WHEN g.g = 0 THEN g.exr_is END) END AS s50,
           CASE WHEN COUNT(CASE WHEN g.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN g.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN g.g = 5 THEN g.exr_ind END)
                   - AVG(CASE WHEN g.g = 1 THEN g.exr_ind END) END AS s51_ind
    FROM grp g
    CROSS JOIN params p
    GROUP BY g.ind, g.h, g.week_start
)
SELECT ind, h                                                        AS horizon_w,
       COUNT(s51)                                                    AS n_weeks_51,
       ROUND(AVG(s51), 2)                                            AS avg_s51,
       ROUND(STDDEV(s51), 2)                                         AS sd_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51,
       ROUND(AVG(CASE WHEN s51 < 0 THEN 1 WHEN s51 IS NOT NULL THEN 0 END) * 100, 1)
                                                                     AS pct_weeks_neg_51,
       COUNT(s50)                                                    AS n_weeks_50,
       ROUND(AVG(s50), 2)                                            AS avg_s50,
       ROUND(AVG(s50) / NULLIF(STDDEV(s50) / SQRT(COUNT(s50)), 0), 2) AS t_s50,
       ROUND(AVG(s51_ind), 2)                                        AS avg_s51_ind_only
FROM sp
GROUP BY ind, h
ORDER BY ind, h;


--------------------------------------------------------------------------------
-- 8. DTC・MSR 群5の小売業・銀行業の偏りと、月末の権利確定の影響(2026-09-16 追加)
--
-- 4 で DTC の群5に小売業(全体の1.77倍)と銀行業(2.07倍)が多かった。小売業は優待銘柄が多く、
-- 3月・9月以外の月末にもつなぎ売りで信用売残が膨らむ。7 は2〜3月・8〜9月しか除いていない。
--
-- A 全体 / B 小売業を除く / C 小売業・銀行業を除く / D 小売業の中だけで5分位
-- E 起点の週の最終営業日が1〜14日 / F 15日以降(月末の権利確定の直前の週を含む側)
--
-- 読み方: B・C で消えるなら業種の偏りが原因。E が0近く F だけ強いなら月末の権利確定が原因。
-- **13週の抽出週(13週おき)はたまたま全て15日以降に当たるので E が出ない。E/F は4週で読む。**
-- 2026-09-16 実測: DTC 4週 A -0.38 / B -0.37 / C -0.35 / D -0.62 / E -0.23(t-1.90, 53週) / F -0.48(t-3.46, 75週)。
-- 業種の偏りでは説明できない。E と F の差 -0.25 は t 約-1.4 で有意ではなく、E でも負が残る。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    SELECT 4 AS h, p.week_start, p.sector33_name, EXTRACT(DAY FROM p.last_bd) AS dd,
           p.msr, p.dtc, p.exr_is_4w AS exr_is
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
      AND (p.dtc > 0 OR p.msr > 0)
    UNION ALL
    SELECT 13, p.week_start, p.sector33_name, EXTRACT(DAY FROM p.last_bd),
           p.msr, p.dtc, p.exr_is_13w
    FROM xs_weekly_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
      AND (p.dtc > 0 OR p.msr > 0)
),
v AS (
    SELECT 'A_ALL' AS variant, o.* FROM obs o
    UNION ALL
    SELECT 'B_EX_RETAIL', o.* FROM obs o WHERE o.sector33_name <> '小売業'
    UNION ALL
    SELECT 'C_EX_RETAIL_BANK', o.* FROM obs o WHERE o.sector33_name NOT IN ('小売業', '銀行業')
    UNION ALL
    SELECT 'D_RETAIL_ONLY', o.* FROM obs o WHERE o.sector33_name = '小売業'
    UNION ALL
    SELECT 'E_DAY_01_14', o.* FROM obs o WHERE o.dd <= 14
    UNION ALL
    SELECT 'F_DAY_15_31', o.* FROM obs o WHERE o.dd >= 15
),
x AS (
    SELECT variant, 'DTC' AS ind, h, week_start, exr_is, dtc AS val FROM v WHERE dtc > 0
    UNION ALL
    SELECT variant, 'MSR', h, week_start, exr_is, msr FROM v WHERE msr > 0
),
gq AS (
    SELECT x.*,
           NTILE(5) OVER (PARTITION BY x.variant, x.ind, x.h, x.week_start ORDER BY x.val) AS g
    FROM x
),
sp AS (
    SELECT q.variant, q.ind, q.h, q.week_start,
           COUNT(CASE WHEN q.g = 5 THEN 1 END) AS n5,
           CASE WHEN COUNT(CASE WHEN q.g = 5 THEN 1 END) >= MAX(p.min_n)
                 AND COUNT(CASE WHEN q.g = 1 THEN 1 END) >= MAX(p.min_n)
                THEN AVG(CASE WHEN q.g = 5 THEN q.exr_is END)
                   - AVG(CASE WHEN q.g = 1 THEN q.exr_is END) END AS s51
    FROM gq q
    CROSS JOIN params p
    GROUP BY q.variant, q.ind, q.h, q.week_start
)
SELECT ind, h AS horizon_w, variant,
       COUNT(s51)                                                     AS n_weeks,
       ROUND(AVG(n5))                                                 AS avg_stocks_q5,
       ROUND(AVG(s51), 2)                                             AS avg_s51,
       ROUND(AVG(s51) / NULLIF(STDDEV(s51) / SQRT(COUNT(s51)), 0), 2) AS t_s51,
       ROUND(AVG(CASE WHEN s51 < 0 THEN 1 WHEN s51 IS NOT NULL THEN 0 END) * 100, 1) AS pct_weeks_neg
FROM sp
GROUP BY ind, h, variant
ORDER BY ind, h, variant;
