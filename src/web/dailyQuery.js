'use strict';

/**
 * 日々の確認(/daily)のデータ。設計は Project の claude/daily_page_design.md、表は ddl/32_daily_seen.sql。
 *
 * 【対象銘柄】保有(約定から計算)+ ウォッチ(FAVORITE_MASTER.IS_WATCHING)+ 終了していない
 *   購入検討リストの銘柄(外した銘柄を除く)。
 *
 * 【期間】3つの場合がある
 *   seen  … 前回「確認した」日時(JNL_DAILY_SEEN の最新)から今まで。出来事は「前回確認のあとに
 *            取り込まれた行」(LOADED_AT > SEEN_AT)。日付の古い行の取り直しを拾わないよう、
 *            出来事の日付が前回確認の日の7日前より新しいものに限る。
 *   date  … 画面で日付を選んだとき。出来事の日付がその日以降のもの。
 *   first … まだ一度も確認していないとき。直近の営業日1日分(date と同じ扱い)。
 *
 * 【値動き】期間の基準の終値 → 最新の終値。分割は AdjFactor で調整する。
 *   seen では基準 = 前回確認の時点で入っていた最新の株価の日。それが最新と同じなら(新しい株価が
 *   まだ入っていない)、最新日の前日比を出す。
 */

const oracledb = require('oracledb');
const { computePositions } = require('./journalPositions');
const jq = require('./journalQuery');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const TZ_JP = 'Asia/Tokyo';
const SEEN_GUARD_DAYS = 7;
const VOL_AVG_DAYS = 25; // 出来高の倍率 = 最新日の出来高 ÷ 直前25営業日の平均

//------------------------------------------------------------------ 小道具
function inBinds(prefix, values) {
  const binds = {};
  const sql = values.map((v, i) => { binds[prefix + i] = v; return ':' + prefix + i; }).join(',');
  return { sql, binds };
}

function ymdIn(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function rows(conn, sql, binds = {}) {
  const r = await conn.execute(sql, binds, OBJ);
  return r.rows;
}

//------------------------------------------------------------------ 確認した日時
async function fetchSeen(conn) {
  let r;
  try {
    r = await rows(conn,
    `SELECT TO_CHAR(MAX(seen_at), 'YYYY-MM-DD HH24:MI:SS') AS utc,
            TO_CHAR(FROM_TZ(MAX(seen_at), '+00:00') AT TIME ZONE '${TZ_JP}', 'YYYY-MM-DD HH24:MI') AS jst
       FROM jnl_daily_seen`);
  } catch (err) {
    // ddl/32 をまだ流していない(表が無い)ときは「一度も確認していない」として扱い、画面で知らせる
    if (err && err.errorNum === 942) return { missing: true };
    throw err;
  }
  return r[0] && r[0].UTC ? { utc: r[0].UTC, jst: r[0].JST } : null;
}

/**
 * 「確認した」を1行足す。payload(画面に出ていた内容の JSON 文字列)も残す。
 * ddl/33 をまだ流していない(PAYLOAD 列が無い、ORA-00904)ときは日時だけ残し、payloadSaved = false を返す。
 */
async function insertSeen(conn, payload) {
  let payloadSaved = true;
  try {
    await conn.execute(`INSERT INTO jnl_daily_seen (seen_at, payload) VALUES (SYSTIMESTAMP, :p)`,
      { p: { val: payload, type: oracledb.CLOB } });
  } catch (err) {
    if (!err || err.errorNum !== 904) throw err;
    await conn.execute(`INSERT INTO jnl_daily_seen (seen_at) VALUES (SYSTIMESTAMP)`);
    payloadSaved = false;
  }
  await conn.commit();
  return { ...(await fetchSeen(conn)), payloadSaved };
}

/** 過去の確認の一覧(新しい順)。内容が残っているかどうかも返す */
async function fetchHistory(conn, limit = 120) {
  let r;
  try {
    r = await rows(conn,
      `SELECT seen_id,
              TO_CHAR(FROM_TZ(seen_at, '+00:00') AT TIME ZONE '${TZ_JP}', 'YYYY-MM-DD HH24:MI') AS jst,
              CASE WHEN payload IS NULL THEN 0 ELSE 1 END AS has_payload
         FROM jnl_daily_seen
        ORDER BY seen_at DESC
        FETCH FIRST :n ROWS ONLY`, { n: limit });
  } catch (err) {
    // 表(ddl/32)や列(ddl/33)がまだ無いときは、一覧は空として扱う
    if (err && (err.errorNum === 942 || err.errorNum === 904)) return [];
    throw err;
  }
  return r.map((x) => ({ id: x.SEEN_ID, jst: x.JST, hasPayload: x.HAS_PAYLOAD === 1 }));
}

/** 過去の確認1件の内容(JSON 文字列)。無ければ null */
async function fetchHistoryItem(conn, id) {
  const r = await conn.execute(
    `SELECT TO_CHAR(FROM_TZ(seen_at, '+00:00') AT TIME ZONE '${TZ_JP}', 'YYYY-MM-DD HH24:MI') AS jst, payload
       FROM jnl_daily_seen WHERE seen_id = :id`,
    { id }, { ...OBJ, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } });
  const x = r.rows[0];
  return x ? { jst: x.JST, payload: x.PAYLOAD } : null;
}

