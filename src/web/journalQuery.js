'use strict';

/**
 * 売買記録(/journal)のDBアクセス。表の定義と意図は ddl/26_trading_journal.sql。
 *
 * db.js は outFormat を既定(ARRAY)のままにしているので、ここでは呼び出しごとに
 * OUT_FORMAT_OBJECT を指定する(demandQuery.js と同じ)。
 * autoCommit は false。書き込む関数は自分で commit する。
 */

const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };

const ACTIONS = ['BUY', 'ADD', 'TRIM', 'SELL', 'PASS', 'HOLD'];
const REASONS = ['EARNINGS', 'DIP', 'MOMENTUM', 'NEWS', 'THEME', 'VALUE', 'DIVIDEND',
  'RECOMMEND', 'REBALANCE', 'STOPLOSS', 'TAKEPROFIT', 'OTHER'];
const SOURCES = ['OWN_SCREEN', 'NEWS', 'SNS', 'DISCLOSURE', 'MEDIA', 'PERSON', 'APP', 'OTHER'];
const VERDICTS = ['RIGHT', 'PARTLY', 'WRONG', 'UNKNOWN'];
const ASSIGNEES = ['SELF', 'CLAUDE'];
const Q_STATUSES = ['OPEN', 'DOING', 'DONE', 'DROPPED'];

