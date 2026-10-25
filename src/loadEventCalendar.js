'use strict';

/**
 * 材料(/events)のカレンダーの取込。OCI の VM の cron で日本時間 7:30 と 14:00 に実行する
 * (scripts/run-events.sh)。時刻は取得元ごとの更新の時刻(src/eventSchedule.js)から決めた。
 *   7:30  … 米国の前日の引けの分(先物・指数・期待インフレ率)、SEC の提出書類
 *   14:00 … 日本の金利(財務省、翌営業日 9:30頃)、FINRA の前日(米国の日付)の分
 * 表は ddl/34_event_calendar.sql と ddl/35(FIRST_LOADED_AT)。取得と解析は src/eventSources.js。
 *
 * 【使い方】
 *   node src/loadEventCalendar.js                     既定: 14日前から
 *   node src/loadEventCalendar.js --from 2026-06-01   初回(過去分をまとめて)
 *   node src/loadEventCalendar.js --only series,cpi,earnings,news
 *     既定は series,cpi,earnings。見出し(news)は 2026-10-20 に画面から外したので、--only news のときだけ取る
 *   node src/loadEventCalendar.js --dry-run           DB に書かず、取れた件数だけ表示
 *   node src/loadEventCalendar.js --refetch-news      取得済みの日の見出しも取り直す
 *
 * 【冪等性】
 *   数字・発表日・決算は MERGE(同じ日は上書き)。見出しは、取りに行った記録(NEWS_FETCH_LOG)が
 *   ある日は取り直さない。Google ニュースの結果は後から変わることがあるため、一度取った日は固定する。
 *
 * 【間隔】
 *   Google ニュースは2秒、SEC は0.2秒あけて1件ずつ取る(SEC は毎秒10回まで)。
 *   初回(4か月分)は見出しの検索が約250回になり、10分ほどかかる。
 *
 * 一つの取得元が失敗しても他は続ける。最後に失敗の一覧を出し、終了コード1で終わる。
 */

const oracledb = require('oracledb');
const db = require('./db');
const src = require('./eventSources');

const NEWS_WAIT_MS = 2000;
const SEC_WAIT_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { from: null, only: null, dryRun: false, refetchNews: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--only') a.only = new Set(argv[++i].split(','));
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--refetch-news') a.refetchNews = true;
    else throw new Error(`知らない引数: ${k}`);
  }
  if (a.from && !/^\d{4}-\d{2}-\d{2}$/.test(a.from)) throw new Error('--from は YYYY-MM-DD');
  return a;
}

//------------------------------------------------------------------ DB
const MERGE_SERIES = `
MERGE INTO ext_series_daily t
USING (SELECT :1 AS series_code, TO_DATE(:2, 'YYYY-MM-DD') AS obs_date, :3 AS value FROM dual) s
ON (t.series_code = s.series_code AND t.obs_date = s.obs_date)
WHEN MATCHED THEN UPDATE SET t.value = s.value, t.loaded_at = SYSTIMESTAMP
  WHERE DECODE(t.value, s.value, 0, 1) = 1
WHEN NOT MATCHED THEN INSERT (series_code, obs_date, value, first_loaded_at)
  VALUES (s.series_code, s.obs_date, s.value, SYSTIMESTAMP)`;

const MERGE_RELEASE = `
MERGE INTO ext_release_date t
USING (SELECT :1 AS series_code, TO_DATE(:2, 'YYYY-MM-DD') AS release_date, TO_DATE(:3, 'YYYY-MM-DD') AS ref_period FROM dual) s
ON (t.series_code = s.series_code AND t.release_date = s.release_date)
WHEN MATCHED THEN UPDATE SET t.ref_period = s.ref_period, t.loaded_at = SYSTIMESTAMP
  WHERE t.ref_period <> s.ref_period
WHEN NOT MATCHED THEN INSERT (series_code, release_date, ref_period) VALUES (s.series_code, s.release_date, s.ref_period)`;

const MERGE_FILING = `
MERGE INTO earnings_filing t
USING (SELECT :1 AS ticker, :2 AS accession_no, TO_DATE(:3, 'YYYY-MM-DD') AS filing_date, :4 AS form_type,
              :5 AS items, :6 AS acceptance_at, :7 AS doc_url FROM dual) s
ON (t.ticker = s.ticker AND t.accession_no = s.accession_no)
WHEN NOT MATCHED THEN INSERT (ticker, accession_no, filing_date, form_type, items, acceptance_at, doc_url)
  VALUES (s.ticker, s.accession_no, s.filing_date, s.form_type, s.items, s.acceptance_at, s.doc_url)`;

