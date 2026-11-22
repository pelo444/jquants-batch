--------------------------------------------------------------------------------
-- 決算情報の画面のためのビュー(3本)
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のためのビューか】
--   FINANCIAL_SUMMARY(決算短信サマリー、開示1件 = 1行)から、次の3つを全銘柄ぶん出す。
--     v_earn_forecast_change  会社予想が前の開示からどう変わったか(上方修正・下方修正)
--     v_earn_progress         四半期の実績が、会社の通期予想に対してどこまで来ているか(進捗率)
--     v_earn_yoy              売上高・営業利益・営業利益率が前年同期より増えたか(0〜3 の点数)
--   ビューには数字だけを持たせる。ランクの線引きは画面側で決める。
--
-- 【共通の約束】
--   ・金額の単位は円(FINANCIAL_SUMMARY のまま)。
--   ・REIT の書類(DOC_TYPE に REIT を含むもの)は除く。
--   ・開示1件につき1行。同じ期に訂正が出ると行が増える(訂正の行は「前と同じ」になる)。
--   ・前年同期・過去の同じ四半期は、期の種類(1Q/2Q/3Q/FY)が同じで期末日がちょうど12か月前の決算短信。
--     同じ期に複数の開示があるときは、連結を優先し、その中で一番新しい開示を使う。
--   ・四半期の実績は期の初めからの累計。前年も累計どうしで比べる。
--   ・会社名・業種・市場は EQUITY_MASTER の今の値。
--
-- 【計算できない行】
--   銀行業は営業利益(OP)が空なので、進捗率と点数は NULL になる。
--   営業利益の予想が0以下・未公表のときは、進捗率と変化率は NULL。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. ビュー(GD_JQUANTS)
--------------------------------------------------------------------------------

-- 1-1 会社予想の変化 -----------------------------------------------------------
--   対象の期(target_fy_en)ごとに、予想を載せた開示を時刻順に並べ、一つ前の予想と比べる。
--   予想を載せる開示は2種類:
--     ・四半期の決算短信と業績予想の修正 … 当期の予想(F_*)。対象の期は CUR_FY_EN
--     ・本決算の決算短信                 … 翌期の予想(NXF_*)。対象の期は NXT_FY_EN
--   その期の最初の予想(本決算で出る翌期予想)は、比べる相手がないので op_dir は NULL。
CREATE OR REPLACE VIEW v_earn_forecast_change AS
WITH fc AS (
    SELECT f.code, f.disc_date, f.disc_time, f.disc_no, f.doc_type, f.cur_per_type,
           f.cur_fy_en AS target_fy_en,
           f.f_sales AS fc_sales, f.f_op AS fc_op, f.f_np AS fc_np
    FROM financial_summary f
    WHERE f.doc_type NOT LIKE '%REIT%'
      AND (f.f_sales IS NOT NULL OR f.f_op IS NOT NULL OR f.f_np IS NOT NULL)
    UNION ALL
    SELECT f.code, f.disc_date, f.disc_time, f.disc_no, f.doc_type, f.cur_per_type,
           f.nxt_fy_en,
           f.nxf_sales, f.nxf_op, f.nxf_np
    FROM financial_summary f
    WHERE f.doc_type NOT LIKE '%REIT%'
      AND f.doc_type LIKE '%FinancialStatements%'
      AND f.cur_per_type = 'FY'
      AND f.nxt_fy_en IS NOT NULL
      AND (f.nxf_sales IS NOT NULL OR f.nxf_op IS NOT NULL OR f.nxf_np IS NOT NULL)
),
w AS (
    SELECT fc.*,
           LAG(fc_sales) IGNORE NULLS OVER (PARTITION BY code, target_fy_en ORDER BY disc_date, disc_time, disc_no) AS prev_fc_sales,
           LAG(fc_op)    IGNORE NULLS OVER (PARTITION BY code, target_fy_en ORDER BY disc_date, disc_time, disc_no) AS prev_fc_op,
           LAG(fc_np)    IGNORE NULLS OVER (PARTITION BY code, target_fy_en ORDER BY disc_date, disc_time, disc_no) AS prev_fc_np,
           LAG(disc_date)             OVER (PARTITION BY code, target_fy_en ORDER BY disc_date, disc_time, disc_no) AS prev_disc_date
    FROM fc
)
SELECT w.disc_date, w.disc_time, w.code, m.co_name, m.sector33_name, m.market_name,
       w.disc_no, w.doc_type, w.cur_per_type, w.target_fy_en,
       CASE WHEN w.doc_type LIKE '%ForecastRevision%' THEN 'REVISION' ELSE 'STATEMENT' END AS src,
       w.fc_sales, w.prev_fc_sales,
       CASE WHEN w.prev_fc_sales > 0 AND w.fc_sales IS NOT NULL
            THEN ROUND((w.fc_sales / w.prev_fc_sales - 1) * 100, 1) END AS sales_chg_pct,
       w.fc_op, w.prev_fc_op,
       CASE WHEN w.prev_fc_op > 0 AND w.fc_op IS NOT NULL
            THEN ROUND((w.fc_op / w.prev_fc_op - 1) * 100, 1) END AS op_chg_pct,
       CASE WHEN w.fc_op IS NULL OR w.prev_fc_op IS NULL THEN NULL
            WHEN w.fc_op > w.prev_fc_op THEN 'UP'
            WHEN w.fc_op < w.prev_fc_op THEN 'DOWN'
            ELSE 'SAME' END AS op_dir,
       w.fc_np, w.prev_fc_np,
       CASE WHEN w.prev_fc_np > 0 AND w.fc_np IS NOT NULL
            THEN ROUND((w.fc_np / w.prev_fc_np - 1) * 100, 1) END AS np_chg_pct,
       w.prev_disc_date
