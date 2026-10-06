--------------------------------------------------------------------------------
-- 信用買残の横断面検証(銘柄間の優劣)
--
-- 問い: 「信用買残が重い・増えている銘柄は、その後、同業・同規模の銘柄より強いか弱いか」
--
-- xsection_short_backtest.sql は売り側(SI・MSR・DTC)を検証した。こちらは買い側。
-- 時系列では「信用倍率」(買残÷売残)を検証して不合格だったが、倍率は売残の動きと混ざるうえ、
-- 市場全体の方向を当てる問題だった。買残だけを、銘柄間の優劣として測るのは未検証だった。
--
-- 前提: ddl/20_xsection_weekly_panel.sql で xs_weekly_panel を、
--       ddl/22_xsection_long_panel.sql で xs_long_panel を作成済みであること。
--       CLAUDE_RO で流すなら ddl/22 末尾の権限付与も。
--
--------------------------------------------------------------------------------
-- 【検証する3つの指標(判定に使う)と、参考の1つ】
--
--   MBR  … 信用買残の時価 ÷ 時価総額(= 買残株数 ÷ 発行済株式数)。個人中心。MSR の買い版。
--   LDTC … 信用買残 ÷ 直近4週の1日平均出来高。DTC の買い版。「買残を売り切るのに何日分か」
--   DMBR … MBR の4週間の変化(pt)。買残の増減のインパクトを測る本命。株数ではなく
--          発行済株式に対する割合の差で測るので、分割・増資の影響を受けにくい。
--   LCHG … 買残株数の4週間の増加率(参考。判定に数えない)。分割は累積調整係数で調整し、
--          4週前の買残が発行済株式の0.1%未満の銘柄は NULL にしてある(基数が小さいと率が暴れる)。
--
--   信用残は「その週のうちに使える」前週申込分を使う(ddl/20 と同じ時点整合)。
--   信用取引残高は分割の遡及調整が無い(short_selling_data)。MBR・DMBR は申込週ごとの
--   時価と時価総額で割るので調整が要らず、LCHG だけが累積係数で調整している。
--
--------------------------------------------------------------------------------
-- 【予想(向きは固定せず両側で判定する)】
--
--   買残が重い(MBR・LDTC 群5)ほど弱いと予想している。理由: 制度信用の期日(6か月)で
--   反対売買が出る「将来の売り圧力」、買い方に逆張りの個人が多いこと。
--   ただし逆に、個人の買い向かいが底を拾っている形で強く出る可能性もあるので、
--   事前に向きは決めず、絶対値で判定する。DMBR は向きの予想なし。
--
--------------------------------------------------------------------------------
-- 【合格の条件を、結果を見る前に決めておく】
--
--   (a) 群1→5 の相対リターンがおおむね単調に並ぶ(2)
--   (b) 群5−群1 のスプレッドの t 値が絶対値 **2.5** 以上。4週・13週で同じ向き(3-1)
--       空売り版の2.0より厳しくした。判定が3指標×2期間=6本あり、2.0だと
--       全部が無関係でも6本のうち1本は偶然超える確率が約25%ある。2.5なら約7%。
--       t 値は「重ならない週ごとのスプレッド」を1観測とした値(Fama-MacBeth の形)。
--       13週先は約38観測、4週先は約125観測しかない。
--   (c) 特定の1〜2年だけで作られていない。どの1年を除いても向きが残る(3-2)
--   (d) 業種内で切り直しても残る(5)。群5が特定の業種の寄せ集めなら(4)で分かる
--   (e) SIZE・PBR・モメンタム・直近4週リターン(REV)の層の中でも向きが残る(6)
--       買残の増減が「直近で下がったから個人が買い向かった」の言い換えでないことを確かめる。
--       MBR・LDTC は時価総額と強く逆相関する(小型株ほど買残が重い。0-3 で確認)ので、
--       SIZE 層の中でも残ることが特に重要。相対リターンは同じ規模5分位の平均との差で
--       測っているが、群5が小型株に偏ること自体は残る
--   (f) 売残側 DTC(SDTC)の層の中でも向きが残る(6)。信用残全体の重さの言い換えでない
--   (g) 優待クロスの時期を除いても向きが残り、平均が半分以上残る(7)
--
--   (a)〜(g) のどれかで落ちたら不合格。条件を変えて出るまで試さない。
--   LCHG だけが通っても合格に数えない(判定の指標を後から増やさないため)。
--
--------------------------------------------------------------------------------
-- 【読むときの前提】
--   ・相対リターン EXR_IS は「同じ週・同じ17業種・同じ時価総額5分位」の等ウェイト平均との差(%)。
--     市場全体が上がった分は引いてある。ただしこの10年が上昇相場一色だったことは変わらない
--     (regime_bias_limits)。下落相場で同じ関係が続くかはこのデータでは確かめられない。
--   ・買残は上昇相場で増えやすい(個人が買い増す)。週内の順位で切っているので市場全体の水準は
--     引けているが、「上昇相場の10年だから買い方が報われた/報われなかった」は残る。
--   ・リターンは分割しか調整しておらず、配当・優待落ちを含む。
--   ・上場廃止銘柄は最後の終値までのリターン。倒産時の損失は過小に出る(ddl/20)。
--   ・同じ週の銘柄同士は相関するので、銘柄数ではなく週数が独立観測の数。
--   ・4週・13週の結果を結果から選んで報告しない。判定は上の条件どおりに行う。
--   ・空売り版で残った候補(DTC 群5)は「形を結果から選んだ」ので事前登録ではない。
--     こちらは事前に登録した形(群5−群1、3指標)で判定する。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0-1. パネルの充足状況(年別)と、指標の分布
--
-- 買残の指標が各年で十分埋まっているか。PCT_* が極端に低い年があれば、その年の週は
-- 検証から事実上外れる(GW・年末年始の欠測週と、2026-09 以降の日次化は想定内)。
-- MED_MBR_PCT / P99_MBR_PCT は発行済株式に対する買残の割合(%)の中央値と上位1%点。
-- MAX_MBR_PCT が100%に近いときは、浮動株が極端に少ない銘柄か、株数の取り違えを疑う。
--------------------------------------------------------------------------------
SELECT EXTRACT(YEAR FROM week_start)                          AS yr,
       COUNT(DISTINCT week_start)                             AS weeks,
       ROUND(COUNT(*) / COUNT(DISTINCT week_start))           AS stocks_per_week,
       ROUND(COUNT(long_vol) / COUNT(*) * 100, 1)             AS pct_long,
       ROUND(COUNT(mbr)      / COUNT(*) * 100, 1)             AS pct_mbr,
       ROUND(COUNT(ldtc)     / COUNT(*) * 100, 1)             AS pct_ldtc,
       ROUND(COUNT(dmbr_4w)  / COUNT(*) * 100, 1)             AS pct_dmbr,
       ROUND(COUNT(lchg_4w)  / COUNT(*) * 100, 1)             AS pct_lchg,
       ROUND(MEDIAN(mbr) * 100, 3)                            AS med_mbr_pct,
       ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY mbr) * 100, 2) AS p99_mbr_pct,
       ROUND(MAX(mbr) * 100, 1)                               AS max_mbr_pct,
       ROUND(MEDIAN(ldtc), 2)                                 AS med_ldtc_days
