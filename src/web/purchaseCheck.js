'use strict';

/**
 * 購入の流れ c) 損失回避チェック(/purchase/check)のサーバー側。
 * 2026-10-14 に、読む順を「1 前提 → 2 銘柄ごとの赤信号で外すか決める → 3 残った銘柄の金額と損切り → 4 判断メモへ」
 * に組み替え、問いを減らした(claude/purchase_flow_design.md の「c) の見直し」)。
 * 値の計算は src/lossChecks.js(check.js と同じ。computeMetrics・sizing・stopInfo など)を使い、文言はここで作る。
 *
 * 【金額の扱い】(2026-10-14 変更)
 *   銘柄ごとに株数を入れる(既定 100株)。買う額 = 買値 × 株数、総額 = その合計。
 *   銘柄ごとの「ふつうの1週で動く額」「損切りで売ったときの損失」はその買う額で出す。
 *   1/週次ボラ の比の配分(lossChecks.sizing)は、同じ総額をその比で分けたら何株か、の参考としてだけ出す。
 *
 * 【問いの番号】(JNL_CHECK_ANSWER.QUESTION_ID)
 *   P-SEMI   前提: 半導体の銘柄数(全体。銘柄コードの代わりに 'ALL')。選ぶ形(よい / 減らす)
 *   R-AVOID / R-DIP / R-DOWNREV / R-SURGE / R-REBUY  赤信号。「要確認」の銘柄にだけ出す
 *   R-OUT    外すかどうかの印(答えは「外す」。画面のチェックボックス)
 *   S-SIZE   金額: この株数で買うか(全体)。選ぶ形(この株数で買う / 変える)
 *   S-STOP   損切り: 置くか、幅はいくらか(銘柄ごと)。選ぶ形(入力した損切り幅 / 置かない)
 *   2026-10-13 版の「Ch番号-連番」の答えは表に残るが、この画面では出さない。
 */

const oracledb = require('oracledb');
const lc = require('../lossChecks');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const MAX_CODES = 5;
const ALL = 'ALL';
const REV_DAYS = 30;
const DEFAULT_SHARES = 100;
const QID_RE = /^(P-SEMI|R-AVOID|R-DIP|R-DOWNREV|R-SURGE|R-REBUY|R-OUT|S-SIZE|S-STOP)$/;

const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const f2 = (x) => (x == null ? '—' : x.toFixed(2));
const sg = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(1));
const man = (x) => (x == null ? '—' : (x / 10000).toFixed(1) + '万円');
const oku = (x) => (x == null ? '—' : Math.round(x / 1e6).toLocaleString('en-US'));

/** 保有(タグ jnl_held)のうち半導体(タグ120/130)の銘柄コード */
async function fetchHeldSemiCodes(conn) {
  const ph = lc.SEMI_TAGS.map((_, i) => `:t${i}`).join(',');
  const binds = {};
  lc.SEMI_TAGS.forEach((t, i) => (binds[`t${i}`] = t));
  const r = await conn.execute(
    `SELECT DISTINCT h.code FROM favorite_tag h
       JOIN favorite_tag s ON s.code = h.code AND s.tag_name IN (${ph})
      WHERE h.tag_name = 'jnl_held'`, binds, OBJ);
  return r.rows.map((x) => x.CODE);
}

//------------------------------------------------------------------ 2 赤信号
function flagAvoid(code, avoid) {
  const a = avoid && avoid.d10 ? avoid.d10[code] : null;
  const lines = [];
  if (!avoid || avoid.error) lines.push('外す候補を計算できなかった');
  else if (a) {
    lines.push(`外す候補に該当する(追加下落スコアの上位10%。銘柄購入の一覧の印と同じ。${avoid.asOf} 時点、母集団 ${avoid.population} 銘柄)`);
    lines.push(`高値から ${sg(a.dd)}% / ふつうの1週の動き ${f2(a.vol13)}% / 4週の騰落 ${sg(a.ret4w)}% / 売買代金 ${f1(a.turnover)}億円/日`);
  } else lines.push('外す候補ではない');
  return {
    key: 'AVOID', label: '外す候補の印', hit: !!a, lines,
    question: a ? { id: 'R-AVOID', text: '外すか、残すか。残すならその理由' } : null,
  };
}

