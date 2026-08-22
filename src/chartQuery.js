'use strict';

/**
 * グラフ描画用のデータ取得クエリをまとめたモジュール。
 *
 * 【株式分割の調整について】
 *   EQUITY_PRICE_DAILY.CLOSE_PRICE は未調整の終値なので、そのまま描画すると
 *   期間中に分割があった銘柄で見かけ上の急落が出てしまう。
 *   ここでは「その日より後に発生した AdjFactor の累積積」を終値に掛けることで、
 *   期間末の株価水準に揃えた系列を返す(queries/sql/rate_price_change.sql と同じ考え方)。
 *
 *   Oracleには積の集計関数が無いため EXP(SUM(LN(...))) で代用している。
 *   最終行は「自分より後の行」が無く SUM() が NULL になるため NVL(...,1) が必須。
 *
 *   累積積は「取得期間内の行」だけを対象にしている。期間より後に起きた分割は
 *   反映されないが、これは意図的で、グラフの右端(期間末)の株価水準に
 *   合わせた表示になる。
 */

/**
 * 取込済みデータの最新営業日を取得する。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<string|null>} 'YYYY-MM-DD'
 */
async function fetchLatestPriceDate(connection) {
  const result = await connection.execute(
    `SELECT TO_CHAR(MAX(price_date), 'YYYY-MM-DD') FROM equity_price_daily`
  );
  return result.rows.length > 0 ? result.rows[0][0] : null;
}

/**
 * タグに紐づく銘柄コードを取得する。
 * 上場廃止等でEQUITY_MASTERに無いコードは返らない。
 * @param {import('oracledb').Connection} connection
 * @param {string} tagName 例: '110_ai_model'
 * @returns {Promise<{code: string, name: string}[]>}
 */
async function fetchCodesByTag(connection, tagName) {
  const result = await connection.execute(
    `SELECT ft.code, em.co_name
     FROM favorite_tag ft
     JOIN equity_master em ON em.code = ft.code
     WHERE ft.tag_name = :tagName
     ORDER BY ft.code`,
    { tagName }
  );
  return result.rows.map((r) => ({ code: r[0], name: r[1] }));
}

/**
 * 登録済みタグの一覧を取得する(--list-tags 用)。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<{tagName: string, label: string, count: number}[]>}
 */
async function fetchTagList(connection) {
  const result = await connection.execute(
    `SELECT tm.tag_name, tm.tag_label_ja, COUNT(ft.code)
     FROM tag_master tm
     LEFT JOIN favorite_tag ft ON ft.tag_name = tm.tag_name
     WHERE tm.is_active = 1
     GROUP BY tm.tag_name, tm.tag_label_ja, tm.tag_code
     ORDER BY tm.tag_code NULLS LAST, tm.tag_name`
  );
  return result.rows.map((r) => ({ tagName: r[0], label: r[1], count: r[2] }));
}

/**
 * 指定銘柄・指定期間の分割調整済み終値を取得する。
 *
 * @param {import('oracledb').Connection} connection
 * @param {string[]} codes 5桁の銘柄コード配列
 * @param {string} dFrom 'YYYY-MM-DD'
 * @param {string} dTo   'YYYY-MM-DD'
 * @returns {Promise<{code: string, name: string, market: string, date: string,
 *                    adjClose: number, rawClose: number, isSplit: number}[]>}
 */
async function fetchAdjustedCloses(connection, codes, dFrom, dTo) {
  if (codes.length === 0) {
    return [];
  }

  // コード数は上限30程度の想定なのでIN句を動的に組み立てる。
  // バインド変数を使うので値の埋め込みによるSQLインジェクションは起きない。
  const binds = { dFrom, dTo };
  const placeholders = codes
    .map((code, i) => {
      binds[`c${i}`] = code;
      return `:c${i}`;
    })
    .join(', ');

  const sql = `
    WITH src AS (
        SELECT p.code, p.price_date, p.close_price, p.adj_factor
        FROM equity_price_daily p
        WHERE p.code IN (${placeholders})
          AND p.price_date BETWEEN TO_DATE(:dFrom, 'YYYY-MM-DD')
                               AND TO_DATE(:dTo,   'YYYY-MM-DD')
          AND p.close_price IS NOT NULL
    ),
    adj AS (
        SELECT code,
               price_date,
               close_price,
               adj_factor,
               ROUND(
                 close_price *
                 NVL(EXP(SUM(LN(NULLIF(adj_factor, 0))) OVER (
                       PARTITION BY code
                       ORDER BY price_date
                       ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1)
               , 2) AS adj_close
        FROM src
    )
    SELECT a.code,
           em.co_name,
           em.market_name,
           TO_CHAR(a.price_date, 'YYYY-MM-DD') AS price_date,
           a.adj_close,
           a.close_price,
           CASE WHEN a.adj_factor <> 1 THEN 1 ELSE 0 END AS is_split
    FROM adj a
    JOIN equity_master em ON em.code = a.code
    ORDER BY a.code, a.price_date`;

  const result = await connection.execute(sql, binds);
  return result.rows.map((r) => ({
    code: r[0],
    name: r[1],
    market: r[2],
    date: r[3],
    adjClose: r[4],
    rawClose: r[5],
    isSplit: r[6],
  }));
}

module.exports = {
  fetchLatestPriceDate,
  fetchCodesByTag,
  fetchTagList,
  fetchAdjustedCloses,
};