FROM xs_long_panel
GROUP BY EXTRACT(YEAR FROM week_start)
ORDER BY yr;


--------------------------------------------------------------------------------
-- 0-2. 買残割合が大きい銘柄(直近で値のある週の上位20)
--
-- 株数の取り違え・分割未調整による異常値がないかを目で確認する。
-- 既知の事情で大きいもの(上場廃止間際・極端な低流動性)は残してよい。
--------------------------------------------------------------------------------
WITH last_wk AS (
    SELECT MAX(week_start) AS wk FROM xs_long_panel WHERE mbr IS NOT NULL
)
SELECT x.code, em.co_name, TO_CHAR(x.week_start, 'YYYY-MM-DD') AS week_start,
       ROUND(x.mbr * 100, 2)  AS mbr_pct,
       ROUND(x.ldtc, 1)       AS ldtc_days,
       x.long_vol, x.mcap_oku, x.sector33_name
FROM xs_long_panel x
JOIN last_wk l ON l.wk = x.week_start
LEFT JOIN equity_master em ON em.code = x.code
WHERE x.mbr IS NOT NULL
ORDER BY x.mbr DESC
FETCH FIRST 20 ROWS ONLY;


--------------------------------------------------------------------------------
-- 0-3. 指標と、既知の要因との週ごとの順位相関(週平均)
--
-- 買残の指標が「過去に下げた銘柄」「小型株」「売残も重い銘柄」の言い換えになっていないか。
-- 相関が±0.3を超えるものは、6 の層別で必ず向きが残るかを確認する。
-- 買い方は逆張りの個人が多いので、DMBR と過去4週リターン(REV)は負の相関が出るはず。
-- それが強いなら、DMBR は「短期反転」を拾っているだけの疑いがある。
-- 4週おきの週だけを使い、7指標がそろった銘柄だけで順位を付ける。
--------------------------------------------------------------------------------
WITH base AS (
    SELECT week_start, mbr, ldtc, dmbr_4w, mom_26w, ret_4w_past, shrt_dtc, mcap_oku
    FROM xs_long_panel
    WHERE MOD(wk_idx, 4) = 0
      AND mbr IS NOT NULL AND ldtc IS NOT NULL AND dmbr_4w IS NOT NULL
      AND mom_26w IS NOT NULL AND ret_4w_past IS NOT NULL
      AND shrt_dtc IS NOT NULL AND mcap_oku IS NOT NULL
),
r AS (
    SELECT week_start,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mbr)         AS r_mbr,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY ldtc)        AS r_ldtc,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY dmbr_4w)     AS r_dmbr,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mom_26w)     AS r_mom,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY ret_4w_past) AS r_rev,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY shrt_dtc)    AS r_sdtc,
           PERCENT_RANK() OVER (PARTITION BY week_start ORDER BY mcap_oku)    AS r_size
    FROM base
),
c AS (
    SELECT week_start,
           CORR(r_mbr,  r_mom)  AS mbr_mom,  CORR(r_mbr,  r_rev)  AS mbr_rev,
           CORR(r_mbr,  r_size) AS mbr_size, CORR(r_mbr,  r_sdtc) AS mbr_sdtc,
           CORR(r_ldtc, r_mom)  AS ldtc_mom, CORR(r_ldtc, r_rev)  AS ldtc_rev,
           CORR(r_ldtc, r_size) AS ldtc_size, CORR(r_ldtc, r_sdtc) AS ldtc_sdtc,
           CORR(r_dmbr, r_mom)  AS dmbr_mom, CORR(r_dmbr, r_rev)  AS dmbr_rev,
           CORR(r_dmbr, r_size) AS dmbr_size, CORR(r_dmbr, r_mbr) AS dmbr_mbr,
           CORR(r_mbr,  r_ldtc) AS mbr_ldtc
    FROM r
    GROUP BY week_start
)
SELECT COUNT(*)                         AS n_weeks,
       ROUND(AVG(mbr_mom), 3)   AS mbr_mom,   ROUND(AVG(mbr_rev), 3)   AS mbr_rev,
       ROUND(AVG(mbr_size), 3)  AS mbr_size,  ROUND(AVG(mbr_sdtc), 3)  AS mbr_sdtc,
       ROUND(AVG(ldtc_mom), 3)  AS ldtc_mom,  ROUND(AVG(ldtc_rev), 3)  AS ldtc_rev,
       ROUND(AVG(ldtc_size), 3) AS ldtc_size, ROUND(AVG(ldtc_sdtc), 3) AS ldtc_sdtc,
       ROUND(AVG(dmbr_mom), 3)  AS dmbr_mom,  ROUND(AVG(dmbr_rev), 3)  AS dmbr_rev,
       ROUND(AVG(dmbr_size), 3) AS dmbr_size, ROUND(AVG(dmbr_mbr), 3)  AS dmbr_mbr,
       ROUND(AVG(mbr_ldtc), 3)  AS mbr_ldtc
