'use strict';

/**
 * 損失回避のチェック項目(claude/loss_avoidance_principles.md の Ch1〜Ch10)のうち、
 * 自動で計算できる部分。人が判断する部分は「人が判断する問い」として出力するだけで、
 * 合否や売買の結論は出さない。
 *
 * 関数は2層に分けてある:
 *   ・純粋関数(computeMetrics, sizing, stopInfo, revisionFromRow, buildReport など):
 *       DB に触れない。tests/lossChecks.test.js で検証できる。
 *   ・DB 取得(fetchDaily, fetchRevisions, fetchPastExits, fetchTopix, fetchHeldSemi。元手は src/capital.js):
 *       db.js の withConnection から渡された接続で SELECT するだけ。書き込みはしない。
 *
 * ボラの尺度に注意: ここで出すボラは「直近13週の週次リターンの標準偏差」で、検証資料の尺度。
 * /journal の VOL_20D_PCT(直近20営業日の日次リターンの標準偏差)とは別物。
 */

const SEMI_TAGS = ['120_semi_design_mfg', '130_semi_equip_material'];

/**
 * 検証資料(claude/downside_risk_rank_backtest.md の十分位表)の値。
 * 売買代金1億円/日以上で、52週高値から −15% 以下の銘柄を、リスクスコアで10群に分けたときの
 * 各群の平均。群の境界は資料に無いので、「近い群」は平均の週次ボラが最も近い群を示すだけの目安。
 */
const RISK_BANDS = [
  { band: 'D1', vol: 3.4, dd: -18.9, further: 31.7 },
  { band: 'D2', vol: 4.3, dd: -21.0, further: 36.4 },
  { band: 'D3', vol: 4.7, dd: -22.9, further: 39.4 },
  { band: 'D4', vol: 5.2, dd: -25.0, further: 40.7 },
  { band: 'D5', vol: 5.7, dd: -27.0, further: 44.1 },
  { band: 'D6', vol: 6.2, dd: -29.8, further: 46.4 },
  { band: 'D7', vol: 6.7, dd: -32.3, further: 50.7 },
  { band: 'D8', vol: 7.4, dd: -35.4, further: 54.2 },
  { band: 'D9', vol: 8.0, dd: -39.9, further: 55.7 },
  { band: 'D10', vol: 10.2, dd: -47.5, further: 58.7 },
];

//------------------------------------------------------------------
// 基本の道具
//------------------------------------------------------------------

/** 4桁(英字混じり含む)の証券コードを5桁にそろえる */
function normalizeCode(raw) {
  const c = String(raw).trim().toUpperCase();
  if (/^[0-9][0-9A-Z]{3}$/.test(c)) return c + '0';
  if (/^[0-9][0-9A-Z]{4}$/.test(c)) return c;
  throw new Error(`銘柄コードが不正です: "${raw}" (4桁または5桁)`);
}

/** DATE を 'YYYY-MM-DD' にする(oracledb はローカル時刻0時の Date で返す) */
function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

/** 標本標準偏差(n-1)。Oracle の STDDEV と同じ */
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** その日を含む週の月曜日(UTC計算) */
function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - day * 86400000).toISOString().slice(0, 10);
}

/** 日次(昇順)から、週ごとの最終営業日の行を取り出す */
function weeklyRows(rows) {
  const out = [];
  for (const r of rows) {
    const k = weekKey(r.date);
    if (out.length && out[out.length - 1].key === k) out[out.length - 1].row = r;
    else out.push({ key: k, row: r });
  }
  return out.map((x) => x.row);
}

const pct = (x) => (x == null ? null : x * 100);

//------------------------------------------------------------------
// 値動きの指標(Ch2, Ch3, Ch5, Ch7, Ch10 が使う)
//------------------------------------------------------------------

/**
 * @param {{date:string, close:number, adjc:number, af:number, vol:number|null}[]} daily 昇順の日次
 * @param {string} [asOf] この日以前だけを使う(検証用)
 */