function flagDip(m) {
  const lines = [];
  let hit = false;
  if (!m || m.dd250 == null) lines.push('高値からの下落を出せない');
  else {
    lines.push(`高値からの下落: ${sg(m.dd250)}%(250営業日の調整後終値の最高値 ${m.hiDate} から)`);
    lines.push(`直近の騰落: 13週 ${sg(m.ret13w)}% / 4週 ${sg(m.ret4w)}% / 20営業日 ${sg(m.ret20d)}%`);
    if (m.dd250 <= -15) {
      hit = true;
      lines.push('−15% 以下に該当する');
      lines.push('52週高値から −15% 以下の銘柄は、その後13週のうちにさらに −10% 以上下がった割合が 32〜59%(検証資料。値動きの小さい銘柄ほど低い側)');
    } else lines.push('−15% 以下ではない');
    if (m.ddWindowDays < 200) lines.push(`注意: 高値を探した期間が ${m.ddWindowDays} 営業日しかない`);
  }
  return {
    key: 'DIP', label: '高値から −15% 以下', hit, lines,
    question: hit ? { id: 'R-DIP', text: '「底」と考える理由は何か' } : null,
  };
}

function flagDownrev(revisions) {
  const lines = [];
  const recent = (revisions || []).filter((r) => r.kind);
  const down = recent.filter((r) => r.verified && r.kind === 'DOWN');
  if (!revisions) lines.push('財務情報を取得できなかった');
  else if (!recent.length) lines.push(`直近${REV_DAYS}日以内に、予想の変更を伴う開示は見つからなかった`);
  for (const r of recent) {
    const kindJa = r.kind === 'DOWN' ? '下方' : r.kind === 'UP' ? '上方' : '小幅';
    lines.push(`${r.discDate} 営業利益予想 ${oku(r.prevOp)} → ${oku(r.fOp)} 百万円(${kindJa}。修正幅 ${sg(r.rev)}pt = 営業益の変化 ÷ 売上高予想)` +
      `${r.verified ? '' : ' ※決算短信での予想変更は未検証。検証済みなのは「業績予想の修正」なので混同しないこと'}`);
  }
  // 結論の行(ほかの赤信号の「−15% 以下ではない」などに合わせる)
  if (down.length) lines.push('下方修正に該当する');
  else if (recent.some((r) => r.kind === 'DOWN')) lines.push('決算短信での予想の下方変更はあるが、「業績予想の修正」による下方修正ではない');
  else if (recent.length) lines.push('下方修正ではない');
  if (down.length) {
    lines.push('検証資料: 下方修正を出した銘柄は、同業種・同規模の銘柄より 4週で −0.89pt、13週で −1.57pt 下回った(平均)');
  }
  return {
    key: 'DOWNREV', label: `直近${REV_DAYS}日の下方修正`, hit: down.length > 0, lines,
    question: down.length ? { id: 'R-DOWNREV', text: '外すか、残すか。残すならその理由(修正が一時的か、続くものか)' } : null,
  };
}

function flagSurge(m) {
  const lines = [];
  let hit = false;
  if (!m || !m.vbu || !m.vbu.available) {
    lines.push(`出来高を比べられない${m && m.vbu && m.vbu.reason ? `(${m.vbu.reason})` : ''}`);
  } else {
    lines.push(`直近5営業日の出来高は直前20営業日の ${f2(m.vbu.vr)} 倍、5営業日の騰落 ${sg(m.vbu.ret5d)}%`);
    if (m.vbu.flag) {
      hit = true;
      lines.push('出来高2倍以上かつ +3% 以上の急騰に該当する');
      lines.push('検証では、その後13週で −1.63pt(売買代金1億円/日以上では −3.39pt)');
    } else lines.push('出来高2倍以上かつ +3% 以上の急騰ではない');
  }
  return {
    key: 'SURGE', label: '出来高を伴う急騰', hit, lines,
    question: hit ? { id: 'R-SURGE', text: '急騰の理由を知っているか' } : null,
  };
}