/** IN 句のバインドを作る: inBinds('c', ['a','b']) → { sql: ':c0,:c1', binds: {c0:'a', c1:'b'} } */
function inBinds(prefix, values) {
  const binds = {};
  const names = values.map((v, i) => {
    binds[prefix + i] = v;
    return ':' + prefix + i;
  });
  return { sql: names.join(','), binds };
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  // DATE は JS の Date(ローカル時刻の0時)で返る
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ts(d) {
  return d ? new Date(d).toISOString() : null;
}

//------------------------------------------------------------------
// 約定の取込
//------------------------------------------------------------------

/** 既に入っている dedup_key の集合 */
async function existingKeys(conn, keys) {
  const found = new Set();
  for (const part of chunks(keys, 500)) {
    const { sql, binds } = inBinds('k', part);
    const r = await conn.execute(`SELECT dedup_key FROM jnl_trade WHERE dedup_key IN (${sql})`, binds);
    r.rows.forEach((x) => found.add(x[0]));
  }
  return found;
}

/**
 * 取込。commit=false なら件数だけ数えて何も書かない(プレビュー)。
 * @returns {{batchId:number|null, total:number, inserted:number, duplicate:number, dupKeys:Set}}
 */
async function importTrades(conn, { source, fileName, sha256, encoding, trades, commit }) {
  const keys = trades.map((t) => t.dedupKey);
  const dup = keys.length ? await existingKeys(conn, keys) : new Set();
  const fresh = trades.filter((t) => !dup.has(t.dedupKey));
  const result = { batchId: null, total: trades.length, inserted: fresh.length, duplicate: dup.size, dupKeys: dup };
  if (!commit) return result;

  const b = await conn.execute(
    `INSERT INTO jnl_import_batch (source, file_name, file_sha256, encoding, rows_total, rows_inserted, rows_duplicate)
     VALUES (:source, :fileName, :sha, :enc, :total, :ins, :dup)
     RETURNING batch_id INTO :id`,
    {
      source, fileName: fileName || null, sha: sha256, enc: encoding,
      total: trades.length, ins: fresh.length, dup: dup.size,
      id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    }
  );
  const batchId = b.outBinds.id[0];

  for (const t of fresh) {
    await conn.execute(
      `INSERT INTO jnl_trade (
         source, batch_id, dedup_key, trade_date, settle_date, code, name, market, account_type,
         trade_type, side_raw, side, position_kind, position_effect, margin_type,
         qty, price, fee, tax, other_cost, settle_amount, tax_type, raw_json)
       VALUES (
         :source, :batchId, :dedupKey, TO_DATE(:tradeDate,'YYYY-MM-DD'), TO_DATE(:settleDate,'YYYY-MM-DD'),
         :code, :name, :market, :accountType, :tradeType, :sideRaw, :side, :positionKind, :positionEffect,
         :marginType, :qty, :price, :fee, :tax, :otherCost, :settleAmount, :taxType, :rawJson)`,
      {
        source: t.source, batchId, dedupKey: t.dedupKey, tradeDate: t.tradeDate, settleDate: t.settleDate,
        code: t.code, name: t.name, market: t.market, accountType: t.accountType, tradeType: t.tradeType,
        sideRaw: t.sideRaw, side: t.side, positionKind: t.positionKind, positionEffect: t.positionEffect,
        marginType: t.marginType, qty: t.qty, price: t.price, fee: t.fee, tax: t.tax,
        otherCost: t.otherCost, settleAmount: t.settleAmount, taxType: t.taxType,
        rawJson: { val: JSON.stringify(t.raw), type: oracledb.CLOB },
      }
    );
  }
  await conn.commit();
  result.batchId = batchId;
  return result;
}

async function fetchImportBatches(conn, limit = 20) {
  const r = await conn.execute(
    `SELECT batch_id, source, file_name, encoding, rows_total, rows_inserted, rows_duplicate, imported_at
     FROM jnl_import_batch ORDER BY batch_id DESC FETCH FIRST :n ROWS ONLY`,
    { n: limit }, OBJ
  );
  return r.rows.map((x) => ({
    batchId: x.BATCH_ID, source: x.SOURCE, fileName: x.FILE_NAME, encoding: x.ENCODING,
    total: x.ROWS_TOTAL, inserted: x.ROWS_INSERTED, duplicate: x.ROWS_DUPLICATE, importedAt: ts(x.IMPORTED_AT),
  }));
}

//------------------------------------------------------------------
// 約定・保有の材料
//------------------------------------------------------------------

async function fetchTrades(conn) {
  const r = await conn.execute(
    `SELECT trade_id, TO_CHAR(trade_date,'YYYY-MM-DD') AS trade_date, TO_CHAR(settle_date,'YYYY-MM-DD') AS settle_date,
            code, name, account_type, trade_type, side_raw, side, position_kind, position_effect,
            qty, price, fee, tax, other_cost, settle_amount, batch_id
     FROM jnl_trade ORDER BY trade_date, trade_id`,
    {}, OBJ
  );
  return r.rows.map((x) => ({
    tradeId: x.TRADE_ID, tradeDate: x.TRADE_DATE, settleDate: x.SETTLE_DATE, code: x.CODE, name: x.NAME,
    accountType: x.ACCOUNT_TYPE, tradeType: x.TRADE_TYPE, sideRaw: x.SIDE_RAW, side: x.SIDE,
    positionKind: x.POSITION_KIND, positionEffect: x.POSITION_EFFECT, qty: x.QTY, price: x.PRICE,
    fee: x.FEE, tax: x.TAX, otherCost: x.OTHER_COST, settleAmount: x.SETTLE_AMOUNT, batchId: x.BATCH_ID,
  }));
}

/** 分割(AdjFactor≠1)の日。銘柄ごとに日付順 */
async function fetchSplits(conn, codes, fromDate) {
  const out = new Map();
  if (!codes.length) return out;
  for (const part of chunks(codes, 500)) {
    const { sql, binds } = inBinds('c', part);
    const r = await conn.execute(
      `SELECT code, TO_CHAR(price_date,'YYYY-MM-DD') AS d, adj_factor
       FROM equity_price_daily
       WHERE code IN (${sql}) AND price_date > TO_DATE(:fromDate,'YYYY-MM-DD')
         AND adj_factor IS NOT NULL AND adj_factor <> 1
       ORDER BY code, price_date`,
      { ...binds, fromDate }, OBJ
    );
    for (const x of r.rows) {
      if (!out.has(x.CODE)) out.set(x.CODE, []);
      out.get(x.CODE).push({ date: x.D, factor: x.ADJ_FACTOR });
    }
  }
  return out;
}

/** 銘柄の最新終値と名前 */
async function fetchQuotes(conn, codes) {
  const out = new Map();
  if (!codes.length) return out;
  for (const part of chunks(codes, 500)) {
    const { sql, binds } = inBinds('c', part);
    const r = await conn.execute(
      `SELECT p.code,
              TO_CHAR(MAX(p.price_date),'YYYY-MM-DD') AS d,
              MAX(p.close_price) KEEP (DENSE_RANK LAST ORDER BY p.price_date) AS c,
              MAX(m.co_name) AS co_name
       FROM equity_price_daily p
       LEFT JOIN equity_master m ON m.code = p.code
       WHERE p.code IN (${sql}) AND p.close_price IS NOT NULL
         AND p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -3)
       GROUP BY p.code`,
      binds, OBJ
    );
    for (const x of r.rows) out.set(x.CODE, { date: x.D, close: x.C, name: x.CO_NAME });
  }
  return out;
}

/** 銘柄コードの確認(画面の入力補助) */
async function lookupCode(conn, code) {
  const r = await conn.execute(
    `SELECT m.code, m.co_name, m.sector33_name, m.market_name, m.delisted_flag,
            (SELECT TO_CHAR(MAX(p.price_date),'YYYY-MM-DD') FROM equity_price_daily p WHERE p.code = m.code) AS last_date
     FROM equity_master m WHERE m.code = :code`,
    { code }, OBJ
  );
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return {
    code: x.CODE, name: x.CO_NAME, sector: x.SECTOR33_NAME, market: x.MARKET_NAME,
    delisted: x.DELISTED_FLAG === 'Y', lastDate: x.LAST_DATE,
  };
}

//------------------------------------------------------------------
// 判断・振り返り
//------------------------------------------------------------------

async function insertDecision(conn, d) {
  const r = await conn.execute(
    `INSERT INTO jnl_decision (
       decision_date, code, action, reason_cat, reason_text, idea_source, expect_ret_pct, horizon_weeks,
       invalidation, confidence, planned_stop_pct, size_note, emotion, supersedes_id)
     VALUES (TO_DATE(:decisionDate,'YYYY-MM-DD'), :code, :action, :reasonCat, :reasonText, :ideaSource,
       :expectRetPct, :horizonWeeks, :invalidation, :confidence, :plannedStopPct, :sizeNote, :emotion, :supersedesId)
     RETURNING decision_id INTO :id`,
    { ...d, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
  );
  await conn.commit();
  return r.outBinds.id[0];
}

async function insertReview(conn, v) {
  const r = await conn.execute(
    `INSERT INTO jnl_review (decision_id, review_date, outcome_note, reason_verdict, lesson)
     VALUES (:decisionId, TO_DATE(:reviewDate,'YYYY-MM-DD'), :outcomeNote, :reasonVerdict, :lesson)
     RETURNING review_id INTO :id`,
    { ...v, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
  );
  await conn.commit();
  return r.outBinds.id[0];
}

/** 判断の一覧(評価ビューの値と振り返りを付ける) */
async function fetchDecisions(conn, { limit = 200, code = null } = {}) {
  const r = await conn.execute(
    `SELECT d.decision_id, TO_CHAR(d.decision_date,'YYYY-MM-DD') AS decision_date, d.code, m.co_name,
            d.action, d.reason_cat, d.reason_text, d.idea_source, d.expect_ret_pct, d.horizon_weeks,
            d.invalidation, d.confidence, d.planned_stop_pct, d.size_note, d.emotion, d.supersedes_id, d.created_at,
            e.late_entry, e.is_superseded, TO_CHAR(e.base_date,'YYYY-MM-DD') AS base_date, e.base_close,
            e.vol_20d_pct, e.ret_20d_pre_pct, e.dd_250d_pct, e.turnover_20d_oku,
            e.ret_20d_pct, e.topix_20d_pct, e.exr_20d_pct, e.ret_60d_pct, e.topix_60d_pct, e.exr_60d_pct
     FROM (SELECT * FROM jnl_decision
           WHERE (:code IS NULL OR code = :code)
           ORDER BY decision_date DESC, decision_id DESC FETCH FIRST :n ROWS ONLY) d
     JOIN jnl_decision_eval_v e ON e.decision_id = d.decision_id
     LEFT JOIN equity_master m ON m.code = d.code
     ORDER BY d.decision_date DESC, d.decision_id DESC`,
    { code, n: limit }, OBJ
  );
  const ids = r.rows.map((x) => x.DECISION_ID);
  const reviews = new Map();
  for (const part of chunks(ids, 500)) {
    const { sql, binds } = inBinds('d', part);
    const rv = await conn.execute(
      `SELECT review_id, decision_id, TO_CHAR(review_date,'YYYY-MM-DD') AS review_date,
              outcome_note, reason_verdict, lesson, created_at
       FROM jnl_review WHERE decision_id IN (${sql}) ORDER BY review_date, review_id`,
      binds, OBJ
    );
    for (const x of rv.rows) {
      if (!reviews.has(x.DECISION_ID)) reviews.set(x.DECISION_ID, []);
      reviews.get(x.DECISION_ID).push({
        reviewId: x.REVIEW_ID, reviewDate: x.REVIEW_DATE, outcomeNote: x.OUTCOME_NOTE,
        reasonVerdict: x.REASON_VERDICT, lesson: x.LESSON, createdAt: ts(x.CREATED_AT),
      });
    }
  }
  return r.rows.map((x) => ({
    decisionId: x.DECISION_ID, decisionDate: x.DECISION_DATE, code: x.CODE, name: x.CO_NAME,
    action: x.ACTION, reasonCat: x.REASON_CAT, reasonText: x.REASON_TEXT, ideaSource: x.IDEA_SOURCE,
    expectRetPct: x.EXPECT_RET_PCT, horizonWeeks: x.HORIZON_WEEKS, invalidation: x.INVALIDATION,
    confidence: x.CONFIDENCE, plannedStopPct: x.PLANNED_STOP_PCT, sizeNote: x.SIZE_NOTE, emotion: x.EMOTION,
    supersedesId: x.SUPERSEDES_ID, createdAt: ts(x.CREATED_AT),
    lateEntry: x.LATE_ENTRY === 'Y', superseded: x.IS_SUPERSEDED === 'Y',
    eval: {
      baseDate: x.BASE_DATE, baseClose: x.BASE_CLOSE, vol20: x.VOL_20D_PCT, ret20Pre: x.RET_20D_PRE_PCT,
      dd250: x.DD_250D_PCT, turnover20: x.TURNOVER_20D_OKU,
      ret20: x.RET_20D_PCT, topix20: x.TOPIX_20D_PCT, exr20: x.EXR_20D_PCT,
      ret60: x.RET_60D_PCT, topix60: x.TOPIX_60D_PCT, exr60: x.EXR_60D_PCT,
    },
    reviews: reviews.get(x.DECISION_ID) || [],
  }));
}

async function decisionExists(conn, id) {
  const r = await conn.execute(`SELECT COUNT(*) FROM jnl_decision WHERE decision_id = :id`, { id });
  return r.rows[0][0] > 0;
}

//------------------------------------------------------------------
// メモと写真
//------------------------------------------------------------------

async function insertNote(conn, n) {
  const r = await conn.execute(
    `INSERT INTO jnl_note (note_date, body, codes, idea_source)
     VALUES (TO_DATE(:noteDate,'YYYY-MM-DD'), :body, :codes, :ideaSource)
     RETURNING note_id INTO :id`,
    {
      noteDate: n.noteDate, body: { val: n.body || '', type: oracledb.CLOB }, codes: n.codes, ideaSource: n.ideaSource,
      id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    }
  );
  const noteId = r.outBinds.id[0];
  await insertImages(conn, noteId, n.images || []);
  await conn.commit();
  return noteId;
}

async function insertImages(conn, noteId, images) {
  for (const img of images) {
    await conn.execute(
      `INSERT INTO jnl_note_image (note_id, file_name, mime, byte_size, width, height, image)
       VALUES (:noteId, :fileName, :mime, :size, :width, :height, :image)`,
      {
        noteId, fileName: img.fileName, mime: img.mime, size: img.buffer.length,
        width: img.width, height: img.height, image: { val: img.buffer, type: oracledb.BLOB },
      }
    );
  }
}

async function updateNote(conn, noteId, n) {
  const r = await conn.execute(
    `UPDATE jnl_note SET note_date = TO_DATE(:noteDate,'YYYY-MM-DD'), body = :body, codes = :codes,
            idea_source = :ideaSource, updated_at = SYSTIMESTAMP
     WHERE note_id = :noteId`,
    { noteId, noteDate: n.noteDate, body: { val: n.body || '', type: oracledb.CLOB }, codes: n.codes, ideaSource: n.ideaSource }
  );
  if (r.rowsAffected === 0) return false;
  await insertImages(conn, noteId, n.images || []);
  await conn.commit();
  return true;
}

async function deleteNote(conn, noteId) {
  const r = await conn.execute(`DELETE FROM jnl_note WHERE note_id = :noteId`, { noteId });
  await conn.commit();
  return r.rowsAffected > 0;
}

async function deleteImage(conn, imageId) {
  const r = await conn.execute(`DELETE FROM jnl_note_image WHERE image_id = :imageId`, { imageId });
  await conn.commit();
  return r.rowsAffected > 0;
}

async function fetchNotes(conn, { limit = 100, q = null, code = null } = {}) {
  const r = await conn.execute(
    `SELECT note_id, TO_CHAR(note_date,'YYYY-MM-DD') AS note_date, body, codes, idea_source, created_at, updated_at
     FROM jnl_note
     WHERE (:q IS NULL OR DBMS_LOB.INSTR(LOWER(body), LOWER(:q)) > 0)
       AND (:code IS NULL OR INSTR(',' || codes || ',', ',' || :code || ',') > 0)
     ORDER BY note_date DESC, note_id DESC FETCH FIRST :n ROWS ONLY`,
    { q, code, n: limit },
    { ...OBJ, fetchInfo: { BODY: { type: oracledb.STRING } } }
  );
  const ids = r.rows.map((x) => x.NOTE_ID);
  const imgs = new Map();
  for (const part of chunks(ids, 500)) {
    const { sql, binds } = inBinds('n', part);
    const ri = await conn.execute(
      `SELECT image_id, note_id, file_name, byte_size, width, height, transcription, transcribed_at
       FROM jnl_note_image WHERE note_id IN (${sql}) ORDER BY image_id`,
      binds, { ...OBJ, fetchInfo: { TRANSCRIPTION: { type: oracledb.STRING } } }
    );
    for (const x of ri.rows) {
      if (!imgs.has(x.NOTE_ID)) imgs.set(x.NOTE_ID, []);
      imgs.get(x.NOTE_ID).push({
        imageId: x.IMAGE_ID, fileName: x.FILE_NAME, size: x.BYTE_SIZE, width: x.WIDTH, height: x.HEIGHT,
        transcription: x.TRANSCRIPTION, transcribedAt: ts(x.TRANSCRIBED_AT),
      });
    }
  }
  return r.rows.map((x) => ({
    noteId: x.NOTE_ID, noteDate: x.NOTE_DATE, body: x.BODY || '', codes: x.CODES ? x.CODES.split(',') : [],
    ideaSource: x.IDEA_SOURCE, createdAt: ts(x.CREATED_AT), updatedAt: ts(x.UPDATED_AT),
    images: imgs.get(x.NOTE_ID) || [],
  }));
}

async function fetchImage(conn, imageId) {
  const r = await conn.execute(
    `SELECT mime, image FROM jnl_note_image WHERE image_id = :imageId`,
    { imageId }, { ...OBJ, fetchInfo: { IMAGE: { type: oracledb.BUFFER } } }
  );
  if (!r.rows.length) return null;
  return { mime: r.rows[0].MIME, buffer: r.rows[0].IMAGE };
}

/**
 * 文字起こしを書く。onlyEmpty=true なら、まだ空の写真だけを埋める
 * (ファイルからの一括取込で、画面で手直しした文字起こしを上書きしないため)。
 * commit は呼び出し側に任せられるよう、doCommit=false も受ける。
 */
async function updateTranscription(conn, imageId, text, { onlyEmpty = false, doCommit = true } = {}) {
  const empty = text === null || text === undefined || String(text).trim() === '';
  const r = await conn.execute(
    `UPDATE jnl_note_image
     SET transcription = :t, transcribed_at = CASE WHEN :e = 1 THEN NULL ELSE SYSTIMESTAMP END
     WHERE image_id = :imageId AND (:onlyEmpty = 0 OR transcription IS NULL)`,
    {
      imageId, t: { val: empty ? null : String(text), type: oracledb.CLOB },
      e: empty ? 1 : 0, onlyEmpty: onlyEmpty ? 1 : 0,
    }
  );
  if (doCommit) await conn.commit();
  return r.rowsAffected > 0;
}

/**
 * 文字起こしがまだの写真をフォルダに書き出す(Claude に読ませるため)。
 * ファイル名は image_<id>.jpg。同じフォルダに一覧 index.json も置く。
 */
async function exportUntranscribed(conn, dir) {
  const r = await conn.execute(
    `SELECT i.image_id, i.note_id, i.mime, i.image, TO_CHAR(n.note_date,'YYYY-MM-DD') AS note_date, n.codes
     FROM jnl_note_image i JOIN jnl_note n ON n.note_id = i.note_id
     WHERE i.transcription IS NULL ORDER BY i.image_id`,
    {}, { ...OBJ, fetchInfo: { IMAGE: { type: oracledb.BUFFER } } }
  );
  fs.mkdirSync(dir, { recursive: true });
  const index = [];
  for (const x of r.rows) {
    const ext = x.MIME === 'image/png' ? 'png' : 'jpg';
    const file = `image_${x.IMAGE_ID}.${ext}`;
    fs.writeFileSync(path.join(dir, file), x.IMAGE);
    index.push({ imageId: x.IMAGE_ID, noteId: x.NOTE_ID, noteDate: x.NOTE_DATE, codes: x.CODES, file });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

//------------------------------------------------------------------
// 口座のスナップショット
//------------------------------------------------------------------

async function upsertSnapshot(conn, s) {
  await conn.execute(
    `MERGE INTO jnl_account_snapshot t
     USING (SELECT TO_DATE(:snapDate,'YYYY-MM-DD') AS snap_date FROM dual) s
     ON (t.snap_date = s.snap_date)
     WHEN MATCHED THEN UPDATE SET cash_yen = :cash, stock_value_yen = :stock, deposit_yen = :dep,
          withdrawal_yen = :wd, note = :note, updated_at = SYSTIMESTAMP
     WHEN NOT MATCHED THEN INSERT (snap_date, cash_yen, stock_value_yen, deposit_yen, withdrawal_yen, note)
          VALUES (s.snap_date, :cash, :stock, :dep, :wd, :note)`,
    { snapDate: s.snapDate, cash: s.cash, stock: s.stock, dep: s.deposit, wd: s.withdrawal, note: s.note }
  );
  await conn.commit();
}

async function deleteSnapshot(conn, snapDate) {
  const r = await conn.execute(
    `DELETE FROM jnl_account_snapshot WHERE snap_date = TO_DATE(:d,'YYYY-MM-DD')`, { d: snapDate });
  await conn.commit();
  return r.rowsAffected > 0;
}

async function fetchSnapshots(conn, limit = 104) {
  const r = await conn.execute(
    `SELECT TO_CHAR(snap_date,'YYYY-MM-DD') AS snap_date, cash_yen, stock_value_yen, deposit_yen, withdrawal_yen, note
     FROM jnl_account_snapshot ORDER BY snap_date DESC FETCH FIRST :n ROWS ONLY`,
    { n: limit }, OBJ
  );
  return r.rows.map((x) => ({
    snapDate: x.SNAP_DATE, cash: x.CASH_YEN, stock: x.STOCK_VALUE_YEN,
    deposit: x.DEPOSIT_YEN, withdrawal: x.WITHDRAWAL_YEN, note: x.NOTE,
  }));
}

//------------------------------------------------------------------
// 調べたいこと(ddl/27_journal_questions.sql)
//------------------------------------------------------------------

function mapQuestion(x) {
  return {
    questionId: x.QUESTION_ID, askedDate: x.ASKED_DATE, question: x.QUESTION, background: x.BACKGROUND,
    codes: x.CODES ? x.CODES.split(',') : [], decisionId: x.DECISION_ID, noteId: x.NOTE_ID,
    assignee: x.ASSIGNEE, status: x.STATUS, priority: x.PRIORITY, answer: x.ANSWER || null,
    answerRef: x.ANSWER_REF, answeredBy: x.ANSWERED_BY, answeredAt: ts(x.ANSWERED_AT),
    createdAt: ts(x.CREATED_AT), updatedAt: ts(x.UPDATED_AT),
  };
}

/** 一覧。scope: 'open'(未完了: OPEN/DOING) / 'closed'(DONE/DROPPED) / 'all' */
async function fetchQuestions(conn, { scope = 'open', assignee = null, limit = 500 } = {}) {
  const r = await conn.execute(
    `SELECT question_id, TO_CHAR(asked_date,'YYYY-MM-DD') AS asked_date, question, background, codes,
            decision_id, note_id, assignee, status, priority, answer, answer_ref, answered_by, answered_at,
            created_at, updated_at
     FROM jnl_question
     WHERE (:scope = 'all'
            OR (:scope = 'open' AND status IN ('OPEN','DOING'))
            OR (:scope = 'closed' AND status IN ('DONE','DROPPED')))
       AND (:assignee IS NULL OR assignee = :assignee)
     ORDER BY CASE WHEN status IN ('OPEN','DOING') THEN 0 ELSE 1 END, priority, asked_date DESC, question_id DESC
     FETCH FIRST :n ROWS ONLY`,
    { scope, assignee, n: limit },
    { ...OBJ, fetchInfo: { ANSWER: { type: oracledb.STRING } } }
  );
  return r.rows.map(mapQuestion);
}

/** 判断・メモに付いた問いの件数(カードに出す) */
async function fetchQuestionLinks(conn) {
  const r = await conn.execute(
    `SELECT decision_id, note_id, status FROM jnl_question WHERE decision_id IS NOT NULL OR note_id IS NOT NULL`,
    {}, OBJ
  );
  return r.rows.map((x) => ({ decisionId: x.DECISION_ID, noteId: x.NOTE_ID, open: x.STATUS === 'OPEN' || x.STATUS === 'DOING' }));
}

async function insertQuestion(conn, q, { doCommit = true } = {}) {
  const r = await conn.execute(
    `INSERT INTO jnl_question (asked_date, question, background, codes, decision_id, note_id, assignee, priority)
     VALUES (TO_DATE(:askedDate,'YYYY-MM-DD'), :question, :background, :codes, :decisionId, :noteId, :assignee, :priority)
     RETURNING question_id INTO :id`,
    {
      askedDate: q.askedDate, question: q.question, background: q.background, codes: q.codes,
      decisionId: q.decisionId, noteId: q.noteId, assignee: q.assignee, priority: q.priority,
      id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    }
  );
  if (doCommit) await conn.commit();
  return r.outBinds.id[0];
}

/**
 * 部分更新。渡された項目だけ変える。
 * answer を入れたとき: 状態の指定が無ければ DONE にし、answered_by / answered_at を付ける。
 * answer を空にしたとき: answered_by / answered_at も消す。
 */
async function updateQuestion(conn, id, u, { answeredBy = 'SELF', onlyEmptyAnswer = false, doCommit = true } = {}) {
  const sets = [];
  const binds = { id };
  const put = (col, key, val, type) => {
    sets.push(`${col} = :${key}`);
    binds[key] = type ? { val, type } : val;
  };
  if ('question' in u) put('question', 'question', u.question);
  if ('background' in u) put('background', 'background', u.background);
  if ('codes' in u) put('codes', 'codes', u.codes);
  if ('assignee' in u) put('assignee', 'assignee', u.assignee);
  if ('priority' in u) put('priority', 'priority', u.priority);
  if ('answerRef' in u) put('answer_ref', 'answerRef', u.answerRef);
  let status = u.status;
  if ('answer' in u) {
    put('answer', 'answer', u.answer, oracledb.CLOB);
    if (u.answer) {
      sets.push('answered_by = :answeredBy', 'answered_at = SYSTIMESTAMP');
      binds.answeredBy = answeredBy;
      if (!status) status = 'DONE';
    } else {
      sets.push('answered_by = NULL', 'answered_at = NULL');
    }
  }
  if (status) put('status', 'status', status);
  if (!sets.length) return true;
  sets.push('updated_at = SYSTIMESTAMP');
  const r = await conn.execute(
    `UPDATE jnl_question SET ${sets.join(', ')} WHERE question_id = :id` +
      (onlyEmptyAnswer ? ' AND answer IS NULL' : ''),
    binds
  );
  if (doCommit) await conn.commit();
  return r.rowsAffected > 0;
}

async function questionExists(conn, id) {
  const r = await conn.execute(`SELECT COUNT(*) FROM jnl_question WHERE question_id = :id`, { id });
  return r.rows[0][0] > 0;
}

async function noteExists(conn, id) {
  const r = await conn.execute(`SELECT COUNT(*) FROM jnl_note WHERE note_id = :id`, { id });
  return r.rows[0][0] > 0;
}

module.exports = {
  ACTIONS, REASONS, SOURCES, VERDICTS, ASSIGNEES, Q_STATUSES,
  importTrades, fetchImportBatches, fetchTrades, fetchSplits, fetchQuotes, lookupCode,
  insertDecision, insertReview, fetchDecisions, decisionExists,
  insertNote, updateNote, deleteNote, deleteImage, fetchNotes, fetchImage, updateTranscription, exportUntranscribed,
  upsertSnapshot, deleteSnapshot, fetchSnapshots,
  fetchQuestions, fetchQuestionLinks, insertQuestion, updateQuestion, questionExists, noteExists,
  _internal: { iso },
};
