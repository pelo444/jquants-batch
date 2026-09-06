'use strict';

/**
 * 株価タグ分析 Webアプリ (Express)
 *
 * 機能:
 *   1. タグと期間を指定して、分割調整済みの騰落率を降順の表で見る
 *   2. 同じ条件で、終値の折れ線グラフを縦に並べて見る(chart.js のHTML生成を再利用)
 *
 * 起動:
 *   npm run web                  → http://127.0.0.1:3000
 *   JQB_WEB_PORT=8080 npm run web
 *
 * 【バインド先について】
 *   既定は 127.0.0.1 で待ち受ける。認証は別途リバースプロキシ側で行う想定のため、
 *   このプロセスを直接インターネットに晒さないこと。
 *   どうしても直接待ち受ける必要がある場合のみ JQB_WEB_HOST=0.0.0.0 を指定する。
 *
 * 【認証について】
 *   このフェーズでは認証を実装していない。OCI VM上の既存の認証サービスから
 *   リバースプロキシ経由でアクセスする構成を想定している。
 *   詳細は src/web/README.md を参照。
 */

const path = require('path');
const express = require('express');

const db = require('../db');
const chartQuery = require('../chartQuery');
const webQuery = require('./webQuery');
const { buildHtml } = require('../chartHtml');
const { buildPayload } = require('../chartPayload');

const PORT = Number(process.env.JQB_WEB_PORT || 3000);
const HOST = process.env.JQB_WEB_HOST || '127.0.0.1';

// グラフは1銘柄1枚のSVGを描くので、枚数が増えるほどブラウザ側が重くなる。
// 表(数値のみ)はもっと多くても平気なので、上限を分けている。
const CHART_MAX_CODES = Number(process.env.JQB_WEB_CHART_MAX_CODES || 60);
const CHART_MAX_YEARS = Number(process.env.JQB_WEB_CHART_MAX_YEARS || 3);
const TABLE_MAX_YEARS = 10;

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 60;

//------------------------------------------------------------------
// 簡易キャッシュ
//
// 株価は日次でしか変わらないので、同じ条件の再取得は短時間キャッシュしてよい。
// 期限切れとサイズ上限だけを見る最小限の実装にしている。
//------------------------------------------------------------------
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  // 参照されたものを末尾に回して、古いものから捨てられるようにする
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

//------------------------------------------------------------------
// 入力検証
//
// バインド変数を使っているのでSQLインジェクションは起きないが、
// 不正な値でクエリを投げる前に弾いてエラーメッセージを分かりやすくする。
//------------------------------------------------------------------
class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, label) {
  if (!ISO_DATE.test(value)) {
    throw new BadRequest(`${label} は YYYY-MM-DD 形式で指定してください: "${value}"`);
  }
  const t = Date.parse(value + 'T00:00:00Z');
  if (Number.isNaN(t)) {
    throw new BadRequest(`${label}が日付として不正です: "${value}"`);
  }
  return value;
}

function shiftYears(iso, years) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCFullYear(dt.getUTCFullYear() - years);
  return dt.toISOString().slice(0, 10);
}

function parseInt0(value, label, min, max, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(`${label} は ${min}〜${max} の整数で指定してください: "${value}"`);
  }
  return n;
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true';
}

/**
 * タグ名を検証する。tag_master に存在しないタグは弾く。
 * 打ち間違いを「該当0件」ではなくエラーとして返せるようにするため。
 */
function parseTags(value, knownTags) {
  if (!value) {
    throw new BadRequest('タグを1つ以上選択してください');
  }
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const uniq = Array.from(new Set(list));
  if (uniq.length === 0) {
    throw new BadRequest('タグを1つ以上選択してください');
  }
  if (uniq.length > 40) {
    throw new BadRequest('一度に指定できるタグは40個までです');
  }
  const unknown = uniq.filter((t) => !knownTags.has(t));
  if (unknown.length > 0) {
    throw new BadRequest(`存在しないタグです: ${unknown.join(', ')}`);
  }
  return uniq;
}

/** 4桁の証券コードをJ-Quantsの5桁形式に揃える */
function normalizeCode(raw) {
  const c = String(raw).trim().toUpperCase();
  if (c.length === 4) return c + '0';
  if (c.length === 5) return c;
  throw new BadRequest(`銘柄コードの桁数が不正です: "${raw}"`);
}