function computeMetrics(daily, asOf) {
  const rows = asOf ? daily.filter((r) => r.date <= asOf) : daily;
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const weekly = weeklyRows(rows);
  const wl = weekly.length;

  // 直近13週の週次リターンの標準偏差(検証と同じ定義。14本の週末終値から13個のリターン)
  let vol13 = null;
  if (wl >= 14) {
    const c = weekly.slice(-14).map((r) => r.adjc);
    const rets = [];
    for (let i = 1; i < c.length; i++) rets.push(c[i] / c[i - 1] - 1);
    vol13 = pct(stdev(rets));
  }
  const ret13w = wl >= 14 ? pct(weekly[wl - 1].adjc / weekly[wl - 14].adjc - 1) : null;
  const ret4w = wl >= 5 ? pct(weekly[wl - 1].adjc / weekly[wl - 5].adjc - 1) : null;

  // 250営業日の調整後終値の高値からの下落(/journal の DD_250D_PCT と同じ考え方)
  const win = rows.slice(-250);
  let hi = null;
  let hiDate = null;
  for (const r of win) {
    if (hi == null || r.adjc > hi) {
      hi = r.adjc;
      hiDate = r.date;
    }
  }
  const dd250 = pct(last.adjc / hi - 1);

  const n = rows.length;
  const ret20d = n >= 21 ? pct(last.adjc / rows[n - 21].adjc - 1) : null;

  // 出来高ブレイク(上方): 直近5営業日の1日平均出来高 ÷ 直前20営業日 ≥ 2.0 かつ 直近5営業日リターン ≥ +3%
  // 検証の定義(週次)の日次版の近似。分割があった窓は出来高を比べない。
  let vbu = { available: false };
  if (n >= 26) {
    const w5 = rows.slice(-5);
    const w20 = rows.slice(-25, -5);
    const split = rows.slice(-25).some((r) => r.af != null && r.af !== 1);
    const v5 = mean(w5.map((r) => r.vol).filter((v) => v != null));
    const v20 = mean(w20.map((r) => r.vol).filter((v) => v != null));
    const ret5d = pct(last.adjc / rows[n - 6].adjc - 1);
    if (!split && v5 != null && v20 != null && v20 > 0) {
      const vr = v5 / v20;
      vbu = { available: true, vr, ret5d, flag: vr >= 2.0 && ret5d >= 3.0 };
    } else {
      vbu = { available: false, reason: split ? '直近25営業日に分割があり出来高を比べられない' : '出来高が足りない', ret5d };
    }
  }

  return {
    asOf: last.date,
    lastClose: last.close,
    lastAdj: last.adjc,
    nDaily: n,
    nWeekly: wl,
    vol13,
    ret13w,
    ret4w,
    ret20d,
    dd250,
    hiDate,
    ddWindowDays: win.length,
    vbu,
  };
}

/** 週次ボラが最も近い群(目安) */
function nearestBand(vol13) {
  if (vol13 == null) return null;
  let best = RISK_BANDS[0];
  for (const b of RISK_BANDS) if (Math.abs(b.vol - vol13) < Math.abs(best.vol - vol13)) best = b;
  return best;
}

//------------------------------------------------------------------
// Ch6: サイズ / Ch7: 損切り
//------------------------------------------------------------------

/**
 * 1/ボラ で重みを付ける。重み = (1/ボラ_i) / Σ(1/ボラ_j)。投資総額は変えない。
 * @param {{code:string, vol13:number|null}[]} items
 * @param {number|null} amount 投資総額(円)
 */
function sizing(items, amount) {
  const ok = items.filter((x) => x.vol13 != null && x.vol13 > 0);
  const inv = ok.map((x) => 1 / x.vol13);
  const sum = inv.reduce((s, x) => s + x, 0);
  return items.map((x) => {
    const i = ok.indexOf(x);
    if (i < 0) return { code: x.code, vol13: x.vol13, weight: null, yen: null, swingYen: null };
    const w = inv[i] / sum;
    const yen = amount != null ? amount * w : null;
    return { code: x.code, vol13: x.vol13, weight: w, yen, swingYen: yen != null ? (yen * x.vol13) / 100 : null };
  });
}

/** 買値・損切り幅から、損切り価格と「幅が週次ボラの何週分か」を出す */
function stopInfo({ buy, stopPcts, vol13, amount }) {
  return stopPcts.map((p) => ({
    stopPct: p,
    stopPrice: buy != null ? buy * (1 - p / 100) : null,
    widthInVolWeeks: vol13 != null && vol13 > 0 ? p / vol13 : null,
    lossYen: amount != null ? (amount * p) / 100 : null,
  }));
}

