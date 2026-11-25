--------------------------------------------------------------------------------
-- 銘柄グループ(/groups)
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のための表か】
--   銘柄をいくつかのグループにまとめておき、グループの銘柄コードをカンマ区切りの文字で
--   コピーする(個別チャートの調査対象などにまとめて貼る)ために使う。
--   グループの並びは作った順(CREATED_AT、同じ時刻なら GROUP_ID)。
--   グループの中の銘柄の並びは足した順(ADDED_AT、同じ時刻なら ITEM_ID)。
--   1つの銘柄を複数のグループに入れてよい。同じグループに同じ銘柄は1回だけ。
--
-- 【行の消し方】
--   グループを消すと、その中の銘柄の行も一緒に消える(ON DELETE CASCADE)。
--   グループから外した銘柄も行ごと消す(作業用なので履歴は残さない)。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. 表(GD_JQUANTS)
--------------------------------------------------------------------------------
CREATE TABLE jnl_stock_group (
    group_id    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_name  VARCHAR2(100 CHAR) NOT NULL,
    created_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_stock_group_name_uk UNIQUE (group_name)
);

COMMENT ON TABLE jnl_stock_group IS '銘柄グループ(/groups)。並びは CREATED_AT・GROUP_ID の昇順';
COMMENT ON COLUMN jnl_stock_group.group_name IS 'グループ名(重複不可)';
COMMENT ON COLUMN jnl_stock_group.created_at IS '作った日時(SYSTIMESTAMP、協定世界時)';

CREATE TABLE jnl_stock_group_item (
    item_id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_id    NUMBER NOT NULL,
    code        VARCHAR2(10) NOT NULL,
    added_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_stock_group_item_fk FOREIGN KEY (group_id)
        REFERENCES jnl_stock_group (group_id) ON DELETE CASCADE,
    CONSTRAINT jnl_stock_group_item_uk UNIQUE (group_id, code)
);

COMMENT ON TABLE jnl_stock_group_item IS '銘柄グループの中の銘柄。並びは ADDED_AT・ITEM_ID の昇順。外したら行ごと消す';
COMMENT ON COLUMN jnl_stock_group_item.code IS '5桁コード(J-Quants と同じ)';
COMMENT ON COLUMN jnl_stock_group_item.added_at IS '足した日時(SYSTIMESTAMP、協定世界時)';

--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS)
--------------------------------------------------------------------------------
GRANT SELECT ON jnl_stock_group TO claude_ro;
GRANT SELECT ON jnl_stock_group_item TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行。先に SELECT USER FROM dual;)
--------------------------------------------------------------------------------
-- SELECT USER FROM dual;
CREATE OR REPLACE SYNONYM jnl_stock_group FOR gd_jquants.jnl_stock_group;
CREATE OR REPLACE SYNONYM jnl_stock_group_item FOR gd_jquants.jnl_stock_group_item;
