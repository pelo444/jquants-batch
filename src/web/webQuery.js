'use strict';

/**
 * Webアプリ用のデータ取得クエリ。
 *
 * 【元にしたSQLからの変更点】
 *   queries/sql/rate_price_change.sql では、タグによる絞り込みを最終WHERE句の
 *   EXISTS で行っていた。しかしその形だと adj CTE が「期間内の全上場銘柄」について
 *   累積調整係数を計算してから捨てることになり、Webのレスポンスとしては遅い。
 *
 *   ここでは対象銘柄を最初に確定させ、adj の入力をその銘柄だけに絞っている。
 *   結果は同じだが、走査量が銘柄数に比例するようになる。
 *
 * 【株式分割の調整】
 *   その日より後に発生した AdjFactor の累積積を終値に掛けて、期間末の株価水準に
 *   揃えた系列にする。Oracleには積の集計関数が無いため EXP(SUM(LN(...))) で代用し、
 *   最終行は SUM() が NULL になるため NVL(...,1) を必ず付ける。
 */

//------------------------------------------------------------------
// メタ情報
//------------------------------------------------------------------

/**
 * 取込済みデータの最新営業日。期間指定の既定値に使う。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<string|null>} 'YYYY-MM-DD'
 */
async function fetchLatestPriceDate(connection) {
  const r = await connection.execute(
    `SELECT TO_CHAR(MAX(price_date), 'YYYY-MM-DD') FROM equity_price_daily`
  );
  return r.rows.length > 0 ? r.rows[0][0] : null;
}

/**
 * タグ一覧。銘柄が1件も付いていないタグも返す(UIで選べるようにするため)。
 * THEMEタグ(番号なし)は tagCode が null になる。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<object[]>}
 */
async function fetchTags(connection) {
  const r = await connection.execute(
    `SELECT tm.tag_name,
            tm.tag_code,
            tm.tag_label_ja,
            tm.tag_type,
            tm.major_code,
            tm.major_label_ja,
            COUNT(ft.code) AS code_count
     FROM tag_master tm
     LEFT JOIN favorite_tag ft ON ft.tag_name = tm.tag_name
     WHERE tm.is_active = 1
     GROUP BY tm.tag_name, tm.tag_code, tm.tag_label_ja, tm.tag_type,
              tm.major_code, tm.major_label_ja
     ORDER BY tm.tag_code NULLS LAST, tm.tag_name`
  );
  return r.rows.map((x) => ({
    tagName: x[0],
    tagCode: x[1],
    label: x[2],
    tagType: x[3],
    majorCode: x[4],
    majorLabel: x[5],
    count: x[6],
  }));
}

//------------------------------------------------------------------
// 騰落率一覧
//------------------------------------------------------------------

/**
 * 指定タグ・指定期間の銘柄について、分割調整済みの期間騰落率を返す。
 * 並び順は騰落率の降順。
 *
 * @param {import('oracledb').Connection} connection
 * @param {object} opts
 * @param {string[]} opts.tags          タグ名の配列(OR条件)
 * @param {string}   opts.from          'YYYY-MM-DD'
 * @param {string}   opts.to            'YYYY-MM-DD'
 * @param {number}   [opts.minDays=0]   最低営業日数。流動性が極端に低い銘柄を除くため
 * @param {boolean}  [opts.excludeFund=true]      ETF・REIT等(sector17_code='99')を除外
 * @param {boolean}  [opts.excludeDelisted=true]  上場廃止銘柄を除外
 * @returns {Promise<object[]>}
 */