//------------------------------------------------------------------ 対象銘柄
/** @returns {Promise<Map<string, {code, held:boolean, watch:boolean, lists:string[]}>>} */
async function fetchTargets(conn) {
  const out = new Map();
  const get = (code) => {
    if (!out.has(code)) out.set(code, { code, held: false, watch: false, lists: [] });
    return out.get(code);
  };

  // 保有: 売買記録の保有タブと同じ計算(約定から)
  const trades = await jq.fetchTrades(conn);
  if (trades.length) {
    const codes = Array.from(new Set(trades.map((t) => t.code)));
    const splits = await jq.fetchSplits(conn, codes, trades[0].tradeDate);
    for (const p of computePositions(trades, splits).positions) get(p.code).held = true;
  }

  for (const x of await rows(conn, `SELECT code FROM favorite_master WHERE is_watching = 1`)) {
    get(x.CODE).watch = true;
  }

  for (const x of await rows(conn,
    `SELECT c.code, l.list_name
       FROM jnl_candidate c
       JOIN jnl_candidate_list l ON l.list_id = c.list_id
      WHERE l.closed_at IS NULL AND c.removed_at IS NULL
      ORDER BY l.list_id`)) {
    const t = get(x.CODE);
    if (!t.lists.includes(x.LIST_NAME)) t.lists.push(x.LIST_NAME);
  }
  return out;
}

//------------------------------------------------------------------ 本体
/**
 * @param {object} p
 * @param {'seen'|'date'|'first'} p.mode
 * @param {string} [p.sinceUtc]  seen のとき。'YYYY-MM-DD HH24:MI:SS'
 * @param {string} [p.sinceJstDate] seen のとき。前回確認の日(日本時間)
 * @param {string} [p.fromDate]  date のとき。'YYYY-MM-DD'
 */