//------------------------------------------------------------------
// メタ情報(タグ一覧・最新営業日)
//
// タグの検証にも使うので、短時間キャッシュして毎回DBを叩かないようにする。
//------------------------------------------------------------------
async function getMeta() {
  const cached = cacheGet('meta');
  if (cached) return cached;

  const meta = await db.withConnection(async (conn) => {
    const [latestDate, tags] = await Promise.all([
      webQuery.fetchLatestPriceDate(conn),
      webQuery.fetchTags(conn),
    ]);
    return { latestDate, tags };
  });

  cacheSet('meta', meta);
  return meta;
}

/**
 * 期間パラメータを解釈する。to を省略した場合は取込済みデータの最新営業日にする。
 */
function resolvePeriod(query, latestDate, maxYears) {
  const to = query.to ? parseDate(query.to, '終了日') : latestDate;
  if (!to) {
    throw new BadRequest('EQUITY_PRICE_DAILY にデータがありません');
  }

  let from;
  if (query.from) {
    from = parseDate(query.from, '開始日');
  } else {
    from = shiftYears(to, 1);
  }

  if (from >= to) {
    throw new BadRequest(`期間が不正です: ${from} 〜 ${to}`);
  }

  const notice = [];
  const limitFrom = shiftYears(to, maxYears);
  if (from < limitFrom) {
    notice.push(`期間の上限は${maxYears}年です。開始日を ${limitFrom} に切り詰めました。`);
    from = limitFrom;
  }
  return { from, to, notice };
}

