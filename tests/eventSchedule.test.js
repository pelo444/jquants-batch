'use strict';
// 材料(/events)の取得元の更新の時刻: 日本時間への換算(夏時間・冬時間)と、画面の表の行
const assert = require('assert');
const sc = require('../src/eventSchedule');
const q = require('../src/web/eventsQuery');

const get = (key) => sc.SCHEDULE.find((x) => x.key === key);

// 米国の夏時間(10/26)と冬時間(11/2、2026年は 11/1 に切り替わる)
assert.deepStrictEqual(sc.describe(get('DGS2'), '2026-10-26'), { original: '翌営業日 15:16(米中部)', jst: '翌々日 5:16頃' });
assert.deepStrictEqual(sc.describe(get('DGS2'), '2026-11-02'), { original: '翌営業日 15:16(米中部)', jst: '翌々日 6:16頃' });
assert.strictEqual(sc.describe(get('HY'), '2026-11-02').jst, '翌日 23:34頃');
assert.strictEqual(sc.describe(get('CPI'), '2026-11-10').jst, '当日 22:30頃');
assert.strictEqual(sc.describe(get('JGB'), '2026-11-02').jst, '翌日 9:30頃');
assert.deepStrictEqual(sc.describe(get('FX'), '2026-11-02'), { original: '24時間', jst: '—' });
assert.strictEqual(sc.describe(get('SEC'), '2026-11-02').original, '随時');

// 夏時間の切り替わりの日の換算
assert.strictEqual(sc.wallToInstant('2026-11-01', '12:00', 'America/New_York'), Date.parse('2026-11-01T17:00:00Z'));
assert.strictEqual(sc.wallToInstant('2026-10-31', '12:00', 'America/New_York'), Date.parse('2026-10-31T16:00:00Z'));

// 引けの時刻: 当日に出るものだけ
assert.deepStrictEqual(sc.closeOf('^SOX'), { tz: 'America/New_York', time: '16:00' });
assert.deepStrictEqual(sc.closeOf('CL=F'), { tz: 'America/New_York', time: '17:00', reopen: '18:00' });
assert.strictEqual(sc.closeOf('JPY=X'), null);
assert.strictEqual(sc.closeOf('DGS10'), null);

// すべての系列(CPI 以外の画面の列)が、どこかの行に入っている
for (const c of q.COLUMNS) assert.ok(sc.SCHEDULE.some((x) => x.codes.includes(c.code)), c.code);

// 画面の表の行: まとめた行は最新の日付が古い方。時刻が無ければ null
{
  const rows = q.buildSchedule({
    series: {
      DGS2: { date: '2026-10-22', firstLoadedAt: '2026-10-23 21:00' },
      DGS10: { date: '2026-10-21', firstLoadedAt: null },
      'CL=F': { date: '2026-10-23', firstLoadedAt: '2026-10-23 22:00' },
    },
    cpiRelease: { date: '2026-10-14', firstLoadedAt: '2026-10-14 23:00' },
    filing: null,
    tokyo: { date: '2026-10-23', firstLoadedAt: null },
  }, '2026-10-26');
  assert.strictEqual(rows.length, sc.SCHEDULE.length);
  assert.deepStrictEqual(rows.map((r) => r.no).slice(0, 3), [1, 2, 3]);
  const r1 = rows.find((r) => r.label === '米2年・10年金利');
  assert.strictEqual(r1.latestDate, '2026-10-21');
  assert.strictEqual(r1.firstLoadedAt, null);
  assert.strictEqual(rows.find((r) => r.label === 'WTI・ブレント先物').latestDate, '2026-10-23'); // 片方が DB に無いときはある方
}
console.log('eventSchedule: ok');
