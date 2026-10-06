--------------------------------------------------------------------------------
-- 相対モメンタムの横断面パネル(検証用スナップショット表)
-- 実行ユーザー: GD_JQUANTS
--
-- 【何のための表か】
--   「過去の騰落率が上位の銘柄は、その後、同業・同規模の銘柄より強いか」という
--   横断面(銘柄間の優劣)の問いを検証する土台。数週間〜1・2か月の売買判断の材料として、
--   個人投資家が最も多く使う「相対的な強さ」を、これまでの需給系の検証と同じ型で測る。
--   queries/sql/xsection_momentum_backtest.sql がこの表を使う。
--
-- 【ddl/20 を作り直さず、別の表にした理由】
--   xs_long_panel(ddl/22)と同じ。xs_weekly_panel に終値・先行リターン・相対リターン・
--   時価総額・出来高が揃っているので、同じ銘柄の過去の行をウィンドウ関数で引くだけで済む。
--   **前提: xs_weekly_panel が最新であること。** パネルを作り直したらこの表も作り直す。
--
-- 【指標の定義(結果を見る前に固定)】
--   adj_close は分割調整後の週末終値(ddl/20)。h週前は wk_idx - h の行。
--   ちょうどその週に行が無い銘柄は NULL(補間しない)。
--
--   MOM_12_1 = (4週前の終値 ÷ 52週前の終値 - 1) × 100   ← 判定に使う本命
--   MOM_6_1  = (4週前の終値 ÷ 26週前の終値 - 1) × 100   ← 判定に使う
--     直近4週を飛ばす(skip)のは、1か月以内の騰落は逆戻りしやすい(短期リバーサル)ため。
--     飛ばさないと、中期の勢いと直近の反転が混ざって打ち消し合う。
--   RET_4W_PAST  = 過去4週リターン。MOM に含めない直近分。リバーサルの層別(REV_Q)に使う
--   RET_1W_PAST  = 過去1週リターン。短期リバーサルの参考(判定に使わない)
--   RET_13W_PAST = 過去13週リターン。地合い別(上昇・下落局面)に分けるための市場平均の材料
--   IND_MOM_12_1 / IND_MOM_6_1 = 同じ週・同じ17業種の MOM の等ウェイト平均(5銘柄未満は NULL)
--     業種モメンタム。EXR_IS は同業種の平均を引いてあるので、業種の勢いは EXR_IS に出ない。
--     業種ローテーション(強い業種を買う)の効果は EXR_MKT 側で見る。
--
--   ランク(五分位)はこの表に持たない。週内の順位はバックテストSQLで付ける。
--
-- 【先行リターンと相対リターン】
--   FWD_RET_4W/13W と EXR_IS/EXR_IND は ddl/20 のコピー。
--   FWD_RET_8W と EXR_IS_8W はここで足した(1〜2か月 = 4〜8週に合わせる)。作り方は ddl/20 と同じ:
--     8週先までに付いた最後の終値へのリターン。上場廃止で途切れたら最後の終値まで(DELIST_8W='Y')。
--     EXR_IS_8W = 自分 - 同じ週・同じ17業種×同じ時価総額5分位の等ウェイト平均(5銘柄未満は NULL)
--   EXR_MKT_* = 自分 - 同じ週の全銘柄の等ウェイト平均(業種・規模を引かない。業種モメンタムを含む)
--
--   TURNOVER_OKU = 直近4週の1日平均売買代金(億円/日) = AVG_VOL_4W × 終値 ÷ 1億。
--     4週の窓内に分割があれば NULL(ddl/20)。流動性の下限を付けた確認に使う。
--
-- 前提: ddl/20 を実行済みで、xs_weekly_panel があること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 0. 事前確認
--------------------------------------------------------------------------------

