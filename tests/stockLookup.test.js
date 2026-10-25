'use strict';
// 企業名から銘柄コードを引く(src/web/stockLookup.js)。実行: node tests/stockLookup.test.js
const assert = require('assert');
const { normalize, buildIndex, search } = require('../src/web/stockLookup');

const idx = buildIndex([
  { code: '67580', name: 'ソニーグループ', nameEn: 'SONY GROUP CORPORATION', market: 'プライム' },
  { code: '72030', name: 'トヨタ自動車', nameEn: 'TOYOTA MOTOR CORPORATION', market: 'プライム' },
  { code: '62010', name: '豊田自動織機', nameEn: 'TOYOTA INDUSTRIES CORPORATION', market: 'プライム' },
  { code: '83060', name: '三菱ＵＦＪフィナンシャル・グループ', nameEn: 'Mitsubishi UFJ Financial Group,Inc.', market: 'プライム' },
  { code: '285A0', name: 'キオクシアホールディングス', nameEn: 'Kioxia Holdings Corporation', market: 'プライム' },
  { code: '99840', name: 'ソフトバンクグループ', nameEn: 'SoftBank Group Corp.', market: 'プライム' },
]);
const codes = (q) => search(idx, q).items.map((x) => x.shortCode);

// 1. カタカナ・ひらがな・半角カナのどれでも当たる
assert.deepStrictEqual(codes('トヨタ'), ['7203']);
assert.deepStrictEqual(codes('とよた'), ['7203']);
assert.deepStrictEqual(codes('ﾄﾖﾀ'), ['7203']);
// 2. 英語名にも当たる。会社名に当たったものが先
assert.deepStrictEqual(codes('toyota'), ['6201', '7203']);
// 3. 全角英字・「・」の有無を吸収
assert.deepStrictEqual(codes('ufj'), ['8306']);
assert.deepStrictEqual(codes('UFJフィナンシャルグループ'), ['8306']);
// 4. 前方一致が途中一致より先(「ソ」で始まる2社 → 途中に「ソ」がある社)
assert.deepStrictEqual(codes('ソ'), ['6758', '9984']);
assert.deepStrictEqual(codes('グループ'), ['6758', '8306', '9984']);
// 5. コードの前方一致が先頭。英字入りのコードも当たる
assert.deepStrictEqual(codes('72'), ['7203']);
assert.deepStrictEqual(codes('285a'), ['285A']);
// 6. 空・空白だけは0件
assert.deepStrictEqual(search(idx, '  ').items, []);
// 7. total は一致件数、items は上限まで
const r = search(idx, 'o', 2);
assert.strictEqual(r.items.length, 2);
assert.ok(r.total > 2);
// 8. normalize
assert.strictEqual(normalize('ＴＯＹＯＴＡ　ﾓｰﾀｰ'), 'toyotaもーたー');

console.log('stockLookup: all tests passed');
