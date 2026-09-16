#!/usr/bin/env node
'use strict';

/**
 * CLAUDE_RO(読み取り専用)で ATP に SELECT する MCP サーバー(stdio)
 *
 * 【なぜ必要か】
 *   Cowork(Claude)のシェルは HTTP(S) のプロキシしか通らず、ATP への SQL*Net 接続が
 *   できない(NJS-530)。Claude Desktop にローカル MCP サーバーとして登録したものは
 *   Mac 自身のネットワークで動き、Cowork のスレッドからツールとして呼べる。
 *   これで「SQL を渡す → Mac で実行 → 結果を貼る」の往復を無くす。
 *
 * 【安全性】
 *   判定と接続は scripts/lib/claudeRoQuery.js(claude-query.js と共有)。
 *   DB側の SELECT 専用権限 + アプリ側の SELECT/WITH 判定の二重防御はそのまま。
 *   この MCP サーバーは SQL を組み立てて渡すのが Claude なので、アプリ側の判定を
 *   ゆるめないこと。
 *
 * 【依存ライブラリなし】
 *   MCP の stdio 転送は「1行1メッセージの JSON-RPC 2.0」なので自前で実装した
 *   (取込バッチ本体に依存を増やさない方針。download-arbitrage-archives.js と同じ)。
 *   **stdout にはプロトコルのメッセージ以外を書かないこと。** ログは stderr へ。
 *
 * 【Claude Desktop への登録】(~/Library/Application Support/Claude/claude_desktop_config.json)
 *   "mcpServers": {
 *     "jquants-db": {
 *       "command": "<which node の絶対パス>",
 *       "args": ["/Users/pelo8/apps/jquants/jquants-batch/scripts/claude-ro-mcp.js"]
 *     }
 *   }
 *   Desktop は GUI アプリなのでシェルの PATH を引き継がない。command は絶対パスで書く。
 *
 * 【環境変数】(.env.claude-readonly に追記してよい)
 *   CLAUDE_MCP_MAX_ROWS    … 1回の上限行数(既定 500、ツール引数で小さくはできるが超えられない)
 *   CLAUDE_MCP_TIMEOUT_MS  … 1クエリのタイムアウト(既定 120000)
 *   CLAUDE_MCP_MAX_CHARS   … 返す文字数の上限(既定 60000。超えたら行を切り詰めて明記)
 *
 * 手元での動作確認(DBに繋がずプロトコルだけ):
 *   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node scripts/claude-ro-mcp.js
 */

const readline = require('readline');
const { runReadOnlyQuery } = require('./lib/claudeRoQuery');

