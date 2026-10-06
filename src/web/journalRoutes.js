'use strict';

/**
 * 売買記録(/journal)のルーティング。server.js から app.use(journalRoutes({ db })) で組み込む。
 *
 * 【この画面の約束】(docs/JOURNAL.md)
 *   ・判断(JNL_DECISION)は追記のみ。編集の口は作らない。訂正は新しい行で元の行を指す。
 *     結果を見てから理由を書き換えると、記録が自分に都合よく変わってしまうため。
 *   ・保有は約定から毎回計算する。保有の表を別に持たない。
 *   ・写真は画面側で長辺1600pxのJPEGに縮めてから送る(位置情報などのEXIFも落ちる)。
 *     サーバーは JPEG/PNG の中身であることだけ確かめて、そのまま保存する。
 *   ・個人の財務情報なので、既定の 127.0.0.1 以外で待ち受けるときは認証を先に入れること。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const jq = require('./journalQuery');
const { parseRakutenCsv } = require('./journalCsv');
const { computePositions, summarizeRealized } = require('./journalPositions');

const WORK_DIR = process.env.JQB_JOURNAL_WORK_DIR || path.resolve(__dirname, '../../../journal_work');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_NOTE = 10;
const MAX_CSV_BYTES = 5 * 1024 * 1024;

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

//------------------------------------------------------------------
// 入力検証
//------------------------------------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function vDate(v, label, { required = true, notFuture = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequest(`${label}を入力してください`);
    return null;
  }
  const s = String(v);
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
    throw new BadRequest(`${label}は YYYY-MM-DD 形式で入力してください: "${s}"`);
  }
  if (notFuture && s > todayLocal()) throw new BadRequest(`${label}に未来の日付は入れられません: ${s}`);
  return s;
}

function vCode(v, label = '銘柄コード', { required = true } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new BadRequest(`${label}を入力してください`);
    return null;
  }
  const c = String(v).trim().toUpperCase().replace(/[０-９Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^[0-9A-Z]{4}$/.test(c)) return c + '0';
  if (/^[0-9A-Z]{5}$/.test(c)) return c;
  throw new BadRequest(`${label}は4桁(または5桁)で入力してください: "${v}"`);
}

function vCodes(v) {
  if (v === undefined || v === null || v === '') return null;
  const list = (Array.isArray(v) ? v : String(v).split(/[,\s、]+/))
    .map((s) => String(s).trim()).filter(Boolean);
  const codes = Array.from(new Set(list.map((c) => vCode(c, '関連銘柄'))));
  if (codes.length > 30) throw new BadRequest('関連銘柄は30件までです');
  return codes.length ? codes.join(',') : null;
}

function vEnum(v, list, label, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequest(`${label}を選んでください`);
    return null;
  }
  if (!list.includes(v)) throw new BadRequest(`${label}の値が不正です: "${v}"`);
  return v;
}

function vNum(v, label, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new BadRequest(`${label}は ${min}〜${max} の${int ? '整数' : '数値'}で入力してください: "${v}"`);
  }
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

function vId(v, label = 'ID') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`${label}が不正です: "${v}"`);
  return n;
}

/** 画像: base64 → Buffer。JPEG/PNG の先頭バイトを確かめる */
function vImages(list) {
  if (!list) return [];
  if (!Array.isArray(list)) throw new BadRequest('images の形式が不正です');
  if (list.length > MAX_IMAGES_PER_NOTE) throw new BadRequest(`写真は1件のメモに${MAX_IMAGES_PER_NOTE}枚までです`);
  return list.map((img, i) => {
    const buf = Buffer.from(String(img.dataBase64 || ''), 'base64');
    if (!buf.length) throw new BadRequest(`${i + 1}枚目の写真が空です`);
    if (buf.length > MAX_IMAGE_BYTES) throw new BadRequest(`${i + 1}枚目の写真が大きすぎます(${buf.length}バイト)`);
    let mime;
    if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png';
    else throw new BadRequest(`${i + 1}枚目は JPEG/PNG ではありません`);
    return {
      buffer: buf, mime,
      fileName: vText(img.fileName, 'ファイル名', 300),
      width: vNum(img.width, '幅', { min: 1, max: 20000, int: true }),
      height: vNum(img.height, '高さ', { min: 1, max: 20000, int: true }),
    };
  });
}

function noteInput(b) {
  return {
    noteDate: vDate(b.noteDate, 'メモの日付'),
    body: vText(b.body, '本文', 100000),
    codes: vCodes(b.codes),
    ideaSource: vEnum(b.ideaSource, jq.SOURCES, '情報源', { required: false }),
    images: vImages(b.images),
  };
}

