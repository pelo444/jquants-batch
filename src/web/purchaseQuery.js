'use strict';

/**
 * 銘柄購入の流れ(/purchase)のクエリ。設計は claude/purchase_flow_design.md、表は ddl/29_purchase_flow.sql。
 *
 * db.js は outFormat を既定(ARRAY)のままにしているので、呼び出しごとに OUT_FORMAT_OBJECT を指定する
 * (journalQuery.js と同じ)。
 *
 * 【一覧の数字の出し方】
 *   株価       最新の終値(調整前の生の値)
 *   売買代金   直近20営業日の平均(円/日)
 *   52週高値からの位置  直近250営業日の調整後終値の最高値に対する、最新終値の位置(%)。
 *              分割調整は「その日より後の AdjFactor の累積積」を終値に掛ける(webQuery.js と同じ)
 *   時価総額   最新の終値 × 株式数。株式数は最新の決算短信の期末発行済株式数 − 期末自己株式数。
 *              決算短信の後に株式分割があれば、その AdjFactor の積で割って今の株数に直す
 *              (2:1 の分割は AdjFactor 0.5 なので、株数は 2 倍になる)
 */

const oracledb = require('oracledb');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };

const MAX_ITEMS = 20;

/** IN 句のバインド: inBinds('c', ['a','b']) → { sql: ':c0,:c1', binds: {c0:'a', c1:'b'} } */
function inBinds(prefix, values) {
  const binds = {};
  const sql = values.map((v, i) => { binds[prefix + i] = v; return ':' + prefix + i; }).join(',');
  return { sql, binds };
}

//------------------------------------------------------------------
// メタ
//------------------------------------------------------------------

/** 33業種(「その他」= ETF・REIT 等の 9999 は除く)と上場銘柄数 */
async function fetchSectors(conn) {
  const r = await conn.execute(
    `SELECT sector33_code, MAX(sector33_name) AS name, COUNT(*) AS cnt
     FROM equity_master
     WHERE delisted_flag = 'N' AND sector33_code IS NOT NULL AND sector33_code <> '9999'
       AND (market_name IS NULL OR market_name <> 'TOKYO PRO MARKET')
     GROUP BY sector33_code
     ORDER BY sector33_code`, {}, OBJ);
  return r.rows.map((x) => ({ code: x.SECTOR33_CODE, name: x.NAME, count: x.CNT }));
}

async function fetchLists(conn) {
  const r = await conn.execute(
    `SELECT l.list_id, l.list_name, l.note,
            TO_CHAR(l.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
            TO_CHAR(l.closed_at, 'YYYY-MM-DD HH24:MI') AS closed_at,
            (SELECT COUNT(*) FROM jnl_candidate c WHERE c.list_id = l.list_id AND c.removed_at IS NULL) AS cnt
     FROM jnl_candidate_list l
     ORDER BY CASE WHEN l.closed_at IS NULL THEN 0 ELSE 1 END, l.created_at DESC`, {}, OBJ);
  return r.rows.map((x) => ({
    listId: x.LIST_ID, name: x.LIST_NAME, note: x.NOTE,
    createdAt: x.CREATED_AT, closedAt: x.CLOSED_AT, count: x.CNT,
  }));
}

//------------------------------------------------------------------
// 銘柄一覧(業種・タグ・コード)
//------------------------------------------------------------------

/**
 * 対象銘柄の一覧と数字。
 * @param {object} t  { sectors?: string[], tags?: string[], codes?: string[] } のどれか1つ
 */
