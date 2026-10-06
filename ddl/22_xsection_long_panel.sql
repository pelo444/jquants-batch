--------------------------------------------------------------------------------
-- 信用買残の横断面パネル(検証用スナップショット表)
-- 実行ユーザー: GD_JQUANTS
--
-- 【何のための表か】
--   「信用買残が重い・増えている銘柄は、その後、同業・同規模の銘柄より強いか弱いか」という
--   横断面(銘柄間の優劣)の問いを検証する土台。空売り側の検証(ddl/20 の xs_weekly_panel と
--   xsection_short_backtest.sql)の買い版。
--   queries/sql/xsection_long_backtest.sql がこの表を使う。
--
-- 【ddl/20 を作り直さず、別の表にした理由】
--   xs_weekly_panel は適用済みで、日次株価の週次集約と分割調整に時間がかかる。
--   買残の指標に必要な材料(買残株数・終値・時価総額・平均出来高・累積調整係数・先行リターン・
--   相対リターン)は xs_weekly_panel に全部ある。ここでは同じ銘柄の前週・4週前・5週前の行を
--   自己結合して指標を足すだけなので、数分で済む。
--   ddl/20 は書き換えない(directory_conventions)。
--
--   **前提: xs_weekly_panel が最新であること。** あちらは日次バッチで更新されない。
--   パネルを作り直したら、この表も作り直す(末尾 3)。
--
--------------------------------------------------------------------------------
-- 【時点整合】
--
--   xs_weekly_panel の LONG_VOL は「前週の申込分」(ddl/20: USE_WEEK = 申込週 + 7)。
--   行 c(週 t)の買残は、申込週 t-1 のもの。この表ではその申込週の行を a と呼ぶ。
--
--     a  = 同じ銘柄の週 t-1 の行(買残の申込週。終値・時価総額・平均出来高をここから取る)
--     b  = 同じ銘柄の週 t-4 の行(その LONG_VOL は申込週 t-5 のもの。4週前の買残)
--     ab = 同じ銘柄の週 t-5 の行(申込週 t-5。b の買残に対応する終値・時価総額・調整係数)
--
--   a や ab の行が無い銘柄・週(その週に株価が1日も付かなかった等)は、その指標が NULL になる。
--   GW・年末年始など信用残が公表されない週も、NULL のまま(0で埋めない。demand_data_seasonality)。
--
-- 【指標】
--
--   MBR     = c.LONG_VOL × a.CLOSE_PX ÷ (a.MCAP_OKU × 1億)
--             買残の時価 ÷ 時価総額。買残株数 ÷ 発行済株式数と同じ。
--             信用残は分割の遡及調整が無く、買残株数も終値も「その週の素のまま」なので、
--             同じ申込週の素の終値と時価総額で割れば、分割をまたいでも調整が要らない。
--             MCAP_OKU は0.1億円単位に丸めてある(誤差は時価総額10億円で最大0.5%程度)。
--   LDTC    = c.LONG_VOL ÷ a.AVG_VOL_4W
--             買残 ÷ 直近4週の1日平均出来高(日数)。AVG_VOL_4W は4週の窓内に分割があれば
--             NULL(ddl/20)。a の週の値を使うので、買残と出来高が同じ株数の単位で割れる。
--   DMBR_4W = MBR(申込週 t-1) − MBR(申込週 t-5)    単位は割合(0.01 = 1pt)
--             買残の増減。分母が時価総額なので、株数の変化がなくても株価が動けば動く。
--             これは意図したもの(発行済株式に対する買残の割合ではなく、時価の割合)。
--             ただし発行済株式数は期末値なので、期中の増資では分母が古いまま残る。
--   LCHG_4W = (買残株数 ÷ 累積調整係数)の4週間の増加率(参考)
--             累積調整係数 = ADJ_CLOSE ÷ CLOSE_PX(株式分割で買残株数が変わった分を消す)。
--             4週前の MBR が 0.1% 未満のときは NULL(基数が小さいと率が暴れる)。
--   RET_4W_PAST = 過去4週の調整後リターン(%)。買い方は逆張りが多いので、買残の増減が
--             「直近の下げ」の言い換えでないかを見る層(REV_Q)に使う。
--
--   MBR_Q / SDTC_Q = 週内の3分位(0 = 残高ゼロ、1〜3、3が最大)。SDTC_Q は売残側 DTC(ddl/20 の DTC)。
--   REV_Q = 週内の過去4週リターン3分位(1 = 直近で最も下げた)。
--   いずれも「その週の横断面の中での順位」なので先読みにならない。
--   同値は銘柄コード順に割り振る(再現性のため)。
--
-- 前提: ddl/20 を実行済みで、xs_weekly_panel があること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0. 事前確認(CTAS の前に流す。どれも SELECT のみ)
--------------------------------------------------------------------------------

