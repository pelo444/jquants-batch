'use strict';

/**
 * 購入の流れ b) の「テクニカル参考情報」(T 値動き・需給: テクニカル7項目 ①〜⑦ と No19 信用倍率)の判定。
 * DB に触らない純粋関数だけを置く(データの取得は purchaseFundQuery.js)。
 * 判定基準はユーザーが貼り付けた「9.テクニカル分析方法」(claude/purchase_flow_design.md)。
 *
 * 記号: good = ◎ / ok = 〇 / bad = × / na = -。warn は記号とは別の注意書き(⚠)。
 *
 * 【株価の調整】
 *   四本値は「その日より後の AdjFactor の累積積」を掛けて今の株数の水準に揃える(webQuery.js と同じ)。
 *   出来高は同じ累積積で割る(2:1 の分割なら過去の出来高を 2 倍にする)。
 *
 * 【他の項目の結果を見る判定】
 *   ② ゴールデンクロス未完成・③ 乖離率5%超・⑥ すぐ上に抵抗線、の3つは、基準に
 *   「ローソク足・出来高・RSI(・レジスタンス)が良い場合は可能性ありとして評価してよい」とある。
 *   ここでは「それらの項目がどれも × でない」ことを「良い」とし、× ではなく 〇 + 注意書きにする。
 */

const RSI_LEN = 14;
const NEAR_PCT = 5;          // 抵抗線が「すぐ上」とみなす幅(現在値から +5% 以内)
const CLUSTER_PCT = 2;       // 反落した高値を同じ価格帯とみなす幅(±2%)
const SWING_HALF = 5;        // 反落した高値 = 前後5営業日の中で一番高い日の高値
const VP_BIN_PCT = 2;        // 出来高価格帯の幅(2%刻み)

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

/** 調整後の日足(昇順)。rows は {date, o, h, l, c, v, af} の昇順 */
function adjust(rows) {
  const out = new Array(rows.length);
  let cum = 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    out[i] = {
      date: r.date,
      o: r.o != null ? r.o * cum : null, h: r.h != null ? r.h * cum : null,
      l: r.l != null ? r.l * cum : null, c: r.c * cum,
      v: r.v != null ? r.v / cum : null,
    };
    const af = r.af != null && r.af !== 0 ? r.af : 1;
    cum *= af;
  }
  return out;
}

function sma(arr, end, len) {
  if (end + 1 < len) return null;
  let s = 0;
  for (let i = end - len + 1; i <= end; i++) s += arr[i];
  return s / len;
}

/** RSI(Wilder 方式。PineScript の ta.rsi と同じ RMA。最初の14本は単純平均で始める) */
function rsiWilder(closes, len = RSI_LEN) {
  if (closes.length <= len) return null;
  let up = 0;
  let dn = 0;
  for (let i = 1; i <= len; i++) {
    const ch = closes[i] - closes[i - 1];
    up += Math.max(ch, 0);
    dn += Math.max(-ch, 0);
  }
  up /= len;
  dn /= len;
  for (let i = len + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    up = (up * (len - 1) + Math.max(ch, 0)) / len;
    dn = (dn * (len - 1) + Math.max(-ch, 0)) / len;
  }
  if (dn === 0) return up === 0 ? 50 : 100;
  return 100 - 100 / (1 + up / dn);
}

/** 節目: 現在値より上の、桁に応じた切りのよい価格(4,820円 → 5,000円、80,540円 → 90,000円) */
function nextRound(price) {
  if (!(price > 0)) return null;
  const step = Math.pow(10, Math.floor(Math.log10(price)));
  const r = Math.ceil(price / step) * step;
  return r > price ? r : r + step;
}

