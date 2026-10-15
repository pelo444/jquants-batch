'use strict';

/**
 * 銘柄購入の流れ(/purchase)のルーティング。server.js から app.use(purchaseRoutes({ db, getTags })) で組み込む。
 * 設計は claude/purchase_flow_design.md、表は ddl/29_purchase_flow.sql、クエリは purchaseQuery.js。
 *
 * 【この画面の約束】
 *   ・リストから外しても行は消さない(REMOVED_AT を入れる)。いつ入れて、いつ外したかを残すため。
 *   ・検討を終えたリストも消さない(CLOSED_AT を入れる)。
 *   ・上限は1リスト20銘柄。保存のときにサーバー側でも確かめる。
 *   ・個人の判断の記録なので、既定の 127.0.0.1 以外で待ち受けるときは認証を先に入れること。
 */

const path = require('path');
const express = require('express');

const pq = require('./purchaseQuery');
const fq = require('./purchaseFundQuery');
const { evaluate: evaluateFund } = require('./fundamentals');
const { evaluate: evaluateTech } = require('./technicals');
const pc = require('./purchaseCheck');

// 業種内の比較に使う全銘柄の値は、全銘柄を走査するので30分持つ
const STATS_TTL_MS = 30 * 60 * 1000;
let statsCache = null;
let statsInFlight = null;
async function industryStats(db) {
  if (statsCache && statsCache.expires > Date.now()) return statsCache.value;
  if (statsInFlight) return statsInFlight;
  statsInFlight = db.withConnection((c) => fq.fetchIndustryStats(c))
    .then((v) => { statsCache = { value: v, expires: Date.now() + STATS_TTL_MS }; return v; })
    .finally(() => { statsInFlight = null; });
  return statsInFlight;
}

// 外す候補(追加下落スコアの上位10%)も全銘柄を走査するので30分持つ
let avoidCache = null;
let avoidInFlight = null;
async function avoidSet(db) {
  if (avoidCache && avoidCache.expires > Date.now()) return avoidCache.value;
  if (avoidInFlight) return avoidInFlight;
  avoidInFlight = db.withConnection((c) => fq.fetchAvoidSet(c))
    .then((v) => { avoidCache = { value: v, expires: Date.now() + STATS_TTL_MS }; return v; })
    .finally(() => { avoidInFlight = null; });
  return avoidInFlight;
}

/** b) ファンダメンタルの判定(リストの表示と、d) の判断時の値の両方で使う) */
async function fundRowsFor(c, codes, stats) {
  const [info, fin, px, revs] = await Promise.all([
    pq.fetchStockRows(c, { codes }),
    fq.fetchFinancialRows(c, codes),
    fq.fetchPriceAndSplits(c, codes),
    fq.fetchRevisions(c, codes, 90),
  ]);
  const byInfo = {};
  info.forEach((r) => { byInfo[r.code] = r; });
  return codes.map((code) => {
    const key = stats.codeGroup[code];
    const g = key ? stats.groups[key] : null;
    const ev = evaluateFund({
      close: px[code].close, priceDate: px[code].priceDate, splits: px[code].splits,
      rows: fin[code] || [], revisions: revs[code] || [],
      sector: g ? { opm: g.opm, eqar: g.eqar, per: g.per, groupName: g.name } : null,
      marketPerMedian: stats.marketPerMedian,
    });
    const i = byInfo[code] || {};
    return { code, name: i.name || null, sector: i.sector || null, market: i.market || null, ...ev };
  });
}

/** b) テクニカルの判定(同上) */
async function techRowsFor(c, codes) {
  const [info, daily, margin] = await Promise.all([
    pq.fetchStockRows(c, { codes }),
    fq.fetchDailyOhlc(c, codes),
    fq.fetchMarginLatest(c, codes),
  ]);
  const byInfo = {};
  info.forEach((r) => { byInfo[r.code] = r; });
  return codes.map((code) => {
    const ev = evaluateTech({ daily: daily[code] || [], margin: margin[code] || null });
    const i = byInfo[code] || {};
    return { code, name: i.name || null, ...ev };
  });
}

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class NotFound extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

const FROMS = ['SECTOR', 'TAG', 'MANUAL'];

/** 4桁(または5桁)のコード。全角は半角に直す。4桁は末尾に0を付けて J-Quants の5桁に揃える */
function vCode(v) {
  const c = String(v).trim().toUpperCase().replace(/[０-９Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^[0-9A-Z]{4}$/.test(c)) return c + '0';
  if (/^[0-9A-Z]{5}$/.test(c)) return c;
  throw new BadRequest(`銘柄コードは4桁(または5桁)で入力してください: "${v}"`);
}

function splitList(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.from(new Set(String(v).split(/[,\s、]+/).map((s) => s.trim()).filter(Boolean)));
}

function vId(v, label = 'ID') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`${label}が不正です: "${v}"`);
  return n;
}

