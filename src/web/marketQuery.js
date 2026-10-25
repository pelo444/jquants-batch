'use strict';

/**
 * 市場のページ(/market)のデータ。設計は Project の claude/market_page_design.md。
 *
 * 1枚の表(行 = 項目、列 = 日付)。期間は「前の週の月曜からその日まで」。
 *   例: 10/15(木) に見たら 10/5(月)〜10/15。
 *
 * 【列の置き方】
 *   - 国内のデータは、そのデータの日付の列(株価は売買日、信用残は申込日、裁定残は週末時点)。
 *   - 投資部門別は公表日の列(週の途中で見たとき、まだ出ていない週を空けておくため)。
 *   - 米国3指数と日経先物(CME)は「日本で見られる日」の列。現地 D の終値は、
 *     D より後の最初の国内営業日の列に置く(金曜の終値 → 月曜の列)。
 *     その列が今日より先になるとき(土日に見たとき)は、今日の列を足してそこに置く。
 *   - 米国・日経先物は取引中の足を出さない(終わった取引の終値だけ)。
 *   - ただし日経先物は、ページを開いた時点の値段を「現在値」の行に別に出す(最新の列だけ。2026-10-19 ユーザー要望)。
 *     比べる相手は取引の終わった直前の足の終値。取引していない時間は「取引時間外」。
 *
 * 【外のデータ】
 *   米国3指数と日経先物は Yahoo Finance の非公式 API から取る(J-Quants に無い / 先物は Premium のみ)。
 *   DB には保存しない。予告なく使えなくなることがあるので、取れなかったら該当行が「—」になり、
 *   errors に理由を返す(画面の上に出す)。
 *
 * 【日経平均】
 *   指数そのものは DB に無い。Yahoo Finance(^N225)から取り、売買日の列に置く(列はずらさない)。
 *   DB の日経225オプションの原証券価格は取込が1日遅れる(当日分は次の取込日の夕方)ため主には使わない
 *   (2026-10-17 ユーザー判断)。
 *   ただし Yahoo の日足は、ある日だけ終値が空(null)のことがある(2026-10-21 分で発生)。
 *   その日は DB の原証券価格で補う(2026-10-22 ユーザー判断)。原証券価格は Yahoo の終値と一致することを
 *   10/14〜10/20 で確認済み。補うのは lookFrom 以降(表の期間と前日比のため)。1年分は約3秒かかるので、
 *   Zスコアの過去1年には使わない。Yahoo がまるごと取れなかったときも、DB にある日は表示する。
 */

const oracledb = require('oracledb');
const { fetchMarginChecks } = require('./marginCheck');

const TZ_JP = 'Asia/Tokyo';
const INVESTOR_SECTION = 'TokyoNagoya'; // 市場区分再編をまたいで続く系列(/demand のマクロと同じ)
const YAHOO_TIMEOUT_MS = 10000;
// Zスコア = (前日比 − 平均) ÷ 標準偏差。平均・標準偏差は、表の期間より前の1年の前日比(%)から計算する。
// 表の中の日は含めない(2026-10-17 ユーザー判断)
const SIGMA_DAYS = 365;
const SIGMA_MIN_N = 120; // これより少ないときは出さない(上場・算出開始の直後など)
// Zスコアの絶対値がこれ以上なら、前日比のセルを背景色で強調する
const HI_SIGMA = 2;

const US_SYMBOLS = [
  { key: 'dji', symbol: '^DJI', label: 'NYダウ' },
  { key: 'ixic', symbol: '^IXIC', label: 'NASDAQ総合' },
  { key: 'gspc', symbol: '^GSPC', label: 'S&P500' },
  { key: 'niy', symbol: 'NIY=F', label: '日経先物(CME 円建て)' },
];

// 日経平均: 国内の売買日の列にそのまま置く
const JP_SYMBOLS = [
  { key: 'n225', symbol: '^N225', label: '日経平均' },
];

