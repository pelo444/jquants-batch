'use strict';

/**
 * CLAUDE_RO(読み取り専用)でクエリを実行する共通部分
 *
 * scripts/claude-query.js(CLI)と scripts/claude-ro-mcp.js(MCPサーバー)の両方が使う。
 * **SELECT 以外を弾く判定をここ1か所に閉じ込める。** 入口ごとに判定を書き写すと、
 * 片方だけ直して食い違う(需給3階層で実際に起きた「階層間で読み方が違う」と同じ壊れ方)。
 *
 * 防御は二重:
 *   1. DB側 … claude_ro には SELECT 以外を付与していない(ddl/10, ddl/18)。これが最終防御線
 *   2. アプリ側 … assertReadOnly() が SELECT/WITH で始まる単文以外を拒否する(簡易チェック)
 *
 * 資格情報は .env.claude-readonly(取込バッチの .env とは別ファイル)。
 */

const path = require('path');
const oracledb = require('oracledb');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.claude-readonly') });

// 大文字小文字を区別せず、単語境界でチェックする(雑な文字列に対する簡易フィルタ)。
// 注意: SQL コメントの中の単語も対象になる(project memory: cowork_device_bridge_limits)。
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

/**
 * SELECT/WITH以外を弾く簡易バリデーション。末尾のセミコロンは取り除いて返す。
 */
function assertReadOnly(sqlText) {
  const trimmed = String(sqlText || '').trim().replace(/;+\s*$/, '');
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
      throw new Error(`禁止されたキーワードが含まれています: ${kw}(SQLコメント内の単語も対象)`);
    }
  }
  return trimmed;
}

async function openConnection({ timeoutMs }) {
  const walletLocation = requireEnv('CLAUDE_DB_WALLET_LOCATION');
  const connection = await oracledb.getConnection({
    user: requireEnv('CLAUDE_DB_USER'), // claude_ro
    password: requireEnv('CLAUDE_DB_PASSWORD'),
    connectString: requireEnv('CLAUDE_DB_CONNECT_STRING'),
    configDir: walletLocation,
    walletLocation,
    walletPassword: requireEnv('CLAUDE_DB_WALLET_PASSWORD'),
  });
  connection.callTimeout = timeoutMs;
  return connection;
}

/**
 * 読み取り専用クエリを1本実行する。
 * @returns {{columns: string[], rows: any[][], truncated: boolean, elapsedMs: number}}
 */
async function runReadOnlyQuery(sqlText, { maxRows, timeoutMs, binds = [] }) {
  const sql = assertReadOnly(sqlText);
  const started = Date.now();
  const connection = await openConnection({ timeoutMs });
  try {
    // maxRows + 1 行取って、切り詰めが起きたかを正確に判定する
    const result = await connection.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      maxRows: maxRows + 1,
    });
    const truncated = result.rows.length > maxRows;
    return {
      columns: result.metaData.map((m) => m.name),
      rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
      truncated,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await connection.close();
  }
}

module.exports = { FORBIDDEN_KEYWORDS, assertReadOnly, runReadOnlyQuery };
