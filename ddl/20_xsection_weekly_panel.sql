--------------------------------------------------------------------------------
-- 銘柄×週の横断面パネル(検証用スナップショット表)
-- 実行ユーザー: GD_JQUANTS
--
-- 【何のための表か】
--   「空売りが多い銘柄は、その後、同業・同規模の銘柄より弱いか」という
--   **横断面(銘柄間の優劣)**の問いを検証する土台。
--   ddl/19 の v_demand_weekly_panel は「週を1行」とする市場全体の時系列で、
--   問いが違う(あちらは TOPIX の方向を当てる問題。5指標とも不合格)。
--   時系列で不合格だったことは、横断面の否定にならない。
--
--   queries/sql/xsection_short_backtest.sql がこの表を使う。
--
-- 【なぜビューでなく表にしたか】
--   約4,000銘柄×約520週=約200万行。行ごとに分割調整・先行リターン・
--   時点整合の突き合わせ(空売り報告・財務情報)を計算するので、ビューにすると
--   検証クエリ1本ごとにこれが全部走る。スナップショットにして使い回す。
--   **日次バッチでは更新されない**。検証をやり直す前に作り直すこと(末尾の手順)。
--
--------------------------------------------------------------------------------
-- 【時点整合: その週の終値の時点で「知り得た」情報だけを使う】
--
--   起点は各週の最終営業日(LAST_BD)の終値。先行リターンはそこから測る。
--
--   空売り残高報告 … 公表日(DISC_DATE) < LAST_BD の報告だけを使う。計算日ではない。
--                    同日公表は大引け時点で使えないとみなして含めない。
--   信用取引残高   … **前週**の申込分を使う(USE_WEEK = 申込週 + 7日)。
--                    週次の申込日(金曜)分の公表は翌週の第2〜3営業日なので、
--                    その週のうちに使えるのは前週分まで。
--                    2026-09-25 申込分から日次になるが、週の最終申込日1件に
--                    畳んでから使うので窓の長さは変わらない(signal_shrt_mult_design の教訓)。
--   財務情報       … 開示日(DISC_DATE) < LAST_BD の最新の開示。時価総額・PBRの計算にだけ使う。
--   業種           … EQUITY_MASTER の現在値。時点の業種ではない。業種変更は稀なので
--                    許容しているが、完全な時点整合ではない。
--
--------------------------------------------------------------------------------
-- 【空売り残高は「報告者ごとの最新」を積み上げる】
--
--   V_EQUITY_SHORT_POSITION_SUM は「銘柄×計算日」で合計したもので、
--   **その計算日に報告した報告者の分しか入っていない**。報告者Aが9/1に1.0%、
--   報告者Bが9/5に0.6%を報告していれば、9/5の行は0.6%で、Aの1.0%は入らない。
--   残高の総量を見るには、報告者ごとに最新の報告を持ち越して合計する必要がある。
--
--   ここでは報告者(SS_NAME / DIC_NAME / FUND_NAME の組)ごとに、
--     有効期間 = 公表日 〜 同じ報告者の次の報告の公表日
--   とし、ただし計算日から SHORT_STALE_DAYS(180日)を過ぎたら失効させる。
--   0.5%を割ると報告義務が切れて更新されなくなるため(大量保有と同じ「古い報告が
--   居座る」構造)。0.5%未満の報告(残高減少の最終報告)はそれ自体を合計に入れず、
--   前の報告を打ち切る役だけを持たせる。
--
--   副作用: 報告は残高が0.1pt以上動いたときに出るので、**半年以上まったく動かない
--   大口の空売りも失効扱いで落ちる**。180日は demand_signal_detection.sql の
--   short_stale_days と揃えた(階層間で同じテーブルの読み方を変えないため)。
--
--   **SI_RATIO が NULL = 0.5%以上の報告者がいない**。空売りがゼロという意味ではない。
--   検証では「報告なし」を5分位とは別の群として扱う。
--
--   【報告者名の表記ゆれ(2026-09-16 実測)】
--   同じ報告者が全角/半角・大文字/小文字違いで出てくる
--   (ＳＭＢＣ日興証券株式会社 / SMBC日興証券株式会社 = 4,063件・300銘柄、
--    REGULUS MASTER FUND / Regulus Master Fund = 398件 ほか計7組)。
--   表記が変わった報告は前の報告を打ち切れず、180日間二重に数えてしまう。
--   報告者のキーは UPPER(TO_SINGLE_BYTE(...)) でそろえる(SS/DIC/FUND の3つとも)。
--
--   【個人の報告は使わない(2026-09-16 決定)】
--   SS_NAME='個人' は 20,111件・610銘柄あり、住所も全件空欄で個人を区別できない。
--   名前でキーを作ると別人の報告が前の報告を打ち切る(過小)。
--   各報告の「直近計算年月日・直近割合」(PREV_RPT_DATE / PREV_RPT_RATIO)で前の報告を
--   探してつなぐ方法を試したが、前回情報のある17,998件のうち2,404件(13%)で前の報告が
--   見つからず、そのうち2,401件は取込期間の中だった。内訳は
--     同じ日に別の割合の個人報告だけある 727 / 同じ日に機関の報告だけ 481 /
--     前後7日に個人報告がある 749 / 近くに何も無い 447
--   で、丸めの差(0.01pt未満)は0件、時期の偏りも無かった。条件を緩めても
--   少なくとも1,655件は直せず、つなげなかった報告は180日間二重に数えてしまう。
--   **SI_RATIO は機関(個人以外)だけの合計**とする。群0「報告なし」には
--   「個人の報告しかない銘柄」も入る。
--
--------------------------------------------------------------------------------
-- 【分割調整と時価総額】
--
--   CUM_ADJ = その週より後の週に付いた ADJ_FACTOR の累積積(PROJECT.md 9章(1)と同じ考え方を週単位で)。
--   ADJ_CLOSE = CLOSE_PX × CUM_ADJ。先行リターン・モメンタムはこれで測る。
--
--   発行済株式数は財務情報の期末値(SH_OUT_FY)しか無く、期末から後に分割があると
--   株数が古いまま残る(SHIFT: 2022年 1,781万株 → 2026年 2億6,750万株)。
--   そのため期末週の累積係数 CUM_ADJ_E で補正する:
--     その週の株数 = SH_OUT_FY × CUM_ADJ(その週) / CUM_ADJ_E
--   期末週に株価の行が無い銘柄(期末が取得期間より前など)は時価総額が NULL になる。
--
--------------------------------------------------------------------------------
-- 【先行リターンと上場廃止】
--
--   FWD_RET_4W / 13W = その週から4週/13週先までに付いた最後の終値へのリターン(%)。
--   **上場廃止で途切れた銘柄は、最後の終値までのリターン**を入れ、DELIST_4W/13W='Y' を付ける。
--   J-Quants には上場廃止時の清算価値が無いので、倒産銘柄の損失は過小に出る。
--   ただし上場廃止銘柄を落とすと、空売りが多く後に消えた銘柄が抜けて
--   「空売りが多くても大丈夫だった」側に偏るので、落とさずに残す。
--   直近の週(4週/13週先がまだ来ていない)は NULL。
--
--------------------------------------------------------------------------------
-- 【比較対象(ベースライン)は業種内・規模内の相対リターン】
--
--   市場全体が上がった分は全銘柄に等しく乗るので、それを引かないと
--   「上昇相場だった」がまた効いてしまう(regime_bias_limits)。
--
--   EXR_IND_*  … 同じ週・同じ33業種の等ウェイト平均との差
--   EXR_IS_*   … 同じ週・同じ17業種 × 同じ時価総額5分位 の等ウェイト平均との差 ← 主に使う
--   比較相手が MIN_PEERS(5)銘柄未満のセルは NULL。
--   17業種にしたのは、33業種×5分位では1セルの銘柄数が足りないため。
--
--   SIZE_Q(時価総額5分位、1=小型)/ PBR_Q(3分位、1=低PBR)/ MOM_Q(過去26週リターン3分位)は
--   **その週の横断面の中での順位**なので先読みにならない。
--   (時系列の検証では全期間の分位が先読みバイアスになったが、横断面の週内順位は
--    その週に計算できる。ここは時系列版と事情が違う。)
--
--------------------------------------------------------------------------------
-- 【対象銘柄】
--   EQUITY_MASTER(上場廃止銘柄を含む)のうち、33業種コードが '9999'(その他 = ETF・REIT 等)
--   でなく、TOKYO PRO MARKET でないもの。**実行前に下の事前確認 0-1 で '9999' の中身を見ること。**
--   市場区分で絞らないのは、2022年4月の再編前の市場名(市場第一部 等)と、
--   上場廃止銘柄の最終時点の市場名が混ざるため。
--
-- 前提: ddl/01・08・11・13 を実行済みで、取り込みが済んでいること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0. 事前確認(CTAS の前に流す。どれも SELECT のみ)
--------------------------------------------------------------------------------

