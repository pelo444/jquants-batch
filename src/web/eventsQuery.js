'use strict';

/**
 * 材料(/events)のデータ。設計は Project の claude/event_calendar_design.md。
 *
 * 縦長の月間カレンダー: 1か月を1つの表にし、行 = その月の毎日(土日も含む)、列 = 数字、右端 = 備考。
 * 月は新しい月を上に、日も新しい日を上に並べる(2026-10-20 ユーザー要望で、1日から順を改めた)。今日(米国の日付)より先の日は出さない。
 * 日付はすべて米国の日付(国内の営業日にずらさない)。
 *
 * 数字は「水準」と「前日差」(前のデータのある日との差)。金利・利回り・上乗せ金利は bp、
 * 原油・SOX・KBW銀行株指数は %、VIX・SKEW はポイント、ドル円は円。CPI は発表日の行に、対象月の前年比と前月比を出す。
 * 日本の金利(財務省)は日本の日付で、同じ日付の行に置く。
 * 備考は、東京の営業日(DB の TOPIX がある日)の日次概況へのリンク(世界一やさしい投資の学校)と、決算の提出書類。
 * 見出し(Google ニュース)は購読の壁で読めないものが多く、2026-10-20 に外した(表 news_headline は残してある)。
 * 取込は src/loadEventCalendar.js(OCI の VM の cron で日本時間 7:30 と 14:00)。
 * 取得元ごとの更新の時刻(src/eventSchedule.js)と、各系列の最新の日付・初めて入った時刻を「取得元と更新の時刻」の表に出す。
 */

const { SCHEDULE, describe } = require('../eventSchedule');

const COLUMNS = [
  { code: 'DGS2', label: '米2年金利', unit: '%', dec: 2, chg: 'bp' },
  { code: 'DGS10', label: '米10年金利', unit: '%', dec: 2, chg: 'bp' },
  { code: 'T10YIE', label: '期待インフレ率(10年)', unit: '%', dec: 2, chg: 'bp' },
  { code: 'JGB10', label: '日本10年金利', unit: '%', dec: 3, chg: 'bp' },
  { code: 'JGB20', label: '日本20年金利', unit: '%', dec: 3, chg: 'bp' },
  { code: 'CL=F', label: 'WTI先物', unit: 'ドル', dec: 2, chg: '%' },
  { code: 'BZ=F', label: 'ブレント先物', unit: 'ドル', dec: 2, chg: '%' },
  { code: 'JPY=X', label: 'ドル円', unit: '円', dec: 2, chg: '円' },
  { code: '^SOX', label: 'SOX(米半導体株)', unit: 'pt', dec: 0, chg: '%' },
  { code: '^BKX', label: 'KBW銀行株指数', unit: 'pt', dec: 2, chg: '%' },
  { code: '^VIX', label: 'VIX', unit: 'pt', dec: 2, chg: 'pt' },
  { code: '^SKEW', label: 'SKEW', unit: 'pt', dec: 1, chg: 'pt' },
  { code: 'BAMLH0A0HYM2', label: 'ハイイールド債の上乗せ金利', unit: '%', dec: 2, chg: 'bp' },
  { code: 'CRWV_975_2031', label: 'コアウィーブ社債利回り(9.75% 2031年)', unit: '%', dec: 2, chg: 'bp' },
];

const COMPANY_LABEL = { MU: 'マイクロン', NVDA: 'エヌビディア', AVGO: 'ブロードコム', AMD: 'AMD', TSM: 'TSMC', CRWV: 'コアウィーブ' };

/** 東京の日次概況(世界一やさしい投資の学校)。URL は日付で決まる(2026-08-03・10-01・10-19・10-20 で確認) */
function recapUrl(ymd) { return `https://tbladvisory.com/${ymd.replace(/-/g, '')}nk/`; }

//------------------------------------------------------------------ 期間
function monthFirst(ym) { return ym + '-01'; }
function monthLast(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ?from=YYYY-MM&to=YYYY-MM。既定は直近3か月(今月と前の2か月) */
function resolvePeriod(q, todayYm) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/;
  let to = re.test(q.to || '') ? q.to : todayYm;
  let from = re.test(q.from || '') ? q.from : addMonths(to, -2);
  if (from > to) [from, to] = [to, from];
  // 長すぎる指定は24か月までに抑える
  if (addMonths(from, 24) <= to) from = addMonths(to, -23);
  return { from, to };
}