function vText(v, label, max, { required = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) {
    if (required) throw new BadRequest(`${label}を入力してください`);
    return null;
  }
  if (s.length > max) throw new BadRequest(`${label}は${max}文字までです(${s.length}文字)`);
  return s;
}

module.exports = function purchaseRoutes({ db, getTags }) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  router.get(['/purchase', '/purchase/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'purchase.html'));
  });
  router.get(['/purchase/check', '/purchase/check/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'purchase-check.html'));
  });

  router.use('/api/purchase', express.json({ limit: '1mb' }));

  //---------------------------------------------------------- メタ(業種・タグ・リスト)
  router.get('/api/purchase/meta', wrap(async (req, res) => {
    const [sectors, lists, meta] = await Promise.all([
      db.withConnection((c) => pq.fetchSectors(c)),
      db.withConnection((c) => pq.fetchLists(c)),
      getTags(),
    ]);
    res.json({ maxItems: pq.MAX_ITEMS, latestDate: meta.latestDate, sectors, tags: meta.tags, lists });
  }));

  //---------------------------------------------------------- 外す候補(追加下落スコアの上位10%)
  router.get('/api/purchase/avoid', wrap(async (req, res) => {
    res.json(await avoidSet(db));
  }));

  //---------------------------------------------------------- 銘柄一覧
  // ?sectors=3650,3600 / ?tags=a,b / ?codes=7203,6758 のどれか1つ
  router.get('/api/purchase/stocks', wrap(async (req, res) => {
    const sectors = splitList(req.query.sectors);
    const tags = splitList(req.query.tags);
    const codes = splitList(req.query.codes).map(vCode);
    const given = [sectors, tags, codes].filter((a) => a.length).length;
    if (given !== 1) throw new BadRequest('業種・タグ・銘柄コードのどれか1つを指定してください');
    if (sectors.some((s) => !/^\d{4}$/.test(s))) throw new BadRequest('業種コードが不正です');
    if (sectors.length > 33 || tags.length > 40 || codes.length > 100) throw new BadRequest('指定が多すぎます');
    if (tags.length) {
      const known = new Set((await getTags()).tags.map((t) => t.tagName));
      const unknown = tags.filter((t) => !known.has(t));
      if (unknown.length) throw new BadRequest(`存在しないタグです: ${unknown.join(', ')}`);
    }
    const rows = await db.withConnection((c) => pq.fetchStockRows(c, { sectors, tags, codes }));
    const found = new Set(rows.map((r) => r.code));
    res.json({ count: rows.length, rows, missing: codes.filter((c) => !found.has(c)) });
  }));

  //---------------------------------------------------------- リスト
  router.post('/api/purchase/lists', wrap(async (req, res) => {
    const b = req.body || {};
    const name = vText(b.name, 'リスト名', 100, { required: true });
    const note = vText(b.note, 'メモ', 1000);
    const listId = await db.withConnection(async (c) => {
      try {
        return await pq.createList(c, { name, note });
      } catch (e) {
        if (e.errorNum === 1) throw new BadRequest(`同じ名前のリストがあります: ${name}`);
        throw e;
      }
    });
    res.status(201).json({ listId });
  }));

  router.get('/api/purchase/lists/:id', wrap(async (req, res) => {
    const listId = vId(req.params.id, 'リストID');
    const list = await db.withConnection(async (c) => {
      const l = await pq.fetchList(c, listId);
      if (!l) return null;
      l.rows = l.items.length ? await pq.fetchStockRows(c, { codes: l.items.map((i) => i.code) }) : [];
      return l;
    });
    if (!list) throw new NotFound(`リスト #${listId} がありません`);
    res.json(list);
  }));

  // リストの中身を丸ごと送る。差分(追加・外す)はサーバー側で計算する
  router.put('/api/purchase/lists/:id/items', wrap(async (req, res) => {
    const listId = vId(req.params.id, 'リストID');
    const b = req.body || {};
    if (!Array.isArray(b.items)) throw new BadRequest('items の形式が不正です');
    const seen = new Set();
    const items = [];
    for (const x of b.items) {
      const code = vCode(x && x.code);
      if (seen.has(code)) continue;
      seen.add(code);
      const from = FROMS.includes(x.from) ? x.from : 'MANUAL';
      items.push({ code, from, detail: from === 'MANUAL' ? null : vText(x.detail, '追加元', 100) });
    }
    if (items.length > pq.MAX_ITEMS) {
      throw new BadRequest(`1つのリストに入れられるのは${pq.MAX_ITEMS}銘柄までです(${items.length}銘柄)`);
    }
    const out = await db.withConnection(async (c) => {
      const l = await pq.fetchList(c, listId);
      if (!l) throw new NotFound(`リスト #${listId} がありません`);
      const exist = await pq.existingCodes(c, items.map((i) => i.code));
      const unknown = items.filter((i) => !exist.has(i.code)).map((i) => i.code);
      if (unknown.length) throw new BadRequest(`銘柄マスタにないコードです: ${unknown.map((s) => s.slice(0, 4)).join(', ')}`);
      return pq.saveItems(c, listId, items);
    });
    res.json(out);
  }));

  //---------------------------------------------------------- b) ファンダメンタル参考情報
  // 保存済みのリストの中身(外していない銘柄)について判定する。保存は画面側が先に行う
  router.get('/api/purchase/lists/:id/fundamentals', wrap(async (req, res) => {
    const listId = vId(req.params.id, 'リストID');
    const stats = await industryStats(db);
    const out = await db.withConnection(async (c) => {
      const l = await pq.fetchList(c, listId);
      if (!l) throw new NotFound(`リスト #${listId} がありません`);
      const codes = l.items.map((i) => i.code);
      if (!codes.length) return { listId, rows: [] };
      const rows = await fundRowsFor(c, codes, stats);
      return { listId, rows, marketPerMedian: stats.marketPerMedian };
    });
    res.json(out);
  }));

  //---------------------------------------------------------- b) テクニカル参考情報
  router.get('/api/purchase/lists/:id/technicals', wrap(async (req, res) => {
    const listId = vId(req.params.id, 'リストID');
    const out = await db.withConnection(async (c) => {
      const l = await pq.fetchList(c, listId);
      if (!l) throw new NotFound(`リスト #${listId} がありません`);
      const codes = l.items.map((i) => i.code);
      if (!codes.length) return { listId, rows: [] };
      const rows = await techRowsFor(c, codes);
      return { listId, rows };
    });
    res.json(out);
  }));

  //---------------------------------------------------------- c) 損失回避チェック
  /** チェックの入力を検証する。銘柄はリストに入っている(外していない)ものに限る */
  async function checkInput(c, q) {
    const listId = vId(q.list, 'リストID');
    const codes = Array.from(new Set((Array.isArray(q.codes) ? q.codes : splitList(q.codes)).map(vCode)));
    if (!codes.length) throw new BadRequest('銘柄を選んでください');
    if (codes.length > pc.MAX_CODES) throw new BadRequest(`損失回避チェックは${pc.MAX_CODES}銘柄までです(${codes.length}銘柄)`);
    const l = await pq.fetchList(c, listId);
    if (!l) throw new NotFound(`リスト #${listId} がありません`);
    const inList = new Set(l.items.map((i) => i.code));
    const outside = codes.filter((x) => !inList.has(x));
    if (outside.length) throw new BadRequest(`リストに入っていない銘柄です: ${outside.map((x) => x.slice(0, 4)).join(', ')}`);
    const posNum = (v, label) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${label}は正の数で入力してください: "${v}"`);
      return n;
    };
    const stopsRaw = Array.isArray(q.stopPcts) ? q.stopPcts : splitList(q.stops || '10,15');
    const stopPcts = stopsRaw.map((x) => posNum(x, '損切り幅')).filter((x) => x != null);
    if (!stopPcts.length || stopPcts.length > 4 || stopPcts.some((x) => x >= 100)) throw new BadRequest('損切り幅は 1〜99 の数を4つまで入力してください');
    const buys = {};
    const rawBuys = q.buys && typeof q.buys === 'object' ? Object.entries(q.buys)
      : splitList(q.buys).map((x) => x.split(':'));
    for (const [k, v] of rawBuys) {
      const code = vCode(k);
      if (codes.includes(code) && v !== undefined && v !== '') buys[code] = posNum(v, '買値');
    }
    // 銘柄ごとの株数(正の整数。無ければ purchaseCheck の既定 100株)
    const shares = {};
    const rawShares = q.shares && typeof q.shares === 'object' ? Object.entries(q.shares)
      : splitList(q.shares).map((x) => x.split(':'));
    for (const [k, v] of rawShares) {
      const code = vCode(k);
      if (!codes.includes(code) || v === undefined || v === '') continue;
      const n = Number(String(v).replace(/,/g, ''));
      if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`株数は正の整数で入力してください: "${v}"`);
      shares[code] = n;
    }
    // 2 赤信号で「外す」にした銘柄。3 の金額の配分から除く
    const exclude = (Array.isArray(q.exclude) ? q.exclude : splitList(q.exclude)).map(vCode).filter((x) => codes.includes(x));
    return { listId, list: l, codes, exclude, amount: posNum(q.amount, '買う額の合計'), stopPcts, buys, shares };
  }

  router.get('/api/purchase/check', wrap(async (req, res) => {
    // 外す候補は全銘柄を走査するので、a) と同じ30分のキャッシュを使う
    const avoid = await avoidSet(db).catch((e) => ({ asOf: null, population: 0, d10: {}, error: e.message }));
    const out = await db.withConnection(async (c) => {
      const p = await checkInput(c, req.query);
      const r = await pc.runCheck(c, { ...p, avoid });
      return { listId: p.listId, listName: p.list.name, ...r };
    });
    res.json(out);
  }));

  router.get('/api/purchase/check/saved', wrap(async (req, res) => {
    const listId = vId(req.query.list, 'リストID');
    const codes = splitList(req.query.codes).map(vCode);
    res.json(await db.withConnection((c) => pc.fetchSaved(c, listId, codes)));
  }));

  router.post('/api/purchase/check/answers', wrap(async (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.answers)) throw new BadRequest('answers の形式が不正です');
    const out = await db.withConnection(async (c) => {
      const p = await checkInput(c, { list: b.listId, codes: b.codes, amount: b.amount, stopPcts: b.stopPcts, buys: b.buys, shares: b.shares });
      const answers = b.answers.map((a) => {
        const code = a.code === pc.ALL ? pc.ALL : vCode(a.code);
        if (code !== pc.ALL && !p.codes.includes(code)) throw new BadRequest(`チェック対象でない銘柄の答えです: ${code}`);
        if (!pc.QID_RE.test(String(a.qid))) throw new BadRequest(`問いの番号が不正です: ${a.qid}`);
        return { code, qid: String(a.qid), answer: vText(a.answer, '答え', 2000) };
      });
      return pc.saveRun(c, { ...p, answers });
    });
    res.status(201).json(out);
  }));

  //---------------------------------------------------------- d) 判断メモの登録時に残す値
  // /journal で判断を記録した直後に呼ぶ。その時点の F・T・c) の値を計算し直して JNL_DECISION_SNAPSHOT に1行書く。
  // 判断の行(JNL_DECISION)は追記専用で列を足さないため、別表にしている(ddl/29)。
  router.post('/api/purchase/snapshot', wrap(async (req, res) => {
    const b = req.body || {};
    const decisionId = vId(b.decisionId, '判断ID');
    const listId = vId(b.listId, 'リストID');
    const runId = b.runId ? vId(b.runId, 'チェックの記録ID') : null;
    const stats = await industryStats(db);
    const avoid = await avoidSet(db).catch((e) => ({ asOf: null, population: 0, d10: {}, error: e.message }));
    const out = await db.withConnection(async (c) => {
      const d = await pc.fetchDecisionHead(c, decisionId);
      if (!d) throw new NotFound(`判断 #${decisionId} がありません`);
      if (await pc.snapshotExists(c, decisionId)) throw new BadRequest(`判断 #${decisionId} の値はすでに残しています`);
      const l = await pq.fetchList(c, listId);
      if (!l) throw new NotFound(`リスト #${listId} がありません`);
      const run = runId ? await pc.fetchRun(c, runId) : null;
      if (runId && (!run || run.listId !== listId)) throw new BadRequest(`チェックの記録 #${runId} はリスト #${listId} のものではありません`);
      const [[f], [t], chk] = await Promise.all([
        fundRowsFor(c, [d.code], stats),
        techRowsFor(c, [d.code]),
        pc.checkSnapshot(c, d.code, run, avoid),
      ]);
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        decision: d,
        list: { listId, name: l.name, inList: l.items.some((i) => i.code === d.code) },
        run: run ? { runId: run.runId, runAt: run.runAt, codes: run.codes, stopPcts: run.stopPcts } : null,
        F: f,
        T: t,
        check: chk,
      };
      await pc.insertSnapshot(c, { decisionId, listId, runId, payload });
      return { decisionId, asOf: chk.asOf };
    });
    res.status(201).json(out);
  }));

  router.post('/api/purchase/lists/:id/close', wrap(async (req, res) => {
    const listId = vId(req.params.id, 'リストID');
    const closed = !(req.body && req.body.reopen);
    const n = await db.withConnection((c) => pq.setListClosed(c, listId, closed));
    if (!n) throw new NotFound(`リスト #${listId} がありません`);
    res.json({ ok: true, closed });
  }));

  return router;
};
