-- 市場区分別の売買代金と値動きの大きさ
SELECT m.market_name,
       COUNT(DISTINCT p.code) AS codes,
       ROUND(AVG(p.turnover_value)/1000000, 1) AS avg_turnover_mil,
       ROUND(AVG((p.high_price - p.low_price) / NULLIF(p.close_price,0) * 100), 2) AS avg_range_pct
FROM equity_price_daily p
JOIN equity_master m ON m.code = p.code
WHERE p.price_date >= DATE '2026-01-01'
  AND p.close_price IS NOT NULL
GROUP BY m.market_name
ORDER BY avg_turnover_mil DESC;