'use strict';

/**
 * 購入の流れ b) の「ファンダメンタル参考情報」(F1 成長 / F2 割安 / F3 収益・財務、No1〜13)の判定。
 * DB に触らない純粋関数だけを置く(データの取得は purchaseQuery.js)。
 * 設計と判定基準は claude/purchase_flow_design.md。
 *
 * 記号: good = ◎(理想) / ok = 〇(最低ライン) / bad = ×(届かない・警戒) / na = -(データなし)。
 *       warn は記号とは別に付ける注意書き(⚠)。
 *
 * 【決算短信の読み方】
 *   ・実績は累計(1Q→2Q→3Q→FY)。単独の四半期は差分で出す(4Q = FY − 3Q)
 *   ・同じ期に連結と単体の両方があれば連結を使う。訂正があれば後の開示を使う
 *   ・今期予想: 四半期の行は F_*(当期の予想)、本決算の行は NXF_*(翌期の予想)。
 *     業績予想の修正(EarnForecastRevision)の行も含め、項目ごとに一番新しい開示の値を使う
 *   ・1株あたりの値(EPS・BPS・配当)は開示の後に株式分割があれば今の株数に直す
 *     (2:1 の分割は AdjFactor 0.5 なので、EPS は 0.5 倍)
 */

const LEVEL = { good: 3, ok: 2, bad: 1 };

function worst(levels) {
  const xs = levels.filter((x) => x && LEVEL[x]);
  if (!xs.length) return 'na';
  return xs.reduce((a, b) => (LEVEL[b] < LEVEL[a] ? b : a));
}

function isStatement(r) { return typeof r.docType === 'string' && r.docType.includes('FinancialStatements'); }
function isConsolidated(r) { return !String(r.docType).includes('NonConsolidated'); }

/** 前年比(%)。基準が0以下なら率は出さず、黒字化 / 赤字 のどちらかを返す */
function growth(cur, base) {
  if (cur == null || base == null) return null;
  if (base <= 0) return { special: cur > 0 ? '黒字化' : '赤字' };
  return { pct: (cur / base - 1) * 100 };
}

/** 成長率の判定(25%以上 ◎、10%以上 〇) */
function rateGrowth(g) {
  if (!g) return null;
  if (g.special) return g.special === '黒字化' ? 'ok' : 'bad';
  return g.pct >= 25 ? 'good' : g.pct >= 10 ? 'ok' : 'bad';
}

/** 分割の補正係数: 日付 d より後(今日まで)の AdjFactor の積 */
function splitFactor(splits, d) {
  return splits.filter((s) => s.date > d).reduce((p, s) => p * s.af, 1);
}

const METRICS = [
  ['sales', '売上'],
  ['op', '営業益'],
  ['odp', '経常'],
  ['np', '純益'],
];

/**
 * 同じ期(期の種類 × 期末)の決算短信を1行にする。連結を優先し、訂正は後の開示を使う。
 * @returns {object[]} 期末の新しい順
 */
function statements(rows) {
  const by = new Map();
  for (const r of rows.filter(isStatement)) {
    const k = r.perType + '|' + r.perEn;
    const cur = by.get(k);
    const better = !cur ||
      (isConsolidated(r) && !isConsolidated(cur)) ||
      (isConsolidated(r) === isConsolidated(cur) && (r.discDate > cur.discDate || (r.discDate === cur.discDate && r.discNo > cur.discNo)));
    if (better) by.set(k, r);
  }
  const typeOrder = { FY: 5, '4Q': 4, '3Q': 3, '2Q': 2, '1Q': 1 };
  return [...by.values()].sort((a, b) =>
    a.perEn < b.perEn ? 1 : a.perEn > b.perEn ? -1 : (typeOrder[b.perType] || 0) - (typeOrder[a.perType] || 0));
}

/**
 * 今期予想(期末 targetFyEn)を項目ごとに、一番新しい開示から取る。
 * @returns {{[field:string]: {v:number, discDate:string}}}
 */