function flagRebuy(pastExits) {
  const lines = [];
  const hit = !!(pastExits && pastExits.length);
  if (!pastExits) lines.push('売買記録を取得できなかった');
  else if (!hit) lines.push('この銘柄を過去180日以内に売った・損切りした記録はない');
  else {
    for (const e of pastExits) {
      lines.push(`${e.decisionDate} ${e.action}(${e.reasonCat})${e.sinceRet != null ? ` — その後の値動き ${sg(e.sinceRet)}%` : ''}`);
    }
    lines.push('過去180日以内に売った・損切りした記録があるので該当する');
  }
  return {
    key: 'REBUY', label: '過去180日に売った', hit, lines,
    question: hit ? { id: 'R-REBUY', text: '売ったときと別の、買い直す理由は何か' } : null,
  };
}

/** 判断メモ(d)に残す値。画面には出さない */
function snapshotOf(m, revisions) {
  const down = (revisions || []).filter((r) => r.verified && r.kind === 'DOWN');
  return {
    vol13: m ? m.vol13 : null,
    dd250: m ? m.dd250 : null,
    ret20d: m ? m.ret20d : null,
    downRevisions: revisions ? down.map((r) => ({ discDate: r.discDate, rev: r.rev })) : null,
  };
}

/**
 * @param {object} p {codes: string[], exclude: string[], stopPcts: number[], buys: {code: number}, shares: {code: number}, avoid}
 */
