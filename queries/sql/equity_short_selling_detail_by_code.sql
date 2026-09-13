--------------------------------------------------------------------------------
-- 個別銘柄の空売り関連データ深掘り(株価と突き合わせ)
--
-- 使い方: 先頭の &code / &d_from / &d_to を指定して実行する(SQL Developerなら
-- 変数入力ダイアログが出る)。例: code=66130, d_from=2026-07-01, d_to=2026-08-31
--
-- 【重要な注意点】空売り残高報告(EQUITY_SHORT_POSITION)は「その日にレコードが
-- 無い=残高ゼロ」ではない。取引参加者がその日に報告書を提出しなかっただけ、
-- という理由でレコードが無いことが多い(J-Quants仕様書にも明記されている)。
-- そのため日次のTOTAL_SHRT_SHARESが大きく上下して見えても、実際の残高が
-- その規模で日々増減しているとは限らない。個別の報告者(SS_NAME)を追って
-- PREV_RPT_RATIOとの連続性を見たほうが実態に近い(クエリ4参照)。
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. 銘柄基本情報
--------------------------------------------------------------------------------
SELECT code, co_name, market_name, sector33_name, margin_name
FROM equity_master
WHERE code = '&code';

--------------------------------------------------------------------------------
-- 2. 株価(分割調整前。期間内に分割があればadj_factorを別途確認すること)
--------------------------------------------------------------------------------
SELECT TO_CHAR(price_date,'YYYY-MM-DD') d, close_price, volume, adj_factor
FROM equity_price_daily
WHERE code = '&code'
AND price_date BETWEEN DATE '&d_from' AND DATE '&d_to'
ORDER BY price_date;

--------------------------------------------------------------------------------
-- 3. 信用取引残高(個人中心・全銘柄。週次 → 2026/9/28以降は日次)
--    絶対水準が小さい銘柄では空売り残高報告(4,5)のほうが支配的なことが多い。
--------------------------------------------------------------------------------
SELECT TO_CHAR(app_date,'YYYY-MM-DD') d, shrt_vol, long_vol, shrt_neg_vol, shrt_std_vol
FROM equity_margin_interest
WHERE code = '&code'
AND app_date BETWEEN DATE '&d_from' AND DATE '&d_to'
ORDER BY app_date;

--------------------------------------------------------------------------------
-- 4. 空売り残高報告: 主要な報告者ごとの残高割合の推移(株価と突合せ)
--    ある報告者の実態に近い連続的な動きを見るのに使う(SS_NAMEを絞る)。
--    PREV_RPT_RATIOと比べると「前回報告からどれだけ動いたか」が分かる。
--------------------------------------------------------------------------------
SELECT TO_CHAR(s.calc_date,'YYYY-MM-DD') calc_d,
       TO_CHAR(s.disc_date,'YYYY-MM-DD') disc_d,  -- 公表は計算日の2営業日後が目安
       s.ss_name, s.shrt_pos_to_so, s.shrt_pos_shares, s.prev_rpt_ratio,
       p.close_price
FROM equity_short_position s
LEFT JOIN equity_price_daily p ON p.code = s.code AND p.price_date = s.calc_date
WHERE s.code = '&code'
-- AND s.ss_name LIKE '%□□□%'   -- 特定の報告者に絞る場合はコメント解除
AND s.calc_date BETWEEN DATE '&d_from' AND DATE '&d_to'
ORDER BY s.calc_date, s.ss_name;

--------------------------------------------------------------------------------
-- 5. 空売り残高報告の日次合計(参考値。上記の注意点のとおり過小評価しうる)
--    株価・出来高と並べて全体感を見る用。
--------------------------------------------------------------------------------
SELECT TO_CHAR(s.calc_date,'YYYY-MM-DD') d, s.total_shrt_shares, s.total_shrt_ratio,
       s.reporter_count, p.close_price, p.volume
FROM V_EQUITY_SHORT_POSITION_SUM s
LEFT JOIN equity_price_daily p ON p.code = s.code AND p.price_date = s.calc_date
WHERE s.code = '&code'
AND s.calc_date BETWEEN DATE '&d_from' AND DATE '&d_to'
ORDER BY s.calc_date;