//------------------------------------------------------------------
// Ch4: 業績予想の修正
//------------------------------------------------------------------

/** 修正幅 REV = (新予想の営業利益 − 直前予想) ÷ 新予想の売上高 × 100(検証資料と同じ定義) */
function revisionFromRow(r) {
  const rev =
    r.prevOp != null && r.fOp != null && r.fSales != null && r.fSales > 0
      ? ((r.fOp - r.prevOp) / r.fSales) * 100
      : null;
  const kind = rev == null ? null : rev <= -1 ? 'DOWN' : rev >= 1 ? 'UP' : 'SMALL';
  return {
    discDate: r.discDate,
    docType: r.docType,
    fyEnd: r.fyEnd,
    fOp: r.fOp,
    prevOp: r.prevOp,
    rev,
    kind,
    // 検証したのは「業績予想の修正」の開示(EarnForecastRevision)。決算短信での予想変更は検証の対象外
    verified: typeof r.docType === 'string' && r.docType.startsWith('EarnForecastRevision'),
  };
}

//------------------------------------------------------------------
// 報告の組み立て
//------------------------------------------------------------------

const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const f2 = (x) => (x == null ? '—' : x.toFixed(2));
const sg = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(1));
const yen = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-US') + '円');
const man = (x) => (x == null ? '—' : (x / 10000).toFixed(1) + '万円');

/**
 * @param {object} c
 *  c.code, c.name, c.metrics, c.revisions[], c.pastExits[], c.capital(src/capital.js の fetchCapital), c.topix,
 *  c.held {held:number, semi:number}, c.isSemi, c.opts {amount, buy, stopPcts, swing, with:[{code,vol13}], days}
 */
