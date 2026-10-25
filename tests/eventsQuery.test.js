'use strict';
const assert = require('assert');
const q = require('../src/web/eventsQuery');

assert.deepStrictEqual(q.resolvePeriod({}, '2026-10'), { from: '2026-08', to: '2026-10' });
assert.deepStrictEqual(q.resolvePeriod({ from: '2026-10', to: '2026-07' }, '2026-10'), { from: '2026-07', to: '2026-10' });
assert.deepStrictEqual(q.resolvePeriod({ from: 'x' }, '2026-01'), { from: '2025-11', to: '2026-01' });
assert.strictEqual(q.monthLast('2026-02'), '2026-02-28');

const data = {
  series: [
    { code: 'DGS10', date: '2026-09-30', value: 5.29 },
    { code: 'DGS10', date: '2026-10-01', value: 5.24 },
    { code: 'CL=F', date: '2026-10-01', value: 92.87 },
    { code: 'CL=F', date: '2026-10-02', value: 91.11 },
    { code: '^VIX', date: '2026-10-01', value: 18.5 },
    { code: '^VIX', date: '2026-10-02', value: 21.25 },
    { code: 'CPIAUCSL', date: '2025-09-01', value: 324.245 },
    { code: 'CPIAUCSL', date: '2026-08-01', value: 334.131 },
    { code: 'CPIAUCSL', date: '2026-09-01', value: 336.298 },
  ],
  releases: [{ code: 'CPIAUCSL', releaseDate: '2026-10-14', refPeriod: '2026-09-01' }],
  tokyoDays: ['2026-10-14', '2026-10-15'],
  filings: [{ ticker: 'TSM', date: '2026-10-15', form: '6-K', url: 'f1' }],
};
const cal = q.buildCalendar({ from: '2026-09', to: '2026-10' }, data);
assert.deepStrictEqual(cal.months.map((m) => m.ym), ['2026-10', '2026-09']);
const octDesc = cal.months[0].days;
assert.strictEqual(octDesc[0].date, '2026-10-31'); // 新しい日が上
const oct = octDesc.slice().reverse(); // 以下は 1日から順に見る
assert.strictEqual(oct.length, 31);
const d1 = oct[0];
const i10 = q.COLUMNS.findIndex((c) => c.code === 'DGS10');
assert.strictEqual(d1.values[i10].v, 5.24);
assert.ok(Math.abs(d1.values[i10].chg - -5) < 1e-9); // 9/30 → 10/1 の差 = −5bp
const iwti = q.COLUMNS.findIndex((c) => c.code === 'CL=F');
assert.strictEqual(d1.values[iwti].chg, null); // 前のデータが無い
assert.ok(Math.abs(oct[1].values[iwti].chg - (91.11 / 92.87 - 1) * 100) < 1e-9);
assert.strictEqual(oct[3].weekend, true); // 10/4 は日曜
const cpi = oct[13].cpi;
assert.strictEqual(cpi.refMonth, 9);
assert.ok(Math.abs(cpi.yoy - 3.7174) < 1e-3);
assert.ok(Math.abs(cpi.mom - 0.6486) < 1e-3);
assert.deepStrictEqual(oct[13].notes.map((n) => n.url), ['https://tbladvisory.com/20261014nk/']);
assert.deepStrictEqual(oct[14].notes.map((n) => n.kind), ['recap', 'filing']); // 概況 → 決算
assert.deepStrictEqual(oct[15].notes, []);
const ivix = q.COLUMNS.findIndex((c) => c.code === '^VIX');
assert.ok(Math.abs(oct[1].values[ivix].chg - 2.75) < 1e-9); // VIX はポイントの差
console.log('eventsQuery: ok');
// 今日より先の日は出さない
{
  const days = q.buildCalendar({ from: '2026-10', to: '2026-10' }, data, '2026-10-19').months[0].days;
  assert.strictEqual(days.length, 19);
  assert.strictEqual(days[0].date, '2026-10-19');
}
console.log('eventsQuery(今日まで): ok');
