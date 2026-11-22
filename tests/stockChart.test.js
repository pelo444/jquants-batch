'use strict';
// 個別チャートの計算(src/web/stockChartQuery.js の調整、src/web/public/stockchartCalc.js)。実行: node tests/stockChart.test.js
const assert = require('assert');
const { _internal: q } = require('../src/web/stockChartQuery');
const C = require('../src/web/public/stockchartCalc');
const { _internal: watch } = require('../src/web/chartWatch');

// 1. 分割調整: 3/3 に 1:2 の分割(AdjFactor 0.5)。それより前の株価は半分、出来高は2倍。当日以降はそのまま
let d = q.adjustDaily([
  { d: '2026-03-02', o: 2000, h: 2100, l: 1980, c: 2040, v: 1000, af: 1 },
  { d: '2026-03-03', o: 1030, h: 1050, l: 1000, c: 1010, v: 2400, af: 0.5 },
  { d: '2026-03-04', o: 1010, h: 1020, l: 990, c: 1000, v: 2000, af: 1 },
]);
assert.deepStrictEqual(d.c, [1020, 1010, 1000]);
assert.deepStrictEqual(d.h, [1050, 1050, 1020]);
assert.deepStrictEqual(d.v, [2000, 2400, 2000]);
assert.deepStrictEqual(d.splits, [{ d: '2026-03-03', af: 0.5 }]);

// 2. 値が付かなかった日は足を作らない。その日の AdjFactor は累積に入れる
d = q.adjustDaily([
  { d: '2026-03-02', o: 2000, h: 2000, l: 2000, c: 2000, v: 100, af: 1 },
  { d: '2026-03-03', o: null, h: null, l: null, c: null, v: 0, af: 0.5 },
  { d: '2026-03-04', o: 1000, h: 1000, l: 1000, c: 1000, v: 100, af: 1 },
]);
assert.deepStrictEqual(d.d, ['2026-03-02', '2026-03-04']);
assert.deepStrictEqual(d.c, [1000, 1000]);

// 3. 信用残の株数も、申込日より後の分割でそろえる(分割日当日の申込分はそのまま)
let m = q.adjustMargin(
  [{ d: '2026-02-27', long: 1000, short: 10 }, { d: '2026-03-03', long: 2100, short: null }],
  [{ d: '2026-03-03', af: 0.5 }]);
assert.deepStrictEqual(m.long, [2000, 2100]);
assert.deepStrictEqual(m.short, [20, null]);

// 4. 決算発表日: 同じ日の開示は1つにまとめる。時刻は時:分まで
assert.deepStrictEqual(
  q.mergeEarnings([
    { d: '2026-05-14', time: '16:30:00', perType: 'FY' },
    { d: '2026-05-14', time: '16:30:00', perType: 'FY' },
    { d: '2026-08-10', time: '15:40:00', perType: '1Q' },
  ]),
  [{ d: '2026-05-14', time: '16:30', label: '本決算' }, { d: '2026-08-10', time: '15:40', label: '1Q' }]);

// 5. 週足・月足: 週は月曜始まり。高値・安値を付けた日を持つ
const day = {
  d: ['2026-10-30', '2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'],
  o: [2416, 2306, 2302, 2488, 1849, 2080],
  h: [2629, 2419, 2438, 2488, 2093, 2092],
  l: [2322, 2270, 2156, 2216, 1848, 1895],
  c: [2406, 2335, 2438, 2219, 2034, 1912],
  v: [10, 20, 30, 40, 50, 60],
};
let w = C.aggregate(day, 'w');
assert.deepStrictEqual(w.d, ['2026-10-30', '2026-11-06', '2026-11-09']);
assert.deepStrictEqual(w.d0, ['2026-10-30', '2026-11-02', '2026-11-09']);
assert.deepStrictEqual([w.o[1], w.h[1], w.l[1], w.c[1], w.v[1]], [2306, 2488, 1848, 2034, 140]);
assert.deepStrictEqual([w.hd[1], w.ld[1]], ['2026-11-05', '2026-11-06']);
let mo = C.aggregate(day, 'm');
assert.deepStrictEqual(mo.d, ['2026-10-30', '2026-11-09']);
assert.deepStrictEqual([mo.o[1], mo.h[1], mo.l[1], mo.c[1]], [2306, 2488, 1848, 1912]);
assert.strictEqual(C.weekKey('2026-11-08'), '2026-11-02'); // 日曜はその前の月曜の週

// 6. 移動平均: 本数が足りない位置は null
assert.deepStrictEqual(C.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);

// 7. 高安値: 前後 k 本の中でいちばん高い高値が山、いちばん低い安値が谷
{
  const h = [10, 12, 20, 13, 12, 14, 13, 12, 21, 15, 14];
  const l = [8, 10, 15, 11, 9, 12, 11, 10, 16, 12, 11];
  assert.deepStrictEqual(C.pivots(h, l, 0, h.length, 3).map((x) => x.type + x.i), ['L0', 'H2', 'L4', 'H8']);
}
// 山と山が続くところには、その間のいちばん低い安値を谷として入れる
// (位置4の安値 4.5 は、3本先の 3 があるので単独では谷にならない。山1と山5の間のいちばん低い安値として入る)
{
  const h = [5, 9, 6, 6, 6.5, 9.5, 7, 6, 6];
  const l = [4, 8, 5, 5, 4.5, 8.5, 6, 3, 5];
  assert.deepStrictEqual(C.pivots(h, l, 0, h.length, 3).map((x) => x.type + x.i), ['L0', 'H1', 'L4', 'H5', 'L7']);
}

