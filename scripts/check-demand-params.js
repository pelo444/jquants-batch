#!/usr/bin/env node
'use strict';

/**
 * 需給3階層のしきい値が、SQLファイルとWebアプリでずれていないかを検査する。
 *
 * 【なぜ要るか】
 *   同じ判定ロジックが queries/sql/demand_*.sql(較正・ad hoc 用)と
 *   src/web/demandQuery.js(日々の運用)の2箇所にある。
 *   「同じテーブルを同じ意味で読むのだから、読み方が食い違っていること自体がバグ」
 *   (docs/DEMAND_SIGNAL_RUNBOOK.md)という原則を、人の注意力ではなく機械で守るための道具。
 *
 *   実際にこのプロジェクトでは、第三階層が第二階層の調整に9件取り残されたことがある
 *   (2026-09-14)。取り残しは「エラーにならない」ので、流し続けても気づけない。
 *
 * 【使い方】
 *   node scripts/check-demand-params.js
 *   しきい値を動かしたら必ず両方を直して、これを流す。DBには接続しない。
 *
 * 【限界】
 *   検査できるのは params CTE に数値リテラルで書かれた「しきい値」だけ。
 *   判定式そのもの(どの列をどう比べるか)がずれていても、これでは分からない。
 *   ロジックを変えたときは両方のファイルを目で突き合わせること。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SQL_FILES = [
  'queries/sql/demand_macro_dashboard.sql',
  'queries/sql/demand_watchlist_sheet.sql',
  'queries/sql/demand_signal_detection.sql',
];

const { PARAMS } = require(path.join(ROOT, 'src/web/demandQuery.js'));

/** snake_case -> camelCase */
function toCamel(s) {
  return s.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase());
}

/**
 * 較正クエリ(05・09)は「いま運用しているしきい値の到達率」を出すために、
 * 同じ値を cur_* という別名でもう一度書いている。**ここもずれる。**
 * 到達率が古いしきい値で計算されていても数字は出てしまうので、対照に含める。
 *
 * cur_margin_ratio_th(旧S2の信用倍率1.0)と cur_dtc_th(days to cover 5.0)は
 * 廃止した判定の記録として残してあるもので、現行の params に対応先が無い。
 * 対照しない。
 */
const ALIASES = {
  curVolMultTh: 'volMultTh',
  curShrtMultTh: 'shrtMultTh',
};

/** 廃止済みの判定に属する名前。対照先が無いのが正しい */
const RETIRED = new Set(['curMarginRatioTh', 'curDtcTh']);

/**
 * params CTE の中の `<数値> AS <名前>` を拾う。
 * 対象を params CTE に限定しないと、本体の `ROUND(...) AS x` まで拾ってしまう。
 */
function extractParams(sqlText) {
  const found = [];
  const re = /params\s+AS\s*\(/gi;
  let m;
  while ((m = re.exec(sqlText)) !== null) {
    const start = m.index + m[0].length;
    const end = sqlText.toUpperCase().indexOf('FROM DUAL', start);
    if (end < 0) continue;
    const body = sqlText.slice(start, end);
    // 行コメントを落としてから拾う(コメント中の数値を拾わないため)
    const cleaned = body.replace(/--[^\n]*/g, '');
    const pre = /(-?\d+(?:\.\d+)?)\s+AS\s+([a-z_][a-z_0-9]*)/gi;
    let p;
    while ((p = pre.exec(cleaned)) !== null) {
      found.push({ name: p[2].toLowerCase(), value: Number(p[1]) });
    }
  }
  return found;
}

let mismatches = 0;
let compared = 0;
const unknown = new Map();

for (const rel of SQL_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.error(`× ファイルがありません: ${rel}`);
    mismatches++;
    continue;
  }
  const found = extractParams(fs.readFileSync(file, 'utf8'));
  for (const { name, value } of found) {
    const raw = toCamel(name);
    const key = ALIASES[raw] || raw;
    if (!(key in PARAMS)) {
      // クエリ固有のパラメータ(weeks_back など)。対照先が無いだけで異常ではない
      if (!unknown.has(raw)) unknown.set(raw, []);
      unknown.get(raw).push(`${rel}:${name}=${value}`);
      continue;
    }
    compared++;
    if (PARAMS[key] !== value) {
      mismatches++;
      console.error(
        `× しきい値がずれています  ${rel}\n` +
          `    params CTE      : ${name} = ${value}\n` +
          `    demandQuery.js  : ${key} = ${PARAMS[key]}` +
          (raw !== key ? `\n    (${name} は ${key} の写しです。較正クエリの到達率が古い\n` +
            `     しきい値で計算されます)` : '')
      );
    }
  }
}

console.log(`対照した項目: ${compared}件 / 不一致: ${mismatches}件`);
const unknownNames = Array.from(unknown.keys()).filter((k) => !RETIRED.has(k));
const retiredNames = Array.from(unknown.keys()).filter((k) => RETIRED.has(k));
if (unknownNames.length > 0) {
  console.log('対照先が無い項目(クエリ固有のパラメータ。異常ではない): ' + unknownNames.join(', '));
}
if (retiredNames.length > 0) {
  console.log('廃止済みの判定の記録(対照しない): ' + retiredNames.join(', '));
}

if (mismatches > 0) {
  console.error(
    '\nしきい値を動かしたときは queries/sql/demand_*.sql の params CTE と\n' +
      'src/web/demandQuery.js の PARAMS の両方を直してください。'
  );
  process.exit(1);
}
console.log('OK: SQLファイルとWebアプリのしきい値は一致しています。');
