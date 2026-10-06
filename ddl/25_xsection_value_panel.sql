--------------------------------------------------------------------------------
-- 割安度・業績の質・配当の横断面パネル(検証用スナップショット表)
-- 実行ユーザー: GD_JQUANTS
--
-- 【何のための表か】
--   「割安(PBR低・益回り高・配当利回り高)、収益性(ROE高)、利益の質(アクルーアル小)の
--   銘柄は、その後、同業・同規模の銘柄より強いか」を、これまでの検証と同じ型で測る土台。
--   claude/xsection_value_quality_backtest.md がこの表を使う。
--
-- 【情報の時点(先読みなし)】
--   各週の最終営業日(last_bd)に、開示日 < last_bd で最新の「通期の決算短信」を使う
--   (xs_weekly_panel の PBR と同じ規則。当日開示は使わない)。
--   業績予想修正・配当予想修正の書類は実績が NULL なので使わない(DOC_TYPE が
--   FYFinancialStatements% のものだけ)。同じ開示日に連結・単体がある場合は連結を優先。
--   開示から 460 日を超えて次の決算が出ていない銘柄は全指標 NULL(古い財務で判断しない)。
--   四半期は使わない(最新の通期実績のみ。最大で約1年前の数字になる)。
--
-- 【指標の定義(結果を見る前に固定)】単位はいずれも円(財務)・億円(時価総額)。
--   EY  = 通期当期純利益 ÷ 時価総額 × 100 (%)。益回り。高いほど割安。負の利益も含める
--   DY  = 配当金総額 ÷ 時価総額 × 100 (%)。配当金総額が NULL で一株配当が0なら 0。
--         どちらも無ければ NULL(無配と未開示を区別する)
--   ROE = 開示の ROE × 100 (%)
--   ACC = (当期純利益 - 営業CF) ÷ 総資産 × 100 (%)。アクルーアル。低いほど利益の質が良い
--   PBR = xs_weekly_panel の PBR(純資産が正のときのみ。0以下は NULL)
--   時価総額で割るので、分割の影響を受けない(株数は分割で補正済み)。
--
-- 前提: ddl/24 を実行済みで、xs_mom_panel があること。
--------------------------------------------------------------------------------

CREATE TABLE xs_value_panel AS
WITH f0 AS (
    SELECT f.code, f.disc_date, f.np, f.cfo, f.ta, f.roe, f.div_total_ann, f.div_ann,
           ROW_NUMBER() OVER (
               PARTITION BY f.code, f.disc_date
               ORDER BY CASE WHEN f.doc_type LIKE '%\_NonConsolidated%' ESCAPE '\' THEN 1 ELSE 0 END,
                        f.disc_time DESC NULLS LAST, f.disc_no DESC) AS rn
    FROM financial_summary f
    WHERE f.cur_per_type = 'FY'
      AND f.doc_type LIKE 'FYFinancialStatements%'
      AND f.np IS NOT NULL
),
fy AS (
    SELECT code, disc_date, np, cfo, ta, roe, div_total_ann, div_ann,
           LEAD(disc_date) OVER (PARTITION BY code ORDER BY disc_date) AS nxt_disc
    FROM f0
    WHERE rn = 1
)
SELECT m.week_start, m.wk_idx, m.last_bd, m.code,
       fy.disc_date AS fy_disc_date,
       m.last_bd - fy.disc_date AS fy_age_d,
       CASE WHEN m.last_bd - fy.disc_date <= 460 AND m.mcap_oku > 0
            THEN fy.np / (m.mcap_oku * 1e8) * 100 END AS ey,
       CASE WHEN m.last_bd - fy.disc_date <= 460 AND m.mcap_oku > 0 THEN
            CASE WHEN fy.div_total_ann IS NOT NULL THEN fy.div_total_ann / (m.mcap_oku * 1e8) * 100
                 WHEN fy.div_ann = 0 THEN 0 END
       END AS dy,
       CASE WHEN m.last_bd - fy.disc_date <= 460 THEN fy.roe * 100 END AS roe,
       CASE WHEN m.last_bd - fy.disc_date <= 460 AND fy.ta > 0 AND fy.cfo IS NOT NULL
            THEN (fy.np - fy.cfo) / fy.ta * 100 END AS acc,
       CASE WHEN m.pbr > 0 THEN m.pbr END AS pbr_v
FROM xs_mom_panel m
LEFT JOIN fy
       ON fy.code = m.code
      AND m.last_bd > fy.disc_date
      AND (fy.nxt_disc IS NULL OR m.last_bd <= fy.nxt_disc);

CREATE INDEX ix_xs_value_panel_wk ON xs_value_panel (week_start, code);

COMMENT ON TABLE xs_value_panel IS '割安度・業績の質・配当の検証用パネル(スナップショット)。xs_mom_panel と同じ行(週×銘柄)に最新の通期決算の指標を付けた。ddl/25';
COMMENT ON COLUMN xs_value_panel.ey  IS '益回り(%)=通期当期純利益÷時価総額×100。高いほど割安';
COMMENT ON COLUMN xs_value_panel.dy  IS '配当利回り(%)=配当金総額÷時価総額×100。無配は0、未開示はNULL';
COMMENT ON COLUMN xs_value_panel.roe IS 'ROE(%)。開示値';
COMMENT ON COLUMN xs_value_panel.acc IS 'アクルーアル(%)=(当期純利益-営業CF)÷総資産×100。低いほど利益の質が良い';
COMMENT ON COLUMN xs_value_panel.pbr_v IS 'PBR(倍)。0以下はNULL';
COMMENT ON COLUMN xs_value_panel.fy_age_d IS '使った決算の開示日から週末までの日数。460日超は指標がNULL';

--------------------------------------------------------------------------------
-- 確認(作成後)
-- 1) 行数が xs_mom_panel と一致(重複結合がないこと)
-- SELECT (SELECT COUNT(*) FROM xs_value_panel) a, (SELECT COUNT(*) FROM xs_mom_panel) b FROM dual;
-- 2) 埋まり率
-- SELECT COUNT(*) n, COUNT(ey) ey, COUNT(dy) dy, COUNT(roe) roe, COUNT(acc) acc, COUNT(pbr_v) pbr FROM xs_value_panel;
--
-- GRANT(GD_JQUANTS で): GRANT SELECT ON gd_jquants.xs_value_panel TO claude_ro;
-- シノニム(CLAUDE_RO に接続し直して): CREATE SYNONYM xs_value_panel FOR gd_jquants.xs_value_panel;
-- 作り直し: DROP TABLE xs_value_panel PURGE;
--------------------------------------------------------------------------------
