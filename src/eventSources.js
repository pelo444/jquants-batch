'use strict';

/**
 * 材料(/events)のカレンダーの外のデータの取得と、その解析(解析は純粋関数)。
 * 取込は src/loadEventCalendar.js。設計は Project の claude/event_calendar_design.md。
 *
 * 【取得元】(2026-10-19 に内蔵ブラウザ・Mac から届くことを確認)
 *   元のサイトでいつ頃更新されるかは src/eventSchedule.js の SCHEDULE にまとめてある
 *   - FRED: fredgraph.csv(キー不要)。米2年・10年金利、期待インフレ率、ハイイールド債の上乗せ金利、CPI
 *   - ALFRED: CPI の版の日付 = 発表日
 *   - Yahoo Finance(非公式): WTI・ブレントの先物、ドル円、SOX(米半導体株指数)、KBW銀行株指数(^BKX)、VIX、SKEW
 *   - 財務省: 国債金利情報の CSV(Shift_JIS、日付は和暦 R8.10.1)。日本の10年・20年金利。日付は日本の日付
 *   - FINRA: 社債の約定の履歴(非商用に限る)。ページが持つ XSRF トークンが要る
 *   - SEC EDGAR: 提出書類の一覧(User-Agent に連絡先が必須。JQB_SEC_USER_AGENT)
 *   - Google ニュースの RSS: 英語の見出し。個人のフィードリーダーとして個人的・非商用に使う条件
 *
 * 【件数を出さない理由】
 *   Google ニュースの RSS は1回100件で切れ、話題の大きい語は毎日100件に達するため件数が比べられない。
 *   件数を数えるための GDELT は、Mac のターミナルからも「5秒に1回まで」と断られた(2026-10-19)。
 */

const { closeOf, wallToInstant } = require('./eventSchedule');
const CLOSE_MARGIN_MS = 15 * 60 * 1000;

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// FRED・ALFRED(stlouisfed.org、前に Akamai)は、OCI の VM から Chrome そのままの名乗りで取ると応答が無く
// 30秒で切れた。'Mozilla/5.0' だけ、または名乗りなしなら取れた(2026-10-25、VM の Node で確認)。
// Mac(家庭のアドレス)ではどちらでも取れる。財務省・FINRA は Chrome の名乗りのまま VM から取れている
const UA_SHORT = 'Mozilla/5.0';
const TIMEOUT_MS = 30000;

//------------------------------------------------------------------ 定義
const FRED_SERIES = ['DGS2', 'DGS10', 'T10YIE', 'BAMLH0A0HYM2', 'CPIAUCSL'];
const YAHOO_SERIES = ['CL=F', 'BZ=F', 'JPY=X', '^SOX', '^BKX', '^VIX', '^SKEW'];

// 財務省の国債金利(残存期間ごとの利回り)。系列コード → CSV の見出しの列名
const MOF_SERIES = { JGB10: '10年', JGB20: '20年' };
const MOF_CURRENT_URL = 'https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv';      // 今月分
const MOF_ALL_URL = 'https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv'; // 前月まで全期間

// コアウィーブ 9.75% 2031年10月1日償還の社債。同じ社債の3つの銘柄記号(私募の種類違い)をまとめて、
// その日の約定の利回りの中央値を1つの値にする
const FINRA_SERIES = {
  CRWV_975_2031: ['CRWV6364371', 'CRWV6364372', 'CRWV6369804'],
};

const NEWS_TOPICS = [
  { topic: 'iran', query: 'Iran OR Hormuz' },
  { topic: 'russia', query: 'Russia Ukraine' },
];

// 見出しを出す出どころ(Google ニュースの <source> の文字列)。2026-10-19 ユーザー判断で英語だけ
const NEWS_SOURCES = new Set([
  'Reuters', 'AP News', 'Associated Press', 'The Associated Press',
  'CNBC', 'Bloomberg', 'Bloomberg.com', 'The Wall Street Journal', 'WSJ', 'Financial Times',
]);
const HEADLINES_PER_DAY = 2;

// 決算: 8-K で項目 2.02(決算の発表)を含むもの。TSMC は外国の会社で 6-K を月に何度も出すため、
// 決算の 6-K を書類名で見分ける(tsm-20261015x6k.htm の形。月次売上は tsm-revenue…、月末は tsm-monthend…)
const COMPANIES = [
  { ticker: 'MU', cik: 723125, name: 'Micron' },
  { ticker: 'NVDA', cik: 1045810, name: 'Nvidia' },
  { ticker: 'AVGO', cik: 1730168, name: 'Broadcom' },
  { ticker: 'AMD', cik: 2488, name: 'AMD' },
  { ticker: 'TSM', cik: 1046179, name: 'TSMC', form: '6-K', docRe: /^tsm-\d{8}x6k\.htm$/ },
  { ticker: 'CRWV', cik: 1769628, name: 'CoreWeave' },
];

