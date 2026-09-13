--------------------------------------------------------------------------------
-- 09_short_position_normalize_spaces.sql
--
-- 【目的】
--   EQUITY_SHORT_POSITION に既に取り込み済みの行について、
--   商号・住所・備考に残っている「桁揃えの空白」を詰める。
--
-- 【背景】
--   空売り残高報告(/markets/short-sale-report)のCSVは、金融庁提出様式の
--   桁を揃えるための空白がそのまま入ってくる。
--   例) 2021年4月の訂正報告の Notes
--         本文123文字 + 空白950文字 = 1073文字
--       → VARCHAR2(1000 CHAR) に収まらず取込が停止した。
--
--   取込プログラム(src/csvMapper.js の clampText)に
--     (1) 連続空白を1つの半角スペースに詰める
--     (2) それでも1000文字を超える場合だけ切り詰める
--   という正規化を入れたが、それ以前に取り込んだ行には空白が残っている。
--   商号に空白が残ると同一の報告者が別名として集計されてしまうため、
--   ここで既存行も同じ形に揃える。
--
-- 【実行タイミング】
--   csvMapper.js を更新した後、1回だけ実行する。
--   何度実行しても結果は変わらない(冪等)。
--
-- 【実行方法】
--   sqlplus GD_JQUANTS/****@atp_low @09_short_position_normalize_spaces.sql
--------------------------------------------------------------------------------

SET SERVEROUTPUT ON
SET LINESIZE 200

--------------------------------------------------------------------------------
-- STEP 1: 影響を受ける行数を確認する(更新前の状態を見るだけ)
--------------------------------------------------------------------------------
PROMPT === STEP 1: 空白の正規化が必要な行数 ===

SELECT COUNT(*) AS 要正規化件数
  FROM equity_short_position
 WHERE ss_name   != TRIM(REGEXP_REPLACE(REPLACE(ss_name,   '　', ' '), '[[:space:]]+', ' '))
    OR ss_addr   != TRIM(REGEXP_REPLACE(REPLACE(ss_addr,   '　', ' '), '[[:space:]]+', ' '))
    OR dic_name  != TRIM(REGEXP_REPLACE(REPLACE(dic_name,  '　', ' '), '[[:space:]]+', ' '))
    OR dic_addr  != TRIM(REGEXP_REPLACE(REPLACE(dic_addr,  '　', ' '), '[[:space:]]+', ' '))
    OR fund_name != TRIM(REGEXP_REPLACE(REPLACE(fund_name, '　', ' '), '[[:space:]]+', ' '))
    OR notes     != TRIM(REGEXP_REPLACE(REPLACE(notes,     '　', ' '), '[[:space:]]+', ' '));

--------------------------------------------------------------------------------
-- STEP 2: 正規化を実行する
--
--   REPLACE(x, '　', ' ')          全角スペースを半角に寄せる
--     ※ [[:space:]] が全角スペースを含むかはキャラクタセット依存なので、
--        先に明示的に置き換えておく
--   REGEXP_REPLACE(..., '[[:space:]]+', ' ')  連続空白(改行・タブ含む)を1つに
--   TRIM(...)                      前後の空白を落とす
--------------------------------------------------------------------------------
PROMPT === STEP 2: 正規化を実行 ===

UPDATE equity_short_position
   SET ss_name   = TRIM(REGEXP_REPLACE(REPLACE(ss_name,   '　', ' '), '[[:space:]]+', ' ')),
       ss_addr   = TRIM(REGEXP_REPLACE(REPLACE(ss_addr,   '　', ' '), '[[:space:]]+', ' ')),
       dic_name  = TRIM(REGEXP_REPLACE(REPLACE(dic_name,  '　', ' '), '[[:space:]]+', ' ')),
       dic_addr  = TRIM(REGEXP_REPLACE(REPLACE(dic_addr,  '　', ' '), '[[:space:]]+', ' ')),
       fund_name = TRIM(REGEXP_REPLACE(REPLACE(fund_name, '　', ' '), '[[:space:]]+', ' ')),
       notes     = TRIM(REGEXP_REPLACE(REPLACE(notes,     '　', ' '), '[[:space:]]+', ' '))
 WHERE ss_name   != TRIM(REGEXP_REPLACE(REPLACE(ss_name,   '　', ' '), '[[:space:]]+', ' '))
    OR ss_addr   != TRIM(REGEXP_REPLACE(REPLACE(ss_addr,   '　', ' '), '[[:space:]]+', ' '))
    OR dic_name  != TRIM(REGEXP_REPLACE(REPLACE(dic_name,  '　', ' '), '[[:space:]]+', ' '))
    OR dic_addr  != TRIM(REGEXP_REPLACE(REPLACE(dic_addr,  '　', ' '), '[[:space:]]+', ' '))
    OR fund_name != TRIM(REGEXP_REPLACE(REPLACE(fund_name, '　', ' '), '[[:space:]]+', ' '))
    OR notes     != TRIM(REGEXP_REPLACE(REPLACE(notes,     '　', ' '), '[[:space:]]+', ' '));

COMMIT;

--------------------------------------------------------------------------------
-- STEP 3: 結果確認
--   ・要正規化件数が0になっていること
--   ・報告者(商号)の異なり数が減っていること(空白違いの重複が解消される)
--------------------------------------------------------------------------------
PROMPT === STEP 3: 結果確認 ===

SELECT COUNT(*) AS 残りの要正規化件数
  FROM equity_short_position
 WHERE ss_name != TRIM(REGEXP_REPLACE(REPLACE(ss_name, '　', ' '), '[[:space:]]+', ' '))
    OR notes   != TRIM(REGEXP_REPLACE(REPLACE(notes,   '　', ' '), '[[:space:]]+', ' '));

SELECT COUNT(DISTINCT ss_name) AS 報告者の異なり数,
       COUNT(*)                AS 明細件数
  FROM equity_short_position;