//------------------------------------------------------------------
// アプリ
//------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// 簡易アクセスログ
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ` +
        `${res.statusCode} ${Date.now() - started}ms`
    );
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

//---------------------------------------------------------- 死活監視
app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

//---------------------------------------------------------- メタ情報
app.get('/api/meta', async (req, res, next) => {
  try {
    const meta = await getMeta();
    res.json({
      latestDate: meta.latestDate,
      tags: meta.tags,
      limits: {
        chartMaxCodes: CHART_MAX_CODES,
        chartMaxYears: CHART_MAX_YEARS,
        tableMaxYears: TABLE_MAX_YEARS,
      },
    });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 騰落率一覧
app.get('/api/performance', async (req, res, next) => {
  try {
    const meta = await getMeta();
    const knownTags = new Set(meta.tags.map((t) => t.tagName));

    const allStocks = req.query.all === '1' || req.query.all === 'true';
    const tags = allStocks ? [] : parseTags(req.query.tags, knownTags);
    const { from, to, notice } = resolvePeriod(req.query, meta.latestDate, TABLE_MAX_YEARS);
    const minDays = parseInt0(req.query.minDays, '最低営業日数', 0, 3000, 0);
    const excludeFund = parseBool(req.query.excludeFund, true);
    const excludeDelisted = parseBool(req.query.excludeDelisted, true);

    const key = JSON.stringify([
      'perf', allStocks, tags.slice().sort(), from, to, minDays, excludeFund, excludeDelisted,
    ]);
    let rows = cacheGet(key);
    if (!rows) {
      rows = await db.withConnection((conn) =>
        webQuery.fetchPerformance(conn, {
          tags, allStocks, from, to, minDays, excludeFund, excludeDelisted,
        })
      );
      cacheSet(key, rows);
    }

    res.json({
      params: { tags, allStocks, from, to, minDays, excludeFund, excludeDelisted },
      notice,
      count: rows.length,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- チャートHTML
//
// iframe に読み込ませる前提で、chart.js と同じ自己完結型HTMLを返す。
// 銘柄の指定方法は2通り:
//   ・tags + 期間 … 騰落率順に上位/下位から limit 件
//   ・codes       … 表でチェックした銘柄をそのまま描画
app.get('/chart', async (req, res, next) => {
  try {
    const meta = await getMeta();
    const { from, to, notice } = resolvePeriod(req.query, meta.latestDate, CHART_MAX_YEARS);
    const limit = parseInt0(req.query.limit, '表示件数', 1, CHART_MAX_CODES, 30);
    const order = req.query.order === 'asc' ? 'asc' : 'desc';

    let codes;
    let source;

    if (req.query.codes) {
      codes = Array.from(
        new Set(String(req.query.codes).split(',').map((s) => s.trim()).filter(Boolean))
      ).map(normalizeCode);
      if (codes.length === 0) {
        throw new BadRequest('銘柄が指定されていません');
      }
      if (codes.length > CHART_MAX_CODES) {
        throw new BadRequest(
          `一度に表示できる銘柄は${CHART_MAX_CODES}件までです(指定: ${codes.length}件)`
        );
      }
      source = `選択した${codes.length}銘柄`;
    } else {
      const knownTags = new Set(meta.tags.map((t) => t.tagName));
      const allStocks = req.query.all === '1' || req.query.all === 'true';
      const tags = allStocks ? [] : parseTags(req.query.tags, knownTags);
      const minDays = parseInt0(req.query.minDays, '最低営業日数', 0, 3000, 0);
      const excludeFund = parseBool(req.query.excludeFund, true);
      const excludeDelisted = parseBool(req.query.excludeDelisted, true);

      const key = JSON.stringify([
        'perf', allStocks, tags.slice().sort(), from, to, minDays, excludeFund, excludeDelisted,
      ]);
      let perf = cacheGet(key);
      if (!perf) {
        perf = await db.withConnection((conn) =>
          webQuery.fetchPerformance(conn, {
            tags, allStocks, from, to, minDays, excludeFund, excludeDelisted,
          })
        );
        cacheSet(key, perf);
      }
      if (perf.length === 0) {
        throw new BadRequest('該当する銘柄がありませんでした');
      }

      // fetchPerformance は騰落率の降順で返る。昇順指定なら反転してから切り出す。
      const ordered = order === 'asc' ? perf.slice().reverse() : perf;
      codes = ordered.slice(0, limit).map((r) => r.code);
      source =
        (allStocks ? '全銘柄' : `タグ: ${tags.join(' / ')}`) +
        ` ・騰落率${order === 'asc' ? '下位' : '上位'}${codes.length}件` +
        (perf.length > codes.length ? `(全${perf.length}銘柄中)` : '');
    }

    const chartKey = JSON.stringify(['chart', codes, from, to, source]);
    let html = cacheGet(chartKey);
    if (!html) {
      const rows = await db.withConnection((conn) =>
        chartQuery.fetchAdjustedCloses(conn, codes, from, to)
      );
      if (rows.length === 0) {
        throw new BadRequest('該当するデータが0件でした。銘柄コードと期間を確認してください。');
      }
      const payload = buildPayload(rows, codes, {
        from,
        to,
        source: source + (notice.length ? ' ・' + notice.join(' ') : ''),
        generatedAt: new Date().toISOString(),
      });
      html = buildHtml(payload);
      cacheSet(chartKey, html);
    }

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- エラー処理
app.use((req, res) => {
  res.status(404).json({ error: 'そのURLはありません' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('サーバーエラー:', err);
  }
  // 内部エラーの詳細はクライアントに返さない
  const message = status >= 500 ? 'サーバー側でエラーが発生しました' : err.message;
  if (req.path === '/chart') {
    // iframe に表示されるのでHTMLで返す
    res
      .status(status)
      .type('html')
      .send(
        '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>エラー</title>' +
          '<style>body{font-family:system-ui,sans-serif;padding:24px;color:#52514e;' +
          'background:#fcfcfb}h1{font-size:15px;color:#d03b3b;margin:0 0 8px}</style></head>' +
          '<body><h1>グラフを表示できませんでした</h1><p>' +
          String(message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) +
          '</p></body></html>'
      );
  } else {
    res.status(status).json({ error: message });
  }
});

//------------------------------------------------------------------
// 起動と終了
//------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`株価タグ分析Webアプリを起動しました: http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.warn(
      '[警告] 0.0.0.0 で待ち受けています。認証が未実装のため、' +
        'ファイアウォールやリバースプロキシで必ずアクセスを制限してください。'
    );
  }
});

async function shutdown(signal) {
  console.log(`${signal} を受信しました。終了します...`);
  server.close(async () => {
    await db.closePool().catch((e) => console.error('プールのクローズに失敗:', e.message));
    process.exit(0);
  });
  // 接続が残っていても一定時間で強制終了する
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