async function fetchDaily(conn, p) {
  const today = ymdIn(new Date(), TZ_JP);
  const targets = await fetchTargets(conn);
  const codes = Array.from(targets.keys());

  // 株価の日付(TOPIX の日付を国内の取引日の目安にする)
  const tp = await rows(conn,
    `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d, close_price AS c,
            CASE WHEN :since IS NOT NULL AND loaded_at <= TO_TIMESTAMP(:since, 'YYYY-MM-DD HH24:MI:SS')
                 THEN 1 ELSE 0 END AS seen
       FROM topix_price_daily
      WHERE price_date >= TRUNC(SYSDATE) - 120
      ORDER BY price_date`, { since: p.mode === 'seen' ? p.sinceUtc : null });
  const tDates = tp.map((x) => x.D);
  const topix = new Map(tp.map((x) => [x.D, x.C]));
  const latestDate = tDates[tDates.length - 1];

  let mode = p.mode;
  let fromDate = p.fromDate || null;
  if (mode === 'first') fromDate = latestDate;
  let baseDate;
  if (mode === 'seen') {
    const seenDates = tp.filter((x) => x.SEEN === 1).map((x) => x.D);
    baseDate = seenDates[seenDates.length - 1] || null;
    if (!baseDate || baseDate >= latestDate) baseDate = tDates[tDates.length - 2];
  } else {
    baseDate = tDates.filter((d) => d < fromDate).pop() || tDates[0];
  }

  // 出来事の絞り込み(列名を差し込む)
  const evFilter = (dateCol, loadedCol) => (mode === 'seen'
    ? `(${loadedCol} > TO_TIMESTAMP(:since, 'YYYY-MM-DD HH24:MI:SS') AND ${dateCol} >= TO_DATE(:guard, 'YYYY-MM-DD'))`
    : `${dateCol} >= TO_DATE(:fromd, 'YYYY-MM-DD')`);
  const evBinds = mode === 'seen'
    ? { since: p.sinceUtc, guard: addDays(p.sinceJstDate, -SEEN_GUARD_DAYS) }
    : { fromd: fromDate };

  const names = new Map();
  const dataDates = await fetchDataDates(conn);
  if (!codes.length) {
    return { today, mode, fromDate, baseDate, latestDate, dataDates, targets: [], events: [], moves: [],
      upcoming: { until: null, items: [] } };
  }

  const b = inBinds('c', codes);
  for (const x of await rows(conn, `SELECT code, co_name FROM equity_master WHERE code IN (${b.sql})`, b.binds)) {
    names.set(x.CODE, x.CO_NAME);
  }

  const events = [];
  events.push(...await financialEvents(conn, b, evFilter, evBinds));
  events.push(...await largeVolumeEvents(conn, b, evFilter, evBinds));
  events.push(...await shortEvents(conn, b, evFilter, evBinds));
  events.push(...await marginAlertEvents(conn, b, evFilter, evBinds));
  events.sort((x, y) => (x.date === y.date ? x.code.localeCompare(y.code) : (x.date < y.date ? 1 : -1)));

  const moves = await priceMoves(conn, b, codes, { baseDate, latestDate, topix });
  const evCount = new Map();
  for (const e of events) evCount.set(e.code, (evCount.get(e.code) || 0) + 1);
  for (const m of moves) m.events = evCount.get(m.code) || 0;
  // 出来事のあった銘柄を上に、その中と残りはそれぞれ騰落率の高い順(値が無いものは最後)
  moves.sort((x, y) => (y.events > 0) - (x.events > 0)
    || ((y.ret == null ? -Infinity : y.ret) - (x.ret == null ? -Infinity : x.ret)));

  const upcoming = await fetchUpcoming(conn, b, codes, today);

  const tgt = Array.from(targets.values()).map((t) => ({ ...t, name: names.get(t.code) || null }));
  for (const list of [events, moves, upcoming.items]) {
    for (const r of list) {
      r.name = names.get(r.code) || null;
      const t = targets.get(r.code);
      r.held = t.held; r.watch = t.watch; r.lists = t.lists;
    }
  }
  return { today, mode, fromDate, baseDate, latestDate, dataDates, targets: tgt, events, moves, upcoming };
}

/** 各データの最新日 */
async function fetchDataDates(conn) {
  const r = await rows(conn,
    `SELECT (SELECT TO_CHAR(MAX(price_date), 'YYYY-MM-DD') FROM topix_price_daily) AS price,
            (SELECT TO_CHAR(MAX(disc_date), 'YYYY-MM-DD') FROM financial_summary) AS fin,
            (SELECT TO_CHAR(MAX(sub_date), 'YYYY-MM-DD') FROM large_volume_shareholder) AS lvs,
            (SELECT TO_CHAR(MAX(disc_date), 'YYYY-MM-DD') FROM equity_short_position) AS short,
            (SELECT TO_CHAR(MAX(pub_date), 'YYYY-MM-DD') FROM equity_margin_alert) AS alert,
            (SELECT TO_CHAR(MAX(app_date), 'YYYY-MM-DD') FROM equity_margin_interest) AS margin
       FROM dual`);
  const x = r[0];
  return { price: x.PRICE, fin: x.FIN, lvs: x.LVS, short: x.SHORT, alert: x.ALERT, margin: x.MARGIN };
}