//------------------------------------------------------------------ 日付
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ymdIn(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function prevMonthFirst(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 10);
}

//------------------------------------------------------------------ 通信
async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA_BROWSER, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

//------------------------------------------------------------------ FRED
/** fredgraph.csv → [{date, value}]。値が空・'.' の日は飛ばす */
function parseFredCsv(text) {
  const out = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = Number(v);
    if (v === '' || v === '.' || !Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

async function fetchFred(id, from) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${from}`;
  return parseFredCsv(await getText(url, { 'User-Agent': UA_SHORT }));
}

/**
 * ALFRED の版の日付 = 発表日の一覧。系列ページのグラフが読む JSON の
 * chart_series[0].series_objects.a.available_revision_dates にある(2026-10-19 確認)。
 * 系列ページの HTML の <option> はスクリプトで後から作られるので、HTML からは取れない。
 */
function parseAlfredVintages(body) {
  const cs = body && body.chart_series && body.chart_series[0];
  const objs = cs && cs.series_objects;
  const first = objs && Object.values(objs)[0];
  const dates = first && first.available_revision_dates;
  if (!Array.isArray(dates)) throw new Error('ALFRED: 形式が想定と違う');
  return [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
}

async function fetchCpiReleases(from) {
  const body = JSON.parse(await getText('https://alfred.stlouisfed.org/graph/api/series/?id=CPIAUCSL&mode=alfred&firstRequest=seriesPage&width=643', { 'User-Agent': UA_SHORT }));
  // 2025年の政府閉鎖で 10/24(9月分)・12/18(11月分)にずれた月も、発表月の前の月で合う
  return parseAlfredVintages(body)
    .filter((d) => d >= from)
    .map((d) => ({ releaseDate: d, refPeriod: prevMonthFirst(d) }));
}

//------------------------------------------------------------------ Yahoo
/**
 * chart API の応答 → [{date, value}]。日付は取引所の時刻帯の日付。
 * 今日(取引所の日付)の足は取引中のことがあるので外す。
 */
/**
 * close: その系列の1日の取引が終わる時刻 {tz, time}(src/eventSchedule.js の closeOf)。
 *   今日(取引所の日付)の足は、取引中のことがあるので外す。ただし close の時刻を15分過ぎていれば入れる
 *   (日本時間 7:00 の回で、米国の前日の引けの分を取れるように。2026-10-25)。close が無い系列(ドル円)は常に外す。
 */
function parseYahooChart(body, now = new Date(), close = null) {
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) {
    const desc = body && body.chart && body.chart.error && body.chart.error.description;
    throw new Error(desc || 'Yahoo: 形式が想定と違う');
  }
  const tz = (result.meta && result.meta.exchangeTimezoneName) || 'America/New_York';
  const today = ymdIn(now, tz);
  const closes = result.indicators.quote[0].close;
  const byDate = new Map();
  result.timestamp.forEach((t, i) => {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) return;
    const date = ymdIn(new Date(t * 1000), tz);
    if (date > today) return;
    if (date === today && !(close && now.getTime() >= wallToInstant(today, close.time, close.tz) + CLOSE_MARGIN_MS)) return;
    byDate.set(date, Math.round(c * 1e4) / 1e4); // 同じ日が2本あれば後の足。小数4桁に丸める
  });
  return [...byDate].map(([date, value]) => ({ date, value }));
}

/**
 * User-Agent は市場のページ(marketQuery.js)と同じ 'Mozilla/5.0'。ブラウザそのままの文字列だと
 * 429 が返った(2026-10-19)。429 のときは5秒おいて1回だけ取り直す。
 */
async function fetchYahoo(symbol, from) {
  const p1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return parseYahooChart(await res.json(), new Date(), closeOf(symbol));
  }
}

//------------------------------------------------------------------ 財務省(国債金利)
const ERA_BASE = { R: 2018, H: 1988, S: 1925 };

/** 和暦 'R8.10.1' → '2026-10-01'。形が違えば null */
function parseWareki(s) {
  const m = /^([RHS])(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const y = ERA_BASE[m[1]] + Number(m[2]);
  return `${y}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`;
}

/**
 * 国債金利の CSV(文字に直したもの) → { JGB10: [{date, value}], ... }。
 * 1行目は表題、2行目が見出し(基準日,1年,2年,…)。値が '-' や空の日は飛ばす。
 */
function parseMofCsv(text, series = MOF_SERIES) {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => l.split(',').includes('10年'));
  if (hi < 0) throw new Error('財務省: 見出しの行が見つからない');
  const head = lines[hi].split(',').map((x) => x.trim());
  const out = {};
  for (const [code, name] of Object.entries(series)) {
    const ci = head.indexOf(name);
    if (ci < 0) throw new Error(`財務省: 列「${name}」が無い`);
    out[code] = [];
    for (const line of lines.slice(hi + 1)) {
      const f = line.split(',');
      const date = parseWareki(f[0]);
      if (!date) continue;
      const v = f[ci] == null ? '' : f[ci].trim();
      const value = Number(v);
      if (v === '' || v === '-' || !Number.isFinite(value)) continue;
      out[code].push({ date, value });
    }
  }
  return out;
}

async function getShiftJis(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA_BROWSER }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return new TextDecoder('shift_jis').decode(await res.arrayBuffer());
}

/**
 * from 以降の日本の10年・20年金利。今月分の CSV は毎日更新される。
 * from が今月より前なら、前月までの全期間の CSV(大きい)も読む。
 */
async function fetchMof(from) {
  const thisMonth = ymdIn(new Date(), 'Asia/Tokyo').slice(0, 8) + '01';
  const texts = [];
  if (from < thisMonth) texts.push(await getShiftJis(MOF_ALL_URL));
  texts.push(await getShiftJis(MOF_CURRENT_URL));
  const merged = {};
  for (const code of Object.keys(MOF_SERIES)) merged[code] = new Map();
  for (const t of texts) {
    const parsed = parseMofCsv(t);
    for (const [code, rows] of Object.entries(parsed)) {
      for (const r of rows) if (r.date >= from) merged[code].set(r.date, r.value);
    }
  }
  const out = {};
  for (const [code, m] of Object.entries(merged)) {
    out[code] = [...m].sort().map(([date, value]) => ({ date, value }));
  }
  return out;
}

//------------------------------------------------------------------ FINRA
const FINRA_BASE = 'https://services-dynarep.ddwa.finra.org';
const FINRA_HEADERS = { Origin: 'https://www.finra.org', Referer: 'https://www.finra.org/', Accept: 'application/json, text/plain, */*' };

/**
 * FINRA の API は「XSRF-TOKEN のクッキーと X-XSRF-TOKEN の見出しが同じ値か」だけを見る。
 * 自分で作った値を両方に入れて通ることを、ブラウザで確かめた(2026-10-19)。
 * fixed-income-tnc=true は利用規約に同意したときにブラウザに付くクッキー(ユーザーが内蔵ブラウザで同意済み)。
 * /user/v1/profile は 200 を返すがクッキーを付けないので使わない。
 */
async function finraSession() {
  const token = require('crypto').randomUUID();
  return { cookie: `XSRF-TOKEN=${token}; fixed-income-tnc=true`, xsrf: token };
}

/** 応答の形が2通りあり得る(returnBody.data が JSON 文字列 / 配列そのもの) */
function finraRows(body) {
  if (Array.isArray(body)) return body;
  if (body && body.returnBody && typeof body.returnBody.data === 'string') return JSON.parse(body.returnBody.data);
  if (body && Array.isArray(body.data)) return body.data;
  throw new Error('FINRA: 応答の形が想定と違う');
}

async function fetchFinraTrades(session, symbol, from, to) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const reqBody = {
      fields: ['issueSymbolIdentifier', 'tradeExecutionDate', 'tradeExecutionTime', 'reportedTradeVolume', 'lastSalePrice', 'lastSaleYield'],
      dateRangeFilters: [{ fieldName: 'tradeExecutionDate', startDate: from, endDate: to }],
      domainFilters: [], compareFilters: [{ fieldName: 'issueSymbolIdentifier', fieldValue: symbol, compareType: 'EQUAL' }],
      multiFieldMatchFilters: [], orFilters: [], aggregationFilter: null,
      sortFields: ['tradeExecutionDate', 'tradeExecutionTime'], limit: 1000, offset, delimiter: null, quoteValues: false,
    };
    const res = await fetch(`${FINRA_BASE}/public/reporting/v2/data/group/FixedIncomeMarket/name/CorporateAndAgencyTradeHistory`, {
      method: 'POST',
      headers: { 'User-Agent': UA_BROWSER, ...FINRA_HEADERS, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': session.xsrf, Cookie: session.cookie },
      body: JSON.stringify(reqBody), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`FINRA ${symbol}: HTTP ${res.status}`);
    const text = await res.text();
    if (!text) break;
    const rows = finraRows(JSON.parse(text));
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

/** 約定 → 日ごとの利回りの中央値 [{date, value}] */
function dailyMedianYield(trades) {
  const by = new Map();
  for (const t of trades) {
    const y = parseFloat(t.lastSaleYield);
    if (!Number.isFinite(y)) continue;
    const d = t.tradeExecutionDate;
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(y);
  }
  return [...by].sort().map(([date, ys]) => {
    ys.sort((a, b) => a - b);
    const n = ys.length;
    const value = n % 2 ? ys[(n - 1) / 2] : (ys[n / 2 - 1] + ys[n / 2]) / 2;
    return { date, value: Math.round(value * 1e4) / 1e4 };
  });
}

//------------------------------------------------------------------ SEC
function secUserAgent() {
  const ua = process.env.JQB_SEC_USER_AGENT;
  if (!ua) throw new Error('SEC: .env に JQB_SEC_USER_AGENT(名前とメールアドレス)を設定してください');
  return ua;
}

/** submissions JSON → 決算の提出書類 */
function parseSubmissions(body, company, from) {
  const f = body.filings && body.filings.recent;
  if (!f || !Array.isArray(f.form)) throw new Error(`SEC ${company.ticker}: 形式が想定と違う`);
  const out = [];
  for (let i = 0; i < f.form.length; i++) {
    if (f.filingDate[i] < from) continue;
    const form = f.form[i];
    const doc = f.primaryDocument[i] || '';
    const ok = company.form === '6-K'
      ? form === '6-K' && company.docRe.test(doc)
      : form === '8-K' && /(^|,)\s*2\.02(\s*,|$)/.test(f.items[i] || '');
    if (!ok) continue;
    const acc = f.accessionNumber[i];
    out.push({
      ticker: company.ticker,
      accessionNo: acc,
      filingDate: f.filingDate[i],
      formType: form,
      items: f.items[i] || null,
      acceptanceAt: f.acceptanceDateTime[i] || null,
      docUrl: `https://www.sec.gov/Archives/edgar/data/${company.cik}/${acc.replace(/-/g, '')}/${doc}`,
    });
  }
  return out;
}