const STR = (n) => ({ type: oracledb.STRING, maxSize: n });

async function saveSeries(conn, code, rows) {
  if (!rows.length) return 0;
  await conn.executeMany(MERGE_SERIES, rows.map((r) => [code, r.date, r.value]), {
    bindDefs: [STR(40), STR(10), { type: oracledb.NUMBER }],
  });
  return rows.length;
}

//------------------------------------------------------------------ 各取込
async function loadSeries(conn, from, dryRun, log) {
  for (const id of src.FRED_SERIES) {
    // CPI は前年比のため1年余り前から
    const f = id === 'CPIAUCSL' ? src.addDays(from, -430) : src.addDays(from, -10);
    const rows = await guard(log, `FRED ${id}`, () => src.fetchFred(id, f));
    if (rows) report(log, `FRED ${id}`, rows, dryRun || (await saveSeries(conn, id, rows)));
  }
  for (const sym of src.YAHOO_SERIES) {
    const rows = await guard(log, `Yahoo ${sym}`, () => src.fetchYahoo(sym, src.addDays(from, -10)));
    if (rows) report(log, `Yahoo ${sym}`, rows, dryRun || (await saveSeries(conn, sym, rows)));
  }
  const mof = await guard(log, '財務省 国債金利', () => src.fetchMof(src.addDays(from, -10)));
  if (mof) {
    for (const [code, rows] of Object.entries(mof)) {
      report(log, `財務省 ${code}`, rows, dryRun || (await saveSeries(conn, code, rows)));
    }
  }
  const session = await guard(log, 'FINRA の接続', () => src.finraSession());
  if (session) {
    const to = src.ymdIn(new Date(), 'America/New_York');
    for (const [code, symbols] of Object.entries(src.FINRA_SERIES)) {
      const trades = [];
      let ok = true;
      for (const s of symbols) {
        const t = await guard(log, `FINRA ${s}`, () => src.fetchFinraTrades(session, s, src.addDays(from, -10), to));
        if (!t) { ok = false; break; }
        trades.push(...t);
      }
      if (!ok) continue;
      // 今日(米国の日付)の約定は途中なので外す(Yahoo の取引中の足を外すのと同じ)
      const rows = src.dailyMedianYield(trades).filter((r) => r.date < to);
      report(log, `FINRA ${code}(約定 ${trades.length} 件)`, rows, dryRun || (await saveSeries(conn, code, rows)));
    }
  }
  if (!dryRun) await conn.commit();
}

async function loadCpi(conn, from, dryRun, log) {
  const rows = await guard(log, 'ALFRED CPI の発表日', () => src.fetchCpiReleases(src.addDays(from, -40)));
  if (!rows) return;
  if (!dryRun && rows.length) {
    await conn.executeMany(MERGE_RELEASE, rows.map((r) => ['CPIAUCSL', r.releaseDate, r.refPeriod]), {
      bindDefs: [STR(40), STR(10), STR(10)],
    });
    await conn.commit();
  }
  console.log(`ALFRED CPI の発表日: ${rows.length} 件 ${rows.map((r) => r.releaseDate).join(' ')}`);
}

async function loadEarnings(conn, from, dryRun, log) {
  for (const c of src.COMPANIES) {
    const rows = await guard(log, `SEC ${c.ticker}`, () => src.fetchEarnings(c, src.addDays(from, -10)));
    await sleep(SEC_WAIT_MS);
    if (!rows) continue;
    if (!dryRun && rows.length) {
      await conn.executeMany(MERGE_FILING, rows.map((r) =>
        [r.ticker, r.accessionNo, r.filingDate, r.formType, r.items, r.acceptanceAt, r.docUrl]), {
        bindDefs: [STR(10), STR(30), STR(10), STR(10), STR(100), STR(30), STR(500)],
      });
    }
    console.log(`SEC ${c.ticker}: ${rows.length} 件 ${rows.map((r) => r.filingDate).join(' ')}`);
  }
  if (!dryRun) await conn.commit();
}

