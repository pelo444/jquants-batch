'use strict';
const assert = require('assert');
const { computePositions, valuePosition, realizedByTrade, pnlByCode } = require('../src/web/journalPositions');

// 約定の最小形(現物・特定口座)
let id = 0;
const t = (tradeDate, code, effect, qty, price, extra = {}) => ({
  tradeId: ++id, tradeDate, code, name: code, accountType: '特定', positionKind: 'CASH', positionEffect: effect,
  qty, price, fee: 0, tax: 0, otherCost: 0, settleAmount: null, ...extra,
});

// 1. 100株を1000円で買い、40株を1200円で売り、残り60株の終値が900円
const trades = [
  t('2026-08-17', '11110', 'OPEN', 100, 1000),
  t('2026-09-10', '11110', 'CLOSE', 40, 1200),
  t('2026-08-20', '22220', 'OPEN', 10, 500),
];
const book = computePositions(trades);
const sold = realizedByTrade(book.realized);
assert.strictEqual(sold.size, 1);
assert.strictEqual(sold.get(2).pnl, 8000);            // (1200 − 1000) × 40
assert.strictEqual(Math.round(sold.get(2).pnlPct * 10) / 10, 20);
assert.strictEqual(sold.get(1), undefined);           // 買いの約定には付かない

const quotes = new Map([['11110', { date: '2026-11-13', close: 900 }]]);
const m = pnlByCode(book.positions, quotes, book.realized);
const a = m.get('11110');
assert.strictEqual(a.held.pnl, -6000);                // (900 − 1000) × 60
assert.strictEqual(Math.round(a.held.pnlPct * 10) / 10, -10);
assert.strictEqual(a.held.closeDate, '2026-11-13');
assert.strictEqual(a.sells.length, 1);
assert.strictEqual(a.realizedTotal, 8000);

// 2. 終値が無い保有は、含み損益を出さない(null)
const b = m.get('22220');
assert.strictEqual(b.held.pnl, null);
assert.strictEqual(b.held.pnlPct, null);
assert.strictEqual(b.sells.length, 0);

// 3. 履歴が足りない売り(持っていない株を売った)は損益不明として数える
const short = computePositions([t('2026-10-01', '33330', 'CLOSE', 10, 700)]);
const u = pnlByCode(short.positions, new Map(), short.realized).get('33330');
assert.strictEqual(u.held, null);
assert.strictEqual(u.sells[0].pnl, null);
assert.strictEqual(u.realizedUnknown, 1);
assert.strictEqual(u.realizedTotal, 0);

// 4. 売りは新しい順
const two = computePositions([
  t('2026-08-01', '44440', 'OPEN', 30, 100),
  t('2026-09-01', '44440', 'CLOSE', 10, 110),
  t('2026-10-01', '44440', 'CLOSE', 10, 90),
]);
const s = pnlByCode(two.positions, new Map(), two.realized).get('44440').sells;
assert.deepStrictEqual(s.map((x) => x.tradeDate), ['2026-10-01', '2026-09-01']);
assert.deepStrictEqual(s.map((x) => x.pnl), [-100, 100]);

// 5. 信用売りの評価: 損益 = (平均単価 − 終値) × 数量、評価額は出さない
const v = valuePosition({ kind: 'MSHORT', qty: 100, avgCost: 500, cost: 50000 }, 450);
assert.deepStrictEqual(v, { value: null, pnl: 5000, pnlPct: 10 });
assert.deepStrictEqual(valuePosition({ kind: 'CASH', qty: 1, avgCost: 1, cost: 1 }, null), { value: null, pnl: null, pnlPct: null });

console.log('journalPositions.test.js: ok');
