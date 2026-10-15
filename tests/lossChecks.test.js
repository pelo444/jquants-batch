'use strict';
const assert = require('assert');
const lc = require('../src/lossChecks');

// 合成データ: 平日のみ、毎日 +0.1%、分割なし
function synth(n, f = (i) => 100 * Math.pow(1.001, i), vol = () => 1000) {
  const out = [];
  const d = new Date(Date.UTC(2025, 0, 6));
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const p = f(i);
    out.push({ date: d.toISOString().slice(0, 10), close: p, adjc: p, af: 1, vol: vol(i) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// normalizeCode
assert.strictEqual(lc.normalizeCode('6861'), '68610');
assert.strictEqual(lc.normalizeCode('68610'), '68610');
assert.strictEqual(lc.normalizeCode('285A'), '285A0');
assert.throws(() => lc.normalizeCode('12'));

// stdev (標本)
assert.ok(Math.abs(lc.stdev([1, 2, 3, 4]) - 1.2909944) < 1e-6);

// weekKey は月曜
assert.strictEqual(lc.weekKey('2026-09-16'), '2026-09-14');
assert.strictEqual(lc.weekKey('2026-09-13'), '2026-09-07');

// 一定の上昇: 週次リターンがほぼ一定 → vol13 ≈ 0、dd250 = 0
let m = lc.computeMetrics(synth(300));
assert.ok(m.vol13 < 0.01, 'vol13 const growth');
assert.strictEqual(m.dd250, 0);
assert.ok(m.ret13w > 0);

// 下落: 最終日に高値から -20%
const s = synth(300);
const hiPrev = Math.max(...s.slice(0, -1).map((r) => r.adjc));
s[s.length - 1].adjc = s[s.length - 1].close = hiPrev * 0.8;
m = lc.computeMetrics(s);
assert.ok(Math.abs(m.dd250 + 20) < 1e-9);

// 週次ボラ: 週ごとに +5% / -5% 交互 → 手計算と一致
const alt = [];
{
  const d = new Date(Date.UTC(2025, 0, 6)); // 月曜
  let p = 100;
  for (let w = 0; w < 30; w++) {
    p *= w % 2 ? 0.95 : 1.05;
    const dt = new Date(d.getTime() + w * 7 * 86400000 + 4 * 86400000); // 金曜
    alt.push({ date: dt.toISOString().slice(0, 10), close: p, adjc: p, af: 1, vol: 1000 });
  }
}
m = lc.computeMetrics(alt);
const rets = [];
for (let i = alt.length - 13; i < alt.length; i++) rets.push(alt[i].adjc / alt[i - 1].adjc - 1);
assert.ok(Math.abs(m.vol13 - lc.stdev(rets) * 100) < 1e-9);

// asOf で切る
const a2 = lc.computeMetrics(synth(300), synth(300)[200].date);
assert.strictEqual(a2.asOf, synth(300)[200].date);

// 出来高ブレイク
const vb = synth(100, (i) => (i < 95 ? 100 : 100 * Math.pow(1.01, i - 94)), (i) => (i >= 95 ? 5000 : 1000));
m = lc.computeMetrics(vb);
assert.ok(m.vbu.available && m.vbu.flag, JSON.stringify(m.vbu));
m = lc.computeMetrics(synth(100));
assert.ok(m.vbu.available && !m.vbu.flag);

// nearestBand
assert.strictEqual(lc.nearestBand(3.5).band, 'D1');
assert.strictEqual(lc.nearestBand(10).band, 'D10');

// sizing: 重み合計 1、ボラが2倍なら重みは半分
const sz = lc.sizing([{ code: 'a', vol13: 2 }, { code: 'b', vol13: 4 }], 3000000);
assert.ok(Math.abs(sz[0].weight + sz[1].weight - 1) < 1e-12);
assert.ok(Math.abs(sz[0].weight / sz[1].weight - 2) < 1e-12);
assert.strictEqual(Math.round(sz[0].yen), 2000000);
assert.strictEqual(Math.round(sz[0].swingYen), 40000);

// stopInfo
const si = lc.stopInfo({ buy: 1000, stopPcts: [10, 15], vol13: 5, amount: 1000000 });
assert.strictEqual(si[1].stopPrice, 850);
assert.strictEqual(si[0].widthInVolWeeks, 2);
assert.strictEqual(si[0].lossYen, 100000);

// revision: テルモ 2026-10-08 の実データ → REV −7.93
const r = lc.revisionFromRow({ discDate: '2026-10-08', docType: 'EarnForecastRevision', fyEnd: '2027-03-31', fOp: 160000000000, fSales: 1229500000000, prevOp: 257500000000 });
assert.ok(Math.abs(r.rev + 7.93) < 0.01 && r.kind === 'DOWN' && r.verified);
assert.strictEqual(lc.revisionFromRow({ docType: '1QFinancialStatements', fOp: 1, fSales: 1, prevOp: null }).kind, null);
assert.strictEqual(lc.revisionFromRow({ docType: 'EarnForecastRevision', fOp: 100.5, fSales: 100, prevOp: 100 }).kind, 'SMALL');

// buildReport / formatReport が通り、Ch1〜Ch10 が揃う
const rep = lc.buildReport({
  code: '99990', name: 'テスト', metrics: lc.computeMetrics(s),
  revisions: [r], pastExits: [], capital: { current: { amount: 1e7, effectiveDate: '2026-10-01' }, netInvested: 4.5e6, unused: 5.5e6,
    flows: { buyTotal: 7e6, sellTotal: 2.5e6, firstTradeDate: '2026-07-01', lastTradeDate: '2026-10-01' } },
  topix: { ret13w: 3, dd250: -2 }, held: { held: 10, semi: 2 }, isSemi: true,
  opts: { amount: 3e6, buy: null, stopPcts: [10, 15], swing: 1e5, with: [{ code: 'x', vol13: 3 }], days: 30 },
});
assert.deepStrictEqual(rep.items.map((x) => x.id), ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Ch7', 'Ch8', 'Ch9', 'Ch10']);
assert.strictEqual(rep.items[3].status, '要確認');
assert.ok(rep.items[8].auto.some((x) => x.includes('まだ使っていない元手: 550.0万円')));
const txt = lc.formatReport(rep);
assert.ok(txt.includes('■ Ch10'));
console.log('OK', txt.split('\n').length, 'lines');
