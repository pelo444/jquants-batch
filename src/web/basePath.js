'use strict';
/**
 * 公開パス（Java のコンテキストパスに相当）の扱い。
 *
 *   JQB_WEB_BASE_PATH=/stock  → アプリ全体を /stock 配下で動かす（例: https://example.com/stock/）
 *   未指定または空            → 従来どおりルート直下（例: http://127.0.0.1:3000/）
 *
 * 画面(HTML)は sendPage() で返す。返すときに
 *   1. href / src / action のルート相対パス（"/..."）の先頭に公開パスを付ける
 *   2. <head> の直後に window.BASE_PATH を埋め込む（画面のJSは fetch などでこれを付ける）
 * をしている。public/ 配下の HTML を express.static で直接返さないのはこのため。
 */
const fs = require('fs');
const path = require('path');

function normalizeBasePath(value) {
  if (value === undefined || value === null) return '';
  let s = String(value).trim();
  if (s === '' || s === '/') return '';
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

const BASE_PATH = normalizeBasePath(process.env.JQB_WEB_BASE_PATH);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USE_CACHE = process.env.NODE_ENV === 'production';
const pageCache = new Map();

function renderPage(name) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  if (BASE_PATH) {
    // "//host/..." のようなプロトコル相対は対象外
    html = html.replace(/(\s(?:href|src|action)=")\/(?!\/)/g, `$1${BASE_PATH}/`);
  }
  const tag = `<script>window.BASE_PATH = ${JSON.stringify(BASE_PATH)};</script>`;
  // <header> に一致しないよう、<head> または <head 属性...> だけを対象にする
  return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  ${tag}`);
}

/** public/ 配下の HTML を、公開パスを反映して返す */
function sendPage(res, name) {
  let html = USE_CACHE ? pageCache.get(name) : undefined;
  if (html === undefined) {
    html = renderPage(name);
    if (USE_CACHE) pageCache.set(name, html);
  }
  res.type('html').set('Cache-Control', 'no-cache').send(html);
}

/** public/ にある HTML ファイル名か（"/" は index.html） */
function pageNameFor(reqPath) {
  const name = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
  if (!/^[A-Za-z0-9_-]+\.html$/.test(name)) return null;
  return fs.existsSync(path.join(PUBLIC_DIR, name)) ? name : null;
}

module.exports = { BASE_PATH, normalizeBasePath, sendPage, pageNameFor };
