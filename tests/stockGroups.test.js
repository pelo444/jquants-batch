'use strict';
// 銘柄グループ(src/web/stockGroups.js)の純粋関数。実行: node tests/stockGroups.test.js
const assert = require('assert');
const { _internal: g, MAX_NAME } = require('../src/web/stockGroups');

// 1. 前後の空白を取り、途中の連続した空白(全角含む)は1つにまとめる
assert.strictEqual(g.cleanName('  半導体　 装置 '), '半導体 装置');
// 2. 空・空白だけ・長すぎるものは 400
assert.throws(() => g.cleanName(''), (e) => e.status === 400);
assert.throws(() => g.cleanName(' 　 '), (e) => e.status === 400);
assert.throws(() => g.cleanName('あ'.repeat(MAX_NAME + 1)), (e) => e.status === 400);
assert.strictEqual(g.cleanName('あ'.repeat(MAX_NAME)).length, MAX_NAME);

console.log('stockGroups: ok');