//------------------------------------------------------------------ 出来事: 決算・予想の修正
async function financialEvents(conn, b, evFilter, evBinds) {
  // 前年同期・直前の予想と比べるため、対象銘柄の直近2年余りの行を全部読み、新しい行に印を付ける
  const r = await rows(conn,
    `SELECT code, TO_CHAR(disc_date, 'YYYY-MM-DD') AS d, disc_time, disc_no, doc_type, cur_per_type,
            TO_CHAR(cur_per_en, 'YYYY-MM-DD') AS per_en, TO_CHAR(cur_fy_en, 'YYYY-MM-DD') AS fy_en,
            TO_CHAR(nxt_fy_en, 'YYYY-MM-DD') AS nxt_fy_en,
            op, f_op, nxf_op, f_div_ann, nxf_div_ann,
            CASE WHEN ${evFilter('disc_date', 'loaded_at')} THEN 1 ELSE 0 END AS is_new
       FROM financial_summary
      WHERE code IN (${b.sql}) AND disc_date >= ADD_MONTHS(TRUNC(SYSDATE), -27)
      ORDER BY code, disc_date, disc_time, disc_no`, { ...b.binds, ...evBinds });

  const byCode = new Map();
  for (const x of r) {
    if (!byCode.has(x.CODE)) byCode.set(x.CODE, []);
    byCode.get(x.CODE).push(x);
  }
  const isStatement = (x) => /FinancialStatements/.test(x.DOC_TYPE || '');
  const oku = (v) => (v == null ? null : Number(v) / 1e8);
  const out = [];

  for (const [code, list] of byCode) {
    list.forEach((x, i) => {
      if (x.IS_NEW !== 1) return;
      const before = list.slice(0, i);
      // 直前の予想(同じ決算期の営業利益予想。本決算の短信の翌期予想も含める)
      const prevForecast = (fy, key, nxKey) => {
        for (let k = before.length - 1; k >= 0; k--) {
          const y = before[k];
          if (y.FY_EN === fy && y[key] != null) return y[key];
          if (y.CUR_PER_TYPE === 'FY' && isStatement(y) && y.NXT_FY_EN === fy && y[nxKey] != null) return y[nxKey];
        }
        return null;
      };

      if (isStatement(x)) {
        const per = x.CUR_PER_TYPE || '';
        // 前年同期 = 同じ四半期で、期末日がちょうど1年前の決算短信
        const py = x.PER_EN ? String(Number(x.PER_EN.slice(0, 4)) - 1) + x.PER_EN.slice(4) : null;
        const prevYear = py ? before.filter((y) => isStatement(y) && y.CUR_PER_TYPE === per && y.PER_EN === py).pop() : null;
        const growth = prevYear && prevYear.OP > 0 && x.OP != null ? (x.OP / prevYear.OP - 1) * 100 : null;
        // 本決算は来期予想、四半期は今期予想
        const isFy = per === 'FY';
        const fNow = isFy ? x.NXF_OP : x.F_OP;
        const fPrev = isFy ? null : prevForecast(x.FY_EN, 'F_OP', 'NXF_OP');
        out.push({
          code, date: x.D, kind: 'fin', type: per === 'FY' ? '本決算' : `${per}決算`,
          op: oku(x.OP), opGrowth: growth,
          forecastLabel: isFy ? '来期予想' : '今期予想', forecast: oku(fNow),
          forecastPrev: oku(fPrev), forecastChg: chgOf(fNow, fPrev),
        });
      } else if (/^(REIT)?EarnForecastRevision/.test(x.DOC_TYPE || '')) {
        const fPrev = prevForecast(x.FY_EN, 'F_OP', 'NXF_OP');
        out.push({
          code, date: x.D, kind: 'rev', type: '業績予想の修正',
          forecastLabel: '営業利益予想', forecast: oku(x.F_OP), forecastPrev: oku(fPrev), forecastChg: chgOf(x.F_OP, fPrev),
        });
      } else if (/^(REIT)?DividendForecastRevision/.test(x.DOC_TYPE || '')) {
        const dPrev = prevForecast(x.FY_EN, 'F_DIV_ANN', 'NXF_DIV_ANN');
        out.push({
          code, date: x.D, kind: 'div', type: '配当予想の修正',
          div: x.F_DIV_ANN, divPrev: dPrev, divChg: chgOf(x.F_DIV_ANN, dPrev),
        });
      }
    });
  }
  return out;
}

