--------------------------------------------------------------------------------
-- 需給指標の検証(イベントスタディ)
--
-- 「この需給指標が◯◯の水準になった週の、その後のリターンはどうだったか」を
-- 手元の10年分で確かめる。指標を増やす前に、手持ちの指標が効くのかを知るためのもの。
--
-- 前提: ddl/19_demand_weekly_panel.sql を実行済みであること。
--       CLAUDE_RO で流すなら GRANT とシノニムも(同ファイル末尾)。
--
--------------------------------------------------------------------------------
-- 【この検証で最も大事なこと】
--
-- 目的は「効く指標を見つける」ことではなく、**「効かない指標を捨てる」**こと。
-- 見つけにいくと必ず何か見つかってしまうため、以下を守る。
--
-- (1) 閾値を1つ選んで当たりを探さない。分位で切って**単調性**を見る。
--     「倍率が高いほど、その後のリターンが低い」という傾向が5分位を通して
--     きれいに並ぶなら意味がある。第1分位と第5分位だけが極端で真ん中が
--     ばらばらなら、それは偶然の可能性が高い。
--
-- (2) 独立な観測数を数える。週次10年は約520週あるが、13週先のリターンは
--     13週ぶん重なっているので、**独立な観測は約40**しかない。
--     26週なら約20。「N=500」に見えても実質は数十で、
--     平均の差が3〜4%程度あっても偶然の範囲に十分収まる。
--
-- (3) 分位の境界を全期間から決めると、その時点では知り得ない情報を使うことになる
--     (先読みバイアス)。3 は探索用として全期間の分位を使い、
--     4 で「過去3年の平均と比べて何%乖離しているか」という、
--     その時点で計算できる形に置き換えている。**判断に使うなら 4 のほう。**
--
-- (4) 差が出なかったときに、条件をいじって出るまで試さない。
--     出なかったという結果自体が収穫。指標を1つ捨てられる。
--
-- 【この検証で分かること・分からないこと】
--   分かる   … 過去10年、その水準の後に何が起きたかの統計的な傾向
--   分からない … 将来どうなるか。市場構造は変わる(空売り比率の水準が
--                HFTの増加で切り上がったように)。過去の関係が続く保証は無い
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. パネルの充足状況(まずこれを見る)
--
-- 指標ごとに始まりが違う。特に裁定残は2023年からしか無いので、
-- 裁定残を条件にした検証は標本数が他の1/3以下になる。
--------------------------------------------------------------------------------
SELECT COUNT(*)                                        AS weeks,
       TO_CHAR(MIN(week_start), 'YYYY-MM-DD')          AS from_week,
       TO_CHAR(MAX(week_start), 'YYYY-MM-DD')          AS to_week,
       COUNT(margin_ratio)                             AS has_margin,
       COUNT(short_ratio_pct)                          AS has_short_ratio,
       COUNT(arb_net_oku)                              AS has_arb,
       COUNT(frgn_oku)                                 AS has_frgn,
       COUNT(fwd_ret_4w)                               AS has_fwd4,
       COUNT(fwd_ret_13w)                              AS has_fwd13,
       COUNT(fwd_ret_26w)                              AS has_fwd26
FROM v_demand_weekly_panel;