const INVESTORS = [
  { key: 'frgn', col: 'frgn_bal', label: '海外' },
  { key: 'ind', col: 'ind_bal', label: '個人' },
  { key: 'trst', col: 'trst_bnk_bal', label: '信託銀行' },
  { key: 'bus', col: 'bus_co_bal', label: '事業法人' },
];

// 値が無いセル(—)にマウスを重ねたときに出す理由
const NA_NOTE = {
  us: '米国の休場日、または取得できなかった',
  niy: '取引が無かった、または取得できなかった',
  n225: '取得できなかった',
  db: 'まだ取り込まれていない',
};

//------------------------------------------------------------------ 日付
function ymdIn(date, timeZone) {
  // en-CA は YYYY-MM-DD の形で返す
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** その日を含む週の、前の週の月曜 */
function periodStart(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 月=0 … 日=6
  return addDays(ymd, -dow - 7);
}

//------------------------------------------------------------------ DB
async function selectRows(connection, sql, binds) {
  const r = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows.map((row) => {
    const out = {};
    for (const k of Object.keys(row)) out[k.toLowerCase()] = row[k];
    return out;
  });
}

/**
 * DB から読む分。日付はすべて 'YYYY-MM-DD' の文字列で受け渡す(タイムゾーンのずれを避ける)。
 * @param {string} lookFrom  前日比・期間前比のために、期間より前から読む日(日次)
 * @param {string} weekFrom  週次のデータを読む始まり(前回比のため、さらに前から)
 * @param {string} histFrom  Zスコアの平均・標準偏差(過去1年の前日比)のために読む始まり。
 *                           取引カレンダー・TOPIX・33業種の株価指数・業種別の空売り比率だけこの日から読む
 * @param {string} to        今日
 */
async function fetchDbPart(connection, { lookFrom, weekFrom, histFrom, to }) {
  const range = { f: lookFrom, t: to };
  const hist = { f: histFrom || lookFrom, t: to };
  const dateRange = (col) =>
    `${col} BETWEEN TO_DATE(:f, 'YYYY-MM-DD') AND TO_DATE(:t, 'YYYY-MM-DD')`;

  const [calendar, topix, margin, investor, arb, sectIdx, sectIdxNames, shortRatio, sectors, n225Und] =
    await Promise.all([
      selectRows(connection,
        `SELECT TO_CHAR(calendar_date, 'YYYY-MM-DD') AS d
           FROM trading_calendar
          WHERE ${dateRange('calendar_date')}
            AND hol_div IN ('1', '2')
          ORDER BY calendar_date`, hist),
      selectRows(connection,
        `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d, close_price AS v
           FROM topix_price_daily
          WHERE ${dateRange('price_date')}`, hist),
      // 信用残の合計 = 株数 × 申込日終値(需給3階層の第一階層 demandQuery.fetchMacro と同じ計算)。
      // 配信の金額(LONG_VAL/SHRT_VAL)は使わない。終値で換算した値ではなく(1株あたりの値段が
      // 買いと売りで違う)、2026/9/25 申込分からしか無いため。2画面で数字を一致させる(2026-10-17 ユーザー判断)。
      // 終値の無い銘柄は合計から外す(第一階層と同じ)。
      selectRows(connection,
        `SELECT TO_CHAR(m.app_date, 'YYYY-MM-DD') AS d,
                SUM(m.long_vol * p.close_price) AS lv,
                SUM(m.shrt_vol * p.close_price) AS sv
           FROM equity_margin_interest m
           JOIN equity_master em
             ON em.code = m.code
            AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
           JOIN equity_price_daily p
             ON p.code = m.code
            AND p.price_date = m.app_date
          WHERE ${dateRange('m.app_date')}
            AND p.close_price IS NOT NULL
          GROUP BY m.app_date`, range),
      selectRows(connection,
        `SELECT TO_CHAR(pub_date, 'YYYY-MM-DD') AS d,
                TO_CHAR(st_date, 'YYYY-MM-DD')  AS st,
                TO_CHAR(en_date, 'YYYY-MM-DD')  AS en,
                SUM(frgn_bal) AS frgn_bal, SUM(ind_bal) AS ind_bal,
                SUM(trst_bnk_bal) AS trst_bnk_bal, SUM(bus_co_bal) AS bus_co_bal
           FROM v_investor_type_trading_latest
          WHERE section = :s
            AND ${dateRange('pub_date')}
          GROUP BY pub_date, st_date, en_date`,
        { s: INVESTOR_SECTION, f: weekFrom, t: to }),
      selectRows(connection,
        `SELECT TO_CHAR(pos_date, 'YYYY-MM-DD') AS d, net_oku_yen AS v, net_wow_oku_yen AS wow
           FROM v_arbitrage_balance_weekly
          WHERE ${dateRange('pos_date')}`, { f: weekFrom, t: to }),
      // 東証業種別株価指数(33業種、0040〜0060)。業種の騰落はこの前日比で見る
      selectRows(connection,
        `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d, index_code AS s, close_price AS v
           FROM index_price_daily
          WHERE ${dateRange('price_date')}
            AND index_code BETWEEN '0040' AND '0060'`, hist),
      selectRows(connection,
        `SELECT index_code AS s, index_name AS n
           FROM index_master
          WHERE index_code BETWEEN '0040' AND '0060'
          ORDER BY index_code`, {}),
      selectRows(connection,
        `SELECT TO_CHAR(ratio_date, 'YYYY-MM-DD') AS d, s33_code AS s, short_ratio_pct AS v
           FROM v_sector_short_ratio
          WHERE ${dateRange('ratio_date')}
            AND s33_code <> '9999'`, hist),
      selectRows(connection,
        `SELECT sector33_code AS s, MAX(sector33_name) AS n
           FROM equity_master
          WHERE sector33_code <> '9999'
          GROUP BY sector33_code
          ORDER BY sector33_code`, {}),
      // 日経平均の補い: 日経225オプションの原証券価格(同じ日はどの銘柄も同じ値)
      selectRows(connection,
        `SELECT TO_CHAR(trade_date, 'YYYY-MM-DD') AS d, MAX(underlying_price) AS v
           FROM index_option_price_daily
          WHERE ${dateRange('trade_date')}
            AND underlying_price IS NOT NULL
          GROUP BY trade_date`, range),
    ]);

  // 信用残の要確認の日(判定は marginCheck.js)。前回比・期間前比に使う日も含めるため lookFrom から
  const marginChecks = await fetchMarginChecks(connection, lookFrom);

  return {
    calendar: calendar.map((r) => r.d),
    topix, margin, investor, arb, sectIdx, sectIdxNames, shortRatio, sectors, marginChecks, n225Und,
  };
}

//------------------------------------------------------------------ Yahoo Finance
/**
 * 1銘柄の日足。終わった取引の足だけを { date(現地の日付), close } で返す。
 */
async function fetchYahooDaily(symbol, nowMs) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=2y&interval=1d'; // 過去1年の標準偏差のため、表の期間より1年以上前から
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const body = await res.json();
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) {
    const desc = body && body.chart && body.chart.error && body.chart.error.description;
    throw new Error(`${symbol}: ${desc || '形式が想定と違う'}`);
  }
  const meta = result.meta || {};
  const tz = meta.exchangeTimezoneName || 'America/New_York';
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] &&
    result.indicators.quote[0].close) || [];

  const bars = [];
  result.timestamp.forEach((ts, i) => {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) return;
    bars.push({ date: ymdIn(new Date(ts * 1000), tz), close: c });
  });

  // 取引中の足は外す(その日の取引が終わっていない値は終値ではないため)
  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  if (reg && bars.length) {
    const sessionDate = ymdIn(new Date(reg.start * 1000), tz);
    const last = bars[bars.length - 1];
    if (last.date === sessionDate && nowMs < reg.end * 1000) bars.pop();
  }
  // 同じ日付が2本あれば後のほうを使う
  const byDate = new Map();
  for (const b of bars) byDate.set(b.date, b.close);
  return Array.from(byDate, ([date, close]) => ({ date, close }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 1銘柄の、今の値段(Yahoo の chart API の meta)。
 *   regularMarketPrice … 最新の値段 / regularMarketTime … その時刻(秒)
 *   currentTradingPeriod.regular … 今の取引の始まりと終わり(秒)
 * 取引中かどうかは「今が取引の始まり〜終わりの間」か「最新の値段が LIVE_FRESH_MS 以内」のどちらかで決める
 * (先物の取引時間を Yahoo がどう持っているか確かめられていないため、両方で見る)。
 */
const LIVE_FRESH_MS = 20 * 60 * 1000;
async function fetchYahooQuote(symbol, nowMs) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=1d&interval=1d';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const body = await res.json();
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  const meta = result && result.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice)) {
    const desc = body && body.chart && body.chart.error && body.chart.error.description;
    throw new Error(`${symbol}: ${desc || '形式が想定と違う'}`);
  }
  const timeMs = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null;
  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const inPeriod = Boolean(reg && nowMs >= reg.start * 1000 && nowMs < reg.end * 1000);
  const fresh = timeMs != null && nowMs - timeMs < LIVE_FRESH_MS;
  return {
    price: meta.regularMarketPrice,
    time: timeMs != null ? new Date(timeMs).toISOString() : null,
    inSession: inPeriod || fresh,
  };
}