/** 見出し: 紛争は毎日、決算は提出日とその翌日 */
async function loadNews(conn, from, dryRun, refetch, log) {
  const lastDay = src.addDays(src.ymdIn(new Date(), 'America/New_York'), -1);
  const jobs = [];
  for (let d = from; d <= lastDay; d = src.addDays(d, 1)) {
    for (const t of src.NEWS_TOPICS) jobs.push({ topic: t.topic, query: t.query, date: d });
  }
  const filings = (await conn.execute(
    `SELECT ticker, TO_CHAR(filing_date, 'YYYY-MM-DD') FROM earnings_filing WHERE filing_date >= TO_DATE(:f, 'YYYY-MM-DD')`,
    { f: from })).rows;
  for (const [ticker, fdate] of filings) {
    const c = src.COMPANIES.find((x) => x.ticker === ticker);
    if (!c) continue;
    for (const d of [fdate, src.addDays(fdate, 1)]) {
      if (d <= lastDay) jobs.push({ topic: 'earn:' + ticker, query: `"${c.name}" earnings`, date: d });
    }
  }

  const done = new Set();
  if (!refetch) {
    const r = await conn.execute(
      `SELECT topic, TO_CHAR(news_date, 'YYYY-MM-DD') FROM news_fetch_log WHERE news_date >= TO_DATE(:f, 'YYYY-MM-DD')`, { f: from });
    for (const [t, d] of r.rows) done.add(t + '|' + d);
  }
  const todo = jobs.filter((j) => !done.has(j.topic + '|' + j.date));
  console.log(`見出し: ${todo.length} 回の検索(取得済み ${jobs.length - todo.length} 回は飛ばす)`);

  let n = 0;
  for (const j of todo) {
    const items = await guard(log, `見出し ${j.topic} ${j.date}`, () => src.fetchHeadlines(j.query, j.date));
    await sleep(NEWS_WAIT_MS);
    if (!items) continue;
    const top = items.slice(0, src.HEADLINES_PER_DAY);
    if (!dryRun) {
      await conn.execute(`DELETE FROM news_headline WHERE topic = :t AND news_date = TO_DATE(:d, 'YYYY-MM-DD')`, { t: j.topic, d: j.date });
      for (let i = 0; i < top.length; i++) {
        await conn.execute(
          `INSERT INTO news_headline (topic, news_date, rank_no, title, source_name, url)
           VALUES (:t, TO_DATE(:d, 'YYYY-MM-DD'), :r, :title, :src, :url)`,
          { t: j.topic, d: j.date, r: i + 1, title: top[i].title.slice(0, 1000), src: top[i].source.slice(0, 200), url: top[i].url.slice(0, 2000) });
      }
      await conn.execute(
        `MERGE INTO news_fetch_log t USING (SELECT :t AS topic, TO_DATE(:d, 'YYYY-MM-DD') AS news_date, :c AS item_count FROM dual) s
         ON (t.topic = s.topic AND t.news_date = s.news_date)
         WHEN MATCHED THEN UPDATE SET t.item_count = s.item_count, t.fetched_at = SYSTIMESTAMP
         WHEN NOT MATCHED THEN INSERT (topic, news_date, item_count) VALUES (s.topic, s.news_date, s.item_count)`,
        { t: j.topic, d: j.date, c: items.length });
      await conn.commit();
    }
    n++;
    if (dryRun || n % 20 === 0) console.log(`  ${j.topic} ${j.date}: ${items.length} 件` + (top[0] ? ` 例「${top[0].title}」(${top[0].source})` : ''));
  }
  console.log(`見出し: ${n} 回 終了`);
}

//------------------------------------------------------------------ 共通
async function guard(log, label, fn) {
  try {
    return await fn();
  } catch (err) {
    log.push(`${label}: ${err.message}`);
    console.error(`失敗 ${label}: ${err.message}`);
    return null;
  }
}

function report(log, label, rows, saved) {
  const last = rows[rows.length - 1];
  console.log(`${label}: ${rows.length} 日分` + (last ? `(最後 ${last.date} ${last.value})` : '') + (saved === true ? ' [dry-run]' : ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from || src.addDays(src.ymdIn(new Date(), 'America/New_York'), -14);
  const want = (k) => (args.only ? args.only.has(k) : k !== 'news');
  const log = [];
  console.log(`材料の取込: ${from} から${args.dryRun ? '(dry-run)' : ''}`);
  try {
    await db.withConnection(async (conn) => {
      if (want('series')) await loadSeries(conn, from, args.dryRun, log);
      if (want('cpi')) await loadCpi(conn, from, args.dryRun, log);
      if (want('earnings')) await loadEarnings(conn, from, args.dryRun, log);
      if (want('news')) await loadNews(conn, from, args.dryRun, args.refetchNews, log);
    });
  } finally {
    await db.closePool();
  }
  if (log.length) {
    console.error(`\n失敗 ${log.length} 件:\n  ` + log.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log('\n完了');
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { parseArgs };