function buildReport(c) {
  const m = c.metrics;
  const o = c.opts;
  const buy = o.buy != null ? o.buy : m ? m.lastClose : null;
  const items = [];

  // Ch1
  items.push({
    id: 'Ch1', tag: '—', title: '「上がる理由」より先に、下がる側を書く', status: '人が判断',
    auto: [],
    human: [
      '次の行動への条件は何か(どうなったら、何をするか。株価・決算などの株価以外・時間のそれぞれで。/journal の「次の行動への条件」に書く)',
      '最悪、いくら下がっても受け入れられるか',
    ],
  });

  // Ch2
  const band = m ? nearestBand(m.vol13) : null;
  const ch2 = [];
  if (!m || m.vol13 == null) ch2.push('週次ボラを出せない(13週分の週次データが足りない)');
  else {
    ch2.push(`直近13週の週次ボラ: ${f2(m.vol13)}%(基準日 ${m.asOf})`);
    ch2.push(`参考: 検証資料の下落銘柄の群で平均の週次ボラが最も近いのは ${band.band}(${band.vol}%)。D1 は 3.4%、D10 は 10.2%`);
    if (o.amount != null) ch2.push(`投資額 ${yen(o.amount)} だと、1週で動く額の目安は ${man((o.amount * m.vol13) / 100)}`);
  }
  items.push({
    id: 'Ch2', tag: 'A', title: '直近13週の値動きの大きさ(ボラ)', status: m && m.vol13 != null ? '情報' : '算出不可',
    auto: ch2,
    human: ['この大きさの値動きを受け入れられるか', 'ボラの高さに見合う理由が他にあるか(ボラは将来を保証しない)'],
  });

  // Ch3
  const ch3 = [];
  let ch3Status = '情報';
  if (m) {
    ch3.push(`高値からの下落(250営業日の調整後終値の最高値 ${m.hiDate} から): ${sg(m.dd250)}%`);
    ch3.push(`直近13週リターン ${sg(m.ret13w)}% / 直近4週 ${sg(m.ret4w)}% / 直近20営業日 ${sg(m.ret20d)}%`);
    if (m.dd250 != null && m.dd250 <= -15) {
      ch3Status = '要確認';
      ch3.push('検証資料の「下げている銘柄」(52週高値から −15% 以下)に該当する');
      ch3.push('参考: 最も安全側の群 D1 でも、13週内に −10% 以上さらに下がる確率は 31.7%。最もリスク側の D10 は 58.7%(群の平均 46%)');
      if (band) ch3.push(`週次ボラで近い群は ${band.band}(追加下落確率 ${band.further}%)。これは群の平均で、この銘柄の確率ではない`);
    } else {
      ch3.push('検証資料の「下げている銘柄」の条件(−15% 以下)に該当しない');
    }
    if (m.dd250 != null && m.ddWindowDays < 200) ch3.push(`注意: 高値の窓が ${m.ddWindowDays} 営業日しかない`);
  }
  items.push({
    id: 'Ch3', tag: 'A/C', title: '下げている銘柄を「底」と呼んでいないか', status: ch3Status,
    auto: ch3,
    human: ['「底」と考える理由は何か', 'さらに下がったときの想定幅と、そのときの行動は決めてあるか'],
  });

  // Ch4
  const ch4 = [];
  let ch4Status = '情報';
  const recent = (c.revisions || []).filter((r) => r.kind);
  const downVerified = recent.filter((r) => r.verified && r.kind === 'DOWN');
  if (!c.revisions) ch4.push('財務情報を取得していない');
  else if (!recent.length) ch4.push(`直近${o.days}日以内に、予想の変更を伴う開示は見つからなかった`);
  for (const r of recent) {
    const kindJa = r.kind === 'DOWN' ? '下方' : r.kind === 'UP' ? '上方' : '小幅';
    ch4.push(`${r.discDate} ${r.docType} FY${r.fyEnd}: 営業利益予想 ${r.prevOp != null ? Math.round(r.prevOp / 1e6).toLocaleString('en-US') : '—'} → ${r.fOp != null ? Math.round(r.fOp / 1e6).toLocaleString('en-US') : '—'} 百万円 / REV ${sg(r.rev)}pt(${kindJa})${r.verified ? '' : ' ※決算短信での予想変更は未検証。検証済みなのは「業績予想の修正」なので混同しないこと'}`);
  }
  if (downVerified.length) {
    ch4Status = '要確認';
    ch4.push('検証資料: 下方修正を出した銘柄は、同業種・同規模より劣後した(4週 −0.89pt、13週 −1.57pt の平均)。外す候補として扱う');
  }
  items.push({
    id: 'Ch4', tag: 'A', title: `直近${o.days}日以内の下方修正`, status: ch4Status,
    auto: ch4,
    human: ['修正の内容(一時的か、構造的か)をどう読むか', '外すか、サイズを下げるか、見送るか'],
  });

  // Ch5
  const ch5 = [];
  let ch5Status = '情報';
  if (!m || !m.vbu || !m.vbu.available) {
    ch5.push(`出来高ブレイクを判定できない${m && m.vbu && m.vbu.reason ? `(${m.vbu.reason})` : ''}`);
  } else {
    ch5.push(`直近5営業日の出来高は直前20営業日の ${f2(m.vbu.vr)} 倍、直近5営業日リターン ${sg(m.vbu.ret5d)}%`);
    if (m.vbu.flag) {
      ch5Status = '要確認';
      ch5.push('出来高2倍以上かつ +3% 以上の急騰に該当する');
      ch5.push('参考: 検証では 13週 −1.63pt、1億円/日以上で −3.39pt');
    } else ch5.push('出来高を伴う急騰(2倍以上かつ +3% 以上)には当たらない');
  }
  items.push({
    id: 'Ch5', tag: 'C', title: '出来高が急増して急騰した直後に追いかけていないか', status: ch5Status,
    auto: ch5,
    human: ['急騰の理由を知っているか', '追いかけたい気持ちが先にないか(/journal の「判断時の状態」に書く)'],
  });

  // Ch6
  const ch6 = [];
  const basket = [{ code: c.code, vol13: m ? m.vol13 : null }, ...(o.with || [])];
  const sz = sizing(basket, o.amount);
  if (m && m.vol13 != null) {
    if (o.swing != null) ch6.push(`1週で動いてよい額を ${yen(o.swing)} にするなら、投資額は約 ${man((o.swing * 100) / m.vol13)}(= 許容額 ÷ 週次ボラ)`);
    else ch6.push('1週で動いてよい額(--swing)を指定すると、投資額の目安を出す');
  }
  if (basket.length > 1 && o.amount != null) {
    for (const s of sz) ch6.push(`${s.code}: 週次ボラ ${f2(s.vol13)}% → 重み ${s.weight != null ? f1(s.weight * 100) : '—'}% / ${man(s.yen)}(1週の動き ${man(s.swingYen)})`);
  } else if (basket.length > 1) ch6.push('複数銘柄の重みを出すには --amount(総額)も指定する');
  if (c.isSemi) ch6.push('この銘柄は半導体(タグ120/130)。群全体の13週リターンの振れが他の約2倍だった。銘柄数を増やしても分散が効きにくい');
  items.push({
    id: 'Ch6', tag: 'B', title: 'サイズはボラで割る', status: '情報',
    auto: ch6,
    human: ['総額と、1週・13週で受け入れる損失の額を決める', '集中度(同じ動きをする銘柄の合計)は許容範囲か'],
  });

  // Ch7
  const ch7 = [];
  const si = stopInfo({ buy, stopPcts: o.stopPcts, vol13: m ? m.vol13 : null, amount: o.amount });
  ch7.push(`基準の買値: ${buy != null ? Math.round(buy * 100) / 100 + '円' : '—'}${o.buy != null ? '(指定)' : '(直近終値)'}`);
  for (const s of si) {
    ch7.push(`幅 ${s.stopPct}%: 損切り価格 ${s.stopPrice != null ? Math.round(s.stopPrice * 100) / 100 + '円' : '—'} / 週次ボラの ${f1(s.widthInVolWeeks)} 週分${s.lossYen != null ? ' / 全量が当たると ' + man(s.lossYen) + ' の損失' : ''}`);
  }
  ch7.push('検証資料: 固定幅の損切りは13週の最悪5%を浅くするが、平均を週次で 0.3〜0.7pt 削る(日次の安値判定ではさらに削れる)。期待値の改善ではなく、最悪を浅くする手段');
  items.push({
    id: 'Ch7', tag: 'A', title: '損切りを置くなら固定幅(10〜15%)', status: '情報',
    auto: ch7,
    human: ['損切りを置くか、置くなら幅はいくらか', '逆指値が発動価格どおりに約定しない場合の損失を許容できるか', '幅が週次ボラの1週分に近いと、通常の値動きで発動する'],
  });

  // Ch8
  const ch8 = [];
  let ch8Status = '情報';
  if (!c.pastExits) ch8.push('/journal の記録を取得していない');
  else if (!c.pastExits.length) ch8.push('この銘柄の、過去180日以内の売り・損切りの記録は見つからなかった');
  else {
    ch8Status = '要確認';
    for (const e of c.pastExits) {
      ch8.push(`${e.decisionDate} ${e.action}(${e.reasonCat})${e.sinceRet != null ? ` — その後の値動き ${sg(e.sinceRet)}%` : ''}`);
    }
    ch8.push('検証資料(15%幅・日次安値判定の損切り): 13週先までの TOPIX 比は平均 −0.45%(後半 −1.39%)。10%幅・トレーリングは未測定');
  }
  items.push({
    id: 'Ch8', tag: 'B', title: '損切り後に「戻るはず」と持ち直さない', status: ch8Status,
    auto: ch8,
    human: ['再び買う理由は、売ったときの理由と別のものか'],
  });

  // Ch9
  const ch9 = [];
  // 元手と、まだ使っていない元手(src/capital.js。売買記録の口座タブと同じ計算)
  const cap = c.capital;
  if (cap && cap.current) {
    const fl = cap.flows || {};
    ch9.push(`元手: ${man(cap.current.amount)}(${cap.current.effectiveDate} から)`);
    ch9.push(`株に入れた正味の額: ${man(cap.netInvested)}(取得額の累計 ${man(fl.buyTotal)} − 売却額の累計 ${man(fl.sellTotal)}。約定 ${fl.firstTradeDate || '—'}〜${fl.lastTradeDate || '—'})`);
    ch9.push(`まだ使っていない元手: ${man(cap.unused)}(元手 − 株に入れた正味の額)`);
  } else ch9.push('元手が記録されていない(売買記録の「口座」タブで入れる)');
  if (c.held) ch9.push(`保有銘柄(タグ jnl_held)${c.held.held} 銘柄のうち、半導体(タグ120/130)は ${c.held.semi} 銘柄(銘柄数ベース。金額ではない)`);
  if (c.topix) ch9.push(`参考: TOPIX は直近13週 ${sg(c.topix.ret13w)}%、250営業日の高値から ${sg(c.topix.dd250)}%`);
  items.push({
    id: 'Ch9', tag: '—', title: '相場に居ること自体が最大の要因', status: '情報',
    auto: ch9,
    human: ['投資比率(現金比率)をいくらにするか', '全体で受け入れる損失の額', '相場全体が下がったとき、どう行動するか'],
  });

  // Ch10
  const lines = [];
  if (m) {
    lines.push(`判断前のボラ(13週・週次): ${f2(m.vol13)}%`);
    lines.push(`高値からの下落(250営業日): ${sg(m.dd250)}%`);
    lines.push(`20営業日リターン: ${sg(m.ret20d)}%`);
  }
  const downNote = !c.revisions
    ? '—'
    : downVerified.length
      ? `あり(${downVerified.map((r) => `${r.discDate} REV ${sg(r.rev)}pt`).join('、')})`
      : `なし(直近${o.days}日)`;
  lines.push(`直近の下方修正: ${downNote}`);
  items.push({
    id: 'Ch10', tag: '—', title: '判断に書く値', status: '情報',
    auto: lines,
    human: ['この値を判断の理由に添えて、/journal に書く'],
  });

  return { code: c.code, name: c.name, asOf: m ? m.asOf : null, items };
}

