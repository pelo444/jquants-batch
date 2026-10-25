'use strict';
// 参考情報(/reference)の業種のテーマの組み立て(純粋関数)
const assert = require('assert');
const q = require('../src/web/referenceQuery');

const theme = q.THEMES.find((t) => t.key === 'down_up_sectors');
const secChg = new Map([['医薬品', 1.02], ['電気・ガス業', 0.28], ['銀行業', -4.33]]);
const stocks = [
  // [業種コード, 業種名(マスタは半角の中黒), コード, 名前, 前日比%, 終値, 売買代金]
  ['3250', '医薬品', '45680', '第一三共', 2.19, 3000, 163.5e8],
  ['3250', '医薬品', '130A0', 'Veritas', 23.67, 500, 0.5e8], // 売買代金が下限未満
  ['3250', '医薬品', '45020', '武田', 1.0, 4000, 300e8],
  ['3250', '医薬品', '45070', '塩野義', -0.5, 2500, 80e8],
  ['4050', '電気･ガス業', '95030', '関西電力', 1.23, 2000, 84.2e8],
  ['7050', '銀行業', '83060', '三菱UFJ', -3.7, 1800, 2000e8],
];
const t = q.buildSectorTable(theme, { day: '2026-10-20', prev: '2026-10-19', topixChg: -1.43, secChg, stocks, n: 5, minTv: 1 });
assert.deepStrictEqual(t.groups.map((g) => g.name), ['医薬品', '電気・ガス業']); // 上がった業種だけ、上昇率の順
assert.deepStrictEqual(t.groups[0].stocks.map((s) => s.code), ['45680', '45020']); // 下限未満と下げた銘柄は外す
assert.strictEqual(t.groups[0].up, 3); // 業種内の上昇・下落は下限に関係なく数える
assert.strictEqual(t.groups[0].down, 1);
assert.strictEqual(t.groups[1].stocks[0].code, '95030'); // 半角の中黒をそろえて突き合わせる
assert.deepStrictEqual(t.notice, []);

// TOPIX が上げた日に「下げた日のテーマ」を選んだら知らせる
const t2 = q.buildSectorTable(theme, { day: 'd', prev: 'p', topixChg: 0.5, secChg, stocks, n: 1, minTv: 0 });
assert.strictEqual(t2.groups[0].stocks.length, 1);
assert.strictEqual(t2.groups[0].stocks[0].code, '130A0'); // 下限0なら小型株が先頭
assert.strictEqual(t2.notice.length, 1);

// 逆のテーマ: 上げた日に下がった業種の値下がり上位
const up = q.THEMES.find((x) => x.key === 'up_down_sectors');
const t3 = q.buildSectorTable(up, { day: 'd', prev: 'p', topixChg: 1.0, secChg, stocks, n: 5, minTv: 1 });
assert.deepStrictEqual(t3.groups.map((g) => g.name), ['銀行業']);
assert.strictEqual(t3.groups[0].stocks[0].code, '83060');
console.log('referenceQuery: ok');
