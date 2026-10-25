'use strict';
// 信用残の要確認の判定(src/web/marginCheck.js)。実行: node tests/marginCheck.test.js
const assert = require('assert');
const { classify } = require('../src/web/marginCheck');

// 2026-10 の実データ(全銘柄の買残・売残の合計、百万株)
const real = [
  { d: '2026-10-15', lv: 3794.9, sv: 362.9 },
  { d: '2026-10-16', lv: 3731.9, sv: 366.3 },
  { d: '2026-10-19', lv: 3723.8, sv: 368.7 },
  { d: '2026-10-20', lv: 2691.6, sv: 301.4 },
];
const topix = new Map([['2026-10-19', 4067.48], ['2026-10-20', 4009.21], ['2026-10-21', 4043.73]]);

// 1. 10/20 の急減は jump。文言に買残・売残・TOPIX の変化が入る
let r = classify(real, topix);
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].kind, 'jump');
assert.strictEqual(r[0].date, '2026-10-20');
assert.ok(/−27\.7%/.test(r[0].text) && /売残 −18\.3%/.test(r[0].text) && /TOPIX −1\.4%/.test(r[0].text), r[0].text);

// 2. 翌日に元の水準へ戻ったら、その日は back(値は正常、前回比は使えない)
r = classify(real.concat([{ d: '2026-10-21', lv: 3720, sv: 370 }]), topix);
assert.deepStrictEqual(r.map((x) => x.kind + ' ' + x.date), ['jump 2026-10-20', 'back 2026-10-21']);

// 3. 翌日も同じ水準のままなら印は 10/20 だけ
r = classify(real.concat([{ d: '2026-10-21', lv: 2700, sv: 300 }]), topix);
assert.deepStrictEqual(r.map((x) => x.kind + ' ' + x.date), ['jump 2026-10-20']);

// 4. 売残だけ大きく動いた日(権利付き最終日前後の優待クロス)は点灯しない。2026/9/28→9/29 の実データ
r = classify([{ d: '2026-09-28', lv: 3499.5, sv: 716.4 }, { d: '2026-09-29', lv: 3660.2, sv: 380.2 }], new Map());
assert.strictEqual(r.length, 0);

// 5. 境目: 9.9% は点灯しない、10% は点灯する。TOPIX が無ければ文言は —
assert.strictEqual(classify([{ d: 'a', lv: 1000, sv: 1 }, { d: 'b', lv: 901, sv: 1 }], new Map()).length, 0);
r = classify([{ d: '2026-01-05', lv: 1000, sv: 1 }, { d: '2026-01-06', lv: 900, sv: 1 }], new Map());
assert.strictEqual(r.length, 1);
assert.ok(/TOPIX —%/.test(r[0].text), r[0].text);

// 6. 前回が 0 や欠けている日は判定しない(割り算できない)
assert.strictEqual(classify([{ d: 'a', lv: 0, sv: 0 }, { d: 'b', lv: 100, sv: 1 }], new Map()).length, 0);

console.log('marginCheck: all passed');