const SERVER_INFO = { name: 'jquants-db', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

const MAX_ROWS = Number(process.env.CLAUDE_MCP_MAX_ROWS || 500);
const TIMEOUT_MS = Number(process.env.CLAUDE_MCP_TIMEOUT_MS || 120000);
const MAX_CHARS = Number(process.env.CLAUDE_MCP_MAX_CHARS || 60000);

const log = (...a) => console.error('[jquants-db]', ...a);

// ---------------------------------------------------------------------------
// 値の整形
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');

function formatValue(v) {
  if (v === null || v === undefined) return '(null)';
  if (v instanceof Date) {
    // oracledb はローカルタイムゾーンで Date を作る。DATE 型は時刻0時が大半なので日付だけにする
    const d = `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return hasTime ? `${d} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}` : d;
  }
  if (Buffer.isBuffer(v)) return `(binary ${v.length} bytes)`;
  return String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '/');
}

/**
 * パイプ区切りの表にする。NULL は '(null)' と明示する
 * (このプロジェクトでは NULL と 0 を取り違えると結論が変わるため)。
 */
function toTable({ columns, rows, truncated, elapsedMs }, maxRows) {
  const header = columns.join(' | ');
  const lines = [header];
  let charCount = header.length;
  let shown = 0;
  for (const row of rows) {
    const line = row.map(formatValue).join(' | ');
    if (charCount + line.length + 1 > MAX_CHARS) break;
    lines.push(line);
    charCount += line.length + 1;
    shown++;
  }
  const notes = [`${shown} 行 / ${elapsedMs} ms`];
  if (truncated) notes.push(`上限 ${maxRows} 行で切り詰め(実際はもっとある)。集計・WHERE で絞ること`);
  if (shown < rows.length) notes.push(`文字数上限 ${MAX_CHARS} のため ${rows.length - shown} 行を省略`);
  return `${lines.join('\n')}\n\n-- ${notes.join(' / ')}`;
}

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'run_select',
    description:
      'jquants の Oracle ATP に CLAUDE_RO(SELECT専用)で問い合わせる。' +
      'SELECT または WITH で始まる単文のみ。セミコロン不可。' +
      'INSERT/UPDATE/DELETE/MERGE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/EXECUTE/CALL/COMMIT/ROLLBACK は ' +
      'SQL コメントの中に書いても拒否される。結果はパイプ区切りの表で、NULL は (null) と表示する。' +
      `既定の上限は ${MAX_ROWS} 行。重い集計はタイムアウト(${Math.round(TIMEOUT_MS / 1000)}秒)に注意。`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '実行する SELECT / WITH 文(1文)' },
        max_rows: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_ROWS,
          description: `返す最大行数(省略時 ${MAX_ROWS})`,
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_objects',
    description:
      'CLAUDE_RO から参照できるテーブル・ビューの一覧(シノニム名)と、実体の種類・コメントを返す。' +
      '無いテーブルで ORA-00942 が出たら、ここに無ければ GRANT/シノニム漏れ(ddl/18 参照)。',
    inputSchema: {
      type: 'object',
      properties: {
        name_like: { type: 'string', description: '名前の絞り込み(部分一致、大文字小文字無視。省略可)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'describe_object',
    description: 'テーブル・ビューの列定義(列名・型・NULL可否・列コメント)を返す。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'テーブル名またはビュー名(例: xs_weekly_panel)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const LIST_SQL = `
SELECT s.synonym_name AS name, o.object_type, SUBSTR(c.comments, 1, 120) AS comments
FROM user_synonyms s
LEFT JOIN all_objects o
  ON o.owner = s.table_owner AND o.object_name = s.table_name
 AND o.object_type IN ('TABLE', 'VIEW')
LEFT JOIN all_tab_comments c
  ON c.owner = s.table_owner AND c.table_name = s.table_name
WHERE (:pat IS NULL OR s.synonym_name LIKE '%' || UPPER(:pat) || '%')
ORDER BY s.synonym_name`;

const DESCRIBE_SQL = `
SELECT t.column_id, t.column_name,
       t.data_type ||
         CASE
           WHEN t.data_type IN ('VARCHAR2', 'CHAR', 'NVARCHAR2')
             THEN '(' || t.char_length || CASE t.char_used WHEN 'C' THEN ' CHAR' ELSE '' END || ')'
           WHEN t.data_type = 'NUMBER' AND t.data_precision IS NOT NULL
             THEN '(' || t.data_precision || ',' || NVL(t.data_scale, 0) || ')'
         END AS data_type,
       t.nullable,
       SUBSTR(cc.comments, 1, 160) AS comments
FROM user_synonyms s
JOIN all_tab_columns t
  ON t.owner = s.table_owner AND t.table_name = s.table_name
LEFT JOIN all_col_comments cc
  ON cc.owner = t.owner AND cc.table_name = t.table_name AND cc.column_name = t.column_name
WHERE s.synonym_name = UPPER(:name)
ORDER BY t.column_id`;

async function callTool(name, args) {
  switch (name) {
    case 'run_select': {
      const maxRows = Math.min(Number(args.max_rows) || MAX_ROWS, MAX_ROWS);
      const r = await runReadOnlyQuery(args.sql, { maxRows, timeoutMs: TIMEOUT_MS });
      return toTable(r, maxRows);
    }
    case 'list_objects': {
      const r = await runReadOnlyQuery(LIST_SQL, {
        maxRows: 1000, timeoutMs: TIMEOUT_MS, binds: { pat: args.name_like || null },
      });
      return toTable(r, 1000);
    }
    case 'describe_object': {
      const r = await runReadOnlyQuery(DESCRIBE_SQL, {
        maxRows: 1000, timeoutMs: TIMEOUT_MS, binds: { name: String(args.name || '') },
      });
      if (r.rows.length === 0) {
        return `${args.name} は CLAUDE_RO のシノニムに見つからない。list_objects で名前を確認するか、GRANT/シノニム漏れを疑う。`;
      }
      return toTable(r, 1000);
    }
    default:
      throw Object.assign(new Error(`未知のツール: ${name}`), { rpcCode: -32602 });
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              'jquants の Oracle ATP を CLAUDE_RO(SELECT専用)で参照する。' +
              '列の意味は describe_object のコメントと jquants-batch/docs/PROJECT.md を参照。',
          },
        });
      case 'ping':
        return isRequest && send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const name = params.name;
        const args = params.arguments || {};
        try {
          const text = await callTool(name, args);
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
        } catch (err) {
          if (err.rpcCode) throw err;
          // SQL の誤り・拒否・ORA エラーはツールの結果として返す(Claude が読んで直せるように)
          log(`${name} failed:`, err.message);
          return send({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: `エラー: ${err.message}` }], isError: true },
          });
        }
      }
      default:
        if (isRequest) {
          return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        return undefined; // 通知(notifications/initialized 等)は応答しない
    }
  } catch (err) {
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: err.rpcCode || -32603, message: err.message } });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const pending = new Set();
let closing = false;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const p = handle(msg).finally(() => {
    pending.delete(p);
    if (closing && pending.size === 0) process.exit(0);
  });
  pending.add(p);
});

rl.on('close', () => {
  closing = true;
  if (pending.size === 0) process.exit(0);
});

log(`started (max_rows=${MAX_ROWS}, timeout_ms=${TIMEOUT_MS})`);