/** 画面に出す文字列にする */
function formatReport(rep) {
  const out = [];
  out.push(`損失回避のチェック: ${rep.name || ''} (${rep.code}) 基準日 ${rep.asOf || '—'}`);
  out.push('※ 自動の部分は数値の提示だけ。結論(買う・見送る・外す)は出さない。人が判断する問いは「？」で示す');
  for (const it of rep.items) {
    out.push('');
    out.push(`■ ${it.id} [${it.tag}] ${it.title} — ${it.status}`);
    for (const l of it.auto) out.push(`  ・${l}`);
    for (const h of it.human) out.push(`  ？ ${h}`);
  }
  return out.join('\n');
}

//------------------------------------------------------------------
// DB 取得(SELECT のみ)
//------------------------------------------------------------------

function objFormat() {
  // oracledb はここで初めて読み込む(純粋関数のテストで不要にするため)
  return { outFormat: require('oracledb').OUT_FORMAT_OBJECT };
}

async function fetchDaily(conn, code, since) {
  // 調整後終値 = 終値 × (その日より後の調整係数の累積積)。/journal の評価ビューと同じ考え方
  const r = await conn.execute(
    `SELECT price_date, close_price, NVL(adj_factor, 1) AS af, volume,
            close_price * EXP(NVL(SUM(LN(NVL(NULLIF(adj_factor, 0), 1))) OVER (
                ORDER BY price_date DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)) AS adjc
       FROM equity_price_daily
      WHERE code = :code AND close_price IS NOT NULL AND price_date >= :since
      ORDER BY price_date`,
    { code, since },
    objFormat(),
  );
  return r.rows.map((x) => ({ date: iso(x.PRICE_DATE), close: x.CLOSE_PRICE, af: x.AF, vol: x.VOLUME, adjc: x.ADJC }));
}