async function runCheck(conn, p) {
  const base = { stopPcts: p.stopPcts, days: REV_DAYS, withCodes: [] };
  const collected = [];
  for (const code of p.codes) collected.push(await lc.collect(conn, code, base));
  const heldSemi = await fetchHeldSemiCodes(conn).catch(() => null);
  const exclude = new Set(p.exclude || []);

  // 2 赤信号(全銘柄)
  const stocks = collected.map((c) => {
    const m = c.metrics;
    const buyIn = p.buys && p.buys[c.code] != null ? p.buys[c.code] : null;
    return {
      code: c.code,
      name: c.name,
      isSemi: !!c.isSemi,
      excluded: exclude.has(c.code),
      lastClose: m ? m.lastClose : null,
      buy: buyIn != null ? buyIn : m ? m.lastClose : null,
      buyIsDefault: buyIn == null,
      vol13: m ? m.vol13 : null,
      flags: [flagAvoid(c.code, p.avoid), flagDip(m), flagDownrev(c.revisions), flagSurge(m), flagRebuy(c.pastExits)],
      snapshot: snapshotOf(m, c.revisions),
    };
  });

  // 3 金額と損切り(外さなかった銘柄だけ)
  const kept = stocks.filter((s) => !s.excluded);
  const base0 = kept.map((s) => {
    const shares = p.shares && p.shares[s.code] != null ? p.shares[s.code] : DEFAULT_SHARES;
    return { s, shares, yen: s.buy != null ? s.buy * shares : null };
  });
  const sum = (arr) => (arr.some((x) => x == null) || !arr.length ? null : arr.reduce((t, x) => t + x, 0));
  const totalYen = sum(base0.map((b) => b.yen));
  // 参考: 同じ総額を 1/週次ボラ の比で分けたときの株数
  const ref = lc.sizing(kept.map((s) => ({ code: s.code, vol13: s.vol13 })), totalYen);
  const rows = base0.map((b, i) => {
    const s = b.s;
    const stops = lc.stopInfo({ buy: s.buy, stopPcts: p.stopPcts, vol13: s.vol13, amount: b.yen }).map((x) => ({
      pct: x.stopPct, price: x.stopPrice, timesWeek: x.widthInVolWeeks, lossYen: x.lossYen,
    }));
    const r = ref[i];
    return {
      code: s.code, name: s.name, buy: s.buy, buyIsDefault: s.buyIsDefault, vol13: s.vol13,
      shares: b.shares, sharesIsDefault: !(p.shares && p.shares[s.code] != null),
      yen: b.yen, share: b.yen != null && totalYen ? b.yen / totalYen : null,
      weekYen: b.yen != null && s.vol13 != null ? (b.yen * s.vol13) / 100 : null,
      refWeight: r.weight, refShares: r.yen != null && s.buy ? r.yen / s.buy : null,
      stops,
    };
  });
  const totals = {
    yen: totalYen,
    weekYen: sum(rows.map((r) => r.weekYen)),
    stopLoss: p.stopPcts.map((pct, j) => ({ pct, lossYen: sum(rows.map((r) => r.stops[j].lossYen)) })),
  };

  // 1 前提
  const cap = collected.length ? collected[0].capital : null;
  const capLines = [];
  if (cap && cap.current) {
    const fl = cap.flows || {};
    capLines.push({ label: '元手', value: man(cap.current.amount), note: `${cap.current.effectiveDate} から` });
    capLines.push({ label: '株に入れた正味の額', value: man(cap.netInvested), note: `取得額の累計 ${man(fl.buyTotal)} − 売却額の累計 ${man(fl.sellTotal)}` });
    capLines.push({ label: 'まだ使っていない元手', value: man(cap.unused), note: '元手 − 株に入れた正味の額', key: true });
  }
  const candSemi = kept.filter((s) => s.isSemi).map((s) => s.code);
  const semiAll = heldSemi ? Array.from(new Set([...heldSemi, ...candSemi])) : null;
  const premise = {
    capital: capLines,
    capitalMissing: !(cap && cap.current),
    unusedYen: cap && cap.current ? cap.unused : null, // 3 で買う額の合計と比べる
    semi: semiAll ? {
      total: semiAll.length, held: heldSemi.length, cand: candSemi.length,
      both: candSemi.filter((c) => heldSemi.includes(c)).length,
    } : null,
    question: semiAll && semiAll.length
      ? { id: 'P-SEMI', text: `半導体が ${semiAll.length} 銘柄になる。よいか`, options: ['よい', '減らす'] } : null,
  };

  return {
    asOf: collected.length && collected[0].metrics ? collected[0].metrics.asOf : null,
    amount: totals.yen,
    stopPcts: p.stopPcts,
    premise,
    stocks,
    sizing: {
      rows, totals,
      sizeQuestion: { id: 'S-SIZE', text: 'この株数で買うか(変えるなら、株数か買値を変えて再計算)', options: ['この株数で買う', '変える'] },
      stopQuestion: {
        id: 'S-STOP', text: '損切りを置くか、置くなら幅はいくらか(判断メモの「予定の損切り」に入る)',
        options: [...p.stopPcts.map((x) => `${x}%`), '置かない'],
      },
    },
  };
}

/**
 * 保存した答えの読み込み。このリストの「答えを保存」の新しい順に見て、
 * (銘柄, 問い) ごとに一番新しい答えを返す。入力欄の値は一番新しい保存のもの。
 */