async function fetchStockRows(conn, t) {
  let targetSql;
  let binds = {};
  if (t.sectors && t.sectors.length) {
    const b = inBinds('s', t.sectors);
    binds = b.binds;
    targetSql = `SELECT em.code FROM equity_master em
                 WHERE em.delisted_flag = 'N' AND em.sector33_code IN (${b.sql})
                   AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')`;
  } else if (t.tags && t.tags.length) {
    const b = inBinds('t', t.tags);
    binds = b.binds;
    targetSql = `SELECT DISTINCT ft.code FROM favorite_tag ft
                 JOIN equity_master em ON em.code = ft.code AND em.delisted_flag = 'N'
                 WHERE ft.tag_name IN (${b.sql})`;
  } else if (t.codes && t.codes.length) {
    const b = inBinds('c', t.codes);
    binds = b.binds;
    targetSql = `SELECT em.code FROM equity_master em WHERE em.code IN (${b.sql})`;
  } else {
    return [];
  }

  const sql = `
    WITH target AS (${targetSql}),
    lastd AS (SELECT MAX(price_date) AS d FROM equity_price_daily),
    px AS (
        SELECT p.code, p.price_date, p.close_price, p.turnover_value,
               ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn,
               NVL(EXP(SUM(LN(NULLIF(p.adj_factor, 0))) OVER (
                     PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1) AS cum
        FROM equity_price_daily p, lastd
        WHERE p.code IN (SELECT code FROM target)
          AND p.price_date > lastd.d - 400
          AND p.close_price IS NOT NULL
    ),
    agg AS (
        SELECT code,
               MAX(CASE WHEN rn = 1 THEN price_date END)          AS last_date,
               MAX(CASE WHEN rn = 1 THEN close_price END)         AS last_close,
               MAX(CASE WHEN rn <= 250 THEN close_price * cum END) AS hi250,
               AVG(CASE WHEN rn <= 20 THEN turnover_value END)     AS tv20,
               COUNT(CASE WHEN rn <= 250 THEN 1 END)               AS n250
        FROM px GROUP BY code
    ),
    fs AS (
        SELECT code, disc_date, sh_out_fy - NVL(tr_sh_fy, 0) AS shares FROM (
            SELECT f.code, f.disc_date, f.sh_out_fy, f.tr_sh_fy,
                   ROW_NUMBER() OVER (PARTITION BY f.code ORDER BY f.disc_date DESC, f.disc_no DESC) AS r
            FROM financial_summary f
            WHERE f.code IN (SELECT code FROM target) AND f.sh_out_fy IS NOT NULL)
        WHERE r = 1
    ),
    spl AS (
        SELECT fs.code, EXP(SUM(LN(NULLIF(p.adj_factor, 0)))) AS prodf
        FROM fs JOIN equity_price_daily p
          ON p.code = fs.code AND p.price_date > fs.disc_date AND p.adj_factor <> 1
        GROUP BY fs.code
    )
    SELECT em.code, em.co_name, em.market_name, em.sector33_code, em.sector33_name, em.delisted_flag,
           TO_CHAR(a.last_date, 'YYYY-MM-DD') AS last_date,
           a.last_close,
           a.last_close * fs.shares / NVL(spl.prodf, 1) AS market_cap,
           a.tv20,
           CASE WHEN a.hi250 > 0 THEN (a.last_close / a.hi250 - 1) * 100 END AS pos52w,
           a.n250
    FROM target t
    JOIN equity_master em ON em.code = t.code
    LEFT JOIN agg a ON a.code = t.code
    LEFT JOIN fs ON fs.code = t.code
    LEFT JOIN spl ON spl.code = t.code
    ORDER BY em.code`;

  const r = await conn.execute(sql, binds, OBJ);
  return r.rows.map((x) => ({
    code: x.CODE,
    name: x.CO_NAME,
    market: x.MARKET_NAME,
    sectorCode: x.SECTOR33_CODE,
    sector: x.SECTOR33_NAME,
    delisted: x.DELISTED_FLAG === 'Y',
    lastDate: x.LAST_DATE,
    close: x.LAST_CLOSE,
    marketCap: x.MARKET_CAP,
    turnover20: x.TV20,
    pos52w: x.POS52W,
    days250: x.N250,
  }));
}

/** 銘柄マスタにあるコードだけを返す */
async function existingCodes(conn, codes) {
  if (!codes.length) return new Set();
  const b = inBinds('c', codes);
  const r = await conn.execute(`SELECT code FROM equity_master WHERE code IN (${b.sql})`, b.binds);
  return new Set(r.rows.map((x) => x[0]));
}

//------------------------------------------------------------------
// リスト
//------------------------------------------------------------------

async function createList(conn, { name, note }) {
  const r = await conn.execute(
    `INSERT INTO jnl_candidate_list (list_name, note) VALUES (:name, :note)
     RETURNING list_id INTO :id`,
    { name, note, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } });
  await conn.commit();
  return r.outBinds.id[0];
}