/** 新しい値と前の値の向き: up / down / same(どちらかが無ければ null) */
function chgOf(now, prev) {
  if (now == null || prev == null) return null;
  const a = Number(now);
  const b2 = Number(prev);
  return a > b2 ? 'up' : a < b2 ? 'down' : 'same';
}

//------------------------------------------------------------------ 出来事: 大量保有報告書
async function largeVolumeEvents(conn, b, evFilter, evBinds) {
  // 提出者は子表の HLDR_SEQ = 1。親の割合が空なら、保有者1名の書類だけ子の割合で補う
  // (memory: large_volume_ratio_nulls / demand_three_layer と同じ扱い)
  const r = await rows(conn,
    `SELECT l.code, TO_CHAR(l.sub_date, 'YYYY-MM-DD') AS d, l.doc_type_code, l.doc_title,
            l.total_shs_ratio AS r, l.total_shs_ratio_last AS rl,
            (SELECT COUNT(*) FROM large_volume_shareholder_holder h WHERE h.doc_id = l.doc_id) AS hn,
            (SELECT MAX(h.hldr_name) FROM large_volume_shareholder_holder h
              WHERE h.doc_id = l.doc_id AND h.hldr_seq = 1) AS filer,
            (SELECT SUM(h.shs_ratio) FROM large_volume_shareholder_holder h WHERE h.doc_id = l.doc_id) AS hr,
            (SELECT SUM(h.shs_ratio_last) FROM large_volume_shareholder_holder h WHERE h.doc_id = l.doc_id) AS hrl
       FROM large_volume_shareholder l
      WHERE l.code IN (${b.sql}) AND ${evFilter('l.sub_date', 'l.loaded_at')}`,
    { ...b.binds, ...evBinds });
  return r.map((x) => {
    const one = Number(x.HN) === 1;
    const ratio = x.R != null ? x.R * 100 : (one && x.HR != null ? x.HR * 100 : null);
    const last = x.RL != null ? x.RL * 100 : (one && x.HRL != null ? x.HRL * 100 : null);
    const title = String(x.DOC_TITLE || '');
    const docKind = title.startsWith('大量保有報告書') ? '大量保有報告書'
      : String(x.DOC_TYPE_CODE) === '360' || title.startsWith('訂正') ? '訂正報告書' : '変更報告書';
    let dir = null;
    if (ratio == null) dir = 'noratio';
    else if (docKind === '大量保有報告書') dir = 'new';
    else if (ratio < 5) dir = 'below5';
    else if (last != null) dir = ratio > last ? 'up' : ratio < last ? 'down' : 'same';
    return { code: x.CODE, date: x.D, kind: 'lvs', type: docKind, filer: x.FILER, ratio, last, dir };
  });
}

//------------------------------------------------------------------ 出来事: 空売り残高報告
async function shortEvents(conn, b, evFilter, evBinds) {
  const r = await rows(conn,
    `SELECT code, TO_CHAR(disc_date, 'YYYY-MM-DD') AS d, TO_CHAR(calc_date, 'YYYY-MM-DD') AS c,
            ss_name, fund_name, shrt_pos_to_so AS r, prev_rpt_ratio AS pr,
            TO_CHAR(prev_rpt_date, 'YYYY-MM-DD') AS pd
       FROM equity_short_position
      WHERE code IN (${b.sql}) AND ${evFilter('disc_date', 'loaded_at')}
      ORDER BY disc_date, code, ss_name`, { ...b.binds, ...evBinds });
  // 同じ銘柄・同じ公表日の報告は1行にまとめ、報告者ごとの値を items に持つ
  const by = new Map();
  for (const x of r) {
    const k = x.CODE + '|' + x.D;
    if (!by.has(k)) by.set(k, { code: x.CODE, date: x.D, kind: 'short', type: '空売り残高報告', calcDate: x.C, items: [] });
    by.get(k).items.push({
      reporter: x.SS_NAME, fund: x.FUND_NAME,
      ratio: x.R == null ? null : x.R * 100, last: x.PR == null ? null : x.PR * 100, lastDate: x.PD,
    });
  }
  return Array.from(by.values());
}

