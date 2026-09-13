--------------------------------------------------------------------------------
-- 指定日の翌営業日・直近N営業日を取得する
--
-- TRADING_CALENDAR.HOL_DIV の意味(仕様書 /spec/mkt-cal/holiday-division より):
--   0: 非営業日   1: 営業日   2: 東証半日立会日   3: 非営業日(祝日取引あり)
-- 「営業日」として扱うのは 1 と 2 (半日立会も取引はあるため営業日に含める)。
--
-- 【使い方】
--   PARAMS の基準日を変更する。
--------------------------------------------------------------------------------

WITH params AS (
    SELECT DATE '2025-12-30' AS base_date
    FROM dual
)
-- 基準日の翌営業日
SELECT 'NEXT' AS kind, c.calendar_date, c.hol_div
FROM trading_calendar c
CROSS JOIN params
WHERE c.calendar_date > params.base_date
  AND c.hol_div IN ('1', '2')
  AND c.calendar_date = (
        SELECT MIN(c2.calendar_date)
        FROM trading_calendar c2
        WHERE c2.calendar_date > params.base_date
          AND c2.hol_div IN ('1', '2')
      )

UNION ALL

-- 基準日を含む直近5営業日
SELECT 'RECENT5' AS kind, c.calendar_date, c.hol_div
FROM (
    SELECT c.calendar_date, c.hol_div
    FROM trading_calendar c
    CROSS JOIN params
    WHERE c.calendar_date <= params.base_date
      AND c.hol_div IN ('1', '2')
    ORDER BY c.calendar_date DESC
    FETCH FIRST 5 ROWS ONLY
) c
ORDER BY 1, 2;