async function fetchSaved(conn, listId, codes) {
  const runs = await conn.execute(
    `SELECT run_id, codes, amount_yen, stop_pcts, buy_prices_json,
            TO_CHAR(run_at, 'YYYY-MM-DD HH24:MI') AS run_at
       FROM jnl_check_run WHERE list_id = :id ORDER BY run_at DESC, run_id DESC FETCH FIRST 50 ROWS ONLY`,
    { id: listId }, { ...OBJ, fetchInfo: { BUY_PRICES_JSON: { type: oracledb.STRING } } });
  if (!runs.rows.length) return { latest: null, answers: {} };
  const want = new Set([...codes, ALL]);
  const ids = runs.rows.map((r) => r.RUN_ID);
  const binds = {};
  const ph = ids.map((v, i) => { binds['r' + i] = v; return ':r' + i; }).join(',');
  const ans = await conn.execute(
    `SELECT a.run_id, a.code, a.question_id, a.answer FROM jnl_check_answer a WHERE a.run_id IN (${ph})`, binds, OBJ);
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = ans.rows
    .filter((x) => want.has(x.CODE) && QID_RE.test(x.QUESTION_ID))
    .sort((a, b) => order.get(a.RUN_ID) - order.get(b.RUN_ID));
  // R-OUT(外す印)は「その保存の時点で外していた」ことを表すので、一番新しい保存のものだけを見る
  const latestId = ids[0];
  const answers = {};
  for (const x of rows) {
    if (x.QUESTION_ID === 'R-OUT' && x.RUN_ID !== latestId) continue;
    const k = x.CODE + '|' + x.QUESTION_ID;
    if (!(k in answers)) answers[k] = x.ANSWER || '';
  }
  const l = runs.rows[0];
  // BUY_PRICES_JSON は {"buys": {コード: 買値}, "shares": {コード: 株数}}。2026-10-14 より前は {コード: 買値} だけ
  let buys = {};
  let shares = {};
  try {
    const j = l.BUY_PRICES_JSON ? JSON.parse(l.BUY_PRICES_JSON) : {};
    if (j && typeof j.buys === 'object') { buys = j.buys || {}; shares = j.shares || {}; } else buys = j || {};
  } catch (e) { buys = {}; shares = {}; }
  return {
    latest: { runId: l.RUN_ID, runAt: l.RUN_AT, codes: l.CODES, amount: l.AMOUNT_YEN, stopPcts: l.STOP_PCTS, buys, shares },
    answers,
  };
}

/** 「答えを保存」1回分を書く。保存のたびに新しい RUN(上書きしない)。AMOUNT_YEN は買う額の合計。SWING_YEN は使わなくなったので NULL */
async function saveRun(conn, r) {
  const out = await conn.execute(
    `INSERT INTO jnl_check_run (list_id, codes, amount_yen, swing_yen, stop_pcts, buy_prices_json)
     VALUES (:list_id, :codes, :amount, NULL, :stops, :buys)
     RETURNING run_id INTO :id`,
    {
      list_id: r.listId, codes: r.codes.join(','), amount: r.amount,
      stops: r.stopPcts.join(','), buys: JSON.stringify({ buys: r.buys || {}, shares: r.shares || {} }),
      id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });
  const runId = out.outBinds.id[0];
  const rows = r.answers.filter((a) => a.answer != null && String(a.answer).trim() !== '')
    .map((a) => ({ run_id: runId, code: a.code, qid: a.qid, answer: String(a.answer) }));
  if (rows.length) {
    await conn.executeMany(
      `INSERT INTO jnl_check_answer (run_id, code, question_id, answer) VALUES (:run_id, :code, :qid, :answer)`,
      rows, { bindDefs: { run_id: { type: oracledb.NUMBER }, code: { type: oracledb.STRING, maxSize: 10 },
        qid: { type: oracledb.STRING, maxSize: 20 }, answer: { type: oracledb.STRING, maxSize: 8000 } } });
  }
  await conn.commit();
  return { runId, saved: rows.length };
}

//------------------------------------------------------------------ d) 判断メモの登録時に残す値

/** チェックの記録1回分(入力と答え) */
async function fetchRun(conn, runId) {
  const r = await conn.execute(
    `SELECT run_id, list_id, codes, amount_yen, stop_pcts, buy_prices_json,
            TO_CHAR(run_at, 'YYYY-MM-DD HH24:MI') AS run_at
       FROM jnl_check_run WHERE run_id = :id`,
    { id: runId }, { ...OBJ, fetchInfo: { BUY_PRICES_JSON: { type: oracledb.STRING } } });
  if (!r.rows.length) return null;
  const l = r.rows[0];
  let buys = {};
  let shares = {};
  try {
    const j = l.BUY_PRICES_JSON ? JSON.parse(l.BUY_PRICES_JSON) : {};
    if (j && typeof j.buys === 'object') { buys = j.buys || {}; shares = j.shares || {}; } else buys = j || {};
  } catch (e) { buys = {}; shares = {}; }
  const a = await conn.execute(
    `SELECT code, question_id, answer FROM jnl_check_answer WHERE run_id = :id`, { id: runId }, OBJ);
  return {
    runId: l.RUN_ID, listId: l.LIST_ID, runAt: l.RUN_AT, codes: String(l.CODES || '').split(',').filter(Boolean),
    amount: l.AMOUNT_YEN, stopPcts: String(l.STOP_PCTS || '').split(',').filter(Boolean).map(Number),
    buys, shares, answers: a.rows.map((x) => ({ code: x.CODE, qid: x.QUESTION_ID, answer: x.ANSWER })),
  };
}