-- 0-1. xs_weekly_panel の期間と、買残・時価総額・平均出来高の埋まり具合
-- SELECT MIN(week_start) AS from_week, MAX(week_start) AS to_week, COUNT(*) AS n,
--        ROUND(COUNT(long_vol)   / COUNT(*) * 100, 1) AS pct_long,
--        ROUND(COUNT(mcap_oku)   / COUNT(*) * 100, 1) AS pct_mcap,
--        ROUND(COUNT(avg_vol_4w) / COUNT(*) * 100, 1) AS pct_avgvol
-- FROM xs_weekly_panel;


--------------------------------------------------------------------------------
-- 1. パネルの作成
--
-- 所要時間の目安: 数分(約200万行の自己結合4回。(code, week_start) のインデックスが効く)。
--------------------------------------------------------------------------------
CREATE TABLE xs_long_panel AS
WITH j AS (
    SELECT c.week_start, c.wk_idx, c.last_bd, c.code,
           c.sector17_code, c.sector33_name, c.delisted_flag,
           c.mcap_oku, c.pbr, c.mom_26w, c.dtc AS shrt_dtc,
           c.size_q, c.pbr_q, c.mom_q,
           c.fwd_ret_4w, c.fwd_ret_13w, c.delist_4w, c.delist_13w,
           c.exr_ind_4w, c.exr_ind_13w, c.exr_is_4w, c.exr_is_13w,
           c.mgn_app_date, c.long_vol, c.shrt_vol,
           CASE WHEN b.adj_close > 0
                THEN (c.adj_close / b.adj_close - 1) * 100 END                      AS ret_4w_past,
           c.long_vol * a.close_px   / NULLIF(a.mcap_oku  * 100000000, 0)           AS mbr,
           b.long_vol * ab.close_px  / NULLIF(ab.mcap_oku * 100000000, 0)           AS mbr_b,
           c.long_vol / NULLIF(a.avg_vol_4w, 0)                                     AS ldtc,
           (c.long_vol / NULLIF(a.adj_close  / NULLIF(a.close_px,  0), 0))
             / NULLIF(b.long_vol / NULLIF(ab.adj_close / NULLIF(ab.close_px, 0), 0), 0) AS lratio_4w
    FROM xs_weekly_panel c
    LEFT JOIN xs_weekly_panel a  ON a.code  = c.code AND a.week_start  = c.week_start - 7
    LEFT JOIN xs_weekly_panel b  ON b.code  = c.code AND b.week_start  = c.week_start - 28
    LEFT JOIN xs_weekly_panel ab ON ab.code = c.code AND ab.week_start = c.week_start - 35
),
k AS (
    SELECT j.*,
           CASE WHEN j.mbr IS NOT NULL AND j.mbr_b IS NOT NULL
                THEN j.mbr - j.mbr_b END                                            AS dmbr_4w,
           CASE WHEN j.mbr_b >= 0.001 AND j.lratio_4w IS NOT NULL
                THEN j.lratio_4w - 1 END                                            AS lchg_4w
    FROM j
),
q AS (
    SELECT k.*,
           CASE WHEN k.mbr IS NULL THEN NULL
                WHEN k.mbr = 0 THEN 0
                ELSE NTILE(3) OVER (PARTITION BY k.week_start,
                                    CASE WHEN k.mbr > 0 THEN 1 ELSE 0 END
                                    ORDER BY k.mbr, k.code) END                     AS mbr_q,
           CASE WHEN k.shrt_dtc IS NULL THEN NULL
                WHEN k.shrt_dtc = 0 THEN 0
                ELSE NTILE(3) OVER (PARTITION BY k.week_start,
                                    CASE WHEN k.shrt_dtc > 0 THEN 1 ELSE 0 END
                                    ORDER BY k.shrt_dtc, k.code) END                AS sdtc_q,
           CASE WHEN k.ret_4w_past IS NULL THEN NULL
                ELSE NTILE(3) OVER (PARTITION BY k.week_start,
                                    CASE WHEN k.ret_4w_past IS NULL THEN 0 ELSE 1 END
                                    ORDER BY k.ret_4w_past, k.code) END             AS rev_q
    FROM k
)
SELECT q.week_start, q.wk_idx, q.last_bd, q.code,
       q.sector17_code, q.sector33_name, q.delisted_flag,
       q.mcap_oku, q.pbr, q.mom_26w, q.shrt_dtc,
       q.size_q, q.pbr_q, q.mom_q, q.rev_q, q.sdtc_q, q.mbr_q,
       q.fwd_ret_4w, q.fwd_ret_13w, q.delist_4w, q.delist_13w,
       q.exr_ind_4w, q.exr_ind_13w, q.exr_is_4w, q.exr_is_13w,
       q.mgn_app_date, q.long_vol, q.shrt_vol,
       ROUND(q.ret_4w_past, 3)                                                      AS ret_4w_past,
       ROUND(q.mbr, 8)                                                              AS mbr,
       ROUND(q.ldtc, 4)                                                             AS ldtc,
       ROUND(q.dmbr_4w, 8)                                                          AS dmbr_4w,
       ROUND(q.lchg_4w, 6)                                                          AS lchg_4w