-- 0-1. xs_weekly_panel の週番号が欠けなく連続していること(ウィンドウの RANGE は週番号で数える)
-- SELECT MIN(wk_idx) AS min_idx, MAX(wk_idx) AS max_idx, COUNT(DISTINCT wk_idx) AS n_idx
-- FROM xs_weekly_panel;
-- 期待: max_idx - min_idx + 1 = n_idx


--------------------------------------------------------------------------------
-- 1. パネルの作成
--
-- 所要時間の目安: 数分(約200万行のウィンドウ関数)。
--------------------------------------------------------------------------------
CREATE TABLE xs_mom_panel AS
WITH w AS (
    SELECT p.week_start, p.wk_idx, p.last_bd, p.code,
           p.sector17_code, p.sector33_name, p.delisted_flag,
           p.close_px, p.adj_close, p.mcap_oku, p.pbr, p.avg_vol_4w, p.size_q, p.pbr_q,
           p.fwd_ret_4w, p.fwd_ret_13w, p.delist_4w, p.delist_13w,
           p.exr_ind_4w, p.exr_ind_13w, p.exr_is_4w, p.exr_is_13w,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 1  PRECEDING AND 1  PRECEDING) AS px_b1,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 4  PRECEDING AND 4  PRECEDING) AS px_b4,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 13 PRECEDING AND 13 PRECEDING) AS px_b13,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 26 PRECEDING AND 26 PRECEDING) AS px_b26,
           MAX(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN 52 PRECEDING AND 52 PRECEDING) AS px_b52,
           LAST_VALUE(p.adj_close) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN CURRENT ROW AND 8 FOLLOWING)   AS px_f8,
           MAX(p.wk_idx) OVER (PARTITION BY p.code ORDER BY p.wk_idx
                                  RANGE BETWEEN CURRENT ROW AND 8 FOLLOWING)   AS idx_f8
    FROM xs_weekly_panel p
),
mx AS (
    SELECT MAX(wk_idx) AS max_idx FROM xs_weekly_panel
),
m AS (
    SELECT w.*,
           CASE WHEN w.px_b52 > 0 AND w.px_b4 > 0 THEN (w.px_b4 / w.px_b52 - 1) * 100 END AS mom_12_1,
           CASE WHEN w.px_b26 > 0 AND w.px_b4 > 0 THEN (w.px_b4 / w.px_b26 - 1) * 100 END AS mom_6_1,
           CASE WHEN w.px_b4  > 0 THEN (w.adj_close / w.px_b4  - 1) * 100 END             AS ret_4w_past,
           CASE WHEN w.px_b1  > 0 THEN (w.adj_close / w.px_b1  - 1) * 100 END             AS ret_1w_past,
           CASE WHEN w.px_b13 > 0 THEN (w.adj_close / w.px_b13 - 1) * 100 END             AS ret_13w_past,
           CASE WHEN w.wk_idx + 8 <= x.max_idx
                THEN (w.px_f8 / w.adj_close - 1) * 100 END                                AS fwd_ret_8w,
           CASE WHEN w.wk_idx + 8 <= x.max_idx AND w.idx_f8 < w.wk_idx + 8
                     AND w.delisted_flag = 'Y' THEN 'Y' END                               AS delist_8w,
           CASE WHEN w.avg_vol_4w > 0
                THEN w.avg_vol_4w * w.close_px / 100000000 END                            AS turnover_oku
    FROM w
    CROSS JOIN mx x
),
ex AS (
    SELECT m.*,
           COUNT(m.fwd_ret_8w)  OVER (PARTITION BY m.week_start, m.sector17_code, m.size_q) AS peers_is_8w,
           AVG(m.fwd_ret_8w)    OVER (PARTITION BY m.week_start, m.sector17_code, m.size_q) AS avg_is_8w,
           AVG(m.fwd_ret_4w)    OVER (PARTITION BY m.week_start)                            AS avg_mkt_4w,
           AVG(m.fwd_ret_8w)    OVER (PARTITION BY m.week_start)                            AS avg_mkt_8w,
           AVG(m.fwd_ret_13w)   OVER (PARTITION BY m.week_start)                            AS avg_mkt_13w,
           AVG(m.ret_13w_past)  OVER (PARTITION BY m.week_start)                            AS mkt_ret_13w_past,
           COUNT(m.mom_12_1)    OVER (PARTITION BY m.week_start, m.sector17_code)           AS ind_n_12_1,
           AVG(m.mom_12_1)      OVER (PARTITION BY m.week_start, m.sector17_code)           AS ind_avg_12_1,
           COUNT(m.mom_6_1)     OVER (PARTITION BY m.week_start, m.sector17_code)           AS ind_n_6_1,
           AVG(m.mom_6_1)       OVER (PARTITION BY m.week_start, m.sector17_code)           AS ind_avg_6_1
    FROM m
)
SELECT e.week_start, e.wk_idx, e.last_bd, e.code,
       e.sector17_code, e.sector33_name, e.delisted_flag,
       e.close_px,
       e.mcap_oku, e.pbr, e.size_q, e.pbr_q,
       ROUND(e.turnover_oku, 4)                                        AS turnover_oku,
       ROUND(e.mom_12_1, 3)                                            AS mom_12_1,
       ROUND(e.mom_6_1, 3)                                             AS mom_6_1,
       ROUND(e.ret_4w_past, 3)                                         AS ret_4w_past,
       ROUND(e.ret_1w_past, 3)                                         AS ret_1w_past,
       ROUND(e.ret_13w_past, 3)                                        AS ret_13w_past,
       ROUND(e.mkt_ret_13w_past, 3)                                    AS mkt_ret_13w_past,
       CASE WHEN e.ind_n_12_1 >= 5 THEN ROUND(e.ind_avg_12_1, 3) END   AS ind_mom_12_1,
       CASE WHEN e.ind_n_6_1  >= 5 THEN ROUND(e.ind_avg_6_1, 3) END    AS ind_mom_6_1,
       e.fwd_ret_4w, ROUND(e.fwd_ret_8w, 3) AS fwd_ret_8w, e.fwd_ret_13w,
       e.delist_4w, e.delist_8w, e.delist_13w,
       e.exr_ind_4w, e.exr_ind_13w,
       e.exr_is_4w,
       CASE WHEN e.size_q IS NOT NULL AND e.peers_is_8w >= 5
            THEN ROUND(e.fwd_ret_8w - e.avg_is_8w, 3) END              AS exr_is_8w,
       e.exr_is_13w,
       ROUND(e.fwd_ret_4w  - e.avg_mkt_4w,  3)                         AS exr_mkt_4w,
       ROUND(e.fwd_ret_8w  - e.avg_mkt_8w,  3)                         AS exr_mkt_8w,
       ROUND(e.fwd_ret_13w - e.avg_mkt_13w, 3)                         AS exr_mkt_13w
