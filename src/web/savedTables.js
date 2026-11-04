'use strict';
/**
 * 参考情報(/reference)の「保存した表」。
 *
 *   src/web/saved/<id>.json を1枚の表として出す。中身はその日に作った表をそのまま残したもので、DB は見ない。
 *   ファイルを置けばプルダウンに出る(一覧は毎回フォルダを読む。サーバーの再起動は要らない)。
 *
 * ファイルの形:
 *   {
 *     "title":     "プルダウンと見出しに出す名前",
 *     "savedAt":   "YYYY-MM-DD"(一覧はこの新しい順),
 *     "condition": "見出しの横に出す条件(任意)",
 *     "columns":   [{ "key": "code", "label": "コード", "type": "code" }, ...],
 *                  type: code(4桁にして株予報Proへのリンク) / name / text / dim / pct(%の値。符号と色を付ける) / num0 / num1 / num2
 *     "groups":    [{ "name": "まとまりの名前", "stats": [{ "label": "業種指数 安値", "pct": -6.03 }, { "label": "戻り率", "num": 0.62 }], "rows": [{...}] }],
 *     "note":      "表の下に出す説明(任意)"
 *   }
 */
const fs = require('fs');
const path = require('path');

const SAVED_DIR = path.join(__dirname, 'saved');
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 一覧: [{ id, title, savedAt }]。savedAt の新しい順、同じ日は id の順(_a, _b, _c …) */
function listSaved(dir = SAVED_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try {
      const j = readJson(path.join(dir, f));
      out.push({ id, title: String(j.title || id), savedAt: j.savedAt || '' });
    } catch (err) {
      console.error(`保存した表を読めませんでした: ${f}: ${err.message}`);
    }
  }
  return out.sort((a, b) => (a.savedAt === b.savedAt ? (a.id < b.id ? -1 : 1) : a.savedAt < b.savedAt ? 1 : -1));
}

/** 1枚分。無ければ null */
function readSaved(id, dir = SAVED_DIR) {
  if (!ID_RE.test(String(id))) return null;
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return { id, ...readJson(file) };
}

module.exports = { SAVED_DIR, ID_RE, listSaved, readSaved };