//------------------------------------------------------------------
// ルーター
//------------------------------------------------------------------
module.exports = function journalRoutes({ db }) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  router.get(['/journal', '/journal/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'journal.html'));
  });

  router.use('/api/journal', express.json({ limit: '40mb' }));

  //---------------------------------------------------------- メタ
  router.get('/api/journal/meta', (req, res) => {
    res.json({
      actions: jq.ACTIONS, reasons: jq.REASONS, sources: jq.SOURCES, verdicts: jq.VERDICTS,
      workDir: WORK_DIR, today: todayLocal(),
    });
  });

  router.get('/api/journal/lookup', wrap(async (req, res) => {
    const code = vCode(req.query.code);
    const info = await db.withConnection((c) => jq.lookupCode(c, code));
    if (!info) throw new NotFound(`銘柄マスタに ${code} がありません`);
    res.json(info);
  }));

  //---------------------------------------------------------- 約定CSVの取込
  router.post('/api/journal/import', wrap(async (req, res) => {
    const b = req.body || {};
    const buf = Buffer.from(String(b.dataBase64 || ''), 'base64');
    if (!buf.length) throw new BadRequest('CSVファイルが空です');
    if (buf.length > MAX_CSV_BYTES) throw new BadRequest('CSVファイルが大きすぎます(5MBまで)');
    const commit = b.commit === true;
    const fileName = vText(b.fileName, 'ファイル名', 300);
    const parsed = parseRakutenCsv(buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (commit && parsed.errors.length) {
      throw new BadRequest(`解釈できない行が${parsed.errors.length}行あります。プレビューで確認してください`);
    }
    const r = await db.withConnection((c) => jq.importTrades(c, {
      source: 'RAKUTEN_JP_STOCK', fileName, sha256, encoding: parsed.encoding, trades: parsed.trades, commit,
    }));
    res.json({
      committed: commit, batchId: r.batchId, encoding: parsed.encoding,
      headers: parsed.headers, unknownHeaders: parsed.unknownHeaders,
      total: r.total, inserted: r.inserted, duplicate: r.duplicate, errors: parsed.errors,
      rows: parsed.trades.slice(0, 2000).map((t) => ({
        line: t.line, tradeDate: t.tradeDate, code: t.code, name: t.name, accountType: t.accountType,
        tradeType: t.tradeType, sideRaw: t.sideRaw, positionKind: t.positionKind, positionEffect: t.positionEffect,
        qty: t.qty, price: t.price, fee: t.fee, tax: t.tax, settleAmount: t.settleAmount,
        duplicate: r.dupKeys.has(t.dedupKey),
      })),
    });
  }));

  router.get('/api/journal/imports', wrap(async (req, res) => {
    const rows = await db.withConnection((c) => jq.fetchImportBatches(c, 30));
    res.json({ rows });
  }));

  //---------------------------------------------------------- 約定と保有
  router.get('/api/journal/trades', wrap(async (req, res) => {
    const rows = await db.withConnection((c) => jq.fetchTrades(c));
    rows.reverse();
    res.json({ count: rows.length, rows: rows.slice(0, 1000) });
  }));

  router.get('/api/journal/positions', wrap(async (req, res) => {
    const out = await db.withConnection(async (c) => {
      const trades = await jq.fetchTrades(c);
      const codes = Array.from(new Set(trades.map((t) => t.code)));
      const first = trades.length ? trades[0].tradeDate : '2000-01-01';
      const splits = await jq.fetchSplits(c, codes, first);
      const { positions, realized, warnings } = computePositions(trades, splits);
      const quotes = await jq.fetchQuotes(c, Array.from(new Set(positions.map((p) => p.code))));
      const snaps = await jq.fetchSnapshots(c, 1);
      return { positions, realized, warnings, quotes, snapshot: snaps[0] || null, tradeCount: trades.length, splits };
    });

    let totalValue = 0;
    let totalCost = 0;
    const positions = out.positions.map((p) => {
      const q = out.quotes.get(p.code);
      const close = q ? q.close : null;
      let value = null;
      let pnl = null;
      if (close !== null) {
        if (p.kind === 'MSHORT') {
          pnl = (p.avgCost - close) * p.qty;
        } else {
          value = close * p.qty;
          pnl = value - p.cost;
        }
      }
      if (p.kind === 'CASH' && value !== null) {
        totalValue += value;
        totalCost += p.cost;
      }
      return {
        ...p, name: p.name || (q && q.name) || null, close, closeDate: q ? q.date : null, value, pnl,
        pnlPct: pnl !== null && p.cost ? (pnl / p.cost) * 100 : null,
        splitAdjusted: out.splits.has(p.code),
      };
    });
    res.json({
      tradeCount: out.tradeCount,
      positions,
      totals: { cashStockValue: totalValue, cashStockCost: totalCost },
      realizedByYear: summarizeRealized(out.realized),
      realized: out.realized.slice(-300).reverse(),
      warnings: out.warnings,
      snapshot: out.snapshot,
    });
  }));

  //---------------------------------------------------------- 判断
  router.get('/api/journal/decisions', wrap(async (req, res) => {
    const code = vCode(req.query.code, '銘柄コード', { required: false });
    const limit = vNum(req.query.limit, '件数', { min: 1, max: 1000, int: true }) || 200;
    const rows = await db.withConnection((c) => jq.fetchDecisions(c, { limit, code }));
    res.json({ count: rows.length, rows });
  }));

  router.post('/api/journal/decisions', wrap(async (req, res) => {
    const b = req.body || {};
    const d = {
      decisionDate: vDate(b.decisionDate, '判断した日'),
      code: vCode(b.code),
      action: vEnum(b.action, jq.ACTIONS, '行動'),
      reasonCat: vEnum(b.reasonCat, jq.REASONS, '理由の分類'),
      reasonText: vText(b.reasonText, '理由', 4000, { required: true }),
      ideaSource: vEnum(b.ideaSource, jq.SOURCES, '情報源', { required: false }),
      expectRetPct: vNum(b.expectRetPct, '想定リターン(%)', { min: -100, max: 1000 }),
      horizonWeeks: vNum(b.horizonWeeks, '想定期間(週)', { min: 0, max: 520 }),
      invalidation: vText(b.invalidation, '間違いと認める条件', 1000),
      confidence: vNum(b.confidence, '確信度', { min: 1, max: 5, int: true }),
      plannedStopPct: vNum(b.plannedStopPct, '予定の損切り(%)', { min: 0, max: 100 }),
      sizeNote: vText(b.sizeNote, 'サイズの考え', 500),
      emotion: vText(Array.isArray(b.emotion) ? b.emotion.join(',') : b.emotion, '状態', 200),
      supersedesId: b.supersedesId ? vId(b.supersedesId, '訂正元') : null,
    };
    const id = await db.withConnection(async (c) => {
      const info = await jq.lookupCode(c, d.code);
      if (!info) throw new BadRequest(`銘柄マスタに ${d.code} がありません`);
      if (d.supersedesId && !(await jq.decisionExists(c, d.supersedesId))) {
        throw new BadRequest(`訂正元の判断 #${d.supersedesId} がありません`);
      }
      return jq.insertDecision(c, d);
    });
    res.status(201).json({ decisionId: id });
  }));

  router.post('/api/journal/decisions/:id/reviews', wrap(async (req, res) => {
    const decisionId = vId(req.params.id, '判断ID');
    const b = req.body || {};
    const v = {
      decisionId,
      reviewDate: vDate(b.reviewDate, '振り返りの日'),
      outcomeNote: vText(b.outcomeNote, '結果', 4000),
      reasonVerdict: vEnum(b.reasonVerdict, jq.VERDICTS, '理由は当たっていたか'),
      lesson: vText(b.lesson, '教訓', 2000),
    };
    const id = await db.withConnection(async (c) => {
      if (!(await jq.decisionExists(c, decisionId))) throw new NotFound(`判断 #${decisionId} がありません`);
      return jq.insertReview(c, v);
    });
    res.status(201).json({ reviewId: id });
  }));

  //---------------------------------------------------------- メモ
  router.get('/api/journal/notes', wrap(async (req, res) => {
    const q = vText(req.query.q, '検索語', 100);
    const code = vCode(req.query.code, '銘柄コード', { required: false });
    const limit = vNum(req.query.limit, '件数', { min: 1, max: 500, int: true }) || 100;
    const rows = await db.withConnection((c) => jq.fetchNotes(c, { limit, q, code }));
    res.json({ count: rows.length, rows });
  }));

  router.post('/api/journal/notes', wrap(async (req, res) => {
    const n = noteInput(req.body || {});
    if (!n.body && !n.images.length) throw new BadRequest('本文か写真のどちらかを入れてください');
    const id = await db.withConnection((c) => jq.insertNote(c, n));
    res.status(201).json({ noteId: id });
  }));

  router.put('/api/journal/notes/:id', wrap(async (req, res) => {
    const noteId = vId(req.params.id, 'メモID');
    const n = noteInput(req.body || {});
    const ok = await db.withConnection((c) => jq.updateNote(c, noteId, n));
    if (!ok) throw new NotFound(`メモ #${noteId} がありません`);
    res.json({ noteId });
  }));

  router.delete('/api/journal/notes/:id', wrap(async (req, res) => {
    const noteId = vId(req.params.id, 'メモID');
    const ok = await db.withConnection((c) => jq.deleteNote(c, noteId));
    if (!ok) throw new NotFound(`メモ #${noteId} がありません`);
    res.json({ deleted: noteId });
  }));

  //---------------------------------------------------------- 写真
  router.get('/api/journal/images/:id', wrap(async (req, res) => {
    const imageId = vId(req.params.id, '写真ID');
    const img = await db.withConnection((c) => jq.fetchImage(c, imageId));
    if (!img) throw new NotFound(`写真 #${imageId} がありません`);
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(img.mime).send(img.buffer);
  }));

  router.delete('/api/journal/images/:id', wrap(async (req, res) => {
    const imageId = vId(req.params.id, '写真ID');
    const ok = await db.withConnection((c) => jq.deleteImage(c, imageId));
    if (!ok) throw new NotFound(`写真 #${imageId} がありません`);
    res.json({ deleted: imageId });
  }));

  router.put('/api/journal/images/:id/transcription', wrap(async (req, res) => {
    const imageId = vId(req.params.id, '写真ID');
    const text = vText((req.body || {}).text, '文字起こし', 100000);
    const ok = await db.withConnection((c) => jq.updateTranscription(c, imageId, text));
    if (!ok) throw new NotFound(`写真 #${imageId} がありません`);
    res.json({ imageId });
  }));

  // 文字起こしがまだの写真を作業フォルダに書き出す(Claude が読むため)
  router.post('/api/journal/transcriptions/export', wrap(async (req, res) => {
    const index = await db.withConnection((c) => jq.exportUntranscribed(c, WORK_DIR));
    res.json({ dir: WORK_DIR, count: index.length });
  }));

  // 作業フォルダの transcriptions.json を取り込む。空の写真だけを埋める(画面で直したものは上書きしない)
  // 形式: [{ "imageId": 12, "text": "..." }, ...]
  router.post('/api/journal/transcriptions/import', wrap(async (req, res) => {
    const file = path.join(WORK_DIR, 'transcriptions.json');
    if (!fs.existsSync(file)) throw new BadRequest(`${file} がありません`);
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new BadRequest(`transcriptions.json を読めません: ${e.message}`);
    }
    if (!Array.isArray(list)) throw new BadRequest('transcriptions.json は配列にしてください');
    const result = await db.withConnection(async (c) => {
      let updated = 0;
      const skipped = [];
      for (const x of list) {
        const id = vId(x.imageId, 'imageId');
        const text = vText(x.text, '文字起こし', 100000);
        if (!text) { skipped.push(id); continue; }
        if (await jq.updateTranscription(c, id, text, { onlyEmpty: true, doCommit: false })) updated += 1;
        else skipped.push(id);
      }
      await c.commit();
      return { updated, skipped };
    });
    res.json({ file, ...result });
  }));

  //---------------------------------------------------------- 口座
  router.get('/api/journal/snapshots', wrap(async (req, res) => {
    const rows = await db.withConnection((c) => jq.fetchSnapshots(c, 104));
    res.json({ rows });
  }));

  router.post('/api/journal/snapshots', wrap(async (req, res) => {
    const b = req.body || {};
    const s = {
      snapDate: vDate(b.snapDate, '日付'),
      cash: vNum(b.cash, '現金(円)', { min: 0 }),
      stock: vNum(b.stock, '株式評価額(円)', { min: 0 }),
      deposit: vNum(b.deposit, '入金(円)', { min: 0 }) || 0,
      withdrawal: vNum(b.withdrawal, '出金(円)', { min: 0 }) || 0,
      note: vText(b.note, 'メモ', 1000),
    };
    if (s.cash === null && s.stock === null) throw new BadRequest('現金か株式評価額のどちらかを入れてください');
    await db.withConnection((c) => jq.upsertSnapshot(c, s));
    res.json({ snapDate: s.snapDate });
  }));

  router.delete('/api/journal/snapshots/:date', wrap(async (req, res) => {
    const d = vDate(req.params.date, '日付', { notFuture: false });
    const ok = await db.withConnection((c) => jq.deleteSnapshot(c, d));
    if (!ok) throw new NotFound(`${d} の記録がありません`);
    res.json({ deleted: d });
  }));

  return router;
};

module.exports.WORK_DIR = WORK_DIR;
module.exports._internal = { vCode, vCodes, vDate, vImages };
