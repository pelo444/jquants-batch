'use strict';
const assert = require('assert');
const { parseRakutenCsv, stableContent } = require('../src/web/journalCsv');

// 楽天「取引履歴(国内株式)」CSVの見出し(実ファイルの列から必要な分)
const HEAD = '"約定日","受渡日","銘柄コード","銘柄名","市場名称","口座区分","取引区分","売買区分","信用区分","弁済期限",' +
  '"数量［株］","単価［円］","手数料［円］","税金等［円］","諸費用［円］","税区分","受渡金額［円］"';
const row = (amount, price = '893.0') =>
  `"2026/10/6","2026/10/8","5246","ＥＬＥＭＥＮＴＳ","市場外","NISA成長投資枠","現物(単元未満)","買付","-","-",` +
  `"40","${price}","0","0","0","-","${amount}"`;
const csv = (...rows) => Buffer.from([HEAD, ...rows].join('\r\n'), 'utf8');

// 1. 受渡日前(受渡金額「-」)と受渡後(金額あり)の同じ約定は、同じキーになる(2026-10-29 の二重取込)
const before = parseRakutenCsv(csv(row('-'))).trades[0];
const after = parseRakutenCsv(csv(row('35,720'))).trades[0];
assert.strictEqual(before.settleAmount, null);
assert.strictEqual(after.settleAmount, 35720);
assert.strictEqual(before.dedupKey, after.dedupKey);
assert.ok(after.dedupKey.startsWith('RK2:'));
assert.ok(after.dedupKey.endsWith('#1'));

// 2. 同じ日に同じ内容の約定が2件あれば #1 と #2 で区別する
const two = parseRakutenCsv(csv(row('35,720'), row('35,720'))).trades;
assert.strictEqual(two.length, 2);
assert.ok(two[0].dedupKey.endsWith('#1'));
assert.ok(two[1].dedupKey.endsWith('#2'));
assert.strictEqual(two[0].dedupKey, after.dedupKey);

// 3. 単価が違えば別の約定
const other = parseRakutenCsv(csv(row('35,760', '894.0'))).trades[0];
assert.notStrictEqual(other.dedupKey, after.dedupKey);

// 4. DBの行から作った内容(rekey-journal-trades.js の形)と、CSVから作った内容が一致する
const fromDb = stableContent({
  tradeDate: '2026-10-06', code: '52460', accountType: 'NISA成長投資枠', tradeType: '現物(単元未満)',
  sideRaw: '買付', marginType: '-', qty: 40, price: 893,
});
assert.strictEqual(fromDb, stableContent(after));

// 5. 空文字と null は同じに扱う(DBは空文字を NULL で保存する)
assert.strictEqual(
  stableContent({ ...after, accountType: '' }),
  stableContent({ ...after, accountType: null })
);

console.log('journalCsv: all tests passed');