//------------------------------------------------------------------ DB
async function fetchEvents(conn, { from, to }) {
  const f = monthFirst(from);
  const t = monthLast(to);
  const q = async (sql, binds) => (await conn.execute(sql, binds)).rows;
  const series = await q(
    `SELECT series_code, TO_CHAR(obs_date, 'YYYY-MM-DD'), value FROM ext_series_daily
      WHERE (series_code <> 'CPIAUCSL' AND obs_date BETWEEN TO_DATE(:f, 'YYYY-MM-DD') - 40 AND TO_DATE(:t, 'YYYY-MM-DD'))
         OR (series_code = 'CPIAUCSL' AND obs_date BETWEEN TO_DATE(:f, 'YYYY-MM-DD') - 430 AND TO_DATE(:t, 'YYYY-MM-DD'))
      ORDER BY series_code, obs_date`, { f, t });
  const releases = await q(
    `SELECT series_code, TO_CHAR(release_date, 'YYYY-MM-DD'), TO_CHAR(ref_period, 'YYYY-MM-DD') FROM ext_release_date
      WHERE release_date BETWEEN TO_DATE(:f, 'YYYY-MM-DD') AND TO_DATE(:t, 'YYYY-MM-DD')`, { f, t });
  // 東京の営業日 = TOPIX(0000)の終値がある日
  const tokyoDays = await q(
    `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') FROM index_price_daily
      WHERE index_code = '0000' AND price_date BETWEEN TO_DATE(:f, 'YYYY-MM-DD') AND TO_DATE(:t, 'YYYY-MM-DD')
      ORDER BY price_date`, { f, t });
  const filings = await q(
    `SELECT ticker, TO_CHAR(filing_date, 'YYYY-MM-DD'), form_type, doc_url FROM earnings_filing
      WHERE filing_date BETWEEN TO_DATE(:f, 'YYYY-MM-DD') AND TO_DATE(:t, 'YYYY-MM-DD')
      ORDER BY filing_date, ticker`, { f, t });
  const lastLoaded = await q(`SELECT TO_CHAR(MAX(loaded_at), 'YYYY-MM-DD HH24:MI') FROM ext_series_daily`, {});
  const freshness = await fetchFreshness(conn);
  return {
    series: series.map(([code, date, value]) => ({ code, date, value })),
    releases: releases.map(([code, releaseDate, refPeriod]) => ({ code, releaseDate, refPeriod })),
    tokyoDays: tokyoDays.map(([d]) => d),
    filings: filings.map(([ticker, date, form, url]) => ({ ticker, date, form, url })),
    loadedAt: lastLoaded[0] && lastLoaded[0][0],
    freshness,
  };
}

/**
 * 系列ごとの最新の日付と、その値が初めて入った時刻(協定世界時)。期間の指定によらない。
 * FIRST_LOADED_AT(ddl/35)をまだ足していない DB では、時刻なしで返す。
 */
async function fetchFreshness(conn) {
  const q = async (sql) => (await conn.execute(sql, {})).rows;
  // 系列ごとの最新の日付の行。firstCol は時刻の列(ddl/35 の前は NULL)
  const latest = (firstCol) =>
    `SELECT series_code, TO_CHAR(obs_date, 'YYYY-MM-DD'), ${firstCol} FROM (
       SELECT d.*, ROW_NUMBER() OVER (PARTITION BY series_code ORDER BY obs_date DESC) AS rn FROM ext_series_daily d)
      WHERE rn = 1`;
  let rows;
  try {
    rows = await q(latest(`TO_CHAR(first_loaded_at, 'YYYY-MM-DD HH24:MI')`));
  } catch (err) {
    if (!/ORA-00904/.test(err.message)) throw err;
    rows = await q(latest('NULL'));
  }
  const series = {};
  for (const [code, date, firstLoadedAt] of rows) series[code] = { date, firstLoadedAt };
  const one = async (sql) => { const r = await q(sql); return r[0] ? { date: r[0][0], firstLoadedAt: r[0][1] } : null; };
  return {
    series,
    cpiRelease: await one(`SELECT TO_CHAR(release_date, 'YYYY-MM-DD'), TO_CHAR(loaded_at, 'YYYY-MM-DD HH24:MI') FROM ext_release_date
                            WHERE series_code = 'CPIAUCSL' ORDER BY release_date DESC FETCH FIRST 1 ROWS ONLY`),
    filing: await one(`SELECT TO_CHAR(filing_date, 'YYYY-MM-DD'), TO_CHAR(loaded_at, 'YYYY-MM-DD HH24:MI') FROM earnings_filing
                        ORDER BY filing_date DESC, loaded_at DESC FETCH FIRST 1 ROWS ONLY`),
    tokyo: await one(`SELECT TO_CHAR(MAX(price_date), 'YYYY-MM-DD'), NULL FROM index_price_daily WHERE index_code = '0000'`),
  };
}

/**
 * 「取得元と更新の時刻」の表の行(純粋関数)。refYmd は日本時間を計算する基準の日(夏時間・冬時間の判定に使う)。
 * 複数の系列をまとめた行は、最新の日付がいちばん古い系列を出す(遅れている方が分かるように)。
 */
