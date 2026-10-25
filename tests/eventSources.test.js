'use strict';
// 材料(/events)の取得元の解析。実データの形(2026-10-19 に内蔵ブラウザで見たもの)を写した合成データで確かめる
const assert = require('assert');
const s = require('../src/eventSources');

// FRED: 空・'.' の日は飛ばす
assert.deepStrictEqual(
  s.parseFredCsv('observation_date,DGS10\n2026-10-14,5.19\n2026-10-15,5.10\n2026-10-16,\n2026-10-17,.\n'),
  [{ date: '2026-10-14', value: 5.19 }, { date: '2026-10-15', value: 5.1 }]);

// ALFRED: 版の日付 → 前の月の1日
assert.deepStrictEqual(s.parseAlfredVintages({ chart_series: [{ series_objects: { a: { available_revision_dates: ['2026-10-14', '2025-12-18', '2026-09-11'] } } }] }),
  ['2025-12-18', '2026-09-11', '2026-10-14']);
assert.throws(() => s.parseAlfredVintages({ status: 'An error has occurred' }), /形式/);
assert.strictEqual(s.prevMonthFirst('2026-10-14'), '2026-09-01');
assert.strictEqual(s.prevMonthFirst('2026-01-13'), '2025-12-01');

// Yahoo: 取引所の時刻帯の日付。今日の足は外す。値が null の足も外す
{
  const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);
  const body = { chart: { result: [{ meta: { exchangeTimezoneName: 'America/New_York' },
    timestamp: [ts('2026-10-15T04:00:00Z'), ts('2026-10-16T04:00:00Z'), ts('2026-10-19T04:00:00Z'), ts('2026-10-20T04:00:00Z')],
    indicators: { quote: [{ close: [97.97, null, 98.18, 99] }] } }] } };
  assert.deepStrictEqual(s.parseYahooChart(body, new Date('2026-10-20T13:00:00Z')),
    [{ date: '2026-10-15', value: 97.97 }, { date: '2026-10-19', value: 98.18 }]);
  assert.throws(() => s.parseYahooChart({ chart: { error: { description: 'No data found' } } }), /No data found/);
}

// FINRA: 応答の2つの形と、日ごとの中央値(利回りが空の約定は飛ばす)
{
  const rows = [
    { tradeExecutionDate: '2026-10-14', lastSaleYield: '15.19' },
    { tradeExecutionDate: '2026-10-14', lastSaleYield: '15.05' },
    { tradeExecutionDate: '2026-10-14', lastSaleYield: '' },
    { tradeExecutionDate: '2026-10-13', lastSaleYield: '14.76' },
    { tradeExecutionDate: '2026-10-13', lastSaleYield: '14.70' },
    { tradeExecutionDate: '2026-10-13', lastSaleYield: '15.02' },
  ];
  assert.deepStrictEqual(s.finraRows({ returnBody: { data: JSON.stringify(rows) } }), rows);
  assert.deepStrictEqual(s.finraRows(rows), rows);
  assert.deepStrictEqual(s.dailyMedianYield(rows), [{ date: '2026-10-13', value: 14.76 }, { date: '2026-10-14', value: 15.12 }]);
}

