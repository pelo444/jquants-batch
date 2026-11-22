'use strict';

/**
 * 個別チャート(/stockchart)の「調査対象」の一覧。表は ddl/39_chart_watch.sql(JNL_CHART_WATCH)。
 *
 *   一覧は1つ。並び順は登録した順(ADDED_AT・WATCH_ID の昇順)。
 *   すでに入っている銘柄を足しても何もしない(並び順も変えない)。
 *   銘柄マスタに無いコードは足さず、unknown として返す。
 *   外す・全部消すは行ごと消す(作業用の一覧なので履歴は残さない)。
 *
 * 表がまだ無いとき(ORA-00942)は、呼び出し側(server.js)が「DDL を流してください」と返す。
 */

const oracledb = require('oracledb');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const MAX_ADD = 500; // 1回で足せる数(貼り付けの打ち間違いで大量に入らないように)

function shortCode(c) { return c && c.length === 5 && c[4] === '0' ? c.slice(0, 4) : c; }

/**
 * 貼り付けた文字列や配列からコードを取り出す(純粋関数)。
 * 改行・カンマ・空白・タブなど、英数字以外を区切りとみなす。4桁は末尾に 0 を付けて5桁にする。
 * 4〜5桁でないものは bad に入れる。同じコードは1つにまとめる(最初に出た順を保つ)。
 * @returns {{codes:string[], bad:string[]}}
 */
function parseCodes(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input == null ? '' : input);
  const codes = [];
  const bad = [];
  const seen = new Set();
  raw.split(/[^0-9A-Za-z]+/).filter(Boolean).forEach((t) => {
    const u = t.toUpperCase();
    if (!/^[0-9][0-9A-Z]{3,4}$/.test(u)) { bad.push(t); return; }
    const c = u.length === 4 ? u + '0' : u;
    if (!seen.has(c)) { seen.add(c); codes.push(c); }
  });
  return { codes, bad };
}

/** 一覧(登録した順)。銘柄名は銘柄マスタから */
async function fetchWatch(conn) {
  const r = await conn.execute(
    `SELECT w.code, m.co_name
       FROM jnl_chart_watch w
       LEFT JOIN equity_master m ON m.code = w.code
      ORDER BY w.added_at, w.watch_id`, {}, OBJ);
  return r.rows.map((x) => ({ code: x.CODE, shortCode: shortCode(x.CODE), name: x.CO_NAME || '' }));
}

/**
 * 足す。銘柄マスタに無いコードは足さない。
 * @returns {Promise<{added:string[], already:string[], unknown:string[], bad:string[], tooMany:boolean, items:object[]}>}
 */
async function addWatch(conn, input) {
  const { codes, bad } = parseCodes(input);
  const tooMany = codes.length > MAX_ADD;
  const list = codes.slice(0, MAX_ADD);
  const added = [], already = [], unknown = [];
  if (list.length) {
    // 銘柄マスタにあるもの・すでに入っているものを先にまとめて引く(1000件の IN 制限より十分少ない)
    const binds = {};
    const ph = list.map((c, i) => { binds['c' + i] = c; return ':c' + i; }).join(',');
    const known = new Set((await conn.execute(
      `SELECT code FROM equity_master WHERE code IN (${ph})`, binds, OBJ)).rows.map((x) => x.CODE));
    const exist = new Set((await conn.execute(
      `SELECT code FROM jnl_chart_watch WHERE code IN (${ph})`, binds, OBJ)).rows.map((x) => x.CODE));
    for (const c of list) {
      if (!known.has(c)) { unknown.push(shortCode(c)); continue; }
      if (exist.has(c)) { already.push(shortCode(c)); continue; }
      // 貼り付けた順に1件ずつ入れる(ADDED_AT が同じになっても WATCH_ID の順で並ぶ)
      await conn.execute(`INSERT INTO jnl_chart_watch (code) VALUES (:c)`, { c });
      added.push(shortCode(c));
    }
    await conn.commit();
  }
  return { added, already, unknown, bad, tooMany, items: await fetchWatch(conn) };
}

/** 1銘柄外す */
async function removeWatch(conn, code) {
  await conn.execute(`DELETE FROM jnl_chart_watch WHERE code = :c`, { c: code });
  await conn.commit();
  return { items: await fetchWatch(conn) };
}

/** 全部消す */
async function clearWatch(conn) {
  await conn.execute(`DELETE FROM jnl_chart_watch`);
  await conn.commit();
  return { items: [] };
}

module.exports = { fetchWatch, addWatch, removeWatch, clearWatch, MAX_ADD, _internal: { parseCodes } };