// 8. 信用残を足に当てる: 週足では、その週の最後の申込日の値。足が無い日の申込分は直前の足
{
  const mg = C.attachMargin(w, { d: ['2026-10-30', '2026-11-04', '2026-11-06'], long: [1, 2, 3], short: [0, 0, 0] });
  assert.deepStrictEqual(mg.map((x) => [x.i, x.d, x.long]), [[0, '2026-10-30', 1], [1, '2026-11-06', 3]]);
  const dd = C.aggregate(day, 'd');
  const mg2 = C.attachMargin(dd, { d: ['2026-11-03'], long: [5], short: [1] }); // 11/3 は祝日で足が無い
  assert.deepStrictEqual(mg2.map((x) => [x.i, x.long]), [[1, 5]]);
}

// 9. 決算発表日を足に当てる: 営業日でない日の発表は次の足
{
  const dd = C.aggregate(day, 'd');
  const e = C.attachEarnings(dd, [{ d: '2026-11-03', label: '2Q' }, { d: '2026-11-06', label: '本決算' }]);
  assert.deepStrictEqual(e.map((x) => x.i), [2, 4]);
}

// 10. 軸の目盛り
assert.deepStrictEqual(C.niceTicks(1000, 4000, 4).ticks, [1000, 2000, 3000, 4000]);
assert.deepStrictEqual(C.niceTicks(0, 318, 2).ticks, [0, 200]);

// 11. ボリンジャーバンド: 中心は単純移動平均、幅は母標準偏差(len 個で割る)。本数が足りない位置は null
{
  const bb = C.bollinger([1, 2, 3, 4, 5, 6], 3);
  assert.deepStrictEqual(bb.mid, [null, null, 2, 3, 4, 5]);
  assert.strictEqual(bb.sd[1], null);
  assert.ok(Math.abs(bb.sd[2] - Math.sqrt(2 / 3)) < 1e-12); // [1,2,3] の母標準偏差
  // 値が動かない区間では幅が 0 になる
  const flat = C.bollinger([5, 5, 5, 5], 3);
  assert.strictEqual(flat.sd[3], 0);
}

// 12. 価格帯別出来高: 1日の出来高を安値〜高値に均等に配る。値幅0の日はその値段の帯に全部
{
  const dd = {
    d: ['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06'],
    h: [999, 120, 110, 999],
    l: [1, 100, 110, 1],
    v: [9, 200, 50, 9],
  };
  // 11/4〜11/5 の高値 120・安値 100 を 4 帯 → 帯の幅 5。帯は [100,105) [105,110) [110,115) [115,120]
  const vp = C.volumeProfile(dd, '2026-11-03', '2026-11-05', 4);
  assert.strictEqual(vp.step, 5);
  assert.deepStrictEqual([vp.from, vp.to, vp.days, vp.total], ['2026-11-04', '2026-11-05', 2, 250]);
  assert.deepStrictEqual(vp.bins.map((b) => [b.p0, b.p1]), [[100, 105], [105, 110], [110, 115], [115, 120]]);
  assert.deepStrictEqual(vp.bins.map((b) => b.v), [50, 50, 100, 50]);
  // 帯の境目は幅の倍数にそろう(安値 101 → 最初の帯は 100 から)。配った合計は出来高の合計と同じ
  const vp2 = C.volumeProfile({ d: ['2026-11-04'], h: [119], l: [101], v: [90] }, '2026-11-04', '2026-11-04', 4);
  assert.strictEqual(vp2.bins[0].p0, 100);
  assert.ok(Math.abs(vp2.bins.reduce((a, b) => a + b.v, 0) - 90) < 1e-9);
  // 期間に日が無ければ null
  assert.strictEqual(C.volumeProfile(dd, '2026-11-07', '2026-11-10', 4), null);
  // 高値 = 安値 の日しかない期間でも帯を1つ以上作る
  const vp3 = C.volumeProfile({ d: ['2026-11-04'], h: [500], l: [500], v: [10] }, '2026-11-04', '2026-11-04', 30);
  assert.strictEqual(vp3.bins.reduce((a, b) => a + b.v, 0), 10);
}

// 13. 調査対象: 貼り付けた文字列からコードを取り出す。4桁は5桁に、同じコードは1つ、読めないものは bad
assert.deepStrictEqual(watch.parseCodes('6613, 5033\n285a\t66130 12 abcde'),
  { codes: ['66130', '50330', '285A0'], bad: ['12', 'abcde'] });
assert.deepStrictEqual(watch.parseCodes(['6613', '7203']).codes, ['66130', '72030']);
assert.deepStrictEqual(watch.parseCodes('').codes, []);

console.log('stockChart.test.js: すべて通過');