function pickForecast(rows, targetFyEn) {
  const fields = {
    sales: ['fSales', 'nxfSales'], op: ['fOp', 'nxfOp'], odp: ['fOdp', 'nxfOdp'], np: ['fNp', 'nxfNp'],
    eps: ['fEps', 'nxfEps'], divAnn: ['fDivAnn', 'nxfDivAnn'],
  };
  const sorted = rows.slice().sort((a, b) =>
    a.discDate < b.discDate ? 1 : a.discDate > b.discDate ? -1 : (a.discNo < b.discNo ? 1 : -1));
  const out = {};
  for (const [f, [cur, nxt]] of Object.entries(fields)) {
    for (const r of sorted) {
      let v = null;
      if (r.fyEn === targetFyEn && r[cur] != null) v = r[cur];
      else if (r.perType === 'FY' && isStatement(r) && r.nxtFyEn === targetFyEn && r[nxt] != null) v = r[nxt];
      if (v != null) { out[f] = { v, discDate: r.discDate }; break; }
    }
  }
  return out;
}

/** 業種内の位置。上位から何%か(0 = 一番上)と、3段階の記号 */
function sectorRank(value, list) {
  if (value == null || !list || !list.length) return null;
  const higher = list.filter((x) => x > value).length;
  const topPct = (higher / list.length) * 100;
  const sortedList = list.slice().sort((a, b) => a - b);
  const mid = sortedList.length % 2
    ? sortedList[(sortedList.length - 1) / 2]
    : (sortedList[sortedList.length / 2 - 1] + sortedList[sortedList.length / 2]) / 2;
  return { topPct, n: list.length, median: mid, level: topPct < 100 / 3 ? 'good' : topPct < 200 / 3 ? 'ok' : 'bad' };
}

/**
 * 1銘柄のファンダメンタル判定。
 * @param {object} d
 *   d.close, d.priceDate      最新の終値と日付
 *   d.splits [{date, af}]     分割(AdjFactor ≠ 1)の日と係数
 *   d.rows                    決算短信・予想修正の行(purchaseQuery.fetchFinancialRows の形)
 *   d.revisions [{discDate, docType, rev, kind, verified}]  直近90日の予想修正(lossChecks.revisionFromRow の形)
 *   d.sector  {opm: number[], eqar: number[], per: number[], groupName}  同じ業種の値
 *   d.marketPerMedian         市場全体の予想PERの中央値
 * @returns {{items: object[], asOf: object}}
 */