/** 日経先物の現在値。取れなかったら niy: null と理由 */
async function fetchLivePart(nowMs) {
  try {
    return { niy: await fetchYahooQuote('NIY=F', nowMs), errors: [] };
  } catch (err) {
    return { niy: null, errors: [`日経先物の現在値を取得できませんでした(${err.message})`] };
  }
}

async function fetchExternalPart(nowMs) {
  const out = {};
  const errors = [];
  await Promise.all(US_SYMBOLS.concat(JP_SYMBOLS).map(async (s) => {
    try {
      out[s.key] = await fetchYahooDaily(s.symbol, nowMs);
    } catch (err) {
      out[s.key] = null;
      errors.push(`${s.label}を取得できませんでした(${err.message})`);
    }
  }));
  return { series: out, errors, fetchedAt: new Date(nowMs).toISOString() };
}

//------------------------------------------------------------------ 表の組み立て(純粋関数)
/**
 * @param {object} p
 * @param {string} p.today       今日(日本時間)
 * @param {object} p.db          fetchDbPart の結果
 * @param {object} p.ext         fetchExternalPart の結果
 * @param {object} [p.live]      fetchLivePart の結果(日経先物の現在値)
 */
function buildMarketTable({ today, db, ext, live }) {
  const from = periodStart(today);
  const days = db.calendar.slice(); // 期間より前を含む国内営業日(昇順)

  // 米国・先物: 現地 D の終値 → D より後の最初の国内営業日。無ければ今日の列。
  let todayExtra = false;
  const placeForeign = (d) => {
    const next = days.find((x) => x > d);
    if (next && next <= today) return next;
    if (!days.includes(today)) todayExtra = true;
    return today;
  };

  const rows = [];
  const num = (v) => (v == null ? null : Number(v));
  const toMap = (list, keyFn, valFn) => {
    const m = new Map();
    for (const r of list) {
      const v = valFn(r);
      if (v != null && Number.isFinite(v)) m.set(keyFn(r), v);
    }
    return m;
  };

  // 1. 指数
  const foreignMaps = {};
  for (const s of US_SYMBOLS) {
    const bars = ext.series[s.key];
    if (!bars) { foreignMaps[s.key] = null; continue; }
    const m = new Map();
    // 読んだ国内営業日より前の足は置き場所が決まらないので使わない。
    // 同じ列に2本来たら(国内の休日をはさむとき)後の足で上書きする
    for (const b of bars) if (b.date >= days[0]) m.set(placeForeign(b.date), b.close);
    foreignMaps[s.key] = m;
  }
  const jpMap = (bars) => {
    if (!bars) return null;
    const m = new Map();
    for (const b of bars) if (b.date >= days[0]) m.set(b.date, b.close);
    return m;
  };
  // 日経平均で Yahoo の終値が空の日を、DB の原証券価格で補う(冒頭の【日経平均】)
  const fillN225 = (m) => {
    const out = m ? new Map(m) : new Map();
    for (const r of db.n225Und || []) {
      const v = num(r.v);
      if (r.d >= days[0] && !out.has(r.d) && v != null && Number.isFinite(v)) out.set(r.d, v);
    }
    // 補った日が途中に入るので、日付順に並べ直す(前日比は Map の並び順で計算する)
    const sorted = new Map(Array.from(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    return sorted.size ? sorted : m;
  };
  // 米国・先物の前日比は、列に置く前の足の並びで計算する(列が重なる日があっても前の取引日との比になる)
  const foreignChg = (bars) => {
    const m = new Map();
    if (!bars) return m;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].date < days[0] || !bars[i - 1].close) continue;
      m.set(placeForeign(bars[i].date), (bars[i].close / bars[i - 1].close - 1) * 100);
    }
    return m;
  };
  const sigmaFrom = addDays(from, -SIGMA_DAYS);
  const sigmaOf = (chgMap) => meanSd(
    Array.from(chgMap).filter(([k]) => k >= sigmaFrom && k < from).map(([, v]) => v));

  const idxDefs = [
    ...US_SYMBOLS.map((s) => ({ key: s.key, label: s.label, map: foreignMaps[s.key],
      chgMap: foreignChg(ext.series[s.key]), na: s.key === 'niy' ? NA_NOTE.niy : NA_NOTE.us })),
    { key: 'n225', label: '日経平均', map: fillN225(jpMap(ext.series.n225)), na: NA_NOTE.n225 },
    { key: 'topix', label: 'TOPIX', map: toMap(db.topix, (r) => r.d, (r) => num(r.v)), na: NA_NOTE.db },
  ];
  for (const d of idxDefs) {
    const map = d.map || new Map();
    const chgMap = d.chgMap || pctChangeMap(map);
    const sigma = sigmaOf(chgMap);
    const hi = hiSet(chgMap, sigma);
    // 項目名は「名前 | 中身」の2列。名前は1行目だけに出す(画面で3行を1つのまとまりに見せる)
    rows.push({ group: 'idx', key: d.key, label: d.label + ' 終値', name: d.label, sub: '終値',
      fmt: 'idx', kind: 'level', daily: true, map, na: d.na, chg: 'pct', latestHi: latestIn(hi, chgMap) });
    rows.push({ group: 'idx', key: d.key + '_chg', label: d.label + ' 前日比(%)', name: '', sub: '前日比(%)',
      fmt: 'chgpct', kind: 'change', daily: true, map: chgMap, na: d.na, hi });
    rows.push(sigmaRow('idx', d.key, d.label, chgMap, sigma, d.na));
    if (d.key === 'niy') {
      // 現在値の行(最新の列だけ)。比べる相手は取引の終わった直前の足の終値
      const bars = ext.series.niy;
      const last = bars && bars.length ? bars[bars.length - 1] : null;
      const q = live ? live.niy : null;
      rows.push({ group: 'idx', key: 'niy_live', label: d.label + ' 現在値', name: '', sub: '現在値',
        kind: 'live', daily: true, map: new Map(), quote: q, prevClose: last,
        na: live ? '取得できなかった' : '取得していない' });
    }
  }

  // 2. 投資部門別(公表日の列、億円。元の単位は千円)
  const invWeeks = new Map(db.investor.map((r) => [r.d, `${r.st}〜${r.en}`]));
  for (const inv of INVESTORS) {
    rows.push({ group: 'inv', key: inv.key, label: inv.label, fmt: 'signed', kind: 'level',
      daily: false, chg: 'diff', weekTitle: invWeeks,
      map: toMap(db.investor, (r) => r.d, (r) => (r[inv.col] == null ? null : Number(r[inv.col]) / 100000)) });
  }

  // 3. 信用・裁定
  //    信用残の3行には要確認の印(marginCheck.js)。jump の日はセル、最新・前回比・期間前比はその日を使うとき
  const mchk = new Map((db.marginChecks || []).map((c) => [c.date, c]));
  rows.push({ group: 'mgn', key: 'mgn_long', label: '信用買残(億円)', fmt: 'oku', kind: 'level', daily: true,
    chg: 'diff', na: NA_NOTE.db, mchk, map: toMap(db.margin, (r) => r.d, (r) => num(r.lv) / 1e8) });
  rows.push({ group: 'mgn', key: 'mgn_short', label: '信用売残(億円)', fmt: 'oku', kind: 'level', daily: true,
    chg: 'diff', na: NA_NOTE.db, mchk, map: toMap(db.margin, (r) => r.d, (r) => num(r.sv) / 1e8) });
  rows.push({ group: 'mgn', key: 'mgn_ratio', label: '信用倍率(倍)', fmt: 'ratio', kind: 'level', daily: true,
    chg: 'diff', na: NA_NOTE.db, mchk,
    map: toMap(db.margin, (r) => r.d, (r) => (num(r.sv) ? num(r.lv) / num(r.sv) : null)) });
  rows.push({ group: 'mgn', key: 'arb', label: '裁定残高 買い−売り(億円)', fmt: 'oku', kind: 'level',
    daily: false, chg: 'diff', map: toMap(db.arb, (r) => r.d, (r) => num(r.v)) });
  rows.push({ group: 'mgn', key: 'arb_wow', label: '裁定残高 前週比(億円)', fmt: 'signed', kind: 'change',
    daily: false, map: toMap(db.arb, (r) => r.d, (r) => num(r.wow)) });

  // 4. 33業種(業種コード順 = 指数コード順)
  //    業種別株価指数の前日比(%)。列には前日比を出し、スマホの3列は
  //    最新 = 最新日の前日比 / 前回比 = —(最新がすでに前日との比のため)/ 期間前比 = 期間前の終値からの騰落率
  for (const s of db.sectIdxNames) {
    const level = toMap(db.sectIdx.filter((r) => r.s === s.s), (r) => r.d, (r) => num(r.v));
    const name = String(s.n).replace(/^東証業種別\s*/, '');
    const chgMap = pctChangeMap(level);
    const sigma = sigmaOf(chgMap);
    const hi = hiSet(chgMap, sigma);
    rows.push({ group: 'sect', key: 'sect_' + s.s, label: name, name, sub: '前日比(%)',
      fmt: 'chgpct', kind: 'level', daily: true, na: NA_NOTE.db, level,
      map: chgMap, hi, latestHi: latestIn(hi, chgMap) });
    rows.push(sigmaRow('sect', 'sect_' + s.s, name, chgMap, sigma, NA_NOTE.db));
  }
  for (const s of db.sectors) {
    // 空売り比率と、前の営業日との差(pt)。項目名は指数と同じ「名前 | 中身」の2列
    const ratio = toMap(db.shortRatio.filter((r) => r.s === s.s), (r) => r.d, (r) => num(r.v));
    // Zスコアは前日差について計算する(指数の前日比と同じ考え方。2026-10-18 ユーザー判断)
    const diff = diffMap(ratio);
    const st = sigmaOf(diff);
    const hi = hiSet(diff, st);
    rows.push({ group: 'short', key: 'short_' + s.s, label: s.n, name: s.n, sub: '空売り比率(%)',
      fmt: 'pct', kind: 'level', daily: true, chg: 'diff', na: NA_NOTE.db, map: ratio,
      latestHi: latestIn(hi, diff) });
    rows.push({ group: 'short', key: 'short_' + s.s + '_chg', label: s.n + ' 前日差(pt)', name: '',
      sub: '前日差(pt)', fmt: 'chgpt', kind: 'change', daily: true, na: NA_NOTE.db, map: diff, hi });
    rows.push(sigmaRow('short', 'short_' + s.s, s.n, diff, st, NA_NOTE.db, 'pt'));
  }

  // 列
  const colDates = days.filter((d) => d >= from && d <= today);
  if (todayExtra && !colDates.includes(today)) colDates.push(today);
  const baseDate = days.filter((d) => d < from).pop() || null;

  const out = rows.map((r) => {
    if (r.kind === 'live') return liveRow(r, colDates);
    const cells = colDates.map((d) => {
      if (r.map.has(d)) {
        const c = r.hi && r.hi.has(d) ? { v: r.map.get(d), hi: true } : { v: r.map.get(d) };
        const mc = r.mchk && r.mchk.get(d);
        if (mc && mc.kind === 'jump') c.warn = mc.text;
        return c;
      }
      // 週次の行は、公表の無い日は空白(欠測ではない)
      if (!r.daily) return { v: null, blank: true };
      // 今日の列は、まだ出ていない(朝・取引中・休日)だけなので空白
      if (d === today) return { v: null, blank: true };
      return { v: null, na: r.na };
    });
    if (r.weekTitle) {
      colDates.forEach((d, i) => { if (r.weekTitle.has(d) && cells[i].v != null) cells[i].title = r.weekTitle.get(d) + ' の売買'; });
    }
    const row = { group: r.group, key: r.key, label: r.label, fmt: r.fmt, kind: r.kind, cells };
    if (r.sub != null) { row.name = r.name; row.sub = r.sub; }
    if (r.group === 'sect' && r.kind === 'level') Object.assign(row, summarizeSector(r.map, r.level, from));
    else if (r.kind === 'level') Object.assign(row, summarize(r.map, from, r.chg));
    else if (r.kind === 'sigma') {
      const keys = Array.from(r.map.keys()).sort();
      const last = keys.filter((k) => k >= from).pop();
      row.latest = last ? r.map.get(last) : null;
      row.latestDate = last || null;
      row.latestHi = row.latest != null && Math.abs(row.latest) >= HI_SIGMA;
    }
    if (r.latestHi) row.latestHi = true;
    if (r.mchk && row.latestDate) {
      // 最新が jump → 最新・前回比・期間前比すべて疑う。最新が back → 前回比だけ(相手が jump の日)
      const mc = r.mchk.get(row.latestDate);
      if (mc && mc.kind === 'jump') { row.latestWarn = mc.text; row.prevWarn = mc.text; row.baseWarn = mc.text; }
      if (mc && mc.kind === 'back') row.prevWarn = mc.text;
    }
    // 投資部門別は週ごとの差引なので、期間前の週との差は出さない(画面では —)
    if (r.group === 'inv') row.baseDiff = null;
    return row;
  });

  return {
    today,
    from,
    baseDate,
    columns: colDates.map((d) => ({ date: d, extra: !days.includes(d) })),
    rows: out,
    errors: ext.errors.concat(live ? live.errors : []),
    // 信用残の要確認(画面の上に出す)。表の列の日付と、期間前比の基準日より後の分
    notices: (db.marginChecks || [])
      .filter((c) => c.kind === 'jump' && (!baseDate || c.date > baseDate) && c.date <= today)
      .map((c) => c.text),
    fetchedAt: ext.fetchedAt,
  };
}