/** レジスタンス候補(現在値より上のものだけ)。a は調整後の日足(昇順) */
function resistances(a, ytdStart) {
  const last = a[a.length - 1];
  const c = last.c;
  const out = [];
  const win250 = a.slice(-250);

  // 直近高値(60営業日)
  const hi60 = Math.max(...a.slice(-60).map((r) => r.h).filter((x) => x != null));
  if (hi60 > c) out.push({ kind: '直近高値(60営業日)', price: hi60 });

  // 年初来高値
  const ytd = a.filter((r) => r.date >= ytdStart && r.h != null);
  if (ytd.length) {
    const hiY = Math.max(...ytd.map((r) => r.h));
    if (hiY > c && Math.abs(hiY - hi60) > 1e-9) out.push({ kind: '年初来高値', price: hiY });
  }

  // 何度も反落した価格: 前後5営業日で一番高い日の高値を拾い、±2% で束ねて2回以上のもの
  const swings = [];
  for (let i = SWING_HALF; i < win250.length - SWING_HALF; i++) {
    const h = win250[i].h;
    if (h == null) continue;
    let top = true;
    for (let j = i - SWING_HALF; j <= i + SWING_HALF && top; j++) {
      if (j !== i && win250[j].h != null && win250[j].h > h) top = false;
    }
    if (top) swings.push({ date: win250[i].date, h });
  }
  const used = new Set();
  const clusters = [];
  swings.slice().sort((x, y) => y.h - x.h).forEach((s, idx, arr) => {
    if (used.has(s)) return;
    const members = arr.filter((t) => !used.has(t) && Math.abs(t.h / s.h - 1) * 100 <= CLUSTER_PCT);
    members.forEach((m) => used.add(m));
    if (members.length >= 2) clusters.push({ price: mean(members.map((m) => m.h)), n: members.length, dates: members.map((m) => m.date).sort() });
  });
  clusters.filter((k) => k.price > c).forEach((k) => out.push({ kind: `${k.n}回反落した価格帯`, price: k.price, touches: k.n, dates: k.dates }));

  // 出来高の多い価格帯(直近250営業日、2%刻み)。一番出来高の多い帯が現在値より上にあるときだけ
  const bins = new Map();
  const step = Math.log(1 + VP_BIN_PCT / 100);
  for (const r of win250) {
    if (r.v == null || r.c == null || r.c <= 0) continue;
    const k = Math.floor(Math.log(r.c) / step);
    bins.set(k, (bins.get(k) || 0) + r.v);
  }
  let best = null;
  for (const [k, v] of bins) if (!best || v > best.v) best = { k, v };
  if (best) {
    const lo = Math.exp(best.k * step);
    const hi = Math.exp((best.k + 1) * step);
    if (lo > c) out.push({ kind: '出来高の多い価格帯', price: lo, priceHi: hi });
  }

  // 節目
  const rnd = nextRound(c);
  if (rnd) out.push({ kind: '節目', price: rnd });

  return out
    .map((x) => ({ ...x, distPct: (x.price / c - 1) * 100 }))
    .sort((x, y) => x.price - y.price);
}

/**
 * 1銘柄のテクニカル判定。
 * @param {object} d
 *   d.daily  [{date, o, h, l, c, v, af}] 昇順(1年半ほど)。最後の行が最新
 *   d.margin {date, long, shrt} 最新の信用残(株数)。無ければ null
 * @returns {{items: object[], asOf: object}}
 */
