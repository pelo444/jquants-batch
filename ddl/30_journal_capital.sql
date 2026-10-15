--------------------------------------------------------------------------------
-- 元手(投資に使うと決めたお金)の履歴
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のための表か】
--   売買記録の「口座」タブと、損失回避チェックの Ch9 で次の値を出すため。
--     株に入れた正味の額   = 取得額の累計 − 売却額の累計(現物の約定 JNL_TRADE から計算)
--     まだ使っていない元手 = 元手 − 株に入れた正味の額
--   元手は PELO が決める額。銀行や証券口座の残高とは切り離して扱う。
--   元手を見直したら「いつから何円にしたか」を1行足す。一番新しい日付の行が今の元手。
--   同じ日付で入れ直すと上書きする(一意制約)。
--
-- 【以前の週次記録(JNL_ACCOUNT_SNAPSHOT)】
--   現金・株式評価額・入出金を週ごとに手で入れる方式は使わなくなった。表と過去の行は残す。
--
-- 前提: ddl/26_trading_journal.sql を実行済み。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. 表(GD_JQUANTS)
--------------------------------------------------------------------------------
CREATE TABLE jnl_capital (
    capital_id      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    effective_date  DATE                NOT NULL,
    amount_yen      NUMBER              NOT NULL,
    note            VARCHAR2(500 CHAR),
    created_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_capital_date_uk UNIQUE (effective_date),
    CONSTRAINT jnl_capital_amount_ck CHECK (amount_yen >= 0)
);

COMMENT ON TABLE jnl_capital IS '元手(投資に使うと決めたお金)の履歴。一番新しい EFFECTIVE_DATE の行が今の元手';
COMMENT ON COLUMN jnl_capital.effective_date IS 'この元手にした日。同じ日付は上書き';
COMMENT ON COLUMN jnl_capital.amount_yen IS '元手(円)';

--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS)
--------------------------------------------------------------------------------
GRANT SELECT ON jnl_capital TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行。先に SELECT USER FROM dual;)
--------------------------------------------------------------------------------
-- SELECT USER FROM dual;
CREATE OR REPLACE SYNONYM jnl_capital FOR gd_jquants.jnl_capital;
