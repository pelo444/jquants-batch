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
/**
 * 指定日以前の最後の営業日の、1つ前の営業日。騰落率一覧の「1日」(前営業日比)の起点に使う。
 * 終了日が休日でも、その直前の営業日を期間末として扱い、さらにその前の営業日を返す。
 * @param {import('oracledb').Connection} connection
 * @param {string} to 'YYYY-MM-DD'
 * @returns {Promise<string|null>} 'YYYY-MM-DD'
 */
async function fetchPrevTradingDate(connection, to) {
  const r = await connection.execute(
    `SELECT TO_CHAR(MAX(price_date), 'YYYY-MM-DD')
     FROM equity_price_daily
     WHERE price_date < (SELECT MAX(price_date) FROM equity_price_daily
                         WHERE price_date <= TO_DATE(:d, 'YYYY-MM-DD'))`,
    { d: to }
  );
  return r.rows.length > 0 ? r.rows[0][0] : null;
}

async function fetchTags(connection) {
  const r = await connection.execute(
    `SELECT tm.tag_name,
            tm.tag_code,
            tm.tag_label_ja,
            tm.tag_type,
            tm.major_code,
            tm.major_label_ja,
            COUNT(ft.code) AS code_count,
            tm.tag_short_ja
     FROM tag_master tm
     LEFT JOIN favorite_tag ft ON ft.tag_name = tm.tag_name
     WHERE tm.is_active = 1
     GROUP BY tm.tag_name, tm.tag_code, tm.tag_label_ja, tm.tag_type,
              tm.major_code, tm.major_label_ja, tm.tag_short_ja
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
    shortLabel: x[7],
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
 * @param {string[]} opts.tags          タグ名の配列(OR条件)。allStocksがtrueの場合は無視される
 * @param {string[]} [opts.stocks=[]]   銘柄コード(5桁)の配列。指定したときは33業種・タグより優先する(画面ではどれか1つだけを送る)
 * @param {string[]} [opts.sectors=[]]  33業種コードの配列(OR条件)。指定したときはタグより優先する(画面ではどちらか一方だけを送る)
 * @param {boolean}  [opts.allStocks=false]  trueの場合はタグで絞らず上場銘柄全体を対象にする
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
    sectors = [],
    stocks = [],
    allStocks = false,
    from,
    to,
    minDays = 0,
    excludeFund = true,
    excludeDelisted = true,
  } = opts;

  const hasSectors = Array.isArray(sectors) && sectors.length > 0;
  const hasStocks = Array.isArray(stocks) && stocks.length > 0;
  if (!allStocks && !hasStocks && !hasSectors && (!Array.isArray(tags) || tags.length === 0)) {
    return [];
  }

  const binds = { dFrom: from, dTo: to, minDays };

  // allStocks時はタグでのINを行わず、上場銘柄全体をtargetにする。
  // 対象期間が短ければ(例: 1ヶ月)、走査量は「全銘柄数×短い日数」で収まるため、
  // rate_price_change.sql が抱えていた「全銘柄×全期間」の重いパターンには当たらない。
  let targetSql;
  if (allStocks) {
    targetSql = `SELECT em.code FROM equity_master em`;
  } else if (hasStocks) {
    const codePlaceholders = stocks
      .map((c, i) => {
        binds[`c${i}`] = c;
        return `:c${i}`;
      })
      .join(', ');
    targetSql = `SELECT em.code FROM equity_master em WHERE em.code IN (${codePlaceholders})`;
  } else if (hasSectors) {
    const secPlaceholders = sectors
      .map((s, i) => {
        binds[`s${i}`] = s;
        return `:s${i}`;
      })
      .join(', ');
    targetSql = `SELECT em.code FROM equity_master em WHERE em.sector33_code IN (${secPlaceholders})`;
  } else {
    const tagPlaceholders = tags
      .map((t, i) => {
        binds[`t${i}`] = t;
        return `:t${i}`;
      })
      .join(', ');
    targetSql = `SELECT DISTINCT ft.code FROM favorite_tag ft WHERE ft.tag_name IN (${tagPlaceholders})`;
  }

  // sector17_code は NULL の銘柄がありうる。NVLしないと NULL <> '99' が
  // UNKNOWN になって行が消えるため、除外の意図と逆の結果になる。
  const fundFilter = excludeFund ? `AND NVL(em.sector17_code, '0') <> '99'` : '';
  const delistedFilter = excludeDelisted ? `AND em.delisted_flag = 'N'` : '';

  const sql = `
    WITH target AS (
        -- 対象銘柄をここで確定させる。以降の走査をこの銘柄だけに限定するのが要点。
        ${targetSql}
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
           (SELECT LISTAGG(f2.tag_name, ' ') WITHIN GROUP (ORDER BY tm2.tag_code NULLS LAST, f2.tag_name)
            FROM favorite_tag f2 LEFT JOIN tag_master tm2 ON tm2.tag_name = f2.tag_name
            WHERE f2.code = b.code) AS all_tags
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

//------------------------------------------------------------------
// 33業種のグラフ(騰落率一覧の「33業種のグラフ」タブ)
//------------------------------------------------------------------

/**
 * 東証業種別株価指数(33業種、INDEX_PRICE_DAILY の 0040〜0060)と TOPIX(0000)の期間騰落率。
 * 起点・期間末の決め方は銘柄の騰落率一覧(fetchPerformance)と同じ:
 * 期間内の最初の営業日の終値 → 最後の営業日の終値。指数なので分割の調整は無い。
 * 指数コードは 0040〜0049, 004A〜004F, 0050〜0059, 005A〜005F, 0060 と英字を含むが、
 * 文字列の BETWEEN で 33本ちょうどになる(2026-10-23 実データで確認)。
 * @param {import('oracledb').Connection} connection
 * @param {{from: string, to: string}} opts
 */
async function fetchSectorPerformance(connection, { from, to }) {
  const r = await connection.execute(
    `SELECT p.index_code,
            MAX(m.index_name),
            TO_CHAR(MIN(p.price_date), 'YYYY-MM-DD'),
            TO_CHAR(MAX(p.price_date), 'YYYY-MM-DD'),
            MIN(p.close_price) KEEP (DENSE_RANK FIRST ORDER BY p.price_date),
            MAX(p.close_price) KEEP (DENSE_RANK LAST  ORDER BY p.price_date)
       FROM index_price_daily p
       LEFT JOIN index_master m ON m.index_code = p.index_code
      WHERE p.price_date BETWEEN TO_DATE(:dFrom, 'YYYY-MM-DD') AND TO_DATE(:dTo, 'YYYY-MM-DD')
        AND p.close_price IS NOT NULL
        AND (p.index_code = '0000' OR p.index_code BETWEEN '0040' AND '0060')
      GROUP BY p.index_code`,
    { dFrom: from, dTo: to }
  );
  const med = await connection.execute(SECTOR_MEDIAN_SQL, { dFrom: from, dTo: to });
  return shapeSectorPerformance(r.rows, med.rows);
}

/**
 * 33業種ごとの銘柄の騰落率の中央値(2026-10-23 ユーザー要望。指数は時価総額の大きい銘柄に引っ張られるため並べて見る)。
 * - 期間は TOPIX の期間内の最初と最後の営業日(d1・d2)。両日に終値がある銘柄だけを数える(指数と同じ区間にそろえる)
 * - 分割の調整: d1 の終値に、d1 より後〜d2 の ADJ_FACTOR の積を掛けてから比べる
 * - 対象は騰落率一覧の初期値と同じ(ETF・REIT 等 = 17業種 99、上場廃止、TOKYO PRO MARKET を除く)。業種 9999 は除く
 * - 走査を軽くするため、d1・d2 の行と ADJ_FACTOR が 1 でない行だけを読む(半年で 0.4 秒、2026-10-23)
 */
const SECTOR_MEDIAN_SQL = `
  WITH cal AS (
      SELECT MIN(price_date) AS d1, MAX(price_date) AS d2
        FROM index_price_daily
       WHERE index_code = '0000' AND close_price IS NOT NULL
         AND price_date BETWEEN TO_DATE(:dFrom, 'YYYY-MM-DD') AND TO_DATE(:dTo, 'YYYY-MM-DD')
  ),
  px AS (
      SELECT p.code,
             MAX(CASE WHEN p.price_date = cal.d1 THEN p.close_price END) AS c1,
             MAX(CASE WHEN p.price_date = cal.d2 THEN p.close_price END) AS c2,
             EXP(SUM(CASE WHEN p.price_date > cal.d1 THEN LN(NULLIF(p.adj_factor, 0)) END)) AS f
        FROM equity_price_daily p CROSS JOIN cal
       WHERE p.price_date BETWEEN cal.d1 AND cal.d2
         AND (p.price_date IN (cal.d1, cal.d2) OR p.adj_factor <> 1)
       GROUP BY p.code
  )
  SELECT MAX(em.sector33_name),
         COUNT(*),
         MEDIAN((px.c2 / (px.c1 * NVL(px.f, 1)) - 1) * 100),
         SUM(CASE WHEN px.c2 / (px.c1 * NVL(px.f, 1)) > 1 THEN 1 ELSE 0 END)
    FROM px JOIN equity_master em ON em.code = px.code
   WHERE px.c1 > 0 AND px.c2 IS NOT NULL
     AND NVL(em.sector17_code, '0') <> '99'
     AND em.delisted_flag = 'N'
     AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')
     AND em.sector33_code <> '9999'
   GROUP BY em.sector33_code`;

/**
 * fetchSectorPerformance の行を画面用にする(純粋関数)。
 * TOPIX を分け、業種名から「東証業種別 」を除き、騰落率の高い順に並べる(同じなら指数コード順)。
 * 起点と期間末が同じ日(期間内の営業日が1日だけ)の指数は騰落率を出せないので null にして末尾に回す。
 * 銘柄の中央値は業種名で突き合わせる。銘柄マスタは半角の中黒「･」(電気･ガス業 など6業種)、指数名は全角「・」なのでそろえる。
 * @param {Array<[string, string, string, string, number, number]>} rows
 *   [指数コード, 指数名, 起点日, 期間末日, 起点の終値, 期間末の終値]
 * @param {Array<[string, number, number, number]>} [medianRows]
 *   [業種名, 銘柄数, 騰落率の中央値(%), 上昇した銘柄数]
 */
function shapeSectorPerformance(rows, medianRows = []) {
  const norm = (n) => String(n || '').replace(/･/g, '・');
  const med = new Map(medianRows.map(([nm, n, m, up]) => [norm(nm), { n, m, up }]));
  const toItem = ([code, name, d1, d2, p1, p2]) => ({
    code,
    name: String(name || code).replace(/^東証業種別\s*/, ''),
    d1, d2, p1, p2,
    changePct: d1 !== d2 && p1 > 0 ? Math.round((p2 / p1 - 1) * 10000) / 100 : null,
  });
  const withMedian = (it) => {
    const m = it.d1 !== it.d2 ? med.get(norm(it.name)) : null;
    return Object.assign(it, {
      medianPct: m && m.m !== null ? Math.round(m.m * 100) / 100 : null,
      stockCount: m ? m.n : 0,
      upCount: m ? m.up : 0,
    });
  };
  let topix = null;
  const sectors = [];
  rows.forEach((x) => {
    if (x[0] === '0000') topix = toItem(x);
    else sectors.push(withMedian(toItem(x)));
  });
  sectors.sort((a, b) => {
    if (a.changePct === null || b.changePct === null) {
      if (a.changePct === b.changePct) return a.code < b.code ? -1 : 1;
      return a.changePct === null ? 1 : -1;
    }
    return b.changePct - a.changePct || (a.code < b.code ? -1 : 1);
  });
  return { topix, sectors };
}

module.exports = {
  fetchLatestPriceDate,
  fetchPrevTradingDate,
  fetchTags,
  fetchPerformance,
  fetchSectorPerformance,
  shapeSectorPerformance,
};