//------------------------------------------------------------------ 出来事: 日々公表銘柄になった
const ALERT_REASONS = [
  ['REASON_RESTRICTED', '信用規制'],
  ['REASON_DAILY_PUBLICATION', '日々公表'],
  ['REASON_MONITORING', '監視'],
  ['REASON_RESTRICTED_BY_JSF', '日証金の申込制限'],
  ['REASON_PRECAUTION_BY_JSF', '日証金の注意喚起'],
  ['REASON_UNCLEAR_OR_SEC_ALERT', '取引所の注意喚起など'],
];

async function marginAlertEvents(conn, b, evFilter, evBinds) {
  // 「なった」= その公表日の前14日に公表が無かった(続けて公表されている日は出さない)
  const r = await rows(conn,
    `SELECT a.code, TO_CHAR(a.pub_date, 'YYYY-MM-DD') AS d,
            MAX(a.reason_restricted) AS reason_restricted, MAX(a.reason_daily_publication) AS reason_daily_publication,
            MAX(a.reason_monitoring) AS reason_monitoring, MAX(a.reason_restricted_by_jsf) AS reason_restricted_by_jsf,
            MAX(a.reason_precaution_by_jsf) AS reason_precaution_by_jsf,
            MAX(a.reason_unclear_or_sec_alert) AS reason_unclear_or_sec_alert
       FROM v_equity_margin_alert_latest a
      WHERE a.code IN (${b.sql}) AND ${evFilter('a.pub_date', 'a.loaded_at')}
        AND NOT EXISTS (SELECT 1 FROM v_equity_margin_alert_latest p
                         WHERE p.code = a.code AND p.pub_date < a.pub_date AND p.pub_date >= a.pub_date - 14)
      GROUP BY a.code, a.pub_date`, { ...b.binds, ...evBinds });
  return r.map((x) => ({
    code: x.CODE, date: x.D, kind: 'alert', type: '日々公表銘柄になった',
    reasons: ALERT_REASONS.filter(([k]) => String(x[k]) === '1').map(([, ja]) => ja),
  }));
}

//------------------------------------------------------------------ 値動き
async function priceMoves(conn, b, codes, { baseDate, latestDate, topix }) {
  const px = await rows(conn,
    `SELECT code, TO_CHAR(price_date, 'YYYY-MM-DD') AS d, close_price AS c, volume AS v, adj_factor AS af
       FROM equity_price_daily
      WHERE code IN (${b.sql}) AND price_date >= LEAST(TO_DATE(:base, 'YYYY-MM-DD'), TRUNC(SYSDATE) - 60)
      ORDER BY code, price_date`, { ...b.binds, base: baseDate });
  const mg = await rows(conn,
    `SELECT code, TO_CHAR(app_date, 'YYYY-MM-DD') AS d, long_vol, shrt_vol
       FROM equity_margin_interest
      WHERE code IN (${b.sql}) AND app_date >= TRUNC(SYSDATE) - 30
      ORDER BY code, app_date`, b.binds);

  const byCode = new Map();
  for (const x of px) {
    if (!byCode.has(x.CODE)) byCode.set(x.CODE, []);
    byCode.get(x.CODE).push(x);
  }
  const mByCode = new Map();
  for (const x of mg) {
    if (!mByCode.has(x.CODE)) mByCode.set(x.CODE, []);
    mByCode.get(x.CODE).push(x);
  }
  const tBase = topix.get(baseDate);
  const tLast = topix.get(latestDate);
  const topixRet = tBase && tLast ? (tLast / tBase - 1) * 100 : null;

  return codes.map((code) => {
    const list = byCode.get(code) || [];
    const last = list.filter((x) => x.D <= latestDate).pop();
    const base = list.filter((x) => x.D <= baseDate && x.C != null).pop();
    let ret = null;
    let close = null;
    if (last && last.C != null) {
      close = last.C;
      if (base && last.D > base.D) {
        // 基準日より後の分割を基準の終値に掛けてから比べる
        const f = list.filter((x) => x.D > base.D && x.D <= last.D && x.AF != null)
          .reduce((a, x) => a * Number(x.AF), 1);
        ret = (last.C / (base.C * f) - 1) * 100;
      }
    }
    // 出来高の倍率: 最新日 ÷ 直前25営業日の平均(最新日が最新の取引日のときだけ)
    let volRatio = null;
    if (last && last.D === latestDate && last.V != null) {
      const prev = list.filter((x) => x.D < last.D && x.V != null).slice(-VOL_AVG_DAYS);
      if (prev.length >= 10) {
        const avg = prev.reduce((a, x) => a + Number(x.V), 0) / prev.length;
        if (avg > 0) volRatio = last.V / avg;
      }
    }
    const m = mByCode.get(code) || [];
    const m1 = m[m.length - 1];
    const m0 = m[m.length - 2];
    const pct = (a, z) => (a == null || z == null || Number(z) === 0 ? null : (a / z - 1) * 100);
    return {
      code, close, closeDate: last ? last.D : null, ret,
      vsTopix: ret != null && topixRet != null ? ret - topixRet : null,
      volRatio,
      marginDate: m1 ? m1.D : null,
      longChg: m1 && m0 ? pct(m1.LONG_VOL, m0.LONG_VOL) : null,
      shortChg: m1 && m0 ? pct(m1.SHRT_VOL, m0.SHRT_VOL) : null,
      marginRatio: m1 && Number(m1.SHRT_VOL) > 0 ? m1.LONG_VOL / m1.SHRT_VOL : null,
    };
  });
}

