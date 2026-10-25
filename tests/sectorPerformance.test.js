'use strict';
// 33業種のグラフの整形(src/web/webQuery.js shapeSectorPerformance)。実行: node tests/sectorPerformance.test.js
const assert = require('assert');
const { shapeSectorPerformance } = require('../src/web/webQuery');

const out = shapeSectorPerformance([
  ['0000', 'TOPIX', '2026-09-24', '2026-10-23', 4075.3, 3965.81],
  ['004C', '東証業種別 非鉄金属', '2026-09-24', '2026-10-23', 5582.01, 4598.24],
  ['0060', '東証業種別 サービス業', '2026-09-24', '2026-10-23', 4352.07, 4851.08],
  ['0047', '東証業種別 医薬品', '2026-10-23', '2026-10-23', 4232.93, 4232.93],
  ['0041', '東証業種別 鉱業', '2026-09-24', '2026-10-23', 100, 101],
  ['0040', '東証業種別 水産・農林業', '2026-09-24', '2026-10-23', 200, 202],
]);
// 1. TOPIX は分けて返す(実データと同じ -2.69%)
assert.strictEqual(out.topix.changePct, -2.69);
assert.strictEqual(out.sectors.length, 5);
// 2. 名前から「東証業種別 」を除く
assert.strictEqual(out.sectors[0].name, 'サービス業');
// 3. 高い順。同じ騰落率は指数コード順。営業日1日だけ(騰落率なし)は末尾
assert.deepStrictEqual(out.sectors.map((x) => x.code), ['0060', '0040', '0041', '004C', '0047']);
assert.strictEqual(out.sectors[0].changePct, 11.47);
assert.strictEqual(out.sectors[3].changePct, -17.62);
assert.strictEqual(out.sectors[4].changePct, null);
// 4. 銘柄の中央値を業種名で付ける(銘柄マスタの半角「･」と指数名の全角「・」をそろえる)。無い業種は null
const withMed = shapeSectorPerformance([
  ['0053', '東証業種別 電気・ガス業', '2026-04-23', '2026-10-23', 100, 110],
  ['0060', '東証業種別 サービス業', '2026-04-23', '2026-10-23', 100, 166.38],
  ['0041', '東証業種別 鉱業', '2026-04-23', '2026-10-23', 100, 90],
], [['電気･ガス業', 27, -3.4216, 12], ['サービス業', 522, -1.99, 224]]);
const by = Object.fromEntries(withMed.sectors.map((x) => [x.code, x]));
assert.strictEqual(by['0053'].medianPct, -3.42);
assert.strictEqual(by['0053'].stockCount, 27);
assert.strictEqual(by['0060'].medianPct, -1.99);
assert.strictEqual(by['0060'].upCount, 224);
assert.strictEqual(by['0041'].medianPct, null);
assert.strictEqual(by['0041'].stockCount, 0);
// 5. 行が無ければ空
assert.deepStrictEqual(shapeSectorPerformance([]), { topix: null, sectors: [] });
console.log('sectorPerformance.test.js: ok');