function evaluate(d) {
  const st = statements(d.rows || []);
  const fys = st.filter((r) => r.perType === 'FY');
  const fy0 = fys[0] || null;
  const fy1 = fys[1] || null;
  const fy2 = fys[2] || null;
  const latest = st[0] || null;
  const items = [];
  const close = d.close;
  const now = (v, discDate) => (v == null ? null : v * splitFactor(d.splits || [], discDate));

  // 進行中の期(今期)
  let targetFyEn = null;
  if (latest) targetFyEn = latest.perType === 'FY' ? latest.nxtFyEn : latest.fyEn;
  const fc = targetFyEn ? pickForecast(d.rows || [], targetFyEn) : {};

  //---------------------------------------------------------------- 1 年間
  {
    const lines = [];
    const levels = [];
    let warn = null;
    const fmtRow = (label, cur, base, rated) => {
      const parts = METRICS.map(([k, ja]) => {
        const g = growth(cur ? (cur[k] && typeof cur[k] === 'object' ? cur[k].v : cur[k]) : null, base ? base[k] : null);
        const lv = rateGrowth(g);
        if (rated && lv) levels.push(lv);
        return { key: k, label: ja, g, level: rated ? lv : null };
      });
      lines.push({ label, parts });
      return parts;
    };
    if (fy0 && fy1) {
      const p = fmtRow(`前期実績(${fy0.fyEn.slice(0, 7)}期)`, fy0, fy1, true);
      const s = p[0].g;
      const o = p[1].g;
      if (s && s.pct > 0 && o && ((o.pct != null && o.pct < 0) || o.special === '赤字')) warn = '売上は伸びたが営業益が減った(利益率の悪化)';
    }
    if (fy0 && Object.keys(fc).length) {
      const p = fmtRow(`今期予想(${String(targetFyEn).slice(0, 7)}期)`, fc, fy0, true);
      const s = p[0].g;
      const o = p[1].g;
      if (!warn && s && s.pct > 0 && o && ((o.pct != null && o.pct < 0) || o.special === '赤字')) warn = '今期予想: 売上は伸びるが営業益が減る(利益率の悪化)';
    } else if (fy0) {
      lines.push({ label: '今期予想', text: '会社予想なし(予想を出していない会社)' });
    }
    if (fy1 && fy2) fmtRow(`前々期実績(${fy1.fyEn.slice(0, 7)}期、参考)`, fy1, fy2, false);
    items.push({ no: 1, group: 'F1', label: '年間の増収・増益率', level: worst(levels), warn, lines });
  }

  //---------------------------------------------------------------- 2 四半期
  {
    const qn = (t) => ({ '1Q': 1, '2Q': 2, '3Q': 3, FY: 4 }[t] || null);
    const cum = (fyEn, n) => st.find((r) => r.fyEn === fyEn && qn(r.perType) === n) || null;
    const single = (fyEn, n, k) => {
      const c = cum(fyEn, n);
      if (!c || c[k] == null) return null;
      if (n === 1) return c[k];
      const p = cum(fyEn, n - 1);
      return p && p[k] != null ? c[k] - p[k] : null;
    };
    const lines = [];
    const levels = [];
    let warn = null;
    let level = 'na';
    if (latest && qn(latest.perType)) {
      const n = qn(latest.perType);
      const fyEn = latest.fyEn;
      const prevFy = fys.find((r) => r.fyEn < fyEn);
      const prevFyEn = prevFy ? prevFy.fyEn : null;
      const qLabel = n === 4 ? '4Q' : n + 'Q';
      const yoy = METRICS.map(([k, ja]) => {
        const g = prevFyEn ? growth(single(fyEn, n, k), single(prevFyEn, n, k)) : null;
        const lv = rateGrowth(g);
        if (lv) levels.push(lv);
        return { key: k, label: ja, g, level: lv };
      });
      const qoq = METRICS.map(([k, ja]) => {
        const prev = n === 1 ? (prevFyEn ? single(prevFyEn, 4, k) : null) : single(fyEn, n - 1, k);
        return { key: k, label: ja, g: growth(single(fyEn, n, k), prev), level: null };
      });
      lines.push({ label: `${fyEn.slice(0, 7)}期 ${qLabel} 前年同期比`, parts: yoy });
      lines.push({ label: '前四半期比(参考)', parts: qoq });
      level = worst(levels);
      const o = yoy[1].g;
      const np = yoy[3].g;
      if (o && np && o.pct != null && np.pct != null && np.pct >= 50 && np.pct - o.pct >= 30) {
        warn = '純益の伸びが営業益より極端に大きい(一時的要因の可能性)';
      } else if (np && np.special === '黒字化' && o && o.special !== '黒字化' && (o.pct == null || o.pct < 10)) {
        warn = '純益だけ黒字化(一時的要因の可能性)';
      }
      if (!yoy.some((p) => p.g)) lines.push({ text: '前年の同じ四半期と比べられない(単独四半期を出す決算短信が足りない)' });
    } else {
      lines.push({ text: '決算短信がない' });
    }
    items.push({ no: 2, group: 'F1', label: '四半期の増収・増益率', level, warn, lines });
  }

  //---------------------------------------------------------------- 3 進捗率
  {
    const lines = [];
    let level = 'na';
    const qn = { '1Q': 1, '2Q': 2, '3Q': 3 }[latest && latest.perType];
    if (qn && latest.fyEn === targetFyEn) {
      const target = qn * 25;
      const parts = [['sales', '売上'], ['op', '営業益'], ['np', '純益']].map(([k, ja]) => {
        const f = fc[k] ? fc[k].v : null;
        const p = latest[k] != null && f != null && f > 0 ? (latest[k] / f) * 100 : null;
        return { key: k, label: ja, p };
      });
      const op = parts[1].p;
      if (op != null) level = op >= target ? 'good' : op >= target - 5 ? 'ok' : 'bad';
      lines.push({ label: `${qn}Q 時点(目安 ${target}%)`, progress: parts });
      // 過去3年の同じ四半期(その時点の会社予想に対する進捗)
      const past = fys.slice(0, 3).map((fy) => {
        const r = st.find((x) => x.fyEn === fy.fyEn && x.perType === latest.perType);
        const p = r && r.op != null && r.fOp != null && r.fOp > 0 ? (r.op / r.fOp) * 100 : null;
        return { fyEn: fy.fyEn, p };
      });
      lines.push({ label: `過去の同じ時期(営業益)`, past });
      if (!fc.op) lines.push({ text: '営業益の会社予想がない' });
    } else if (latest && latest.perType === 'FY') {
      lines.push({ text: '本決算の直後のため、次の1Qの発表から表示' });
    } else {
      lines.push({ text: '会社予想または決算短信がない' });
    }
    items.push({ no: 3, group: 'F1', label: '進捗率', level, warn: null, lines });
  }

  //---------------------------------------------------------------- 4 来期予想の伸び
  // 本決算で出る翌期予想は、そのまま「今期予想」になるため 1 の今期予想の行に含めている
  items.push({ no: 4, group: 'F1', label: '来期予想の伸び', level: 'na', warn: null,
    lines: [{ text: '1 の「今期予想」に含めています(本決算で出る翌期予想が、そのまま今期予想になるため)' }] });

  //---------------------------------------------------------------- 5 予想の修正
  {
    const revs = d.revisions || [];
    const lines = revs.length
      ? revs.map((r) => ({ revision: r }))
      : [{ text: '直近90日に、営業利益予想の変更を伴う開示はない' }];
    const last = revs.find((r) => r.kind) || null;
    const level = !last ? 'ok' : last.kind === 'UP' ? 'good' : last.kind === 'DOWN' ? 'bad' : 'ok';
    items.push({ no: 5, group: 'F1', label: '予想の修正', level, warn: null, lines });
  }

  //---------------------------------------------------------------- 6 PER
  const epsF = fc.eps ? now(fc.eps.v, fc.eps.discDate) : null;
  const epsA = fy0 && fy0.eps != null ? now(fy0.eps, fy0.discDate) : null;
  const perF = epsF != null && epsF > 0 && close ? close / epsF : null;
  const perA = epsA != null && epsA > 0 && close ? close / epsA : null;
  {
    const per = perF != null ? perF : perA;
    let level = 'na';
    if (per != null) level = per < 20 ? 'good' : per < 30 ? 'ok' : 'bad';
    else if ((epsF != null && epsF <= 0) || (epsF == null && epsA != null && epsA <= 0)) level = 'bad';
    const sec = d.sector && d.sector.per && d.sector.per.length ? sectorRank(0, d.sector.per) : null;
    const lines = [{
      per: {
        forecast: perF, actual: perA, epsF, epsA,
        lossF: epsF != null && epsF <= 0, lossA: epsA != null && epsA <= 0,
        sectorMedian: sec ? sec.median : null, marketMedian: d.marketPerMedian,
        basis: perF != null ? '予想' : perA != null ? '実績' : null,
      },
    }];
    const warn = per != null && per < 10 ? '低PER: 業績悪化・財務不安・成長鈍化がないか確認' : null;
    items.push({ no: 6, group: 'F2', label: 'PER', level, warn, lines });
  }

  //---------------------------------------------------------------- 7 PBR
  {
    const bpsRow = st.find((r) => r.bps != null && r.bps > 0);
    const bps = bpsRow ? now(bpsRow.bps, bpsRow.discDate) : null;
    const pbr = bps && close ? close / bps : null;
    const level = pbr == null ? 'na' : pbr < 1 ? 'good' : pbr < 3 ? 'ok' : 'bad';
    items.push({ no: 7, group: 'F2', label: 'PBR', level, warn: null,
      lines: [{ value: { pbr, bps, from: bpsRow ? bpsRow.perEn : null } }] });
  }

  //---------------------------------------------------------------- 8 配当利回り
  {
    let div = fc.divAnn ? now(fc.divAnn.v, fc.divAnn.discDate) : null;
    let basis = '予想';
    if (div == null && fy0 && fy0.divAnn != null) { div = now(fy0.divAnn, fy0.discDate); basis = '実績'; }
    const y = div != null && close ? (div / close) * 100 : null;
    const level = y == null ? 'na' : y >= 3 ? 'good' : y >= 1 ? 'ok' : 'bad';
    const warn = y != null && y > 6 ? '利回りが高すぎる(減配の可能性も確認)' : null;
    items.push({ no: 8, group: 'F2', label: '配当利回り', level, warn, lines: [{ value: { yield: y, div, basis } }] });
  }

  //---------------------------------------------------------------- 9 PEG
  {
    const g = epsF != null && epsA != null && epsA > 0 ? (epsF / epsA - 1) * 100 : null;
    let peg = null;
    let level = 'na';
    let note = null;
    if (perF != null && g != null) {
      if (g <= 0) { level = 'bad'; note = 'EPSの伸びがマイナスのため評価不能'; }
      else { peg = perF / g; level = peg < 1 ? 'good' : peg < 2 ? 'ok' : 'bad'; }
    }
    items.push({ no: 9, group: 'F2', label: 'PEG', level, warn: null, lines: [{ value: { peg, per: perF, epsGrowth: g, note } }] });
  }

  //---------------------------------------------------------------- 10 ROE
  {
    const roeRow = fys.find((r) => r.roe != null);
    const roe = roeRow ? roeRow.roe * 100 : null;
    const level = roe == null ? 'na' : roe >= 15 ? 'good' : roe >= 8 ? 'ok' : 'bad';
    items.push({ no: 10, group: 'F3', label: 'ROE', level, warn: null, lines: [{ value: { roe, from: roeRow ? roeRow.perEn : null } }] });
  }

  //---------------------------------------------------------------- 11 営業利益率(業種内)
  {
    const opm = fy0 && fy0.sales > 0 && fy0.op != null ? (fy0.op / fy0.sales) * 100 : null;
    const rk = d.sector ? sectorRank(opm, d.sector.opm) : null;
    items.push({ no: 11, group: 'F3', label: '営業利益率', level: rk ? rk.level : 'na', warn: null,
      lines: [{ value: { opm, rank: rk, groupName: d.sector ? d.sector.groupName : null, from: fy0 ? fy0.perEn : null } }] });
  }

  //---------------------------------------------------------------- 12 自己資本比率(業種内)
  {
    const eqRow = st.find((r) => r.eqAr != null);
    const eqar = eqRow ? eqRow.eqAr * 100 : null;
    const rk = d.sector ? sectorRank(eqar, d.sector.eqar) : null;
    items.push({ no: 12, group: 'F3', label: '自己資本比率', level: rk ? rk.level : 'na', warn: null,
      lines: [{ value: { eqar, rank: rk, groupName: d.sector ? d.sector.groupName : null, from: eqRow ? eqRow.perEn : null } }] });
  }

  //---------------------------------------------------------------- 13 営業キャッシュフロー
  {
    const r = fys.find((x) => x.cfo != null);
    let level = 'na';
    if (r) level = r.cfo <= 0 ? 'bad' : r.np != null && r.cfo >= r.np ? 'good' : 'ok';
    items.push({ no: 13, group: 'F3', label: '営業キャッシュフロー', level, warn: null,
      lines: [{ value: { cfo: r ? r.cfo : null, np: r ? r.np : null, from: r ? r.perEn : null } }] });
  }

  return {
    items,
    asOf: {
      priceDate: d.priceDate, close,
      latestStatement: latest ? { perType: latest.perType, fyEn: latest.fyEn, discDate: latest.discDate } : null,
      targetFyEn,
    },
  };
}

module.exports = { evaluate, _internal: { growth, rateGrowth, statements, pickForecast, sectorRank, splitFactor, worst } };