-- 0-1. 33業種コード '9999' に何が入っているか(ETF・REIT だけであること)
-- SELECT sector33_code, sector33_name, market_name, delisted_flag, COUNT(*) AS n,
--        MIN(co_name) AS sample_name
-- FROM equity_master
-- WHERE sector33_code = '9999' OR sector33_code IS NULL
-- GROUP BY sector33_code, sector33_name, market_name, delisted_flag
-- ORDER BY n DESC;

-- 0-2. 上場廃止銘柄の株価が入っているか(生存者バイアスの確認)
-- SELECT em.delisted_flag, COUNT(DISTINCT em.code) AS codes,
--        COUNT(DISTINCT p.code) AS codes_with_price
-- FROM equity_master em
-- LEFT JOIN equity_price_daily p ON p.code = em.code
-- WHERE NVL(em.sector33_code, '9999') <> '9999'
-- GROUP BY em.delisted_flag;

-- 0-3. 空売り残高報告・財務情報の期間
-- SELECT 'short_position' AS src, MIN(disc_date) AS from_date, MAX(disc_date) AS to_date, COUNT(*) AS n
-- FROM equity_short_position
-- UNION ALL
-- SELECT 'financial_summary', MIN(disc_date), MAX(disc_date), COUNT(*)
-- FROM financial_summary WHERE sh_out_fy > 0
-- UNION ALL
-- SELECT 'margin_interest', MIN(app_date), MAX(app_date), COUNT(*)
-- FROM equity_margin_interest;