/** 日経先物の現在値の行。値は最新の列だけ。取引していない時間は off */
function liveRow(r, colDates) {
  const q = r.quote;
  const off = Boolean(q && !q.inSession);
  const price = q && !off ? q.price : null;
  const pc = r.prevClose;
  const chg = price != null && pc && pc.close ? (price / pc.close - 1) * 100 : null;
  const cells = colDates.map((d, i) => {
    if (i !== colDates.length - 1) return { v: null, blank: true };
    if (off) return { v: null, off: true };
    if (price == null) return { v: null, na: r.na };
    return { v: price, live: true, chg };
  });
  return {
    group: r.group, key: r.key, label: r.label, name: r.name, sub: r.sub, fmt: 'idx', kind: 'live', cells,
    liveTime: q ? q.time : null, liveOff: off,
    prevClose: pc ? pc.close : null, prevCloseDate: pc ? pc.date : null,
    latest: price, prevDiff: chg, baseDiff: null,
  };
}

/** 平均と標準偏差(標本)。数が少なければ null */
function meanSd(xs) {
  if (xs.length < SIGMA_MIN_N) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  const sd = Math.sqrt(v);
  // 値が動いていない系列(価格が固定された指数など)では Zスコアを出さない
  return sd > 0.01 ? { mean: m, sd } : null;
}

