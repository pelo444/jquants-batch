
-- コード検索
SELECT
    *
FROM
    equity_price_daily epd
WHERE
    epd.code like '85540%'
    order by epd.price_date 
;
select * from equity_master eqm
where eqm.code = '71630'
;
-- 名前検索
SELECT
    eqm.code
    , eqm.co_name
    , epd.*
FROM
    equity_price_daily epd
    inner join equity_master eqm 
    on epd.code = eqm.code
WHERE
    eqm.co_name like '%筑邦%'
    order by epd.price_date
;