function buildSchedule(freshness, refYmd) {
  const f = freshness || { series: {} };
  return SCHEDULE.map((s, i) => {
    let latest = null;
    if (s.release) latest = f.cpiRelease || null;
    else if (s.filing) latest = f.filing || null;
    else if (s.recap) latest = f.tokyo || null;
    else {
      for (const c of s.codes) {
        const x = f.series && f.series[c];
        if (x && (!latest || x.date < latest.date)) latest = x;
      }
    }
    const d = describe(s, refYmd);
    return {
      no: i + 1, label: s.label, source: s.source, original: d.original, jst: d.jst, basis: s.basis,
      latestDate: latest ? latest.date : null,
      firstLoadedAt: latest ? latest.firstLoadedAt || null : null,
    };
  });
}

//------------------------------------------------------------------ 組み立て(純粋関数)
function change(col, prev, cur) {
  if (prev == null || cur == null) return null;
  if (col.chg === 'bp') return (cur - prev) * 100;
  if (col.chg === '%') return prev === 0 ? null : (cur / prev - 1) * 100;
  // 'pt'(VIX・SKEW)と '円' はそのままの差
  return cur - prev;
}

function monthKey(ymd, deltaMonths) {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + deltaMonths, 1)).toISOString().slice(0, 10);
}

/**
 * @param {{from:string,to:string}} period YYYY-MM
 * @param {object} data fetchEvents の結果
 * @param {string} [today] 米国の今日(YYYY-MM-DD)。これより先の日は出さない
 */
function buildCalendar(period, data, today) {
  // 系列ごとに日付 → 値と、前のデータのある日の値
  const bySeries = new Map();
  for (const r of data.series) {
    if (!bySeries.has(r.code)) bySeries.set(r.code, []);
    bySeries.get(r.code).push(r);
  }
  const cell = new Map(); // code|date → {v, chg}
  for (const col of COLUMNS) {
    const rows = (bySeries.get(col.code) || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    rows.forEach((r, i) => {
      const prev = i > 0 ? rows[i - 1].value : null;
      cell.set(col.code + '|' + r.date, { v: r.value, chg: change(col, prev, r.value) });
    });
  }

  const cpi = new Map((bySeries.get('CPIAUCSL') || []).map((r) => [r.date, r.value]));
  const cpiByDay = new Map();
  for (const rel of data.releases.filter((x) => x.code === 'CPIAUCSL')) {
    const v = cpi.get(rel.refPeriod);
    const y1 = cpi.get(monthKey(rel.refPeriod, -12));
    const m1 = cpi.get(monthKey(rel.refPeriod, -1));
    cpiByDay.set(rel.releaseDate, {
      refMonth: Number(rel.refPeriod.slice(5, 7)),
      yoy: v != null && y1 ? (v / y1 - 1) * 100 : null,
      mom: v != null && m1 ? (v / m1 - 1) * 100 : null,
    });
  }

  // 備考: 東京の概況 → 決算の提出書類
  const notes = new Map(); // date → [...]
  const push = (d, n) => { if (!notes.has(d)) notes.set(d, []); notes.get(d).push(n); };
  for (const d of data.tokyoDays || []) {
    push(d, { kind: 'recap', label: '東京', title: '日経平均の概況', source: '世界一やさしい投資の学校', url: recapUrl(d) });
  }
  for (const f of data.filings) {
    push(f.date, { kind: 'filing', label: `${COMPANY_LABEL[f.ticker] || f.ticker} 決算発表(${f.form})`, url: f.url });
  }

  const months = [];
  for (let ym = period.to; ym >= period.from; ym = addMonths(ym, -1)) {
    const days = [];
    const last = today && today < monthLast(ym) ? today : monthLast(ym);
    for (let d = monthFirst(ym); d <= last; d = addDays(d, 1)) {
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      days.push({
        date: d,
        weekend: wd === 0 || wd === 6,
        values: COLUMNS.map((c) => cell.get(c.code + '|' + d) || null),
        cpi: cpiByDay.get(d) || null,
        notes: notes.get(d) || [],
      });
    }
    days.reverse(); // 新しい日を上に
    months.push({ ym, days });
  }

  return {
    period,
    columns: COLUMNS.map(({ code, label, unit, dec, chg }) => ({ code, label, unit, dec, chg })),
    months,
    loadedAt: data.loadedAt || null,
    schedule: buildSchedule(data.freshness, today || period.to + '-01'),
  };
}

module.exports = { COLUMNS, recapUrl, resolvePeriod, fetchEvents, buildCalendar, buildSchedule, addMonths, monthLast };
