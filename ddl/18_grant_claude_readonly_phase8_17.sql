--------------------------------------------------------------------------------
-- CLAUDE_RO への権限追加(Phase 8〜17 + 裁定取引残高)
--
-- 【なぜ必要になったか】
--   ddl/10_create_claude_readonly_user.sql を作った時点で存在していたのは
--   Phase 1〜7(マスタ・株価・タグ・空売り/信用取引)までだった。
--   その後に追加した取引カレンダー・指数・投資部門別情報・財務情報・
--   EDINET系3データ・裁定取引残高には、GRANT もシノニムも作られていない。
--
--   このため CLAUDE_RO で新しいテーブルを参照すると
--     ORA-00942: table or view "CLAUDE_RO"."<名前>" does not exist
--   になる。「テーブルが無い」というメッセージだが、実際には
--   **テーブルはある。見る権限が無い**。GD_JQUANTS で同じSQLを流すと通るので、
--   このエラーが出たらまず権限を疑うこと。
--
--   queries/sql/demand_*.sql(需給3階層)は investor_type_trading /
--   trading_calendar / topix_price_daily / financial_summary /
--   large_volume_shareholder / edinet_major_shareholder / arbitrage_balance を
--   参照するため、このファイルを流すまで CLAUDE_RO からは1本も動かない。
--
-- 【今後の運用】
--   新しいエンドポイントを追加したら、PROJECT.md 7章の手順に
--   「CLAUDE_RO への GRANT とシノニムを足す」を必ず含めること。
--   忘れると、取り込みは成功しているのに Claude からだけ見えない状態になる。
--
-- 【対象外(ddl/10 と同じ方針)】
--   ・*_STG (ステージング)  … 取込途中の一時データ。分析に不要
--   ・LOAD_PROGRESS         … バッチの内部状態。分析に不要
--
-- 【実行順序】
--   1. 「1. 権限付与」を GD_JQUANTS で実行する
--      (自分が所有するオブジェクトへの GRANT なので ADMIN でなくてよい。
--       ADMIN で実行しても構わない)
--   2. 「2. シノニム作成」を CLAUDE_RO で接続し直して実行する
--
-- 前提: ddl/10 を実行済みで、CLAUDE_RO が存在すること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 権限付与 (GD_JQUANTS で実行)
--------------------------------------------------------------------------------

-- 取引カレンダー・指数四本値 (Phase 8〜10)
GRANT SELECT ON gd_jquants.trading_calendar   TO claude_ro;
GRANT SELECT ON gd_jquants.topix_price_daily  TO claude_ro;
GRANT SELECT ON gd_jquants.index_price_daily  TO claude_ro;
GRANT SELECT ON gd_jquants.index_master       TO claude_ro;

-- 投資部門別情報・決算発表予定日 (Phase 11〜12)
GRANT SELECT ON gd_jquants.investor_type_trading         TO claude_ro;
GRANT SELECT ON gd_jquants.earnings_schedule             TO claude_ro;
GRANT SELECT ON gd_jquants.v_investor_type_trading_latest TO claude_ro;
GRANT SELECT ON gd_jquants.v_earnings_schedule_latest    TO claude_ro;

-- 財務情報・日経225オプション四本値 (Phase 13〜14)
GRANT SELECT ON gd_jquants.financial_summary        TO claude_ro;
GRANT SELECT ON gd_jquants.index_option_price_daily TO claude_ro;
GRANT SELECT ON gd_jquants.v_financial_summary_latest TO claude_ro;

-- 大量保有報告書(EDINET) (Phase 15)
GRANT SELECT ON gd_jquants.large_volume_shareholder            TO claude_ro;
GRANT SELECT ON gd_jquants.large_volume_shareholder_holder     TO claude_ro;
GRANT SELECT ON gd_jquants.large_volume_shareholder_acq_disp   TO claude_ro;
GRANT SELECT ON gd_jquants.large_volume_shareholder_borrowing  TO claude_ro;
GRANT SELECT ON gd_jquants.large_volume_shareholder_creditor   TO claude_ro;
GRANT SELECT ON gd_jquants.v_large_volume_shareholder_detail   TO claude_ro;

-- 大株主状況(EDINET) (Phase 16)
GRANT SELECT ON gd_jquants.edinet_major_shareholder          TO claude_ro;
GRANT SELECT ON gd_jquants.edinet_major_shareholder_holder   TO claude_ro;
GRANT SELECT ON gd_jquants.v_edinet_major_shareholder_detail TO claude_ro;

-- 政策保有株式(EDINET) (Phase 17)
GRANT SELECT ON gd_jquants.edinet_cross_shareholding                TO claude_ro;
GRANT SELECT ON gd_jquants.edinet_cross_shareholding_holder         TO claude_ro;
GRANT SELECT ON gd_jquants.edinet_cross_shareholding_stock          TO claude_ro;
GRANT SELECT ON gd_jquants.v_edinet_cross_shareholding_overview     TO claude_ro;
GRANT SELECT ON gd_jquants.v_edinet_cross_shareholding_stock_detail TO claude_ro;

-- 裁定取引残高 (JPX手動取込)
GRANT SELECT ON gd_jquants.arbitrage_balance          TO claude_ro;
GRANT SELECT ON gd_jquants.v_arbitrage_balance_weekly TO claude_ro;