FROM ex e;

CREATE INDEX ix_xs_mom_panel_wk   ON xs_mom_panel (week_start);
CREATE INDEX ix_xs_mom_panel_code ON xs_mom_panel (code, week_start);

COMMENT ON TABLE xs_mom_panel IS
  '銘柄×週の相対モメンタム横断面パネル(検証用スナップショット。xs_weekly_panel から作る。日次バッチでは更新されない。ddl/24)';

COMMENT ON COLUMN xs_mom_panel.week_start       IS '週の起点(月曜)。情報はこの週の最終営業日の終値時点で知り得たものだけ';
COMMENT ON COLUMN xs_mom_panel.wk_idx           IS '営業日のある週の通し番号。重ならない標本は MOD(wk_idx,4)=0・MOD(wk_idx,8)=0・MOD(wk_idx,13)=0';
COMMENT ON COLUMN xs_mom_panel.last_bd          IS 'その週の最終営業日';
COMMENT ON COLUMN xs_mom_panel.code             IS '銘柄コード(5桁)';
COMMENT ON COLUMN xs_mom_panel.sector17_code    IS '17業種コード(現在値)';
COMMENT ON COLUMN xs_mom_panel.sector33_name    IS '33業種名(現在値)';
COMMENT ON COLUMN xs_mom_panel.delisted_flag    IS '上場廃止フラグ(Y/N)';
COMMENT ON COLUMN xs_mom_panel.close_px         IS '週末終値(円、分割調整前の素の値)';
COMMENT ON COLUMN xs_mom_panel.mcap_oku         IS '時価総額(億円)';
COMMENT ON COLUMN xs_mom_panel.pbr              IS 'PBR(倍)';
COMMENT ON COLUMN xs_mom_panel.size_q           IS '時価総額の週内5分位(1=小型)';
COMMENT ON COLUMN xs_mom_panel.pbr_q            IS 'PBRの週内3分位(1=低PBR)';
COMMENT ON COLUMN xs_mom_panel.turnover_oku     IS '直近4週の1日平均売買代金(億円/日)。4週の窓内に分割があれば NULL';
COMMENT ON COLUMN xs_mom_panel.mom_12_1         IS '12-1モメンタム(%、調整後)=(4週前終値÷52週前終値-1)×100。直近4週を除く。52週前の行が無ければ NULL';
COMMENT ON COLUMN xs_mom_panel.mom_6_1          IS '6-1モメンタム(%、調整後)=(4週前終値÷26週前終値-1)×100。直近4週を除く';
COMMENT ON COLUMN xs_mom_panel.ret_4w_past      IS '過去4週リターン(%、調整後)。MOM に含めない直近分。短期リバーサルの層別(REV)に使う';
COMMENT ON COLUMN xs_mom_panel.ret_1w_past      IS '過去1週リターン(%、調整後)。短期リバーサルの参考(xsection_reversal_backtest.sql)';
COMMENT ON COLUMN xs_mom_panel.ret_13w_past     IS '過去13週リターン(%、調整後)';
COMMENT ON COLUMN xs_mom_panel.mkt_ret_13w_past IS '同じ週の全銘柄の過去13週リターンの等ウェイト平均(%)。地合い別(上昇・下落局面)の判定に使う';
COMMENT ON COLUMN xs_mom_panel.ind_mom_12_1     IS '同じ週・同じ17業種の MOM_12_1 の等ウェイト平均(%)。5銘柄未満は NULL。業種モメンタム';
COMMENT ON COLUMN xs_mom_panel.ind_mom_6_1      IS '同じ週・同じ17業種の MOM_6_1 の等ウェイト平均(%)。5銘柄未満は NULL';
COMMENT ON COLUMN xs_mom_panel.fwd_ret_4w       IS '4週先までの最後の終値へのリターン(%、調整後)。ddl/20 のコピー';
COMMENT ON COLUMN xs_mom_panel.fwd_ret_8w       IS '8週先までの最後の終値へのリターン(%、調整後)。廃止で途切れたら最後の終値まで';
COMMENT ON COLUMN xs_mom_panel.fwd_ret_13w      IS '13週先までの最後の終値へのリターン(%、調整後)。ddl/20 のコピー';
COMMENT ON COLUMN xs_mom_panel.delist_4w        IS '4週先までに上場廃止で途切れたら Y';
COMMENT ON COLUMN xs_mom_panel.delist_8w        IS '8週先までに上場廃止で途切れたら Y';
COMMENT ON COLUMN xs_mom_panel.delist_13w       IS '13週先までに上場廃止で途切れたら Y';
COMMENT ON COLUMN xs_mom_panel.exr_ind_4w       IS '4週先の相対リターン(%、同週・同33業種平均との差)。ddl/20 のコピー';
COMMENT ON COLUMN xs_mom_panel.exr_ind_13w      IS '13週先の相対リターン(%、同週・同33業種平均との差)。ddl/20 のコピー';
COMMENT ON COLUMN xs_mom_panel.exr_is_4w        IS '4週先の相対リターン(%、同週・同17業種×同規模5分位平均との差)。検証の主指標';
COMMENT ON COLUMN xs_mom_panel.exr_is_8w        IS '8週先の相対リターン(%、同週・同17業種×同規模5分位平均との差)。ここで作った';
COMMENT ON COLUMN xs_mom_panel.exr_is_13w       IS '13週先の相対リターン(%、同週・同17業種×同規模5分位平均との差)。検証の主指標';
COMMENT ON COLUMN xs_mom_panel.exr_mkt_4w       IS '4週先の相対リターン(%、同週の全銘柄の等ウェイト平均との差)。業種・規模を引かない。業種モメンタムを含む';
COMMENT ON COLUMN xs_mom_panel.exr_mkt_8w       IS '8週先の相対リターン(%、同週の全銘柄の等ウェイト平均との差)';
COMMENT ON COLUMN xs_mom_panel.exr_mkt_13w      IS '13週先の相対リターン(%、同週の全銘柄の等ウェイト平均との差)';


