'use strict';

/**
 * 銘柄グループ(/groups)。表は ddl/40_stock_group.sql(JNL_STOCK_GROUP / JNL_STOCK_GROUP_ITEM)。
 *
 *   グループの並びは作った順、グループの中の銘柄の並びは足した順。
 *   グループ名は前後の空白を取り、途中の連続した空白は1つにまとめる。空・100文字超は不可。同じ名前は不可。
 *   すでにグループに入っている銘柄を足しても何もしない(並び順も変えない)。
 *   銘柄マスタに無いコードは足さず、unknown として返す。
 *   グループを消すと中の銘柄も消える。外した銘柄は行ごと消す。
 *   変更した後は、毎回グループの一覧を丸ごと返す(画面はそれで描き直す)。
 *
 * 表がまだ無いとき(ORA-00942)は、呼び出し側(server.js)が「DDL を流してください」と返す。
 */

const oracledb = require('oracledb');
const { _internal: { parseCodes } } = require('./chartWatch');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const MAX_NAME = 100;
const MAX_ADD = 500; // 1回で足せる数

class GroupError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function shortCode(c) { return c && c.length === 5 && c[4] === '0' ? c.slice(0, 4) : c; }

/** グループ名をそろえる(純粋関数)。不正なら GroupError */
function cleanName(input) {
  const s = String(input == null ? '' : input).replace(/\s+/g, ' ').trim();
  if (!s) throw new GroupError('グループ名を入れてください');
  if (s.length > MAX_NAME) throw new GroupError(`グループ名は${MAX_NAME}文字までです`);
  return s;
}

/** 一意制約違反(ORA-00001)を「同じ名前があります」に言い換える */
function dupName(err, name) {
  if (err && err.errorNum === 1) return new GroupError(`「${name}」という名前のグループはすでにあります`);
  return err;
}

/** グループの一覧(中の銘柄つき) */
async function fetchGroups(conn) {
  const g = await conn.execute(
    `SELECT group_id, group_name FROM jnl_stock_group ORDER BY created_at, group_id`, {}, OBJ);
  const it = await conn.execute(
    `SELECT i.group_id, i.code, m.co_name
       FROM jnl_stock_group_item i
       LEFT JOIN equity_master m ON m.code = i.code
      ORDER BY i.added_at, i.item_id`, {}, OBJ);
  const byId = new Map();
  const groups = g.rows.map((x) => {
    const o = { id: x.GROUP_ID, name: x.GROUP_NAME, items: [] };
    byId.set(o.id, o);
    return o;
  });
  for (const x of it.rows) {
    const o = byId.get(x.GROUP_ID);
    if (o) o.items.push({ code: x.CODE, shortCode: shortCode(x.CODE), name: x.CO_NAME || '' });
  }
  return groups;
}

async function mustExist(conn, id) {
  const r = await conn.execute(`SELECT group_name FROM jnl_stock_group WHERE group_id = :id`, { id }, OBJ);
  if (!r.rows.length) throw new GroupError('そのグループはありません(別の画面で消された可能性があります)');
  return r.rows[0].GROUP_NAME;
}

async function createGroup(conn, rawName) {
  const name = cleanName(rawName);
  const out = await conn.execute(
    `INSERT INTO jnl_stock_group (group_name) VALUES (:name) RETURNING group_id INTO :id`,
    { name, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
  ).catch((e) => { throw dupName(e, name); });
  await conn.commit();
  return { id: out.outBinds.id[0], groups: await fetchGroups(conn) };
}

async function renameGroup(conn, id, rawName) {
  const name = cleanName(rawName);
  const r = await conn.execute(
    `UPDATE jnl_stock_group SET group_name = :name WHERE group_id = :id`, { name, id }
  ).catch((e) => { throw dupName(e, name); });
  if (!r.rowsAffected) throw new GroupError('そのグループはありません(別の画面で消された可能性があります)');
  await conn.commit();
  return { groups: await fetchGroups(conn) };
}

async function deleteGroup(conn, id) {
  await conn.execute(`DELETE FROM jnl_stock_group WHERE group_id = :id`, { id });
  await conn.commit();
  return { groups: await fetchGroups(conn) };
}

/**
 * グループに足す。
 * @returns {Promise<{added:string[], already:string[], unknown:string[], bad:string[], tooMany:boolean, groups:object[]}>}
 */
async function addItems(conn, id, input) {
  await mustExist(conn, id);
  const { codes, bad } = parseCodes(input);
  const tooMany = codes.length > MAX_ADD;
  const list = codes.slice(0, MAX_ADD);
  const added = [], already = [], unknown = [];
  if (list.length) {
    const binds = {};
    const ph = list.map((c, i) => { binds['c' + i] = c; return ':c' + i; }).join(',');
    const known = new Set((await conn.execute(
      `SELECT code FROM equity_master WHERE code IN (${ph})`, binds, OBJ)).rows.map((x) => x.CODE));
    const exist = new Set((await conn.execute(
      `SELECT code FROM jnl_stock_group_item WHERE group_id = :gid AND code IN (${ph})`,
      Object.assign({ gid: id }, binds), OBJ)).rows.map((x) => x.CODE));
    for (const c of list) {
      if (!known.has(c)) { unknown.push(shortCode(c)); continue; }
      if (exist.has(c)) { already.push(shortCode(c)); continue; }
      // カードの順に1件ずつ入れる(ADDED_AT が同じになっても ITEM_ID の順で並ぶ)
      await conn.execute(`INSERT INTO jnl_stock_group_item (group_id, code) VALUES (:gid, :c)`, { gid: id, c });
      added.push(shortCode(c));
    }
    await conn.commit();
  }
  return { added, already, unknown, bad, tooMany, groups: await fetchGroups(conn) };
}

async function removeItem(conn, id, code) {
  await conn.execute(`DELETE FROM jnl_stock_group_item WHERE group_id = :id AND code = :c`, { id, c: code });
  await conn.commit();
  return { groups: await fetchGroups(conn) };
}

module.exports = {
  fetchGroups, createGroup, renameGroup, deleteGroup, addItems, removeItem,
  MAX_NAME, MAX_ADD, _internal: { cleanName },
};