//------------------------------------------------------------------ これからの予定
/** 今日から来週の日曜まで: 決算発表予定日と権利付き最終日 */
async function fetchUpcoming(conn, b, codes, today) {
  const d = new Date(today + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  const until = addDays(today, -dow + 13);

  const out = [];
  const es = await rows(conn,
    `SELECT code, fq_name, TO_CHAR(sch_date, 'YYYY-MM-DD') AS d
       FROM v_earnings_schedule_latest
      WHERE code IN (${b.sql})
        AND sch_date BETWEEN TO_DATE(:t, 'YYYY-MM-DD') AND TO_DATE(:u, 'YYYY-MM-DD')`,
    { ...b.binds, t: today, u: until });
  for (const x of es) out.push({ code: x.CODE, date: x.D, kind: 'earn', type: '決算発表', detail: x.FQ_NAME });

  // 権利付き最終日 = 月末の最後の営業日の2営業日前。期末(決算月)と中間(決算月の6か月前)
  const cal = (await rows(conn,
    `SELECT TO_CHAR(calendar_date, 'YYYY-MM-DD') AS d FROM trading_calendar
      WHERE calendar_date BETWEEN TO_DATE(:t, 'YYYY-MM-DD') - 5 AND TO_DATE(:t, 'YYYY-MM-DD') + 70
        AND hol_div IN ('1', '2')
      ORDER BY calendar_date`, { t: today })).map((x) => x.D);
  const lastBizOfMonth = (ym) => cal.filter((x) => x.startsWith(ym)).pop() || null;
  const fy = await rows(conn,
    `SELECT code, TO_CHAR(MAX(cur_fy_en) KEEP (DENSE_RANK LAST ORDER BY disc_date, disc_no), 'MM') AS fm
       FROM financial_summary
      WHERE code IN (${b.sql}) AND cur_fy_en IS NOT NULL AND disc_date >= ADD_MONTHS(TRUNC(SYSDATE), -18)
      GROUP BY code`, b.binds);
  const months = new Set();
  for (let i = 0; i < 3; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    months.add(m.toISOString().slice(0, 7));
  }
  for (const x of fy) {
    const fm = Number(x.FM);
    const mid = ((fm + 5) % 12) + 1;
    for (const ym of months) {
      const mm = Number(ym.slice(5, 7));
      const which = mm === fm ? '期末' : mm === mid ? '中間' : null;
      if (!which) continue;
      const lastBiz = lastBizOfMonth(ym);
      if (!lastBiz) continue;
      const i = cal.indexOf(lastBiz);
      const rd = i >= 2 ? cal[i - 2] : null;
      if (rd && rd >= today && rd <= until) {
        out.push({ code: x.CODE, date: rd, kind: 'right', type: `権利付き最終日(${which})`, detail: `${ym.replace('-', '/')}末の権利` });
      }
    }
  }
  out.sort((x, y) => (x.date === y.date ? x.code.localeCompare(y.code) : (x.date < y.date ? -1 : 1)));
  return { until, items: out };
}

module.exports = { fetchSeen, insertSeen, fetchHistory, fetchHistoryItem, fetchDaily, ymdIn, TZ_JP };