const zOf = (v, st) => (v - st.mean) / st.sd;

/** Zスコアの絶対値が HI_SIGMA 以上の日 */
function hiSet(chgMap, st) {
  const out = new Set();
  if (!st) return out;
  for (const [k, v] of chgMap) if (Math.abs(zOf(v, st)) >= HI_SIGMA) out.add(k);
  return out;
}

/** 最新の前日比が強調の対象か */
function latestIn(hi, chgMap) {
  const keys = Array.from(chgMap.keys()).sort();
  return keys.length > 0 && hi.has(keys[keys.length - 1]);
}

/** Zスコアの行。値 = (前日比 − 平均) ÷ 標準偏差(符号付き)。平均・標準偏差は表の期間より前の1年 */
function sigmaRow(group, key, name, chgMap, st, na, unit = '%') {
  const map = new Map();
  if (st) for (const [k, v] of chgMap) map.set(k, zOf(v, st));
  const sub = st ? `Zスコア(標準偏差 ${st.sd.toFixed(2)}${unit})` : 'Zスコア(標準偏差 —)';
  return { group, key: key + '_sg', label: `${name} ${sub}`, name: '', sub, fmt: 'sigma', kind: 'sigma',
    daily: true, map, na: st ? na : '過去1年の値が足りない' };
}