function evaluate(d) {
  const rows = (d.daily || []).filter((r) => r.c != null);
  const items = [];
  if (rows.length < 30) {
    const na = (id, no, label) => ({ id, no, label, level: 'na', warn: null, lines: [{ text: '株価データが足りない' }] });
    return {
      items: [na('①', 14, '200日線との関係'), na('②', 14, '5日線と25日線のゴールデンクロス'), na('③', 15, '5日線と25日線の乖離率'),
        na('④', 18, 'ローソク足・上昇力'), na('⑤', 17, '出来高増加'), na('⑥', 16, 'レジスタンスライン'), na('⑦', 15, 'RSI'),
        marginItem(d.margin)],
      asOf: { priceDate: rows.length ? rows[rows.length - 1].date : null },
    };
  }
  const a = adjust(rows);
  const n = a.length;
  const last = a[n - 1];
  const prev = a[n - 2];
  const closes = a.map((r) => r.c);
  const ytdStart = last.date.slice(0, 4) + '-01-01';

  //------------------------------------------------ ④ ローソク足(最新の日足)
  const candle = (() => {
    const { o, h, l, c } = last;
    const lines = [];
    if (o == null || h == null || l == null) return { level: 'na', warn: null, lines: [{ text: '四本値がない' }] };
    const range = h - l;
    const chg = prev ? (c / prev.c - 1) * 100 : null;
    if (range <= 0) {
      lines.push({ candle: { o, h, l, c, chg, note: '始値・高値・安値・終値が同じ(値幅なし)' } });
      return { level: 'ok', warn: null, lines };
    }
    const yang = c > o;
    const body = (Math.abs(c - o) / range) * 100;
    const upper = ((h - Math.max(o, c)) / range) * 100;
    const push = ((h - c) / range) * 100;
    lines.push({ candle: { o, h, l, c, chg, yang, body, upper, push } });
    let level;
    if (yang && push < 30 && body >= 50) level = 'good';
    else if (yang && push < 30) level = 'ok';
    else level = 'bad';
    const warn = push >= 30 ? `高値から ${push.toFixed(0)}% 押し下げられて引けた(上値が重い)` : null;
    return { level, warn, lines };
  })();

  //------------------------------------------------ ⑤ 出来高(当日 ÷ 直前25営業日の平均)
  const volume = (() => {
    const v = last.v;
    const past = a.slice(-26, -1).map((r) => r.v).filter((x) => x != null);
    const avg25 = past.length >= 20 ? mean(past) : null;
    const avg5 = mean(a.slice(-6, -1).map((r) => r.v).filter((x) => x != null));
    if (v == null || !avg25) return { level: 'na', warn: null, lines: [{ text: '出来高が足りない' }] };
    const ratio = v / avg25;
    const up = prev ? last.c > prev.c : null;
    const down = prev ? last.c < prev.c : null;
    let level;
    let warn = null;
    if (ratio >= 2 && up) level = 'good';
    else if (ratio >= 2 && down) { level = 'bad'; warn = '下落した日に出来高が増えた(売り圧力の可能性)'; }
    else if (ratio >= 1) level = 'ok';
    else level = 'bad';
    if (!warn && down && ratio >= 1.5) warn = '下落した日に出来高が増えた(売り圧力の可能性)';
    return { level, warn, lines: [{ volume: { v, avg5, avg25, ratio, up, down } }] };
  })();

  //------------------------------------------------ ⑦ RSI(14、Wilder)
  const rsiItem = (() => {
    const r = rsiWilder(closes);
    if (r == null) return { level: 'na', warn: null, lines: [{ text: '株価データが足りない' }] };
    const level = r >= 85 ? 'bad' : r >= 75 ? 'ok' : 'good';
    const warn = r >= 85 ? 'RSI 85以上(強い警戒ライン)' : null;
    return { level, warn, lines: [{ value: { rsi: r } }], rsi: r };
  })();

  //------------------------------------------------ ⑥ レジスタンス
  const res = resistances(a, ytdStart);
  const near = res.filter((x) => x.distPct <= NEAR_PCT);
  const nearBounce = near.filter((x) => x.touches >= 2);
  const othersOk6 = candle.level !== 'bad' && volume.level !== 'bad' && rsiItem.level !== 'bad';
  const resistance = (() => {
    let level;
    let warn = null;
    if (!near.length) level = 'good';
    else {
      level = othersOk6 ? 'ok' : 'bad';
      warn = `すぐ上(+${NEAR_PCT}%以内)に抵抗線: ` + near.map((x) => `${x.kind} ${Math.round(x.price).toLocaleString('ja-JP')}円(+${x.distPct.toFixed(1)}%)`).join('、');
      if (nearBounce.length) warn += '。何度も反落した価格帯が近い';
    }
    return { level, warn, lines: [{ resistance: { list: res.slice(0, 6), nearPct: NEAR_PCT } }] };
  })();

  //------------------------------------------------ ① 200日線
  const ma200 = sma(closes, n - 1, 200);
  const line200 = (() => {
    if (ma200 == null) return { level: 'na', warn: null, lines: [{ text: `200営業日に足りない(${n}日分)` }] };
    const dev = (last.c / ma200 - 1) * 100;
    const level = dev <= 0 ? 'good' : dev <= 15 ? 'ok' : 'bad';
    const warn = dev > 0 ? `200日線より上(+${dev.toFixed(1)}%)。過熱リスク` : null;
    return { level, warn, lines: [{ ma: { price: last.c, ma200, dev } }] };
  })();

  //------------------------------------------------ ② ゴールデンクロス / ③ 乖離率
  const ma5 = sma(closes, n - 1, 5);
  const ma25 = sma(closes, n - 1, 25);
  const ma5p = sma(closes, n - 2, 5);
  const ma25p = sma(closes, n - 2, 25);
  const othersOk23 = othersOk6 && resistance.level !== 'bad';
  const gc = (() => {
    if (ma5 == null || ma25 == null || ma5p == null || ma25p == null) return { level: 'na', warn: null, lines: [{ text: '株価データが足りない' }] };
    const above = ma5 > ma25;
    const rising = ma5 > ma5p && ma25 > ma25p;
    // 直近のゴールデンクロス(5日線が25日線を下から上に抜けた日)
    let crossDays = null;
    for (let i = n - 1; i >= 26 && n - 1 - i <= 60; i--) {
      const a5 = sma(closes, i, 5); const a25 = sma(closes, i, 25);
      const b5 = sma(closes, i - 1, 5); const b25 = sma(closes, i - 1, 25);
      if (a5 > a25 && b5 <= b25) { crossDays = n - 1 - i; break; }
    }
    let level;
    let warn = null;
    if (above && rising) level = 'good';
    else if (above) level = 'ok';
    else if (ma5 > ma5p && othersOk23) { level = 'ok'; warn = 'ゴールデンクロスは完成前(準備段階)'; }
    else level = 'bad';
    return { level, warn, lines: [{ gc: { ma5, ma25, ma5p, ma25p, above, rising, crossDays } }] };
  })();
  const gap = (() => {
    if (ma5 == null || ma25 == null) return { level: 'na', warn: null, lines: [{ text: '株価データが足りない' }] };
    const g = (Math.abs(ma5 - ma25) / ma25) * 100;
    let level;
    let warn = null;
    if (g < 5) level = 'good';
    else { level = othersOk23 ? 'ok' : 'bad'; warn = `乖離率 ${g.toFixed(1)}%(5%超。短期の過熱、またはトレンドが進みすぎ)`; }
    return { level, warn, lines: [{ value: { gap: g, ma5, ma25 } }] };
  })();

  items.push({ id: '①', no: 14, label: '200日線との関係', ...line200 });
  items.push({ id: '②', no: 14, label: '5日線と25日線のゴールデンクロス', ...gc });
  items.push({ id: '③', no: 15, label: '5日線と25日線の乖離率', ...gap });
  items.push({ id: '④', no: 18, label: 'ローソク足・上昇力', ...candle });
  items.push({ id: '⑤', no: 17, label: '出来高増加', ...volume });
  items.push({ id: '⑥', no: 16, label: 'レジスタンスライン', ...resistance });
  items.push({ id: '⑦', no: 15, label: 'RSI(14)', level: rsiItem.level, warn: rsiItem.warn, lines: rsiItem.lines });
  items.push(marginItem(d.margin));

  return { items, asOf: { priceDate: last.date, close: rows[n - 1].c, days: n } };
}

/** No19 信用倍率 = 買残 ÷ 売残(株数)。1倍未満 ◎、3倍未満 〇、3倍以上 × */
function marginItem(m) {
  const base = { id: '19', no: 19, label: '信用倍率' };
  if (!m || m.long == null || m.shrt == null) return { ...base, level: 'na', warn: null, lines: [{ text: '信用残のデータがない(信用銘柄でない等)' }] };
  let ratio = null;
  let level;
  if (m.shrt > 0) {
    ratio = m.long / m.shrt;
    level = ratio < 1 ? 'good' : ratio < 3 ? 'ok' : 'bad';
  } else level = m.long > 0 ? 'bad' : 'na';
  return { ...base, level, warn: null, lines: [{ margin: { ratio, long: m.long, shrt: m.shrt, date: m.date } }] };
}

module.exports = { evaluate, _internal: { adjust, rsiWilder, nextRound, resistances, sma } };