FROM w
LEFT JOIN equity_master m ON m.code = w.code;

COMMENT ON TABLE v_earn_forecast_change IS '会社予想の変化(開示1件×対象の期。一つ前の予想と比べた上方修正・下方修正)';
COMMENT ON COLUMN v_earn_forecast_change.target_fy_en   IS '予想の対象の期(期末日)。本決算の短信では翌期';
COMMENT ON COLUMN v_earn_forecast_change.src            IS 'REVISION: 業績予想の修正として出た開示 / STATEMENT: 決算短信の中の予想';
COMMENT ON COLUMN v_earn_forecast_change.fc_op          IS 'この開示の営業利益予想(通期、円)';
COMMENT ON COLUMN v_earn_forecast_change.prev_fc_op     IS '同じ期の一つ前の営業利益予想(円)。無ければ NULL';
COMMENT ON COLUMN v_earn_forecast_change.op_chg_pct     IS '営業利益予想の変化率(%)。前の予想が0以下なら NULL';
COMMENT ON COLUMN v_earn_forecast_change.op_dir         IS '営業利益予想の向き。UP / DOWN / SAME。比べる相手が無ければ NULL';
COMMENT ON COLUMN v_earn_forecast_change.prev_disc_date IS '同じ期の予想を載せた一つ前の開示の日付';