/** 直前の値との差。キーは列の日付 */
function diffMap(map) {
  const keys = Array.from(map.keys()).sort();
  const out = new Map();
  for (let i = 1; i < keys.length; i++) out.set(keys[i], map.get(keys[i]) - map.get(keys[i - 1]));
  return out;
}

/** 直前の値との変化率(%)。キーは列の日付 */
function pctChangeMap(map) {
  const keys = Array.from(map.keys()).sort();
  const out = new Map();
  for (let i = 1; i < keys.length; i++) {
    const prev = map.get(keys[i - 1]);
    if (prev) out.set(keys[i], (map.get(keys[i]) / prev - 1) * 100);
  }
  return out;
}

/** 33業種のスマホの3列: 最新の前日比 / 前回比は出さない / 期間前の終値からの騰落率 */
function summarizeSector(chgMap, level, from) {
  const keys = Array.from(chgMap.keys()).sort();
  if (!keys.length) return { latest: null };
  const lastKey = keys[keys.length - 1];
  const lv = Array.from(level.keys()).sort();
  const baseKey = lv.filter((k) => k < from).pop() || null;
  const base = baseKey ? level.get(baseKey) : null;
  return {
    latest: chgMap.get(lastKey), latestDate: lastKey, prevDiff: null,
    baseDiff: base && lastKey >= from && level.has(lastKey) ? (level.get(lastKey) / base - 1) * 100 : null,
  };
}

/** スマホの3列: 最新・前回比・期間前比 */
function summarize(map, from, chg) {
  const keys = Array.from(map.keys()).sort();
  if (!keys.length) return { latest: null };
  const lastKey = keys[keys.length - 1];
  const latest = map.get(lastKey);
  const prevKey = keys.length > 1 ? keys[keys.length - 2] : null;
  const baseKey = keys.filter((k) => k < from).pop() || null;
  const diff = (a, b) => {
    if (a == null || b == null) return null;
    return chg === 'pct' ? (b ? (a / b - 1) * 100 : null) : a - b;
  };
  return {
    latest, latestDate: lastKey,
    prevDiff: prevKey ? diff(latest, map.get(prevKey)) : null,
    baseDiff: baseKey && lastKey >= from ? diff(latest, map.get(baseKey)) : null,
    diffUnit: chg === 'pct' ? 'pct' : 'same',
  };
}

module.exports = {
  fetchDbPart,
  fetchExternalPart,
  fetchLivePart,
  buildMarketTable,
  periodStart,
  addDays,
  ymdIn,
  TZ_JP,
};