async function fetchEarnings(company, from) {
  const url = `https://data.sec.gov/submissions/CIK${String(company.cik).padStart(10, '0')}.json`;
  const body = JSON.parse(await getText(url, { 'User-Agent': secUserAgent(), Accept: 'application/json' }));
  return parseSubmissions(body, company, from);
}

//------------------------------------------------------------------ Google ニュース
function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** RSS → [{title, source, url, date}]。タイトル末尾の「 - 出どころ」は外す。date は pubDate のグリニッジ標準時の日付 */
function parseNewsRss(xml) {
  const items = xml.split('<item>').slice(1);
  const tag = (s, t) => {
    const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
    return m ? decodeXml(m[1]).trim() : '';
  };
  return items.map((it) => {
    const source = tag(it, 'source');
    let title = tag(it, 'title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const pub = new Date(tag(it, 'pubDate'));
    return { title, source, url: tag(it, 'link'), date: Number.isNaN(pub.getTime()) ? null : pub.toISOString().slice(0, 10) };
  });
}

/** その日の、決めた出どころの見出し(Google の並び順) */
function pickHeadlines(items, date) {
  return items.filter((x) => x.date === date && NEWS_SOURCES.has(x.source) && x.title);
}

/**
 * after:D before:D+1 で D と D+1 の記事が返る(2026-10-19 確認)。D の日付のものだけ使う。
 * after と before に同じ日を入れると、返る記事が極端に少なくなるので使わない。
 */
async function fetchHeadlines(query, date) {
  const q = `${query} after:${date} before:${addDays(date, 1)}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const items = parseNewsRss(await getText(url));
  return pickHeadlines(items, date);
}

module.exports = {
  FRED_SERIES, YAHOO_SERIES, MOF_SERIES, FINRA_SERIES, NEWS_TOPICS, NEWS_SOURCES, HEADLINES_PER_DAY, COMPANIES,
  addDays, ymdIn, prevMonthFirst,
  parseFredCsv, fetchFred, parseAlfredVintages, fetchCpiReleases,
  parseYahooChart, fetchYahoo,
  parseWareki, parseMofCsv, fetchMof,
  finraSession, finraRows, fetchFinraTrades, dailyMedianYield,
  parseSubmissions, fetchEarnings,
  parseNewsRss, pickHeadlines, fetchHeadlines,
};
