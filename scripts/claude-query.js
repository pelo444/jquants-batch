'use strict';

/**
 * Claude Desktop 用の読み取り専用クエリ実行ツール
 *
 * 【なぜ必要か】
 *   Claude Desktopに直接SQLを組み立てさせて分析させたい場面がある。
 *   接続に使うのは claude_ro (ddl/10_create_claude_readonly_user.sql で作成、
 *   SELECTのみ・DDL/DML権限なし)。このスクリプトはさらにアプリ側でも
 *   SELECT以外を弾く(多層防御。DB側の権限が最終防御線であることに変わりはない)。
 *
 *   資格情報は取込バッチの .env とは別ファイル .env.claude-readonly に置く。
 *   src/config.js 経由のGD_JQUANTS資格情報とは完全に独立させ、
 *   このスクリプトがバッチ用の書き込み権限アカウントを誤って使うことがないようにする。
 *
 * 使い方:
 *   node scripts/claude-query.js "SELECT code, co_name FROM equity_master WHERE code = '68570'"
 *   node scripts/claude-query.js --file query.sql
 *   node scripts/claude-query.js --json "SELECT ..."   結果をJSONで出力
 *
 * 制約:
 *   ・SELECT / WITH で始まる単一の問い合わせのみ許可(セミコロン区切りの複数文は不可)
 *   ・危険なキーワードを含む場合は実行前に拒否する(簡易チェック。過信しないこと)
 *   ・行数の上限(既定1000行)を超える場合は警告して切り詰める
 *   ・クエリタイムアウト(既定30秒)を設定する
 */

const path = require('path');
const fs = require('fs');
const oracledb = require('oracledb');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.claude-readonly') });

const MAX_ROWS = Number(process.env.CLAUDE_QUERY_MAX_ROWS || 1000);
const TIMEOUT_MS = Number(process.env.CLAUDE_QUERY_TIMEOUT_MS || 30000);

// 大文字小文字を区別せず、単語境界でチェックする(雑な文字列に対する簡易フィルタ)
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE',
  'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'CALL', 'COMMIT', 'ROLLBACK',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。.env.claude-readonly を確認してください。`
    );
  }
  return value;
}

function parseArgs(argv) {
  const args = { json: false, file: null, sql: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--file') {
      args.file = argv[++i];
    } else {
      rest.push(a);
    }
  }
  if (args.file) {
    args.sql = fs.readFileSync(args.file, 'utf8');
  } else {
    args.sql = rest.join(' ');
  }
  return args;
}

/**
 * SELECT/WITH以外を弾く簡易バリデーション。
 * あくまでアプリ側の多層防御であり、本当の防御線はDB側のSELECT専用権限。
 */
function assertReadOnly(sqlText) {
  const trimmed = sqlText.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    throw new Error('SQLが空です。');
  }
  if (trimmed.includes(';')) {
    throw new Error('複数文(セミコロン区切り)は実行できません。1文だけ渡してください。');
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('SELECT または WITH で始まるクエリのみ実行できます。');
  }
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(trimmed)) {
      throw new Error(`禁止されたキーワードが含まれています: ${kw}`);
    }
  }
  return trimmed;
}

function printTable(rows, metaData) {
  if (rows.length === 0) {
    console.log('(0 rows)');
    return;
  }
  const columns = metaData.map((m) => m.name);
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[i] === null ? '' : r[i]).length))
  );
  const printRow = (values) =>
    console.log(values.map((v, i) => String(v).padEnd(widths[i])).join(' | '));
  printRow(columns);
  printRow(widths.map((w) => '-'.repeat(w)));
  for (const row of rows) {
    printRow(row.map((v) => (v === null ? '' : v)));
  }
  console.log(`(${rows.length} rows)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sql = assertReadOnly(args.sql);

  const user = requireEnv('CLAUDE_DB_USER'); // claude_ro
  const password = requireEnv('CLAUDE_DB_PASSWORD');
  const connectString = requireEnv('CLAUDE_DB_CONNECT_STRING');
  const walletLocation = requireEnv('CLAUDE_DB_WALLET_LOCATION');
  const walletPassword = requireEnv('CLAUDE_DB_WALLET_PASSWORD');

  const connection = await oracledb.getConnection({
    user,
    password,
    connectString,
    configDir: walletLocation,
    walletLocation,
    walletPassword,
  });

  connection.callTimeout = TIMEOUT_MS;

  try {
    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      maxRows: MAX_ROWS,
    });

    if (result.rows.length >= MAX_ROWS) {
      console.error(`警告: 結果が ${MAX_ROWS} 行に切り詰められています。WHERE句や集計で絞り込んでください。`);
    }

    if (args.json) {
      const columns = result.metaData.map((m) => m.name);
      const objects = result.rows.map((row) =>
        Object.fromEntries(row.map((v, i) => [columns[i], v]))
      );
      console.log(JSON.stringify(objects, null, 2));
    } else {
      printTable(result.rows, result.metaData);
    }
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
