'use strict';

/**
 * 損失回避のチェック(Ch1〜Ch10)のうち、自動で計算できる部分を出すツール。
 * DB は SELECT だけ。売買の結論は出さず、人が判断する問いを添えて表示する。
 *
 * 使い方:
 *   node src/check.js --code 6861
 *   node src/check.js --code 6861 --amount 3000000 --buy 52000 --stop 10,15 --swing 100000
 *   node src/check.js --code 6861 --amount 6000000 --with 7203,8035
 *   node src/check.js --code 6861 --json
 *
 * オプション:
 *   --code <c>     銘柄コード(4桁でも5桁でも可)。必須
 *   --amount <円>  この銘柄に入れる予定額(1週の動く額・損失額の計算に使う)。--with と併用すると総額
 *   --buy <円>     買値の予定(省略時は直近終値)
 *   --stop <list>  損切り幅(%)をカンマ区切りで(既定: 10,15)
 *   --swing <円>   1週で動いてよい額。投資額の目安を出す(Ch6)
 *   --with <list>  同時に持つ他の銘柄。1/ボラで重みを出す(Ch6)
 *   --days <n>     下方修正を探す期間(既定: 30)
 *   --json         JSON で出力
 *   --help         この説明
 */

const fs = require('fs');
const db = require('./db');
const lc = require('./lossChecks');

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log(m[1].replace(/^ \* ?/gm, '').trim());
}

function num(a, v) {
  const x = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${a} は正の数で指定してください: ${v}`);
  return x;
}

function parseArgs(argv) {
  const o = { stopPcts: [10, 15], days: 30, withCodes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} には値が必要です`);
      i++;
      return v;
    };
    switch (a) {
      case '--code': o.code = lc.normalizeCode(next()); break;
      case '--amount': o.amount = num(a, next()); break;
      case '--buy': o.buy = num(a, next()); break;
      case '--stop': o.stopPcts = next().split(',').map((s) => num(a, s)); break;
      case '--swing': o.swing = num(a, next()); break;
      case '--with': o.withCodes = next().split(',').filter(Boolean).map(lc.normalizeCode); break;
      case '--days': o.days = Math.round(num(a, next())); break;
      case '--json': o.json = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`不明なオプション: ${a}`);
    }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.code) {
    printHelp();
    return;
  }
  try {
    const data = await db.withConnection((conn) => lc.collect(conn, o.code, o));
    if (!data.metrics) {
      console.error(`株価データが見つかりません: ${o.code}`);
      process.exitCode = 1;
      return;
    }
    const rep = lc.buildReport(data);
    console.log(o.json ? JSON.stringify(rep, null, 2) : lc.formatReport(rep));
  } finally {
    await db.closePool();
  }
}

main().catch((e) => {
  console.error('エラー:', e.message);
  process.exit(1);
});
