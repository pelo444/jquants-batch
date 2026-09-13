--------------------------------------------------------------------------------
-- Claude Desktop 用 読み取り専用ユーザー
--
-- 背景:
--   Claude Desktop(このMac上のセッション)から直接 J-Quants のデータを
--   参照・分析させたい場面がある。しかし GD_JQUANTS は取り込みバッチが
--   使うアカウントであり、CREATE TABLE / INSERT / UPDATE / DELETE 等の
--   フル権限を持つ。LLMが組み立てたSQLをそのまま実行させるのは
--   このアカウントでは行わない。
--
--   このファイルは、SELECTのみ・対象オブジェクトも分析用途に絞った
--   別ユーザー(CLAUDE_RO)を作る。バッチ本体の権限には一切手を入れない。
--
-- 対象外にしたオブジェクト(理由):
--   ・*_STG (ステージングテーブル) … 取込途中の一時データ。分析に不要
--   ・LOAD_PROGRESS            … バッチの内部状態。分析に不要
--
-- 実行順序:
--   1. ADMIN権限のユーザーで本ファイルの「1. ユーザー作成」「2. 権限付与」を実行する
--   2. 実行後、claude_ro ユーザーで接続し直し、「3. シノニム作成」を実行する
--      (スキーマ名を付けずに SELECT * FROM equity_master のように書けるようにするため)
--
-- 注意:
--   ・パスワードは仮の値です。実行前に必ず強固なパスワードに置き換えてください。
--   ・このパスワードは GD_JQUANTS とは別の値にし、.env.claude-readonly にのみ保存してください
--     (取込バッチの .env とは別ファイルで管理し、混在させないこと)。
--   ・パスワードの入力・管理はご自身で行ってください(Claudeは代行しません)。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. ユーザー作成
--------------------------------------------------------------------------------
CREATE USER claude_ro IDENTIFIED BY "CHANGE_ME_STRONG_PASSWORD";

-- 接続とシノニム作成のみ。CREATE TABLE/VIEW/PROCEDURE等は一切付与しない。
GRANT CREATE SESSION TO claude_ro;
GRANT CREATE SYNONYM  TO claude_ro;

-- 表領域: このユーザー自身はオブジェクトを持たないので割当は不要
-- (UNLIMITED TABLESPACEは付与しない)。

-- 任意: 接続を放置したまま残らないよう、簡単なプロファイルで縛っておく。
-- ATPの版によっては一部パラメータが無視されることがあるが、
-- IDLE_TIME/SESSIONS_PER_USERは有効に機能する。
CREATE PROFILE claude_ro_profile LIMIT
  SESSIONS_PER_USER   3
  IDLE_TIME           30    -- 分。放置セッションを自動切断
  CONNECT_TIME        480;  -- 分。8時間で強制切断
ALTER USER claude_ro PROFILE claude_ro_profile;

--------------------------------------------------------------------------------
-- 2. 権限付与(GD_JQUANTS所有オブジェクトへのSELECTのみ)
--------------------------------------------------------------------------------

-- 中核データ
GRANT SELECT ON gd_jquants.equity_master      TO claude_ro;
GRANT SELECT ON gd_jquants.equity_master_hist TO claude_ro;
GRANT SELECT ON gd_jquants.equity_price_daily TO claude_ro;

-- 分類・お気に入り
GRANT SELECT ON gd_jquants.tag_master     TO claude_ro;
GRANT SELECT ON gd_jquants.favorite_tag   TO claude_ro;
GRANT SELECT ON gd_jquants.favorite_master TO claude_ro;
GRANT SELECT ON gd_jquants.v_equity_tag   TO claude_ro;

-- 空売り・信用取引
GRANT SELECT ON gd_jquants.sector_short_ratio     TO claude_ro;
GRANT SELECT ON gd_jquants.equity_margin_interest TO claude_ro;
GRANT SELECT ON gd_jquants.equity_margin_alert    TO claude_ro;
GRANT SELECT ON gd_jquants.equity_short_position  TO claude_ro;

-- 空売り・信用取引(集計ビュー)
GRANT SELECT ON gd_jquants.v_sector_short_ratio          TO claude_ro;
GRANT SELECT ON gd_jquants.v_equity_short_position_sum   TO claude_ro;
GRANT SELECT ON gd_jquants.v_equity_margin_alert_latest  TO claude_ro;
GRANT SELECT ON gd_jquants.v_equity_short_overview       TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム作成(claude_ro ユーザーで接続して実行)
--    例: CONNECT claude_ro/"<password>"@<接続文字列>
--    これにより SELECT * FROM equity_master のようにスキーマ省略で書ける。
--------------------------------------------------------------------------------

CREATE SYNONYM equity_master      FOR gd_jquants.equity_master;
CREATE SYNONYM equity_master_hist FOR gd_jquants.equity_master_hist;
CREATE SYNONYM equity_price_daily FOR gd_jquants.equity_price_daily;

CREATE SYNONYM tag_master      FOR gd_jquants.tag_master;
CREATE SYNONYM favorite_tag    FOR gd_jquants.favorite_tag;
CREATE SYNONYM favorite_master FOR gd_jquants.favorite_master;
CREATE SYNONYM v_equity_tag    FOR gd_jquants.v_equity_tag;

CREATE SYNONYM sector_short_ratio     FOR gd_jquants.sector_short_ratio;
CREATE SYNONYM equity_margin_interest FOR gd_jquants.equity_margin_interest;
CREATE SYNONYM equity_margin_alert    FOR gd_jquants.equity_margin_alert;
CREATE SYNONYM equity_short_position  FOR gd_jquants.equity_short_position;

CREATE SYNONYM v_sector_short_ratio         FOR gd_jquants.v_sector_short_ratio;
CREATE SYNONYM v_equity_short_position_sum  FOR gd_jquants.v_equity_short_position_sum;
CREATE SYNONYM v_equity_margin_alert_latest FOR gd_jquants.v_equity_margin_alert_latest;
CREATE SYNONYM v_equity_short_overview      FOR gd_jquants.v_equity_short_overview;

--------------------------------------------------------------------------------
-- 4. 動作確認(claude_ro で接続したまま)
--------------------------------------------------------------------------------
-- 参照できること
-- SELECT COUNT(*) FROM equity_master;

-- 書き込み権限が無いことの確認(ORA-01031 権限不足になるはず)
-- INSERT INTO equity_master (code, co_name, as_of_date) VALUES ('99999', 'TEST', SYSDATE);

-- DDL権限が無いことの確認(ORA-01031になるはず)
-- CREATE TABLE test_tbl (c1 NUMBER);