// SEC: 8-K は項目 2.02 を含むもの。TSMC は決算の 6-K だけ
{
  const body = { filings: { recent: {
    form: ['8-K', '8-K', '10-Q', '8-K'],
    filingDate: ['2026-09-30', '2026-09-15', '2026-09-20', '2026-06-24'],
    items: ['2.02,9.01', '5.02', '', '2.02,9.01'],
    acceptanceDateTime: ['2026-09-30T20:02:11.000Z', '', '', ''],
    accessionNumber: ['0000723125-26-000041', 'a', 'b', 'c'],
    primaryDocument: ['mu-20260930.htm', 'x.htm', 'y.htm', 'z.htm'],
  } } };
  const mu = s.COMPANIES.find((c) => c.ticker === 'MU');
  const r = s.parseSubmissions(body, mu, '2026-07-01');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].filingDate, '2026-09-30');
  assert.strictEqual(r[0].docUrl, 'https://www.sec.gov/Archives/edgar/data/723125/000072312526000041/mu-20260930.htm');

  const tsm = s.COMPANIES.find((c) => c.ticker === 'TSM');
  const t = s.parseSubmissions({ filings: { recent: {
    form: ['6-K', '6-K', '6-K', '6-K'], filingDate: ['2026-10-15', '2026-10-08', '2026-09-24', '2026-07-16'],
    items: ['', '', '', ''], acceptanceDateTime: ['', '', '', ''], accessionNumber: ['1', '2', '3', '4'],
    primaryDocument: ['tsm-20261015x6k.htm', 'tsm-revenue20261008.htm', 'tsm-monthend6kx20260924.htm', 'tsm-20260716x6k.htm'],
  } } }, tsm, '2026-07-01');
  assert.deepStrictEqual(t.map((x) => x.filingDate), ['2026-10-15', '2026-07-16']);
}

// Google ニュース: タイトル末尾の出どころを外す。日付と出どころで絞る(並び順はそのまま)
{
  const xml = `<rss><channel><title>x</title>
<item><title>Oil jumps after Trump reinstates Iran blockade - Reuters</title><link>https://news.google.com/rss/articles/A</link><pubDate>Mon, 13 Jul 2026 07:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Iran &amp; oil: what&#39;s next - Some Blog</title><link>https://news.google.com/rss/articles/B</link><pubDate>Mon, 13 Jul 2026 07:00:00 GMT</pubDate><source url="https://x">Some Blog</source></item>
<item><title>Brent rises again - CNBC</title><link>https://news.google.com/rss/articles/C</link><pubDate>Tue, 14 Jul 2026 07:00:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item>
<item><title>Stocks fall as oil soars - CNBC</title><link>https://news.google.com/rss/articles/D</link><pubDate>Mon, 13 Jul 2026 07:00:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item>
</channel></rss>`;
  const items = s.parseNewsRss(xml);
  assert.strictEqual(items[0].title, 'Oil jumps after Trump reinstates Iran blockade');
  assert.strictEqual(items[1].title, "Iran & oil: what's next");
  assert.strictEqual(items[0].date, '2026-07-13');
  assert.deepStrictEqual(s.pickHeadlines(items, '2026-07-13').map((x) => x.url),
    ['https://news.google.com/rss/articles/A', 'https://news.google.com/rss/articles/D']);
}

console.log('eventSources: ok');

// 財務省の国債金利
assert.strictEqual(s.parseWareki('R8.10.1'), '2026-10-01');
assert.strictEqual(s.parseWareki('H31.4.26'), '2019-04-26');
assert.strictEqual(s.parseWareki('基準日'), null);
{
  const csv = '国債金利情報 (令和8年10月),,,(単位 : %)\r\n' +
    '基準日,1年,2年,3年,4年,5年,6年,7年,8年,9年,10年,15年,20年,25年,30年,40年\r\n' +
    'R8.10.1,1.668,1.939,2.077,2.274,2.407,2.534,2.657,2.82,2.952,3.092,3.62,3.91,4.154,4.122,4.125\r\n' +
    'R8.10.2,1.65,1.919,2.065,2.259,2.397,2.528,2.657,2.821,2.957,-,3.626,3.925,4.171,4.148,4.168\r\n' +
    ',,,,,,,,,,,,,,,\r\n';
  const r = s.parseMofCsv(csv);
  assert.deepStrictEqual(r.JGB10, [{ date: '2026-10-01', value: 3.092 }]); // '-' の日は飛ばす
  assert.deepStrictEqual(r.JGB20, [{ date: '2026-10-01', value: 3.91 }, { date: '2026-10-02', value: 3.925 }]);
  assert.throws(() => s.parseMofCsv('a,b\n1,2'));
}
console.log('eventSources(財務省): ok');
