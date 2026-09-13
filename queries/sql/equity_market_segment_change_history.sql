SELECT h.code, m.co_name, h.market_name,
       TO_CHAR(MIN(h.as_of_date), 'YYYY-MM-DD') AS from_date,
       TO_CHAR(MAX(h.as_of_date), 'YYYY-MM-DD') AS to_date
FROM equity_master_hist h
JOIN equity_master m ON m.code = h.code
WHERE h.code IN (
        SELECT code FROM equity_master_hist
        GROUP BY code
        HAVING COUNT(DISTINCT market_name) > 1
      )
GROUP BY h.code, m.co_name, h.market_name
ORDER BY h.code, MIN(h.as_of_date);