--------------------------------------------------------------------------------
-- 2. ベースライン(全期間の先行リターン分布)
--
-- 何と比べるかの基準。以降の条件付き分布は、必ずこれと比べて読む。
-- 「条件を満たした週の13週後リターンの平均が +3%」だけでは意味が無く、
-- 全期間の平均が +4% なら、その条件はむしろ悪い。
--------------------------------------------------------------------------------
--
-- 【2026-09-13 修正】WIN_PCT が先行リターンNULLの週(直近13週・26週)を
--   「負け」として数えていた。AVG(CASE WHEN x > 0 THEN 1 ELSE 0 END) は
--   x が NULL のとき ELSE 0 に落ちるため、分母だけが膨らんでいた。
--   13週後の正しい勝率は 66.5% ではなく 68.2%。
--   **COUNT() の分母と AVG(CASE...) の分母が違う**という、
--   集計を並べたときに起きやすい取り違え。WHERE で明示的に除外して直した。
SELECT '4週後'  AS horizon,
       COUNT(*)                                                      AS n,
       ROUND(AVG(fwd_ret_4w), 2)                                     AS avg_ret,
       ROUND(MEDIAN(fwd_ret_4w), 2)                                  AS med_ret,
       ROUND(STDDEV(fwd_ret_4w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_4w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct,
       ROUND(MIN(fwd_ret_4w), 1)                                     AS min_ret,
       ROUND(MAX(fwd_ret_4w), 1)                                     AS max_ret
FROM v_demand_weekly_panel
WHERE fwd_ret_4w IS NOT NULL
UNION ALL
SELECT '13週後', COUNT(*), ROUND(AVG(fwd_ret_13w), 2),
       ROUND(MEDIAN(fwd_ret_13w), 2), ROUND(STDDEV(fwd_ret_13w), 2),
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1),
       ROUND(MIN(fwd_ret_13w), 1), ROUND(MAX(fwd_ret_13w), 1)
FROM v_demand_weekly_panel
WHERE fwd_ret_13w IS NOT NULL
UNION ALL
SELECT '26週後', COUNT(*), ROUND(AVG(fwd_ret_26w), 2),
       ROUND(MEDIAN(fwd_ret_26w), 2), ROUND(STDDEV(fwd_ret_26w), 2),
       ROUND(AVG(CASE WHEN fwd_ret_26w > 0 THEN 1 ELSE 0 END) * 100, 1),
       ROUND(MIN(fwd_ret_26w), 1), ROUND(MAX(fwd_ret_26w), 1)
FROM v_demand_weekly_panel
WHERE fwd_ret_26w IS NOT NULL;


--------------------------------------------------------------------------------
-- 3. 【探索用】指標の5分位ごとの先行リターン
--
-- 指標を全期間で5等分し、分位ごとに13週後リターンを見る。
-- **見るのは第1分位と第5分位の差ではなく、1→5の並びが単調かどうか。**
--
-- 【使い方】 params の指標名を変えて、3つとも流す。
--
-- 【注意】分位の境界を全期間から決めているため先読みバイアスがある。
--         「過去10年を振り返るとこうだった」であって、
--         「その時点でこう判断できた」ではない。判断に使うなら 4 を見ること。
--------------------------------------------------------------------------------

-- 3-1. 信用倍率
SELECT q                                                              AS quintile,
       COUNT(*)                                                       AS n,
       ROUND(MIN(margin_ratio), 2)                                    AS ratio_from,
       ROUND(MAX(margin_ratio), 2)                                    AS ratio_to,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT margin_ratio, fwd_ret_13w,
           NTILE(5) OVER (ORDER BY margin_ratio) AS q
    FROM v_demand_weekly_panel
    WHERE margin_ratio IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY q
ORDER BY q;

-- 3-2. 空売り比率
SELECT q                                                              AS quintile,
       COUNT(*)                                                       AS n,
       ROUND(MIN(short_ratio_pct), 2)                                 AS pct_from,
       ROUND(MAX(short_ratio_pct), 2)                                 AS pct_to,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT short_ratio_pct, fwd_ret_13w,
           NTILE(5) OVER (ORDER BY short_ratio_pct) AS q
    FROM v_demand_weekly_panel
    WHERE short_ratio_pct IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY q
ORDER BY q;

-- 3-3. 海外投資家ネット(単週ではブレるので4週累計で見る)
SELECT q                                                              AS quintile,
       COUNT(*)                                                       AS n,
       ROUND(MIN(frgn_4w), 0)                                         AS oku_from,
       ROUND(MAX(frgn_4w), 0)                                         AS oku_to,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT frgn_4w, fwd_ret_13w,
           NTILE(5) OVER (ORDER BY frgn_4w) AS q
    FROM (
        SELECT SUM(frgn_oku) OVER (ORDER BY week_start
                                   ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS frgn_4w,
               fwd_ret_13w
        FROM v_demand_weekly_panel
        WHERE frgn_oku IS NOT NULL
    )
    WHERE frgn_4w IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY q
ORDER BY q;


--------------------------------------------------------------------------------
-- 4. 【判断用】先読みバイアスの無い形での検証
--
-- 3 は分位の境界を全期間から決めていた。実際の運用では「今が全期間の第5分位か」は
-- その時点では分からない。そこで **過去3年(156週)の平均からの乖離**という、
-- その週に計算できる形に置き換える。
--
--   DEV_PCT = 当週の指標 ÷ 直近156週(当週を含まない)の平均 - 1
--
-- 当週を含めない(ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING)のが要点。
-- 含めると自分自身が基準に混ざる。
--
-- 3 で単調性が見えた指標だけ、ここで確かめる。3 で何も無いものをここで
-- 探し直さないこと((4)の戒め)。
--------------------------------------------------------------------------------

-- 4-1. 信用倍率の「過去3年平均からの乖離」5分位
SELECT q                                                              AS quintile,
       COUNT(*)                                                       AS n,
       ROUND(MIN(dev_pct), 1)                                         AS dev_from,
       ROUND(MAX(dev_pct), 1)                                         AS dev_to,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT dev_pct, fwd_ret_13w, NTILE(5) OVER (ORDER BY dev_pct) AS q
    FROM (
        SELECT (margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                    ORDER BY week_start
                    ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
               fwd_ret_13w
        FROM v_demand_weekly_panel
        WHERE margin_ratio IS NOT NULL
    )
    WHERE dev_pct IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY q
ORDER BY q;

-- 4-2. 空売り比率の「過去3年平均からの乖離」5分位
--
-- 空売り比率は水準そのものが構造的に切り上がってきた(HFT・マーケットメイクの
-- 増加による)。過去3年平均との比較にすると、その構造変化を吸収できる。
-- 3-2 と結果が食い違うなら、3-2 が拾っていたのは「時代」であって
-- 「需給のシグナル」ではなかった、ということになる。
SELECT q                                                              AS quintile,
       COUNT(*)                                                       AS n,
       ROUND(MIN(dev_pct), 1)                                         AS dev_from,
       ROUND(MAX(dev_pct), 1)                                         AS dev_to,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT dev_pct, fwd_ret_13w, NTILE(5) OVER (ORDER BY dev_pct) AS q
    FROM (
        SELECT (short_ratio_pct / NULLIF(AVG(short_ratio_pct) OVER (
                    ORDER BY week_start
                    ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
               fwd_ret_13w
        FROM v_demand_weekly_panel
        WHERE short_ratio_pct IS NOT NULL
    )
    WHERE dev_pct IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY q
ORDER BY q;


--------------------------------------------------------------------------------
-- 5. 裁定買残ネットの縮小(いま起きていることの検証)
--
-- 「直近26週の高値から何%縮小したか」で見る。
-- 2026年2月の35,975億円 → 8月末21,484億円は、26週高値から約40%の縮小にあたる。
--
-- 【標本数に注意】裁定残は2023年からしか無く、週数は約190。
-- 13週先のリターンまで取れるのは約180週で、**独立な観測は14程度**。
-- ここで出た数字は傾向を示唆するだけで、検定に耐えるものではない。
-- 「効かない」と言い切ることすらできない標本数だと理解して見ること。
--------------------------------------------------------------------------------
SELECT CASE
         WHEN drawdown_pct >= 30 THEN '30%以上の縮小'
         WHEN drawdown_pct >= 15 THEN '15〜30%の縮小'
         WHEN drawdown_pct >=  5 THEN '5〜15%の縮小'
         ELSE                         '高値圏(5%未満)'
       END                                                            AS bucket,
       COUNT(*)                                                       AS n,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT (1 - arb_net_oku / NULLIF(MAX(arb_net_oku) OVER (
                ORDER BY week_start
                ROWS BETWEEN 25 PRECEDING AND CURRENT ROW), 0)) * 100 AS drawdown_pct,
           fwd_ret_13w
    FROM v_demand_weekly_panel
    WHERE arb_net_oku IS NOT NULL
)
WHERE drawdown_pct IS NOT NULL
  AND fwd_ret_13w IS NOT NULL
GROUP BY CASE
           WHEN drawdown_pct >= 30 THEN '30%以上の縮小'
           WHEN drawdown_pct >= 15 THEN '15〜30%の縮小'
           WHEN drawdown_pct >=  5 THEN '5〜15%の縮小'
           ELSE                         '高値圏(5%未満)'
         END
ORDER BY 1;


--------------------------------------------------------------------------------
-- 5-2. 【5 の欠陥の修正】同じ期間のベースラインと比べる
--
-- 5 は裁定残のある期間(2023年以降)の結果を、2 の全期間ベースライン(+3.07%)と
-- 暗黙に比べる作りになっていた。これは誤り。2023年以降はTOPIXが約2倍になった
-- 強い上昇相場で、素の勝率がそもそも高い。**同じ窓で計算したベースラインと
-- 比べなければ、何も言っていないのと同じ。**
--
-- ここでは裁定残が存在する週だけでベースラインを出し、5 のバケットと並べる。
-- 差がベースラインとの間に無ければ、5 の「勝率92%」は
-- 「この時期はどの週から入っても92%勝てた」と言っているだけになる。
--------------------------------------------------------------------------------
SELECT '(基準)裁定残のある全週' AS bucket,
       COUNT(*)                                                       AS n,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM v_demand_weekly_panel
WHERE arb_net_oku IS NOT NULL
  AND fwd_ret_13w IS NOT NULL
UNION ALL
SELECT CASE
         WHEN drawdown_pct >= 30 THEN '30%以上の縮小'
         WHEN drawdown_pct >= 15 THEN '15〜30%の縮小'
         WHEN drawdown_pct >=  5 THEN '5〜15%の縮小'
         ELSE                         '高値圏(5%未満)'
       END,
       COUNT(*),
       ROUND(AVG(fwd_ret_13w), 2),
       ROUND(MEDIAN(fwd_ret_13w), 2),
       ROUND(STDDEV(fwd_ret_13w), 2),
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1)
FROM (
    SELECT (1 - arb_net_oku / NULLIF(MAX(arb_net_oku) OVER (
                ORDER BY week_start
                ROWS BETWEEN 25 PRECEDING AND CURRENT ROW), 0)) * 100 AS drawdown_pct,
           fwd_ret_13w
    FROM v_demand_weekly_panel
    WHERE arb_net_oku IS NOT NULL
)
WHERE drawdown_pct IS NOT NULL
  AND fwd_ret_13w IS NOT NULL
GROUP BY CASE
           WHEN drawdown_pct >= 30 THEN '30%以上の縮小'
           WHEN drawdown_pct >= 15 THEN '15〜30%の縮小'
           WHEN drawdown_pct >=  5 THEN '5〜15%の縮小'
           ELSE                         '高値圏(5%未満)'
         END
ORDER BY 1;


--------------------------------------------------------------------------------
-- 5-3. 【全体に効く修正】同じ窓のベースラインを常に添える
--
-- 5-2 と同じ問題は、指標の期間が違う限りどこでも起きる。
-- 条件付きの数字を見るときは、必ず「その条件が計算できた週全部」の
-- ベースラインを隣に置くこと。2 の全期間ベースラインは、
-- 全期間データがある指標(信用倍率・空売り比率)にしか使えない。
--------------------------------------------------------------------------------
SELECT '全期間'                       AS window_name,
       COUNT(*)                       AS n,
       ROUND(AVG(fwd_ret_13w), 2)     AS avg_ret_13w,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM v_demand_weekly_panel WHERE fwd_ret_13w IS NOT NULL
UNION ALL
SELECT '信用倍率のある週', COUNT(*), ROUND(AVG(fwd_ret_13w), 2),
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1)
FROM v_demand_weekly_panel WHERE fwd_ret_13w IS NOT NULL AND margin_ratio IS NOT NULL
UNION ALL
SELECT '裁定残のある週(2023-)', COUNT(*), ROUND(AVG(fwd_ret_13w), 2),
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1)
FROM v_demand_weekly_panel WHERE fwd_ret_13w IS NOT NULL AND arb_net_oku IS NOT NULL;


--------------------------------------------------------------------------------
-- 5-4. 4-1(信用倍率の乖離)の頑健性: 期間を前半・後半に割る
--
-- 4-1 で上位2分位の先行リターンが落ちる傾向が見えた。
-- **本物なら、期間を半分に割っても両方で同じ向きに出るはず。**
-- 片方でしか出ないなら、特定の時期(たとえばコロナ後の一局面)を
-- 拾っているだけで、市場構造の変化に耐えない。
--
-- 閾値は「その半分の期間の中央値」を使う。全期間で見つけた +16.6% という線を
-- そのまま持ち込むと、当たりが出た場所を後から正当化することになるため。
--------------------------------------------------------------------------------
SELECT CASE half WHEN 1 THEN '前半' ELSE '後半' END                   AS period,
       TO_CHAR(MIN(week_start), 'YYYY-MM')                            AS from_month,
       TO_CHAR(MAX(week_start), 'YYYY-MM')                            AS to_month,
       CASE WHEN dev_pct >= med_dev THEN '乖離 大(中央値以上)'
            ELSE '乖離 小(中央値未満)' END                             AS dev_group,
       COUNT(*)                                                       AS n,
       ROUND(AVG(fwd_ret_13w), 2)                                     AS avg_ret_13w,
       ROUND(MEDIAN(fwd_ret_13w), 2)                                  AS med_ret_13w,
       ROUND(STDDEV(fwd_ret_13w), 2)                                  AS sd,
       ROUND(AVG(CASE WHEN fwd_ret_13w > 0 THEN 1 ELSE 0 END) * 100, 1) AS win_pct
FROM (
    SELECT week_start, dev_pct, fwd_ret_13w, half,
           MEDIAN(dev_pct) OVER (PARTITION BY half) AS med_dev
    FROM (
        SELECT week_start, dev_pct, fwd_ret_13w,
               NTILE(2) OVER (ORDER BY week_start) AS half
        FROM (
            SELECT week_start,
                   (margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                        ORDER BY week_start
                        ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
                   fwd_ret_13w
            FROM v_demand_weekly_panel
            WHERE margin_ratio IS NOT NULL
        )
        WHERE dev_pct IS NOT NULL
          AND fwd_ret_13w IS NOT NULL
    )
)
GROUP BY half,
         CASE WHEN dev_pct >= med_dev THEN '乖離 大(中央値以上)'
              ELSE '乖離 小(中央値未満)' END
ORDER BY half, dev_group;


--------------------------------------------------------------------------------
-- 5-5. 4-1 は特定の時期に偏っていないか(年別の内訳)
--
-- 5-4 で「向きは前後半とも同じだが、大きさは後半が圧倒的」と出た。
-- 効果が2〜3年に集中しているなら、それは需給の性質ではなくその時期の出来事。
-- **各年で同じ向きに出るか**を見る。年をまたいで符号がばらつくなら、
-- 5-4 の一致は偶然に近い。
--
-- 年ごとの週数は約50、13週先リターンの独立観測は年あたり4程度しかない。
-- 個々の年の数字は当てにならないので、**符号の並び方だけを見ること。**
--------------------------------------------------------------------------------
SELECT TO_CHAR(week_start, 'YYYY')                                   AS yr,
       COUNT(*)                                                      AS n,
       SUM(CASE WHEN hi = 1 THEN 1 ELSE 0 END)                       AS n_hi,
       ROUND(AVG(CASE WHEN hi = 1 THEN fwd_ret_13w END), 2)          AS ret_hi,
       ROUND(AVG(CASE WHEN hi = 0 THEN fwd_ret_13w END), 2)          AS ret_lo,
       ROUND(AVG(CASE WHEN hi = 1 THEN fwd_ret_13w END)
             - AVG(CASE WHEN hi = 0 THEN fwd_ret_13w END), 2)        AS diff_hi_minus_lo
FROM (
    SELECT week_start, fwd_ret_13w,
           CASE WHEN dev_pct >= MEDIAN(dev_pct) OVER () THEN 1 ELSE 0 END AS hi
    FROM (
        SELECT week_start,
               (margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                    ORDER BY week_start
                    ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
               fwd_ret_13w
        FROM v_demand_weekly_panel
        WHERE margin_ratio IS NOT NULL
    )
    WHERE dev_pct IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY TO_CHAR(week_start, 'YYYY')
ORDER BY yr;


--------------------------------------------------------------------------------
-- 5-6. 【核心】「信用倍率の乖離」は「最近よく上がった」の言い換えではないか
--
-- 信用買残は相場が上がった後に積み上がる。だとすると
--   乖離が大きい = 直近で値上がりした局面
--   その後リターンが劣る = 単なる平均回帰
-- ということになり、**需給指標ではなく価格モメンタムを遠回りに測っているだけ**。
-- それなら信用取引残高を取り込む意味が無い(TOPIXの騰落率だけ見ればよい)。
--
-- (a) 乖離と「直近26週のTOPIX騰落率」の相関を見る。
--     0.6〜0.7以上なら、ほぼ同じものを測っている疑いが濃い。
-- (b) 直近26週騰落率で3層に分けたうえで、各層の中で乖離大小を比べる。
--     **値上がり幅を揃えてもなお差が残るなら**、信用残は価格に無い情報を
--     持っていることになる。差が消えるなら、価格の言い換えだったということ。
--------------------------------------------------------------------------------

-- (a) 相関
SELECT COUNT(*)                                  AS n,
       ROUND(CORR(dev_pct, trail_ret_26w), 3)    AS corr_dev_vs_trailing_return
FROM (
    SELECT (margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                ORDER BY week_start
                ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
           (topix_close / NULLIF(LAG(topix_close, 26)
                OVER (ORDER BY week_start), 0) - 1) * 100                  AS trail_ret_26w
    FROM v_demand_weekly_panel
    WHERE margin_ratio IS NOT NULL
)
WHERE dev_pct IS NOT NULL
  AND trail_ret_26w IS NOT NULL;

-- (b) 直近26週騰落率で層別してから、乖離大小を比べる
SELECT CASE trail_grp WHEN 1 THEN '1_直近が弱い'
                      WHEN 2 THEN '2_直近が中位'
                      ELSE        '3_直近が強い' END                  AS trailing_group,
       ROUND(MIN(trail_ret_26w), 1)                                   AS trail_from,
       ROUND(MAX(trail_ret_26w), 1)                                   AS trail_to,
       SUM(CASE WHEN hi = 1 THEN 1 ELSE 0 END)                        AS n_hi,
       ROUND(AVG(CASE WHEN hi = 1 THEN fwd_ret_13w END), 2)           AS ret_hi,
       SUM(CASE WHEN hi = 0 THEN 1 ELSE 0 END)                        AS n_lo,
       ROUND(AVG(CASE WHEN hi = 0 THEN fwd_ret_13w END), 2)           AS ret_lo,
       ROUND(AVG(CASE WHEN hi = 1 THEN fwd_ret_13w END)
             - AVG(CASE WHEN hi = 0 THEN fwd_ret_13w END), 2)         AS diff_hi_minus_lo
FROM (
    SELECT trail_ret_26w, fwd_ret_13w,
           NTILE(3) OVER (ORDER BY trail_ret_26w) AS trail_grp,
           CASE WHEN dev_pct >= MEDIAN(dev_pct) OVER () THEN 1 ELSE 0 END AS hi
    FROM (
        SELECT (margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                    ORDER BY week_start
                    ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
               (topix_close / NULLIF(LAG(topix_close, 26)
                    OVER (ORDER BY week_start), 0) - 1) * 100                  AS trail_ret_26w,
               fwd_ret_13w
        FROM v_demand_weekly_panel
        WHERE margin_ratio IS NOT NULL
    )
    WHERE dev_pct IS NOT NULL
      AND trail_ret_26w IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
)
GROUP BY trail_grp
ORDER BY trail_grp;


--------------------------------------------------------------------------------
-- 5-7. 【決定打】年内順位で分ける
--
-- 5-5 で、全期間の中央値で切ると**年まるごとが片側に寄る**ことが分かった
-- (2016年・2019年は「乖離大」の週がゼロ、2018・2021・2022・2024年はほぼ全週が
-- 「乖離大」)。つまり 4-1・5-4・5-6 の比較は、週と週ではなく**年と年**を
-- 比べていたことになる。実効的な観測数は496ではなく9。
--
-- ここでは **各年の中央値**で切る。年の相場つきの違いを打ち消したうえで、
-- 「同じ年の中で、信用倍率が相対的に高い週と低い週」を比べる。
--
-- これで差が消えるなら、4-1 で見えたものは需給の性質ではなく
-- 「乖離が高かった年はたまたま相場が弱かった」という年単位の偶然。
-- **シンプソンのパラドックス**(プールすると出る差が層の中では消える)の実例。
--
-- 【この検証の限界も書いておく】
--   年内で切ると、年をまたぐ大きな乖離の変動そのものは検出できなくなる。
--   「年をまたぐ変動にこそ意味がある」という反論は成り立つが、
--   それを主張するなら実効観測数9で議論することになり、何も言えない。
--   どちらに転んでも結論は「この標本では判定できない」。
--------------------------------------------------------------------------------
SELECT SUM(CASE WHEN hi_in_year = 1 THEN 1 ELSE 0 END)                AS n_hi,
       ROUND(AVG(CASE WHEN hi_in_year = 1 THEN fwd_ret_13w END), 2)   AS ret_hi,
       ROUND(AVG(CASE WHEN hi_in_year = 1 AND fwd_ret_13w > 0 THEN 1
                      WHEN hi_in_year = 1 THEN 0 END) * 100, 1)       AS win_hi,
       SUM(CASE WHEN hi_in_year = 0 THEN 1 ELSE 0 END)                AS n_lo,
       ROUND(AVG(CASE WHEN hi_in_year = 0 THEN fwd_ret_13w END), 2)   AS ret_lo,
       ROUND(AVG(CASE WHEN hi_in_year = 0 AND fwd_ret_13w > 0 THEN 1
                      WHEN hi_in_year = 0 THEN 0 END) * 100, 1)       AS win_lo,
       ROUND(AVG(CASE WHEN hi_in_year = 1 THEN fwd_ret_13w END)
             - AVG(CASE WHEN hi_in_year = 0 THEN fwd_ret_13w END), 2) AS diff_hi_minus_lo
FROM (
    SELECT fwd_ret_13w,
           CASE WHEN dev_pct >= MEDIAN(dev_pct)
                       OVER (PARTITION BY TO_CHAR(week_start, 'YYYY'))
                THEN 1 ELSE 0 END AS hi_in_year
    FROM (
        SELECT week_start,
               (margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                    ORDER BY week_start
                    ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100 AS dev_pct,
               fwd_ret_13w
        FROM v_demand_weekly_panel
        WHERE margin_ratio IS NOT NULL
    )
    WHERE dev_pct IS NOT NULL
      AND fwd_ret_13w IS NOT NULL
);


--------------------------------------------------------------------------------
-- 6. 現在地の確認(いまが過去のどのあたりか)
--
-- 3〜5 で傾向が見えたら、直近の週がどの分位・どのバケットに入るのかを確認する。
-- 検証結果を「いま」に当てはめる唯一の接点。
--------------------------------------------------------------------------------
SELECT TO_CHAR(week_start, 'YYYY-MM-DD')                              AS week_start,
       topix_close,
       margin_ratio,
       ROUND((margin_ratio / NULLIF(AVG(margin_ratio) OVER (
                 ORDER BY week_start
                 ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100, 1)
                                                                      AS margin_dev_pct,
       short_ratio_pct,
       ROUND((short_ratio_pct / NULLIF(AVG(short_ratio_pct) OVER (
                 ORDER BY week_start
                 ROWS BETWEEN 156 PRECEDING AND 1 PRECEDING), 0) - 1) * 100, 1)
                                                                      AS short_dev_pct,
       arb_net_oku,
       ROUND((1 - arb_net_oku / NULLIF(MAX(arb_net_oku) OVER (
                 ORDER BY week_start
                 ROWS BETWEEN 25 PRECEDING AND CURRENT ROW), 0)) * 100, 1)
                                                                      AS arb_drawdown_pct
FROM v_demand_weekly_panel
ORDER BY week_start DESC
FETCH FIRST 8 ROWS ONLY;


--------------------------------------------------------------------------------
-- 7. 結果の読み方(検証を終えたあとに読むこと)
--
-- 【差が出なかった場合】
--   それが最も価値のある結果。その指標を「相場の方向を当てるもの」として
--   使うのをやめられる。需給指標の多くは方向の予測力を持たない。
--   持たないことを知っているだけで、無駄な判断を減らせる。
--
-- 【差が出た場合に確認すること】
--   ・単調か。1→5が順に並んでいるか、両端だけが極端ではないか
--   ・標本数。13週先なら独立観測は N/13 程度。N=400 でも実質30
--   ・sd(標準偏差)と比べて差はどのくらいか。平均の差が2%でも
--     sd が15%なら、その差はノイズに埋もれている
--   ・3(全期間分位)と4(過去3年乖離)で結論が変わらないか。
--     変わるなら3が拾っていたのは時代の変化であってシグナルではない
--   ・期間を前半5年・後半5年で割っても同じ傾向が出るか
--     (出ないなら市場構造の変化に耐えない)
--
-- 【やってはいけないこと】
--   閾値・期間・ホライズンを動かして「効く組み合わせ」を探すこと。
--   20通り試せば1つは偶然5%水準を通る。探した事実を忘れて
--   「見つけた」と思い込むのが、この種の分析で最も多い失敗。
--
-- 【2026-09-13 に実際に流した結果の要約】
--   ・ベースライン(13週後)は 平均+3.07% / 勝率66.5%。**この10年はまるごと上昇相場**で、
--     年率に直すと約13%。勝率90%台を見ても、比較対象は50%ではなく66.5%。
--   ・空売り比率は 3-2(水準)・4-2(乖離)とも並びが無く、**方向の予測には使えない**。
--     2つの形で揃って何も出たので、取りこぼしではなく本当に情報が無いと判断した。
--     需給の描写には引き続き使える。
--   ・信用倍率の**水準**(3-1)も並びが無い。
--   ・海外投資家(3-3)は第1分位と第5分位の両方が良いU字。買っても売っても上がる、は
--     **上昇相場でフロー変数の極端値がどちらも良く見える**典型的な見せかけ。
--     しかも第5分位の102週は独立な事象としては3〜4エピソードしかない。
--   ・裁定残(5-2)は同期間ベースライン(平均+5.52%/勝率81.1%)と比べると差はわずか。
--     2023年以降は**どの週から入っても81%勝てた**期間で、
--     「30%以上の縮小で勝率92.2%」はその中の小さな上振れにすぎない。
--     しかも64週は独立事象としては2〜3エピソード。使えない。
--
--   ・唯一引っかかったのが 4-1、信用倍率の**過去3年平均からの乖離**だったが、
--     **5-5 で否定された**。全期間の中央値で切ると年まるごとが片側に寄っており
--     (2016年・2019年は「乖離大」ゼロ、2018・2021・2022・2024年はほぼ全週が乖離大)、
--     週と週ではなく**年と年**を比べていた。実効観測数は496ではなく9。
--     年内で見た DIFF_HI_MINUS_LO は9年中6年がプラス(プール結果と逆符号)。
--     5-7 で各年の中央値で切り直したところ **+0.21(平均+3.21% vs +3.00%)** で、
--     全期間分割の -3.4 から符号ごと消えた。**シンプソンのパラドックス**の実例。
--     勝率だけ 64.7% vs 72.1% と元の向きに -7.4pt 残るが、年内分割後の
--     独立観測は片側19程度(252÷13)で勝率差の標準誤差は15pt前後。読む価値はない。
--     なお 5-6 は通っている(直近26週リターンとの相関0.067、3層すべてで差が残る)。
--     価格モメンタムの言い換えではなかったが、**年の相場つきの言い換えだった**。
--
--   ・結論: 検証した5つの指標(空売り比率の水準・同乖離・信用倍率の水準・同乖離・
--     裁定残の縮小)は、いずれも13週先のTOPIXの方向を予測しない。
--     海外投資家ネットも上昇相場の見せかけ。**方向の予測には使わないこと。**
--     需給の「いま何が起きているか」を描写する用途では引き続き有効。
--
-- 【最後に】
--   ここで何が出ても、それは過去の統計的性質であって将来の予測ではない。
--   市場構造は変わる(空売り比率の水準がHFTの増加で切り上がったように)。
--   投資判断の材料の1つ以上のものとして扱わないこと。
--------------------------------------------------------------------------------