async function fetchName(conn, code) {
  const r = await conn.execute(`SELECT co_name FROM equity_master WHERE code = :code`, { code }, objFormat());
  return r.rows.length ? r.rows[0].CO_NAME : null;
}

async function fetchRevisions(conn, code, sinceDate) {
  const r = await conn.execute(
    `SELECT * FROM (
        SELECT disc_date, doc_type, cur_fy_en, f_op, f_sales,
               LAG(f_op) OVER (PARTITION BY code, cur_fy_en ORDER BY disc_date, disc_time, disc_no) AS prev_op
          FROM financial_summary
         WHERE code = :code AND f_op IS NOT NULL)
      WHERE disc_date >= :since
      ORDER BY disc_date DESC`,
    { code, since: sinceDate },
    objFormat(),
  );
  return r.rows.map((x) =>
    revisionFromRow({ discDate: iso(x.DISC_DATE), docType: x.DOC_TYPE, fyEnd: iso(x.CUR_FY_EN), fOp: x.F_OP, fSales: x.F_SALES, prevOp: x.PREV_OP }),
  );
}

async function fetchPastExits(conn, code, sinceDate, daily) {
  // 訂正されていない判断のうち、売り(SELL/TRIM)または理由が損切りのもの
  const r = await conn.execute(
    `SELECT d.decision_date, d.action, d.reason_cat
       FROM jnl_decision d
      WHERE d.code = :code AND d.decision_date >= :since
        AND NOT EXISTS (SELECT 1 FROM jnl_decision s WHERE s.supersedes_id = d.decision_id)
        AND (d.reason_cat = 'STOPLOSS' OR d.action IN ('SELL', 'TRIM'))
      ORDER BY d.decision_date DESC`,
    { code, since: sinceDate },
    objFormat(),
  );
  const last = daily.length ? daily[daily.length - 1] : null;
  return r.rows.map((x) => {
    const dd = iso(x.DECISION_DATE);
    const base = [...daily].reverse().find((row) => row.date <= dd);
    return {
      decisionDate: dd,
      action: x.ACTION,
      reasonCat: x.REASON_CAT,
      sinceRet: base && last ? (last.adjc / base.adjc - 1) * 100 : null,
    };
  });
}