--------------------------------------------------------------------------------
-- 2. シノニム作成
--
--    ★★★ ここから先は CLAUDE_RO で接続し直して実行すること ★★★
--
--    例: CONNECT claude_ro/"<password>"@<接続文字列>
--
--    シノニムを作らないと、スキーマ名を付けて
--    SELECT * FROM gd_jquants.arbitrage_balance と書く必要がある。
--    Claudeに書かせるSQLを既存のもの(queries/sql/*.sql)と同じ形に保つため、
--    ddl/10 と同様にシノニムを作る。
--
--    【このファイルを頭から一気に流すと、ここで必ず失敗する】
--    1 の GRANT は GD_JQUANTS で実行する。そのまま続けて 2 を実行すると
--      ORA-01471: オブジェクトと同じ名前のシノニムは作成できません
--    が全行で出る。GD_JQUANTS は同名のテーブル・ビューの実体を所有しているため、
--    自分のスキーマに同名のシノニムを作れないという意味。
--    エラーの文面からは接続ユーザーの問題だと分かりにくいので注意。
--    このとき 1 の GRANT は成功しているので、やり直す必要はない。
--    接続を CLAUDE_RO に切り替えて、この 2 だけを実行すればよい。
--
--    2026-09-09 に実際にこれを踏んだ。ddl/10 の「3. シノニム作成」も同じ構造。
--------------------------------------------------------------------------------

-- 接続ユーザーの確認。CLAUDE_RO と表示されない場合は、
-- ここで止めて接続を切り替えること。
SELECT USER AS connected_as FROM dual;


CREATE SYNONYM trading_calendar   FOR gd_jquants.trading_calendar;
CREATE SYNONYM topix_price_daily  FOR gd_jquants.topix_price_daily;
CREATE SYNONYM index_price_daily  FOR gd_jquants.index_price_daily;
CREATE SYNONYM index_master       FOR gd_jquants.index_master;

CREATE SYNONYM investor_type_trading          FOR gd_jquants.investor_type_trading;
CREATE SYNONYM earnings_schedule              FOR gd_jquants.earnings_schedule;
CREATE SYNONYM v_investor_type_trading_latest FOR gd_jquants.v_investor_type_trading_latest;
CREATE SYNONYM v_earnings_schedule_latest     FOR gd_jquants.v_earnings_schedule_latest;

CREATE SYNONYM financial_summary        FOR gd_jquants.financial_summary;
CREATE SYNONYM index_option_price_daily FOR gd_jquants.index_option_price_daily;
CREATE SYNONYM v_financial_summary_latest FOR gd_jquants.v_financial_summary_latest;

CREATE SYNONYM large_volume_shareholder           FOR gd_jquants.large_volume_shareholder;
CREATE SYNONYM large_volume_shareholder_holder    FOR gd_jquants.large_volume_shareholder_holder;
CREATE SYNONYM large_volume_shareholder_acq_disp  FOR gd_jquants.large_volume_shareholder_acq_disp;
CREATE SYNONYM large_volume_shareholder_borrowing FOR gd_jquants.large_volume_shareholder_borrowing;
CREATE SYNONYM large_volume_shareholder_creditor  FOR gd_jquants.large_volume_shareholder_creditor;
CREATE SYNONYM v_large_volume_shareholder_detail  FOR gd_jquants.v_large_volume_shareholder_detail;

CREATE SYNONYM edinet_major_shareholder          FOR gd_jquants.edinet_major_shareholder;
CREATE SYNONYM edinet_major_shareholder_holder   FOR gd_jquants.edinet_major_shareholder_holder;
CREATE SYNONYM v_edinet_major_shareholder_detail FOR gd_jquants.v_edinet_major_shareholder_detail;

CREATE SYNONYM edinet_cross_shareholding                FOR gd_jquants.edinet_cross_shareholding;
CREATE SYNONYM edinet_cross_shareholding_holder         FOR gd_jquants.edinet_cross_shareholding_holder;
CREATE SYNONYM edinet_cross_shareholding_stock          FOR gd_jquants.edinet_cross_shareholding_stock;
CREATE SYNONYM v_edinet_cross_shareholding_overview     FOR gd_jquants.v_edinet_cross_shareholding_overview;
CREATE SYNONYM v_edinet_cross_shareholding_stock_detail FOR gd_jquants.v_edinet_cross_shareholding_stock_detail;

CREATE SYNONYM arbitrage_balance          FOR gd_jquants.arbitrage_balance;
CREATE SYNONYM v_arbitrage_balance_weekly FOR gd_jquants.v_arbitrage_balance_weekly;


--------------------------------------------------------------------------------
-- 3. 動作確認 (CLAUDE_RO で接続したまま)
--------------------------------------------------------------------------------

-- 裁定取引残高が見えること
-- SELECT TO_CHAR(pos_date,'YYYY-MM-DD') AS pos_date,
--        buy_oku_yen, sell_oku_yen, net_oku_yen
-- FROM   v_arbitrage_balance_weekly
-- ORDER  BY pos_date DESC
-- FETCH FIRST 10 ROWS ONLY;

-- CLAUDE_RO から見えているオブジェクトの一覧(シノニムの作り漏れ確認)
-- SELECT synonym_name, table_owner, table_name
-- FROM   user_synonyms
-- ORDER  BY synonym_name;

-- 参照できるはずなのに見えないものが無いかの突き合わせ。
-- GD_JQUANTS 側で実行し、結果に出たものはシノニム/GRANTが漏れている。
-- SELECT object_name, object_type
-- FROM   user_objects
-- WHERE  object_type IN ('TABLE','VIEW')
--   AND  object_name NOT LIKE '%\_STG' ESCAPE '\'
--   AND  object_name <> 'LOAD_PROGRESS'
--   AND  object_name NOT IN (
--          SELECT table_name FROM all_tab_privs
--          WHERE  grantee = 'CLAUDE_RO' AND privilege = 'SELECT'
--        )
-- ORDER  BY object_type, object_name;