async function fetchPerformance(connection, opts) {
  const {
    tags,
    from,
    to,
    minDays = 0,
    excludeFund = true,
    excludeDelisted = true,
  } = opts;

  if (!Array.isArray(tags) || tags.length === 0) {
    return [];
  }

  const binds = { dFrom: from, dTo: to, minDays };
  const tagPlaceholders = tags
    .map((t, i) => {
      binds[`t${i}`] = t;
      return `:t${i}`;
    })
    .join(', ');

  // sector17_code は NULL の銘柄がありうる。NVLしないと NULL <> '99' が
  // UNKNOWN になって行が消えるため、除外の意図と逆の結果になる。
  const fundFilter = excludeFund ? `AND NVL(em.sector17_code, '0') <> '99'` : '';
  const delistedFilter = excludeDelisted ? `AND em.delisted_flag = 'N'` : '';

  const sql = `
    WITH target AS (
        -- 対象銘柄をここで確定させる。以降の走査をこの銘柄だけに限定するのが要点。
        SELECT DISTINCT ft.code
        FROM favorite_tag ft
        WHERE ft.tag_name IN (${tagPlaceholders})
    ),
    adj AS (
        SELECT p.code,
               p.price_date,
               p.close_price,
               p.adj_factor,
               ROUND(
                 p.close_price *
                 NVL(EXP(SUM(LN(NULLIF(p.adj_factor, 0))) OVER (
                       PARTITION BY p.code
                       ORDER BY p.price_date
                       ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1)
               , 2) AS adj_close
        FROM equity_price_daily p
        WHERE p.close_price IS NOT NULL
          AND p.price_date BETWEEN TO_DATE(:dFrom, 'YYYY-MM-DD')
                               AND TO_DATE(:dTo,   'YYYY-MM-DD')
          AND p.code IN (SELECT code FROM target)
    ),
    base AS (
        SELECT code,
               MIN(price_date)  KEEP (DENSE_RANK FIRST ORDER BY price_date) AS d1,
               MAX(price_date)  KEEP (DENSE_RANK LAST  ORDER BY price_date) AS d2,
               MIN(close_price) KEEP (DENSE_RANK FIRST ORDER BY price_date) AS raw_p1,
               MIN(adj_close)   KEEP (DENSE_RANK FIRST ORDER BY price_date) AS p1,
               MAX(adj_close)   KEEP (DENSE_RANK LAST  ORDER BY price_date) AS p2,
               COUNT(*)                                                     AS trading_days,
               COUNT(CASE WHEN adj_factor <> 1 THEN 1 END)                  AS split_count
        FROM adj
        GROUP BY code
    )
    SELECT b.code,
           em.co_name,
           em.market_name,
           em.sector33_name,
           TO_CHAR(b.d1, 'YYYY-MM-DD')                  AS d1,
           TO_CHAR(b.d2, 'YYYY-MM-DD')                  AS d2,
           b.p1,
           b.p2,
           ROUND(b.p2 - b.p1, 1)                        AS diff,
           ROUND((b.p2 / NULLIF(b.p1, 0) - 1) * 100, 2) AS change_pct,
           b.trading_days,
           b.split_count,
           b.raw_p1,
           (SELECT LISTAGG(f2.tag_name, ' ') WITHIN GROUP (ORDER BY f2.tag_name)
            FROM favorite_tag f2 WHERE f2.code = b.code) AS all_tags
    FROM base b
    JOIN equity_master em ON em.code = b.code
    WHERE b.trading_days >= :minDays
      ${fundFilter}
      ${delistedFilter}
      -- 個人が売買できない市場を除外。NULLの銘柄を落とさないよう IS NULL を明示する
      AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')
    ORDER BY change_pct DESC NULLS LAST, b.code`;

  const r = await connection.execute(sql, binds);
  return r.rows.map((x) => ({
    code: x[0],
    name: x[1],
    market: x[2],
    sector33: x[3],
    d1: x[4],
    d2: x[5],
    p1: x[6],
    p2: x[7],
    diff: x[8],
    changePct: x[9],
    tradingDays: x[10],
    splitCount: x[11],
    rawP1: x[12],
    tags: x[13] ? x[13].split(' ') : [],
  }));
}

module.exports = {
  fetchLatestPriceDate,
  fetchTags,
  fetchPerformance,
};