--------------------------------------------------------------------------------
-- 1. パネルの作成
--
-- 所要時間の目安: 数分〜十数分(日次株価 約1,000万行の週次集約と窓関数)。
-- 期間を短くして試すなら params.from_date を動かす。
--------------------------------------------------------------------------------
CREATE TABLE xs_weekly_panel AS
WITH params AS (
    SELECT DATE '2016-01-01' AS from_date,        -- パネルの開始(実データは10年ローリングの下限から)
           180               AS short_stale_days, -- 空売り報告の失効日数(demand_signal_detection と同じ)
           5                 AS min_peers         -- 相対リターンの比較相手の最低銘柄数
    FROM dual
),
univ AS (
    SELECT em.code, em.sector17_code, em.sector33_code, em.sector33_name,
           em.market_name, em.delisted_flag
    FROM equity_master em
    WHERE em.sector33_code <> '9999'                        -- NULL もここで落ちる
      AND NVL(em.market_name, '-') <> 'TOKYO PRO MARKET'
),
wk AS (
    -- 営業日のある週の通し番号。先行リターンの「h週先」はこの番号で数える
    SELECT week_start, last_bd,
           ROW_NUMBER() OVER (ORDER BY week_start) AS wk_idx
    FROM (
        SELECT TRUNC(c.calendar_date, 'IW') AS week_start,
               MAX(c.calendar_date)         AS last_bd
        FROM trading_calendar c
        CROSS JOIN params p
        WHERE c.hol_div IN ('1', '2')
          AND c.calendar_date >= ADD_MONTHS(p.from_date, -9)
          AND c.calendar_date <= TRUNC(SYSDATE)
        GROUP BY TRUNC(c.calendar_date, 'IW')
    )
),
mx AS (
    SELECT MAX(wk_idx) AS max_idx FROM wk
),
wpx AS (
    -- 日次 → 週次。終値は週の最後に値が付いた日のもの
    SELECT d.code,
           TRUNC(d.price_date, 'IW')                                   AS week_start,
           MAX(d.close_price) KEEP (DENSE_RANK LAST ORDER BY
               CASE WHEN d.close_price IS NOT NULL THEN d.price_date END NULLS FIRST)
                                                                       AS close_px,
           NVL(EXP(SUM(LN(NULLIF(d.adj_factor, 0)))), 1)               AS wk_factor,
           SUM(d.volume)                                               AS vol_sum,
           COUNT(*)                                                    AS day_cnt
    FROM equity_price_daily d
    JOIN univ u ON u.code = d.code
    CROSS JOIN params p
    WHERE d.price_date >= ADD_MONTHS(p.from_date, -9)
    GROUP BY d.code, TRUNC(d.price_date, 'IW')
),
wadj AS (
    SELECT w.code, w.week_start, w.close_px, w.wk_factor, w.vol_sum, w.day_cnt,
           NVL(EXP(SUM(LN(w.wk_factor)) OVER (
                   PARTITION BY w.code ORDER BY w.week_start
                   ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1) AS cum_adj
    FROM wpx w
),
wp AS (
    SELECT a.code, a.week_start, k.wk_idx, k.last_bd,
           a.close_px, a.cum_adj, a.close_px * a.cum_adj AS adj_close,
           a.wk_factor, a.vol_sum, a.day_cnt
    FROM wadj a
    JOIN wk k ON k.week_start = a.week_start
    WHERE a.close_px IS NOT NULL
),
wf AS (
    SELECT wp.*,
           -- h週先までに付いた最後の終値と、その週番号
           LAST_VALUE(adj_close) OVER (PARTITION BY code ORDER BY wk_idx
                                       RANGE BETWEEN CURRENT ROW AND 4 FOLLOWING)  AS px_f4,
           MAX(wk_idx)           OVER (PARTITION BY code ORDER BY wk_idx
                                       RANGE BETWEEN CURRENT ROW AND 4 FOLLOWING)  AS idx_f4,
           LAST_VALUE(adj_close) OVER (PARTITION BY code ORDER BY wk_idx
                                       RANGE BETWEEN CURRENT ROW AND 13 FOLLOWING) AS px_f13,
           MAX(wk_idx)           OVER (PARTITION BY code ORDER BY wk_idx
                                       RANGE BETWEEN CURRENT ROW AND 13 FOLLOWING) AS idx_f13,
           -- 過去26週(ちょうど26週前に終値があるときだけ使う)
           FIRST_VALUE(adj_close) OVER (PARTITION BY code ORDER BY wk_idx
                                        RANGE BETWEEN 26 PRECEDING AND CURRENT ROW) AS px_b26,
           MIN(wk_idx)            OVER (PARTITION BY code ORDER BY wk_idx
                                        RANGE BETWEEN 26 PRECEDING AND CURRENT ROW) AS idx_b26,
           -- days to cover の分母: 直近4週の1日平均出来高。窓内に分割があれば使わない
           SUM(vol_sum)  OVER (PARTITION BY code ORDER BY wk_idx
                               RANGE BETWEEN 3 PRECEDING AND CURRENT ROW)           AS vol_4w,
           SUM(day_cnt)  OVER (PARTITION BY code ORDER BY wk_idx
                               RANGE BETWEEN 3 PRECEDING AND CURRENT ROW)           AS days_4w,
           EXP(SUM(LN(wk_factor)) OVER (PARTITION BY code ORDER BY wk_idx
                               RANGE BETWEEN 3 PRECEDING AND CURRENT ROW))          AS factor_4w
    FROM wp
),
sp_rpt AS (
    -- 機関(個人以外)。報告者キーは表記ゆれをそろえてから作る。個人を外す理由は冒頭コメント
    SELECT s.code, s.disc_date, s.calc_date, s.shrt_pos_to_so,
           LEAD(s.disc_date) OVER (
               PARTITION BY s.code,
                            UPPER(TO_SINGLE_BYTE(NVL(s.ss_name,   '-'))),
                            UPPER(TO_SINGLE_BYTE(NVL(s.dic_name,  '-'))),
                            UPPER(TO_SINGLE_BYTE(NVL(s.fund_name, '-')))
               ORDER BY s.calc_date, s.disc_date, s.position_id)       AS next_disc
    FROM equity_short_position s
    JOIN univ u ON u.code = s.code
    WHERE NVL(s.ss_name, '-') <> '個人'
),
sp_iv AS (
    SELECT r.code, r.shrt_pos_to_so, r.calc_date,
           r.disc_date                                                 AS valid_from,
           LEAST(NVL(r.next_disc, DATE '9999-12-31'),
                 r.calc_date + p.short_stale_days)                     AS valid_to
    FROM sp_rpt r
    CROSS JOIN params p
    WHERE r.shrt_pos_to_so >= 0.005          -- 0.5%未満の報告は前の報告を打ち切る役だけ(LEAD で済んでいる)
),
sp_wk AS (
    SELECT w.code, w.week_start,
           SUM(i.shrt_pos_to_so)                                       AS si_ratio,
           COUNT(*)                                                    AS si_rpt_cnt,
           MIN(i.calc_date)                                            AS si_oldest_calc
    FROM wp w
    JOIN sp_iv i
      ON i.code = w.code
     AND i.valid_from < w.last_bd          -- 同日公表は大引け時点で使えない
     AND w.last_bd <= i.valid_to           -- 次の報告が同日公表なら、まだ前の報告が有効
    GROUP BY w.code, w.week_start
),
sp_cov AS (
    -- 空売り報告の取得開始から失効日数ぶん経つまでは「報告なし」が本当の報告なしと言えない
    SELECT MIN(s.disc_date) + MAX(p.short_stale_days) AS covered_from
    FROM equity_short_position s
    CROSS JOIN params p
),
mg AS (
    -- 信用残は週の最終申込日1件に畳み、翌週に使う
    SELECT code, app_date, shrt_vol, long_vol, week_start + 7 AS use_week, week_start AS app_week
    FROM (
        SELECT m.code, m.app_date, m.shrt_vol, m.long_vol,
               TRUNC(m.app_date, 'IW')                                 AS week_start,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC)            AS rn
        FROM equity_margin_interest m
        JOIN univ u ON u.code = m.code
        CROSS JOIN params p
        WHERE m.app_date >= ADD_MONTHS(p.from_date, -9)
    )
    WHERE rn = 1
),
fs AS (
    SELECT f.code, f.disc_date, f.cur_per_en, f.sh_out_fy,
           NVL(f.eq, f.nc_eq)                                          AS eq,
           LEAD(f.disc_date) OVER (PARTITION BY f.code
                                   ORDER BY f.disc_date, f.disc_no)    AS next_disc
    FROM financial_summary f
    JOIN univ u ON u.code = f.code
    WHERE f.sh_out_fy > 0
),
base AS (
    SELECT w.week_start, w.wk_idx, w.last_bd, w.code,
           u.sector17_code, u.sector33_code, u.sector33_name, u.market_name, u.delisted_flag,
           w.close_px, w.adj_close,
           -- 時価総額(円)。株数を期末週の累積係数で補正
           w.close_px * f.sh_out_fy * w.cum_adj / NULLIF(ce.cum_adj, 0) AS mcap,
           f.eq,
           CASE WHEN w.idx_b26 = w.wk_idx - 26
                THEN (w.adj_close / w.px_b26 - 1) * 100 END             AS mom_26w,
           CASE WHEN ABS(w.factor_4w - 1) < 0.000001 AND w.days_4w > 0
                THEN w.vol_4w / w.days_4w END                          AS avg_vol_4w,
           CASE WHEN c.covered_from < w.last_bd THEN 'Y' ELSE 'N' END  AS si_covered,
           s.si_ratio, s.si_rpt_cnt, s.si_oldest_calc,
           g.app_date                                                  AS mgn_app_date,
           g.shrt_vol, g.long_vol,
           -- 信用売残 ÷ 申込週時点の発行済株式数
           g.shrt_vol / NULLIF(f.sh_out_fy * ma.cum_adj / NULLIF(ce.cum_adj, 0), 0) AS msr,
           CASE WHEN w.wk_idx + 4  <= x.max_idx THEN (w.px_f4  / w.adj_close - 1) * 100 END AS fwd_ret_4w,
           CASE WHEN w.wk_idx + 13 <= x.max_idx THEN (w.px_f13 / w.adj_close - 1) * 100 END AS fwd_ret_13w,
           CASE WHEN w.wk_idx + 4  <= x.max_idx AND w.idx_f4  < w.wk_idx + 4
                     AND u.delisted_flag = 'Y' THEN 'Y' END            AS delist_4w,
           CASE WHEN w.wk_idx + 13 <= x.max_idx AND w.idx_f13 < w.wk_idx + 13
                     AND u.delisted_flag = 'Y' THEN 'Y' END            AS delist_13w
    FROM wf w
    JOIN univ u  ON u.code = w.code
    CROSS JOIN mx x
    CROSS JOIN sp_cov c
    CROSS JOIN params p
    LEFT JOIN sp_wk s ON s.code = w.code AND s.week_start = w.week_start
    LEFT JOIN mg g    ON g.code = w.code AND g.use_week = w.week_start
    LEFT JOIN wadj ma ON ma.code = g.code AND ma.week_start = g.app_week
    LEFT JOIN fs f
      ON f.code = w.code
     AND f.disc_date < w.last_bd
     AND w.last_bd <= NVL(f.next_disc, DATE '9999-12-31')
    LEFT JOIN wadj ce ON ce.code = f.code AND ce.week_start = TRUNC(f.cur_per_en, 'IW')
    WHERE w.week_start >= p.from_date
),
b2 AS (
    SELECT b.*,
           CASE WHEN b.eq > 0 THEN b.mcap / b.eq END                   AS pbr,
           CASE WHEN b.shrt_vol IS NOT NULL AND b.avg_vol_4w > 0
                THEN b.shrt_vol / b.avg_vol_4w END                     AS dtc
    FROM base b
),
q AS (
    -- 週内の横断面順位(NULL は順位を付けない)
    SELECT b.*,
           CASE WHEN b.mcap IS NOT NULL THEN
               NTILE(5) OVER (PARTITION BY b.week_start,
                              CASE WHEN b.mcap IS NULL THEN 0 ELSE 1 END
                              ORDER BY b.mcap) END                     AS size_q,
           CASE WHEN b.pbr IS NOT NULL THEN
               NTILE(3) OVER (PARTITION BY b.week_start,
                              CASE WHEN b.pbr IS NULL THEN 0 ELSE 1 END
                              ORDER BY b.pbr) END                      AS pbr_q,
           CASE WHEN b.mom_26w IS NOT NULL THEN
               NTILE(3) OVER (PARTITION BY b.week_start,
                              CASE WHEN b.mom_26w IS NULL THEN 0 ELSE 1 END
                              ORDER BY b.mom_26w) END                  AS mom_q
    FROM b2 b
),
ex AS (
    SELECT q.*,
           COUNT(q.fwd_ret_4w)  OVER (PARTITION BY q.week_start, q.sector33_code)  AS peers_ind_4w,
           AVG(q.fwd_ret_4w)    OVER (PARTITION BY q.week_start, q.sector33_code)  AS avg_ind_4w,
           COUNT(q.fwd_ret_13w) OVER (PARTITION BY q.week_start, q.sector33_code)  AS peers_ind_13w,
           AVG(q.fwd_ret_13w)   OVER (PARTITION BY q.week_start, q.sector33_code)  AS avg_ind_13w,
           COUNT(q.fwd_ret_4w)  OVER (PARTITION BY q.week_start, q.sector17_code, q.size_q) AS peers_is_4w,
           AVG(q.fwd_ret_4w)    OVER (PARTITION BY q.week_start, q.sector17_code, q.size_q) AS avg_is_4w,
           COUNT(q.fwd_ret_13w) OVER (PARTITION BY q.week_start, q.sector17_code, q.size_q) AS peers_is_13w,
           AVG(q.fwd_ret_13w)   OVER (PARTITION BY q.week_start, q.sector17_code, q.size_q) AS avg_is_13w
    FROM q
)
SELECT e.week_start, e.wk_idx, e.last_bd, e.code,
       e.sector17_code, e.sector33_code, e.sector33_name, e.market_name, e.delisted_flag,
       e.close_px,
       ROUND(e.adj_close, 4)                                           AS adj_close,
       ROUND(e.mcap / 100000000, 1)                                    AS mcap_oku,
       ROUND(e.pbr, 3)                                                 AS pbr,
       ROUND(e.mom_26w, 2)                                             AS mom_26w,
       ROUND(e.avg_vol_4w)                                             AS avg_vol_4w,
       e.si_covered,
       e.si_ratio, e.si_rpt_cnt, e.si_oldest_calc,
       e.mgn_app_date, e.shrt_vol, e.long_vol,
       ROUND(e.msr, 8)                                                 AS msr,
       ROUND(e.dtc, 4)                                                 AS dtc,
       ROUND(e.fwd_ret_4w, 3)                                          AS fwd_ret_4w,
       ROUND(e.fwd_ret_13w, 3)                                         AS fwd_ret_13w,
       e.delist_4w, e.delist_13w,
       e.size_q, e.pbr_q, e.mom_q,
       CASE WHEN e.peers_ind_4w  >= p.min_peers THEN ROUND(e.fwd_ret_4w  - e.avg_ind_4w,  3) END AS exr_ind_4w,
       CASE WHEN e.peers_ind_13w >= p.min_peers THEN ROUND(e.fwd_ret_13w - e.avg_ind_13w, 3) END AS exr_ind_13w,
       CASE WHEN e.size_q IS NOT NULL AND e.peers_is_4w  >= p.min_peers
            THEN ROUND(e.fwd_ret_4w  - e.avg_is_4w,  3) END            AS exr_is_4w,
       CASE WHEN e.size_q IS NOT NULL AND e.peers_is_13w >= p.min_peers
            THEN ROUND(e.fwd_ret_13w - e.avg_is_13w, 3) END            AS exr_is_13w,
       e.peers_ind_13w, e.peers_is_13w
FROM ex e
CROSS JOIN params p;

CREATE INDEX ix_xs_weekly_panel_wk   ON xs_weekly_panel (week_start);
CREATE INDEX ix_xs_weekly_panel_code ON xs_weekly_panel (code, week_start);

COMMENT ON TABLE xs_weekly_panel IS
  '銘柄×週の横断面パネル(検証用スナップショット。日次バッチでは更新されない。ddl/20)';


--------------------------------------------------------------------------------
-- 2. 作成直後の確認
--------------------------------------------------------------------------------

-- 2-1. 年ごとの充足状況(銘柄数・時価総額・空売り報告・信用残・先行リターンの埋まり具合)
-- SELECT EXTRACT(YEAR FROM week_start)                         AS yr,
--        COUNT(DISTINCT week_start)                            AS weeks,
--        ROUND(COUNT(*) / COUNT(DISTINCT week_start))          AS stocks_per_week,
--        ROUND(COUNT(mcap_oku)    / COUNT(*) * 100, 1)         AS pct_mcap,
--        ROUND(COUNT(CASE WHEN si_covered = 'Y' THEN 1 END) / COUNT(*) * 100, 1) AS pct_si_covered,
--        ROUND(COUNT(si_ratio)    / COUNT(*) * 100, 1)         AS pct_si_reported,
--        ROUND(COUNT(msr)         / COUNT(*) * 100, 1)         AS pct_msr,
--        ROUND(COUNT(exr_is_13w)  / COUNT(*) * 100, 1)         AS pct_exr_is_13w,
--        COUNT(delist_13w)                                     AS n_delist_13w
-- FROM xs_weekly_panel
-- GROUP BY EXTRACT(YEAR FROM week_start)
-- ORDER BY yr;

-- 2-2. 分割補正の検算: SHIFT(3697)の時価総額が分割をまたいで跳ねていないこと
-- SELECT week_start, close_px, mcap_oku, msr, si_ratio
-- FROM xs_weekly_panel
-- WHERE code = '36970'
-- ORDER BY week_start;

-- 2-3. 相対リターンの平均が週ごとにほぼ0であること(定義上そうなるはず)
-- SELECT ROUND(AVG(exr_ind_13w), 4) AS avg_exr_ind,
--        ROUND(AVG(exr_is_13w), 4)  AS avg_exr_is
-- FROM xs_weekly_panel;


--------------------------------------------------------------------------------
-- 3. 作り直し(検証をやり直す前に)
--
-- 表を消してから 1 をもう一度流す。インデックスも一緒に消える。
--   DROP TABLE xs_weekly_panel PURGE;
-- CLAUDE_RO のシノニムは表を作り直しても残るが、GRANT は消えるので 4-1 を流し直す。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 4. CLAUDE_RO への権限付与
--
-- 4-1 を GD_JQUANTS で、4-2 を CLAUDE_RO で接続し直して実行する。
-- **一気に流すと 4-2 で ORA-01471 になる**(GD_JQUANTS は同名の実体を持つため)。
--------------------------------------------------------------------------------

-- 4-1. GD_JQUANTS で実行
-- GRANT SELECT ON gd_jquants.xs_weekly_panel TO claude_ro;

-- 4-2. CLAUDE_RO で接続し直して実行(初回だけ)
-- SELECT USER AS connected_as FROM dual;   -- CLAUDE_RO であること
-- CREATE SYNONYM xs_weekly_panel FOR gd_jquants.xs_weekly_panel;