/**
 * 1銘柄の c) の値を、登録の時点で計算し直して返す(株価・開示は後で増えるため、判断時の値はここにしか残らない)。
 * 買値・株数・答えはチェックの記録(run)から取る。run が無ければ買値は直近終値、株数は無し。
 */
async function checkSnapshot(conn, code, run, avoid) {
  const stopPcts = run && run.stopPcts.length ? run.stopPcts : [10, 15];
  const c = await lc.collect(conn, code, { stopPcts, days: REV_DAYS, withCodes: [] });
  const m = c.metrics;
  const buyIn = run && run.buys[code] != null ? Number(run.buys[code]) : null;
  const buy = buyIn != null ? buyIn : m ? m.lastClose : null;
  const inRun = !!(run && run.codes.includes(code));
  const shares = inRun ? (run.shares[code] != null ? Number(run.shares[code]) : DEFAULT_SHARES) : null;
  const yen = buy != null && shares != null ? buy * shares : null;
  const answers = {};
  if (run) {
    for (const x of run.answers) {
      if (x.code === code || x.code === ALL) answers[(x.code === ALL ? 'ALL:' : '') + x.qid] = x.answer;
    }
  }
  const flags = [flagAvoid(code, avoid), flagDip(m), flagDownrev(c.revisions), flagSurge(m), flagRebuy(c.pastExits)]
    .map((f) => ({ key: f.key, label: f.label, hit: f.hit }));
  return {
    asOf: m ? m.asOf : null,
    lastClose: m ? m.lastClose : null,
    buy, buyIsDefault: buyIn == null, shares, yen,
    stops: lc.stopInfo({ buy, stopPcts, vol13: m ? m.vol13 : null, amount: yen }).map((x) => ({
      pct: x.stopPct, price: x.stopPrice, timesWeek: x.widthInVolWeeks, lossYen: x.lossYen,
    })),
    ...snapshotOf(m, c.revisions),
    ret13w: m ? m.ret13w : null,
    ret4w: m ? m.ret4w : null,
    flags,
    excluded: answers['R-OUT'] != null,
    answers,
  };
}

async function fetchDecisionHead(conn, decisionId) {
  const r = await conn.execute(
    `SELECT decision_id, code, action, TO_CHAR(decision_date, 'YYYY-MM-DD') AS decision_date
       FROM jnl_decision WHERE decision_id = :id`, { id: decisionId }, OBJ);
  return r.rows.length ? { decisionId: r.rows[0].DECISION_ID, code: r.rows[0].CODE, action: r.rows[0].ACTION, decisionDate: r.rows[0].DECISION_DATE } : null;
}

async function snapshotExists(conn, decisionId) {
  const r = await conn.execute(`SELECT COUNT(*) AS n FROM jnl_decision_snapshot WHERE decision_id = :id`, { id: decisionId }, OBJ);
  return r.rows[0].N > 0;
}

async function insertSnapshot(conn, { decisionId, listId, runId, payload }) {
  await conn.execute(
    `INSERT INTO jnl_decision_snapshot (decision_id, list_id, run_id, payload) VALUES (:d, :l, :r, :p)`,
    { d: decisionId, l: listId, r: runId, p: { val: JSON.stringify(payload), type: oracledb.CLOB } });
  await conn.commit();
}

module.exports = {
  MAX_CODES, ALL, QID_RE, DEFAULT_SHARES, runCheck, fetchSaved, saveRun,
  fetchRun, checkSnapshot, fetchDecisionHead, snapshotExists, insertSnapshot,
};