-- 1-2 進捗率 -------------------------------------------------------------------
--   四半期(1Q/2Q/3Q)の決算短信1件につき1行。
--   進捗率 = 累計の実績 ÷ その開示の時点の通期予想。
--   通期予想は、その短信に載っていればその値、無ければ同じ期の直前の予想(本決算で出た翌期予想を含む)。
--   過去の同じ四半期の進捗率は、その年の短信に載っていた通期予想に対する割合。
--   py1_op_share_of_fy_pct は、前年の同じ四半期の累計が、前年の通期の実績の何%だったか。
CREATE OR REPLACE VIEW v_earn_progress AS
WITH st AS (
    SELECT f.code, f.disc_date, f.disc_time, f.disc_no, f.doc_type, f.cur_per_type, f.cur_per_en, f.cur_fy_en,
           f.sales, f.op, f.f_sales, f.f_op,
           CASE WHEN f.doc_type LIKE '%NonConsolidated%' THEN 0 ELSE 1 END AS is_cons
    FROM financial_summary f
    WHERE f.doc_type LIKE '%FinancialStatements%' AND f.doc_type NOT LIKE '%REIT%'
),
fcsrc AS (
    SELECT f.code, f.disc_date, f.disc_time, f.disc_no, f.cur_fy_en AS target_fy_en,
           f.f_sales AS fc_sales, f.f_op AS fc_op
    FROM financial_summary f
    WHERE f.doc_type NOT LIKE '%REIT%'
    UNION ALL
    SELECT f.code, f.disc_date, f.disc_time, f.disc_no, f.nxt_fy_en, f.nxf_sales, f.nxf_op
    FROM financial_summary f
    WHERE f.doc_type NOT LIKE '%REIT%' AND f.doc_type LIKE '%FinancialStatements%'
      AND f.cur_per_type = 'FY' AND f.nxt_fy_en IS NOT NULL
),
fcrun AS (
    SELECT code, disc_no, target_fy_en,
           LAST_VALUE(fc_sales) IGNORE NULLS OVER (PARTITION BY code, target_fy_en ORDER BY disc_date, disc_time, disc_no
                                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cur_fc_sales,
           LAST_VALUE(fc_op)    IGNORE NULLS OVER (PARTITION BY code, target_fy_en ORDER BY disc_date, disc_time, disc_no
                                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cur_fc_op
    FROM fcsrc
),
sd AS (
    SELECT * FROM (
        SELECT st.*,
               ROW_NUMBER() OVER (PARTITION BY code, cur_per_type, cur_per_en
                                  ORDER BY is_cons DESC, disc_date DESC, disc_no DESC) AS rn
        FROM st)
    WHERE rn = 1
)
SELECT s.disc_date, s.disc_time, s.code, m.co_name, m.sector33_name, m.market_name,
       s.disc_no, s.doc_type, s.cur_per_type, s.cur_per_en, s.cur_fy_en,
       CASE s.cur_per_type WHEN '1Q' THEN 25 WHEN '2Q' THEN 50 WHEN '3Q' THEN 75 END AS guide_pct,
       s.sales, r.cur_fc_sales AS fc_sales,
       CASE WHEN r.cur_fc_sales > 0 AND s.sales IS NOT NULL
            THEN ROUND(s.sales / r.cur_fc_sales * 100, 1) END AS sales_progress_pct,
       s.op, r.cur_fc_op AS fc_op,
       CASE WHEN r.cur_fc_op > 0 AND s.op IS NOT NULL
            THEN ROUND(s.op / r.cur_fc_op * 100, 1) END AS op_progress_pct,
       CASE WHEN p1.f_op > 0 AND p1.op IS NOT NULL THEN ROUND(p1.op / p1.f_op * 100, 1) END AS py1_op_progress_pct,
       CASE WHEN p2.f_op > 0 AND p2.op IS NOT NULL THEN ROUND(p2.op / p2.f_op * 100, 1) END AS py2_op_progress_pct,
       CASE WHEN p3.f_op > 0 AND p3.op IS NOT NULL THEN ROUND(p3.op / p3.f_op * 100, 1) END AS py3_op_progress_pct,
       CASE WHEN fy1.op > 0 AND p1.op IS NOT NULL THEN ROUND(p1.op / fy1.op * 100, 1) END AS py1_op_share_of_fy_pct
FROM st s
LEFT JOIN fcrun r ON r.code = s.code AND r.disc_no = s.disc_no AND r.target_fy_en = s.cur_fy_en
LEFT JOIN sd p1  ON p1.code = s.code AND p1.cur_per_type = s.cur_per_type AND p1.cur_per_en = ADD_MONTHS(s.cur_per_en, -12)
LEFT JOIN sd p2  ON p2.code = s.code AND p2.cur_per_type = s.cur_per_type AND p2.cur_per_en = ADD_MONTHS(s.cur_per_en, -24)
LEFT JOIN sd p3  ON p3.code = s.code AND p3.cur_per_type = s.cur_per_type AND p3.cur_per_en = ADD_MONTHS(s.cur_per_en, -36)
LEFT JOIN sd fy1 ON fy1.code = s.code AND fy1.cur_per_type = 'FY' AND fy1.cur_fy_en = ADD_MONTHS(s.cur_fy_en, -12)
LEFT JOIN equity_master m ON m.code = s.code
WHERE s.cur_per_type IN ('1Q', '2Q', '3Q');

COMMENT ON TABLE v_earn_progress IS '進捗率(四半期の決算短信1件 = 1行。累計の実績 ÷ その時点の通期予想)';
COMMENT ON COLUMN v_earn_progress.guide_pct              IS '四半期を均等に割ったときの目安(1Q 25 / 2Q 50 / 3Q 75)';
COMMENT ON COLUMN v_earn_progress.fc_op                  IS 'この開示の時点の営業利益の通期予想(円)。短信に無ければ同じ期の直前の予想';
COMMENT ON COLUMN v_earn_progress.op_progress_pct        IS '営業利益の進捗率(%)。予想が0以下・未公表なら NULL';
COMMENT ON COLUMN v_earn_progress.sales_progress_pct     IS '売上高の進捗率(%)';
COMMENT ON COLUMN v_earn_progress.py1_op_progress_pct    IS '1年前の同じ四半期の営業利益の進捗率(その年の短信の通期予想に対して)';
COMMENT ON COLUMN v_earn_progress.py2_op_progress_pct    IS '2年前の同じ四半期の営業利益の進捗率';
COMMENT ON COLUMN v_earn_progress.py3_op_progress_pct    IS '3年前の同じ四半期の営業利益の進捗率';
COMMENT ON COLUMN v_earn_progress.py1_op_share_of_fy_pct IS '1年前の同じ四半期の累計の営業利益が、その年の通期の実績の何%だったか';


-- 1-3 前年同期比の点数 ---------------------------------------------------------
--   決算短信(四半期・本決算)1件につき1行。
--   売上高が前年同期より多い / 営業利益が前年同期より多い / 営業利益率が前年同期より高い を 1・0 で持ち、
--   3つの合計を score(0〜3)とする。どれか1つでも比べられなければ score は NULL。
--   営業利益の増減は金額どうしで比べる(前年が赤字でも、増えていれば 1)。伸び率は前年が0以下なら NULL。
CREATE OR REPLACE VIEW v_earn_yoy AS
WITH st AS (
    SELECT f.code, f.disc_date, f.disc_time, f.disc_no, f.doc_type, f.cur_per_type, f.cur_per_en, f.cur_fy_en,
           f.sales, f.op,
           CASE WHEN f.doc_type LIKE '%NonConsolidated%' THEN 0 ELSE 1 END AS is_cons
    FROM financial_summary f
    WHERE f.doc_type LIKE '%FinancialStatements%' AND f.doc_type NOT LIKE '%REIT%'
),
sd AS (
    SELECT * FROM (
        SELECT st.*,
               ROW_NUMBER() OVER (PARTITION BY code, cur_per_type, cur_per_en
                                  ORDER BY is_cons DESC, disc_date DESC, disc_no DESC) AS rn
        FROM st)
    WHERE rn = 1
),
y AS (
    SELECT s.*, p.sales AS py_sales, p.op AS py_op,
           CASE WHEN s.sales IS NULL OR p.sales IS NULL THEN NULL
                WHEN s.sales > p.sales THEN 1 ELSE 0 END AS sales_up,
           CASE WHEN s.op IS NULL OR p.op IS NULL THEN NULL
                WHEN s.op > p.op THEN 1 ELSE 0 END AS op_up,
           CASE WHEN s.op IS NULL OR p.op IS NULL OR s.sales IS NULL OR p.sales IS NULL
                     OR s.sales <= 0 OR p.sales <= 0 THEN NULL
                WHEN s.op / s.sales > p.op / p.sales THEN 1 ELSE 0 END AS margin_up
    FROM st s
    LEFT JOIN sd p ON p.code = s.code AND p.cur_per_type = s.cur_per_type
                  AND p.cur_per_en = ADD_MONTHS(s.cur_per_en, -12)
)
SELECT y.disc_date, y.disc_time, y.code, m.co_name, m.sector33_name, m.market_name,
       y.disc_no, y.doc_type, y.cur_per_type, y.cur_per_en, y.cur_fy_en,
       y.sales, y.py_sales,
       CASE WHEN y.py_sales > 0 AND y.sales IS NOT NULL
            THEN ROUND((y.sales / y.py_sales - 1) * 100, 1) END AS sales_yoy_pct,
       y.op, y.py_op,
       CASE WHEN y.py_op > 0 AND y.op IS NOT NULL
            THEN ROUND((y.op / y.py_op - 1) * 100, 1) END AS op_yoy_pct,
       CASE WHEN y.sales > 0 AND y.op IS NOT NULL THEN ROUND(y.op / y.sales * 100, 2) END AS op_margin_pct,
       CASE WHEN y.py_sales > 0 AND y.py_op IS NOT NULL THEN ROUND(y.py_op / y.py_sales * 100, 2) END AS py_op_margin_pct,
       y.sales_up, y.op_up, y.margin_up,
       y.sales_up + y.op_up + y.margin_up AS score
FROM y
LEFT JOIN equity_master m ON m.code = y.code;

COMMENT ON TABLE v_earn_yoy IS '前年同期比の点数(決算短信1件 = 1行。売上高・営業利益・営業利益率が前年同期より増えた数 0〜3)';
COMMENT ON COLUMN v_earn_yoy.py_sales         IS '前年同期の売上高(累計、円)';
COMMENT ON COLUMN v_earn_yoy.py_op            IS '前年同期の営業利益(累計、円)';
COMMENT ON COLUMN v_earn_yoy.sales_yoy_pct    IS '売上高の前年同期比(%)';
COMMENT ON COLUMN v_earn_yoy.op_yoy_pct       IS '営業利益の前年同期比(%)。前年が0以下なら NULL';
COMMENT ON COLUMN v_earn_yoy.op_margin_pct    IS '営業利益率(%) = 営業利益 ÷ 売上高';
COMMENT ON COLUMN v_earn_yoy.py_op_margin_pct IS '前年同期の営業利益率(%)';
COMMENT ON COLUMN v_earn_yoy.sales_up         IS '売上高が前年同期より多い = 1、そうでない = 0、比べられない = NULL';
COMMENT ON COLUMN v_earn_yoy.op_up            IS '営業利益が前年同期より多い = 1、そうでない = 0、比べられない = NULL';
COMMENT ON COLUMN v_earn_yoy.margin_up        IS '営業利益率が前年同期より高い = 1、そうでない = 0、比べられない = NULL';
COMMENT ON COLUMN v_earn_yoy.score            IS 'sales_up + op_up + margin_up(0〜3)。どれか比べられなければ NULL';


--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS)
--------------------------------------------------------------------------------
GRANT SELECT ON v_earn_forecast_change TO claude_ro;
GRANT SELECT ON v_earn_progress        TO claude_ro;
GRANT SELECT ON v_earn_yoy             TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行。先に SELECT USER FROM dual;)
--------------------------------------------------------------------------------
-- SELECT USER AS connected_as FROM dual;   -- CLAUDE_RO であること
CREATE OR REPLACE SYNONYM v_earn_forecast_change FOR gd_jquants.v_earn_forecast_change;
CREATE OR REPLACE SYNONYM v_earn_progress        FOR gd_jquants.v_earn_progress;
CREATE OR REPLACE SYNONYM v_earn_yoy             FOR gd_jquants.v_earn_yoy;


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- (1) その日の上方修正(営業利益予想の引き上げ幅の大きい順)
-- SELECT disc_time, code, co_name, sector33_name, src, cur_per_type,
--        ROUND(prev_fc_op / 1e8, 1) AS prev_oku, ROUND(fc_op / 1e8, 1) AS now_oku, op_chg_pct
-- FROM v_earn_forecast_change
-- WHERE disc_date = DATE '2026-11-13' AND op_dir = 'UP'
-- ORDER BY op_chg_pct DESC NULLS LAST;
--
-- (2) その日の進捗率(目安をどれだけ上回っているかの順)
-- SELECT code, co_name, cur_per_type, guide_pct, op_progress_pct,
--        py1_op_progress_pct, py2_op_progress_pct, py3_op_progress_pct, py1_op_share_of_fy_pct
-- FROM v_earn_progress
-- WHERE disc_date = DATE '2026-11-13' AND op_progress_pct IS NOT NULL
-- ORDER BY op_progress_pct - guide_pct DESC;
--
-- (3) その日の点数3の決算(営業利益の伸びの大きい順)
-- SELECT code, co_name, cur_per_type, sales_yoy_pct, op_yoy_pct, py_op_margin_pct, op_margin_pct, score
-- FROM v_earn_yoy
-- WHERE disc_date = DATE '2026-11-13' AND score = 3
-- ORDER BY op_yoy_pct DESC NULLS LAST;