FROM c;


--------------------------------------------------------------------------------
-- 1. ベースライン(全銘柄)
--
-- 横断面のベースラインは「相対リターンの平均 ≒ 0」。平均が0から大きく外れていたら
-- パネルの作り方がおかしい。見るべきは中央値と PCT_BEAT(業種・規模平均に勝った割合)で、
-- 2 以降の群の数字はこれと比べて読む(50%と比べない)。
-- 空売り版(xsection_short_backtest.sql の 1)と同じ値になるはず。違えばパネルの対象が違う。
--------------------------------------------------------------------------------
WITH obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
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
-- VAL_FROM / VAL_TO は各週の群の最小・最大の平均(MBR は %、LDTC は日数、DMBR は pt、LCHG は %)。
-- DMBR・LCHG は群1が「最も減った」、群5が「最も増えた」。
-- AVG_EXR_IS が主。AVG_EXR_IND(業種のみ調整)と大きく違うなら、規模の違いが効いている。
-- AVG_RET(未調整)は参考。上昇相場の分が乗っているので判断に使わない。
--------------------------------------------------------------------------------
WITH obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- MBR・LDTC: 群0 = 買残ゼロ、1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    -- DMBR・LCHG: 群0 なし。全体を週内5分位(1 = 最も減った、5 = 最も増えた)
    -- 同値の銘柄は銘柄コード順で割り振る(結果が実行のたびに変わらないように)
    SELECT 'MBR' AS ind, o.*, o.mbr * 100 AS val,
           CASE WHEN o.mbr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.mbr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.mbr, o.code) END AS g
    FROM obs o
    WHERE o.mbr IS NOT NULL
    UNION ALL
    SELECT 'LDTC', o.*, o.ldtc,
           CASE WHEN o.ldtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.ldtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.ldtc, o.code) END
    FROM obs o
    WHERE o.ldtc IS NOT NULL
    UNION ALL
    SELECT 'DMBR', o.*, o.dmbr_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.dmbr_4w, o.code)
    FROM obs o
    WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.*, o.lchg_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.lchg_4w, o.code)
    FROM obs o
    WHERE o.lchg_4w IS NOT NULL
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
-- S50 は 群5 − 群0(買残ゼロ)。MBR・LDTC のみで、DMBR・LCHG は群0がないので NULL。
-- 買残ゼロの銘柄は週に10銘柄に満たないのが普通で、その場合は MBR・LDTC も NULL になる(判定に使わない)。
-- PCT_WEEKS_NEG は分母を「スプレッドが計算できた週」に揃えてある
-- (AVG(CASE ... ELSE 0) で NULL を負け扱いにした過去の失敗を繰り返さないため)。
-- 判定は MBR・LDTC・DMBR の3指標×4週/13週の6本。LCHG は参考で、判定に数えない。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- MBR・LDTC: 群0 = 買残ゼロ、1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    -- DMBR・LCHG: 群0 なし。全体を週内5分位(1 = 最も減った、5 = 最も増えた)
    -- 同値の銘柄は銘柄コード順で割り振る(結果が実行のたびに変わらないように)
    SELECT 'MBR' AS ind, o.*, o.mbr * 100 AS val,
           CASE WHEN o.mbr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.mbr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.mbr, o.code) END AS g
    FROM obs o
    WHERE o.mbr IS NOT NULL
    UNION ALL
    SELECT 'LDTC', o.*, o.ldtc,
           CASE WHEN o.ldtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.ldtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.ldtc, o.code) END
    FROM obs o
    WHERE o.ldtc IS NOT NULL
    UNION ALL
    SELECT 'DMBR', o.*, o.dmbr_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.dmbr_4w, o.code)
    FROM obs o
    WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.*, o.lchg_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.lchg_4w, o.code)
    FROM obs o
    WHERE o.lchg_4w IS NOT NULL
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
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- MBR・LDTC: 群0 = 買残ゼロ、1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    -- DMBR・LCHG: 群0 なし。全体を週内5分位(1 = 最も減った、5 = 最も増えた)
    -- 同値の銘柄は銘柄コード順で割り振る(結果が実行のたびに変わらないように)
    SELECT 'MBR' AS ind, o.*, o.mbr * 100 AS val,
           CASE WHEN o.mbr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.mbr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.mbr, o.code) END AS g
    FROM obs o
    WHERE o.mbr IS NOT NULL
    UNION ALL
    SELECT 'LDTC', o.*, o.ldtc,
           CASE WHEN o.ldtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.ldtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.ldtc, o.code) END
    FROM obs o
    WHERE o.ldtc IS NOT NULL
    UNION ALL
    SELECT 'DMBR', o.*, o.dmbr_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.dmbr_4w, o.code)
    FROM obs o
    WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.*, o.lchg_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.lchg_4w, o.code)
    FROM obs o
    WHERE o.lchg_4w IS NOT NULL
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
-- 4. 群5・群1の業種の偏り(条件 d の下見)
--
-- 各指標の群5(MBR・LDTC は買残が重い、DMBR・LCHG は最も増えた)と群1に、
-- 特定の33業種が偏っていないか。4週先の観測だけで数える。
-- RATIO5 = 群5に占める割合 ÷ 全体に占める割合。1より大きいほど群5に多い。
-- RATIO1 は群1について同じ。全体の1%以上を占める業種のうち、RATIO5 の大きい6業種を指標ごとに出す。
-- 買残は優待・配当人気の銘柄(小売・食品・サービス)と、個人が好む小型の成長株(情報通信など)に
-- 偏りやすいと予想している。偏りが強ければ 5 で業種内に切り直した結果を優先して読む。
--------------------------------------------------------------------------------
WITH obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
grp AS (
    -- MBR・LDTC: 群0 = 買残ゼロ、1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    -- DMBR・LCHG: 群0 なし。全体を週内5分位(1 = 最も減った、5 = 最も増えた)
    -- 同値の銘柄は銘柄コード順で割り振る(結果が実行のたびに変わらないように)
    SELECT 'MBR' AS ind, o.*, o.mbr * 100 AS val,
           CASE WHEN o.mbr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.mbr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.mbr, o.code) END AS g
    FROM obs o
    WHERE o.mbr IS NOT NULL
    UNION ALL
    SELECT 'LDTC', o.*, o.ldtc,
           CASE WHEN o.ldtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.ldtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.ldtc, o.code) END
    FROM obs o
    WHERE o.ldtc IS NOT NULL
    UNION ALL
    SELECT 'DMBR', o.*, o.dmbr_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.dmbr_4w, o.code)
    FROM obs o
    WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.*, o.lchg_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.lchg_4w, o.code)
    FROM obs o
    WHERE o.lchg_4w IS NOT NULL
),
cnt AS (
    SELECT ind, sector33_name,
           COUNT(CASE WHEN g = 5 THEN 1 END) AS n5,
           COUNT(CASE WHEN g = 1 THEN 1 END) AS n1,
           COUNT(*)                          AS n_all
    FROM grp
    WHERE h = 4
    GROUP BY ind, sector33_name
),
tot AS (
    SELECT ind, SUM(n5) AS t5, SUM(n1) AS t1, SUM(n_all) AS t_all
    FROM cnt
    GROUP BY ind
),
r AS (
    SELECT c.ind, c.sector33_name, c.n5,
           ROUND(c.n5 / t.t5 * 100, 1)                                   AS share5,
           ROUND(c.n_all / t.t_all * 100, 1)                             AS share_all,
           ROUND((c.n5 / t.t5) / (c.n_all / t.t_all), 2)                 AS ratio5,
           ROUND((c.n1 / t.t1) / (c.n_all / t.t_all), 2)                 AS ratio1,
           ROW_NUMBER() OVER (PARTITION BY c.ind
                              ORDER BY (c.n5 / t.t5) / (c.n_all / t.t_all) DESC) AS rk
    FROM cnt c
    JOIN tot t ON t.ind = c.ind
    WHERE c.n_all / t.t_all >= 0.01
)
SELECT ind, sector33_name, n5, share5, share_all, ratio5, ratio1
FROM r
WHERE rk <= 6
ORDER BY ind, rk;


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
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
v AS (
    SELECT 'MBR' AS ind, o.h, o.week_start, o.code, o.sector17_code, o.exr_is, o.mbr AS x
    FROM obs o WHERE o.mbr > 0
    UNION ALL
    SELECT 'LDTC', o.h, o.week_start, o.code, o.sector17_code, o.exr_is, o.ldtc
    FROM obs o WHERE o.ldtc > 0
    UNION ALL
    SELECT 'DMBR', o.h, o.week_start, o.code, o.sector17_code, o.exr_is, o.dmbr_4w
    FROM obs o WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.h, o.week_start, o.code, o.sector17_code, o.exr_is, o.lchg_4w
    FROM obs o WHERE o.lchg_4w IS NOT NULL
),
gq AS (
    SELECT v.*,
           NTILE(5) OVER (PARTITION BY v.ind, v.h, v.week_start ORDER BY v.x, v.code)                  AS g_global,
           NTILE(5) OVER (PARTITION BY v.ind, v.h, v.week_start, v.sector17_code ORDER BY v.x, v.code) AS g_sec,
           COUNT(*) OVER (PARTITION BY v.ind, v.h, v.week_start, v.sector17_code)                      AS cell_n
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
-- 6. 層別のスプレッド(条件 e・f と、効果がどこに集中するか)
--
-- LAYER:
--   SIZE  … 時価総額5分位(1=小型)
--   PBR   … PBR3分位(1=低PBR)
--   MOM   … 過去26週リターン3分位(1=負け組)
--   REV   … 過去4週リターン3分位(1=直近で最も下げた)。買い方は逆張りが多いので、
--           買残の増減が「直近の下げ」の言い換えでないかを見る(条件 e)
--   SDTC  … 売残側 DTC の3分位(0=売残ゼロ、1〜3)。買残の重さが
--           「信用残全体の重さ」の言い換えでないかを見る(条件 f)
--   MBR3  … 買残割合の3分位(0=買残ゼロ、1〜3)。DMBR・LCHG・LDTC のみ。
--           増減の効果が「もともと買残が多い銘柄」の言い換えでないかを見る
-- 各層の中で指標の5分位を切り直し、群5−群1 を出す。
--
-- 読み方:
--   ・全層で向きが同じなら、その層の言い換えではない。1つの層だけで出ていたら、その層の性質を拾っている疑い。
--   ・層の中の銘柄数が少ないので、N_WEEKS と T 値を必ず一緒に見る。1層ずつの t 値は
--     全体より小さくなるのが普通で、「層ごとに有意か」ではなく「向きが揃うか」を見る。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
),
v AS (
    SELECT 'MBR' AS ind, o.h, o.week_start, o.code, o.exr_is, o.mbr AS x,
           o.size_q, o.pbr_q, o.mom_q, o.rev_q, o.sdtc_q, o.mbr_q
    FROM obs o WHERE o.mbr > 0
    UNION ALL
    SELECT 'LDTC', o.h, o.week_start, o.code, o.exr_is, o.ldtc,
           o.size_q, o.pbr_q, o.mom_q, o.rev_q, o.sdtc_q, o.mbr_q
    FROM obs o WHERE o.ldtc > 0
    UNION ALL
    SELECT 'DMBR', o.h, o.week_start, o.code, o.exr_is, o.dmbr_4w,
           o.size_q, o.pbr_q, o.mom_q, o.rev_q, o.sdtc_q, o.mbr_q
    FROM obs o WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.h, o.week_start, o.code, o.exr_is, o.lchg_4w,
           o.size_q, o.pbr_q, o.mom_q, o.rev_q, o.sdtc_q, o.mbr_q
    FROM obs o WHERE o.lchg_4w IS NOT NULL
),
lay AS (
    SELECT ind, h, week_start, code, exr_is, x, 'SIZE' AS layer, size_q AS lv FROM v WHERE size_q IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, code, exr_is, x, 'PBR',  pbr_q  FROM v WHERE pbr_q  IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, code, exr_is, x, 'MOM',  mom_q  FROM v WHERE mom_q  IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, code, exr_is, x, 'REV',  rev_q  FROM v WHERE rev_q  IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, code, exr_is, x, 'SDTC', sdtc_q FROM v WHERE sdtc_q IS NOT NULL
    UNION ALL
    SELECT ind, h, week_start, code, exr_is, x, 'MBR3', mbr_q  FROM v WHERE mbr_q IS NOT NULL AND ind <> 'MBR'
),
gq AS (
    SELECT l.*,
           NTILE(5) OVER (PARTITION BY l.ind, l.h, l.week_start, l.layer, l.lv ORDER BY l.x, l.code) AS g
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
-- 7. 優待クロスの時期を除いたスプレッド(条件 g。3-1 の頑健性確認)
--
-- 3月・9月の権利付最終日の前は、つなぎ売りのために信用売残だけでなく信用買残も一時的に
-- 膨らみ得る(一般信用の買い建てと売り建てを同時に建てる形)。その銘柄は MBR・LDTC・DMBR の
-- 群5に入り、直後の権利落ちで株価が下がる。このパネルのリターンは分割しか調整しておらず
-- 配当・優待落ちを含むので、「群5が負ける」が権利落ちで機械的に作られている可能性がある。
-- (空売り版では DTC は季節性で説明されず、MSR は2割強縮んだ。買残でも同じ確認を置く。)
--
-- 確かめ方: 起点の週が 2月後半〜3月 / 8月後半〜9月 のものを除いて 3-1 と同じ計算をする。
-- 3-1 と比べてスプレッドが大きく縮むなら、権利落ちの効果だった。
-- 13週は抽出週の並びの都合で半分ほど消えるので、判定は4週で行い、t値より平均の大きさで比べる。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    -- 重ならない週だけを使う(4週先は4週おき、13週先は13週おき)。
    -- 1週ごとに使うと同じ値動きを何度も数え、独立な観測数を水増しする。
    SELECT 4 AS h, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_4w AS ret, p.exr_ind_4w AS exr_ind, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.wk_idx, p.last_bd, p.code, p.sector17_code, p.sector33_name,
           p.size_q, p.pbr_q, p.mom_q, p.rev_q, p.sdtc_q, p.mbr_q,
           p.mbr, p.ldtc, p.dmbr_4w, p.lchg_4w,
           p.fwd_ret_13w, p.exr_ind_13w, p.exr_is_13w
    FROM xs_long_panel p
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
    -- MBR・LDTC: 群0 = 買残ゼロ、1〜5 = 値がある銘柄の中での週内5分位(5が最大)
    -- DMBR・LCHG: 群0 なし。全体を週内5分位(1 = 最も減った、5 = 最も増えた)
    -- 同値の銘柄は銘柄コード順で割り振る(結果が実行のたびに変わらないように)
    SELECT 'MBR' AS ind, o.*, o.mbr * 100 AS val,
           CASE WHEN o.mbr = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.mbr > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.mbr, o.code) END AS g
    FROM obs_f o
    WHERE o.mbr IS NOT NULL
    UNION ALL
    SELECT 'LDTC', o.*, o.ldtc,
           CASE WHEN o.ldtc = 0 THEN 0
                ELSE NTILE(5) OVER (PARTITION BY o.h, o.week_start,
                                    CASE WHEN o.ldtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY o.ldtc, o.code) END
    FROM obs_f o
    WHERE o.ldtc IS NOT NULL
    UNION ALL
    SELECT 'DMBR', o.*, o.dmbr_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.dmbr_4w, o.code)
    FROM obs_f o
    WHERE o.dmbr_4w IS NOT NULL
    UNION ALL
    SELECT 'LCHG', o.*, o.lchg_4w * 100,
           NTILE(5) OVER (PARTITION BY o.h, o.week_start ORDER BY o.lchg_4w, o.code)
    FROM obs_f o
    WHERE o.lchg_4w IS NOT NULL
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
-- 8. 小売業・銀行業の偏りと、月末の権利確定の影響
--
-- A 全体 / B 小売業を除く / C 小売業・銀行業を除く / D 小売業の中だけで5分位
-- E 起点の週の最終営業日が1〜14日 / F 15日以降(月末の権利確定の直前の週を含む側)
--
-- 読み方: B・C で消えるなら業種の偏りが原因。E が0近く F だけ強いなら月末の権利確定が原因。
-- **13週の抽出週(13週おき)はたまたま全て15日以降に当たるので E が出ない。E/F は4週で読む。**
-- MBR・LDTC・DMBR だけを見る(LCHG は参考なので省く)。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 10 AS min_n FROM dual
),
obs AS (
    SELECT 4 AS h, p.week_start, p.code, p.sector33_name, EXTRACT(DAY FROM p.last_bd) AS dd,
           p.mbr, p.ldtc, p.dmbr_4w, p.exr_is_4w AS exr_is
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 4) = 0
      AND p.exr_is_4w IS NOT NULL
    UNION ALL
    SELECT 13, p.week_start, p.code, p.sector33_name, EXTRACT(DAY FROM p.last_bd),
           p.mbr, p.ldtc, p.dmbr_4w, p.exr_is_13w
    FROM xs_long_panel p
    WHERE MOD(p.wk_idx, 13) = 0
      AND p.exr_is_13w IS NOT NULL
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
    SELECT variant, 'MBR' AS ind, h, week_start, code, exr_is, mbr AS val FROM v WHERE mbr > 0
    UNION ALL
    SELECT variant, 'LDTC', h, week_start, code, exr_is, ldtc FROM v WHERE ldtc > 0
    UNION ALL
    SELECT variant, 'DMBR', h, week_start, code, exr_is, dmbr_4w FROM v WHERE dmbr_4w IS NOT NULL
),
gq AS (
    SELECT x.*,
           NTILE(5) OVER (PARTITION BY x.variant, x.ind, x.h, x.week_start ORDER BY x.val, x.code) AS g
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
