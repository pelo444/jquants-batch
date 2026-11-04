'use strict';
// 参考情報(/reference)の「保存した表」の一覧と読み込み
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../src/web/savedTables');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-'));
fs.writeFileSync(path.join(dir, 'a_old.json'), JSON.stringify({ title: '古い', savedAt: '2026-10-01', groups: [] }));
fs.writeFileSync(path.join(dir, 'b_new.json'), JSON.stringify({ title: '新しい', savedAt: '2026-11-04', groups: [] }));
fs.writeFileSync(path.join(dir, 'broken.json'), '{');
fs.writeFileSync(path.join(dir, 'memo.txt'), 'x');

const origErr = console.error;
console.error = () => {}; // 壊れたファイルのログは出さない
const list = s.listSaved(dir);
console.error = origErr;
assert.deepStrictEqual(list.map((x) => x.id), ['b_new', 'a_old']); // 新しい順。壊れたファイルと .json 以外は外す
assert.strictEqual(s.readSaved('b_new', dir).title, '新しい');
assert.strictEqual(s.readSaved('nothing', dir), null);
assert.strictEqual(s.readSaved('../b_new', dir), null); // フォルダの外は読まない
assert.deepStrictEqual(s.listSaved(path.join(dir, 'none')), []);

// 置いてある表は読める
for (const x of s.listSaved()) {
  const d = s.readSaved(x.id);
  assert.ok(Array.isArray(d.columns) && Array.isArray(d.groups), x.id);
}
fs.rmSync(dir, { recursive: true });
console.log('savedTables: ok');