async function setListClosed(conn, listId, closed) {
  const r = await conn.execute(
    `UPDATE jnl_candidate_list SET closed_at = ${closed ? 'SYSTIMESTAMP' : 'NULL'} WHERE list_id = :id`,
    { id: listId });
  await conn.commit();
  return r.rowsAffected;
}

async function fetchList(conn, listId) {
  const r = await conn.execute(
    `SELECT list_id, list_name, note,
            TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
            TO_CHAR(closed_at, 'YYYY-MM-DD HH24:MI') AS closed_at
     FROM jnl_candidate_list WHERE list_id = :id`, { id: listId }, OBJ);
  if (!r.rows.length) return null;
  const x = r.rows[0];
  const items = await conn.execute(
    `SELECT code, added_from, added_detail, note, TO_CHAR(added_at, 'YYYY-MM-DD HH24:MI') AS added_at
     FROM jnl_candidate WHERE list_id = :id AND removed_at IS NULL
     ORDER BY added_at, cand_id`, { id: listId }, OBJ);
  const removed = await conn.execute(
    `SELECT c.code, em.co_name, TO_CHAR(c.added_at, 'YYYY-MM-DD HH24:MI') AS added_at,
            TO_CHAR(c.removed_at, 'YYYY-MM-DD HH24:MI') AS removed_at
     FROM jnl_candidate c
     LEFT JOIN equity_master em ON em.code = c.code
     WHERE c.list_id = :id AND c.removed_at IS NOT NULL
     ORDER BY c.removed_at DESC, c.cand_id DESC`, { id: listId }, OBJ);
  return {
    listId: x.LIST_ID, name: x.LIST_NAME, note: x.NOTE, createdAt: x.CREATED_AT, closedAt: x.CLOSED_AT,
    items: items.rows.map((i) => ({
      code: i.CODE, from: i.ADDED_FROM, detail: i.ADDED_DETAIL, note: i.NOTE, addedAt: i.ADDED_AT,
    })),
    removed: removed.rows.map((i) => ({ code: i.CODE, name: i.CO_NAME, addedAt: i.ADDED_AT, removedAt: i.REMOVED_AT })),
  };
}

/**
 * リストの中身を items に揃える。新しいコードは行を追加、無くなったコードは REMOVED_AT を入れる。
 * 1つのトランザクションで行い、上限(外していない行の数)を超える場合は何も書かない。
 * @returns {{added: string[], removed: string[]}}
 */
async function saveItems(conn, listId, items) {
  if (items.length > MAX_ITEMS) throw Object.assign(new Error(`1つのリストに入れられるのは${MAX_ITEMS}銘柄までです`), { status: 400 });
  // 同じリストへの同時保存で上限や一意索引を越えないよう、リストの行をロックしてから比べる
  await conn.execute(`SELECT list_id FROM jnl_candidate_list WHERE list_id = :id FOR UPDATE`, { id: listId });
  const cur = await conn.execute(
    `SELECT code FROM jnl_candidate WHERE list_id = :id AND removed_at IS NULL`, { id: listId });
  const curSet = new Set(cur.rows.map((x) => x[0]));
  const nextSet = new Set(items.map((i) => i.code));
  const removed = [...curSet].filter((c) => !nextSet.has(c));
  const added = items.filter((i) => !curSet.has(i.code));

  for (const code of removed) {
    await conn.execute(
      `UPDATE jnl_candidate SET removed_at = SYSTIMESTAMP
       WHERE list_id = :id AND code = :code AND removed_at IS NULL`, { id: listId, code });
  }
  for (const i of added) {
    await conn.execute(
      `INSERT INTO jnl_candidate (list_id, code, added_from, added_detail)
       VALUES (:id, :code, :src, :detail)`,
      { id: listId, code: i.code, src: i.from, detail: i.detail || null });
  }
  await conn.commit();
  return { added: added.map((i) => i.code), removed };
}

module.exports = {
  MAX_ITEMS,
  fetchSectors, fetchLists, fetchStockRows, existingCodes,
  createList, setListClosed, fetchList, saveItems,
};