FROM q;

CREATE INDEX ix_xs_long_panel_wk   ON xs_long_panel (week_start);
CREATE INDEX ix_xs_long_panel_code ON xs_long_panel (code, week_start);

COMMENT ON TABLE xs_long_panel IS
  '銘柄×週の信用買残の横断面パネル(検証用スナップショット。xs_weekly_panel から作る。日次バッチでは更新されない。ddl/22)';


--------------------------------------------------------------------------------
-- 2. 作成直後の確認
--------------------------------------------------------------------------------

-- 2-1. 行数が xs_weekly_panel と一致すること(自己結合で行が増減していない)
-- SELECT (SELECT COUNT(*) FROM xs_weekly_panel) AS n_base,
--        (SELECT COUNT(*) FROM xs_long_panel)   AS n_long
-- FROM dual;

-- 2-2. 年ごとの充足状況
--      queries/sql/xsection_long_backtest.sql の 0-1 と同じ。

-- 2-3. 分割調整の検算: 分割をまたぐ4週間で、買残株数の「素の増加率」は大きく動くが、
--      LCHG_4W(調整後)と DMBR_4W は動かないこと。
--      2022-2025年、累積調整係数が4週間で5%以上動いた行の中央値で比べる。
--      検証済み(2026-10-03、プロトタイプ): 素の増加率の中央値 +132% / 調整後 -3.3%(2,746行)。
-- SELECT COUNT(*) AS n_split_rows,
--        ROUND(MEDIAN(c.long_vol / NULLIF(b.long_vol, 0) - 1), 3) AS med_raw_chg,
--        ROUND(MEDIAN(c.lchg_4w), 3)                              AS med_adj_chg,
--        ROUND(MEDIAN(ABS(c.dmbr_4w)) * 100, 4)                   AS med_abs_dmbr_pt
-- FROM xs_long_panel c
-- JOIN xs_weekly_panel a  ON a.code  = c.code AND a.week_start  = c.week_start - 7
-- JOIN xs_weekly_panel ab ON ab.code = c.code AND ab.week_start = c.week_start - 35
-- JOIN xs_weekly_panel b  ON b.code  = c.code AND b.week_start  = c.week_start - 28
-- WHERE c.week_start >= DATE '2022-01-01' AND c.week_start < DATE '2026-01-01'
--   AND b.long_vol > 0
--   AND ABS((a.adj_close / a.close_px) / NULLIF(ab.adj_close / ab.close_px, 0) - 1) > 0.05;

-- 2-4. SHIFT(3697)など分割のあった銘柄で、MBR が分割で跳ねていないこと
-- SELECT week_start, long_vol, ROUND(mbr * 100, 3) AS mbr_pct, ROUND(dmbr_4w * 100, 3) AS dmbr_pt, lchg_4w
-- FROM xs_long_panel
-- WHERE code = '36970'
-- ORDER BY week_start;


--------------------------------------------------------------------------------
-- 3. 作り直し(xs_weekly_panel を作り直した後、または検証をやり直す前に)
--
-- 表を消してから 1 をもう一度流す。インデックスも一緒に消える。
--   DROP TABLE xs_long_panel PURGE;
-- CLAUDE_RO のシノニムは表を作り直しても残るが、GRANT は消えるので 4-1 を流し直す。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 4. CLAUDE_RO への権限付与
--
-- 4-1 を GD_JQUANTS で、4-2 を CLAUDE_RO で接続し直して実行する。
-- **一気に流すと 4-2 で ORA-01471 になる**(GD_JQUANTS は同名の実体を持つため)。
-- 新しいテーブルを作ったので、忘れると Claude Desktop 側から ORA-00942 になる。
--------------------------------------------------------------------------------

-- 4-1. GD_JQUANTS で実行
-- GRANT SELECT ON gd_jquants.xs_long_panel TO claude_ro;

-- 4-2. CLAUDE_RO で接続し直して実行(初回だけ)
-- SELECT USER AS connected_as FROM dual;   -- CLAUDE_RO であること
-- CREATE SYNONYM xs_long_panel FOR gd_jquants.xs_long_panel;