async function fetchTopix(conn, since) {
  const r = await conn.execute(
    `SELECT price_date, close_price FROM topix_price_daily WHERE price_date >= :since AND close_price IS NOT NULL ORDER BY price_date`,
    { since },
    objFormat(),
  );
  const rows = r.rows.map((x) => ({ date: iso(x.PRICE_DATE), close: x.CLOSE_PRICE, adjc: x.CLOSE_PRICE, af: 1, vol: null }));
  const m = computeMetrics(rows);
  return m ? { ret13w: m.ret13w, dd250: m.dd250 } : null;
}

async function fetchHeldSemi(conn) {
  const ph = SEMI_TAGS.map((_, i) => `:t${i}`).join(',');
  const binds = {};
  SEMI_TAGS.forEach((t, i) => (binds[`t${i}`] = t));
  const r = await conn.execute(
    `SELECT COUNT(DISTINCT h.code) AS held,
            COUNT(DISTINCT CASE WHEN s.code IS NOT NULL THEN h.code END) AS semi
       FROM favorite_tag h
       LEFT JOIN favorite_tag s ON s.code = h.code AND s.tag_name IN (${ph})
      WHERE h.tag_name = 'jnl_held'`,
    binds,
    objFormat(),
  );
  return { held: r.rows[0].HELD, semi: r.rows[0].SEMI };
}

async function fetchIsSemi(conn, code) {
  const ph = SEMI_TAGS.map((_, i) => `:t${i}`).join(',');
  const binds = { code };
  SEMI_TAGS.forEach((t, i) => (binds[`t${i}`] = t));
  const r = await conn.execute(
    `SELECT COUNT(*) AS n FROM favorite_tag WHERE code = :code AND tag_name IN (${ph})`,
    binds,
    objFormat(),
  );
  return r.rows[0].N > 0;
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/** 接続を受け取って、報告用のデータを集める。SELECT だけ。 */
async function collect(conn, code, opts) {
  const since = daysAgo(480); // 250営業日 + 13週の助走
  const daily = await fetchDaily(conn, code, since);
  const [name, revisions, pastExits, capital, held, isSemi, topixRows] = await Promise.all([
    fetchName(conn, code),
    fetchRevisions(conn, code, daysAgo(opts.days)),
    fetchPastExits(conn, code, daysAgo(180), daily).catch(() => null),
    require('./capital').fetchCapital(conn).catch(() => null),
    fetchHeldSemi(conn).catch(() => null),
    fetchIsSemi(conn, code).catch(() => false),
    fetchTopix(conn, since).catch(() => null),
  ]);
  const withItems = [];
  for (const w of opts.withCodes || []) {
    const d = await fetchDaily(conn, w, since);
    const wm = computeMetrics(d);
    withItems.push({ code: w, vol13: wm ? wm.vol13 : null });
  }
  return {
    code,
    name,
    metrics: computeMetrics(daily),
    revisions,
    pastExits,
    capital,
    held,
    isSemi,
    topix: topixRows,
    opts: { ...opts, with: withItems },
  };
}

module.exports = {
  SEMI_TAGS,
  RISK_BANDS,
  normalizeCode,
  iso,
  stdev,
  weekKey,
  weeklyRows,
  computeMetrics,
  nearestBand,
  sizing,
  stopInfo,
  revisionFromRow,
  buildReport,
  formatReport,
  collect,
};