--------------------------------------------------------------------------------
-- 2. 作成直後の確認
--------------------------------------------------------------------------------

-- 2-1. 行数が xs_weekly_panel と一致すること
-- SELECT (SELECT COUNT(*) FROM xs_weekly_panel) AS n_base,
--        (SELECT COUNT(*) FROM xs_mom_panel)    AS n_mom
-- FROM dual;

-- 2-2. ddl/20 の先行リターンと一致していること(FWD_RET_4W は両表で同じ値のはず)
-- SELECT COUNT(*) AS n_diff
-- FROM xs_mom_panel m
-- JOIN xs_weekly_panel p ON p.code = m.code AND p.week_start = m.week_start
-- WHERE ABS(NVL(m.fwd_ret_4w, 0) - NVL(p.fwd_ret_4w, 0)) > 0.001;

-- 2-3. 年別の充足状況(MOM は52週分の履歴が要るので最初の1年は NULL。2017年8月から)
-- SELECT EXTRACT(YEAR FROM week_start)                   AS yr,
--        COUNT(*)                                        AS n,
--        ROUND(COUNT(mom_12_1)    / COUNT(*) * 100, 1)   AS pct_mom12,
--        ROUND(COUNT(mom_6_1)     / COUNT(*) * 100, 1)   AS pct_mom6,
--        ROUND(COUNT(turnover_oku)/ COUNT(*) * 100, 1)   AS pct_turnover,
--        ROUND(COUNT(exr_is_8w)   / COUNT(*) * 100, 1)   AS pct_exr_is_8w
-- FROM xs_mom_panel
-- GROUP BY EXTRACT(YEAR FROM week_start)
-- ORDER BY yr;


--------------------------------------------------------------------------------
-- 3. 作り直し(xs_weekly_panel を作り直した後、または検証をやり直す前に)
--   DROP TABLE xs_mom_panel PURGE;
-- 作り直したら GRANT(4-1)も流し直す。シノニムは残る。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 4. CLAUDE_RO への権限付与
--
-- 4-1 を GD_JQUANTS で、4-2 を CLAUDE_RO で接続し直して実行する。
-- **一気に流すと 4-2 で ORA-01471 になる**(GD_JQUANTS は同名の実体を持つため)。
-- 忘れると Claude Desktop 側から ORA-00942 になる。
--------------------------------------------------------------------------------

-- 4-1. GD_JQUANTS で実行
-- GRANT SELECT ON gd_jquants.xs_mom_panel TO claude_ro;

-- 4-2. CLAUDE_RO で接続し直して実行(初回だけ)
-- SELECT USER AS connected_as FROM dual;   -- CLAUDE_RO であること
-- CREATE SYNONYM xs_mom_panel FOR gd_jquants.xs_mom_panel;
