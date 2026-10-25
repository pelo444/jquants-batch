'use strict';

/**
 * 株価タグ分析 Webアプリ (Express)
 *
 * 機能:
 *   1. タグと期間を指定して、分割調整済みの騰落率を降順の表で見る
 *   2. 同じ条件で、終値の折れ線グラフを縦に並べて見る(chart.js のHTML生成を再利用)
 *   3. 需給3階層(マクロ / ウォッチリスト / シグナル)を /demand で見る
 *      クエリは demandQuery.js。読み方の約束は docs/DEMAND_WEB.md と
 *      docs/DEMAND_SIGNAL_RUNBOOK.md を参照。
 *   4. 自分の売買・判断・メモの記録を /journal で付ける
 *      ルーティングは journalRoutes.js。約束と運用は docs/JOURNAL.md。
 *      個人の財務情報なので、127.0.0.1 以外で待ち受けるなら認証を先に入れること。
 *   5. 銘柄購入の流れ(購入検討リスト → 参考情報 → 損失回避チェック → 判断メモ)を /purchase で行う
 *      ルーティングは purchaseRoutes.js。設計は claude/purchase_flow_design.md。
 *   6. 市場(米国3指数・日経先物・日経平均・TOPIX・投資部門別・信用残・裁定残・33業種)を /market で1枚の表で見る
 *      データは marketQuery.js。設計は claude/market_page_design.md。
 *   7. 日々の確認(保有・ウォッチ・検討中の銘柄の出来事・値動き・予定)を /daily で見る
 *      データは dailyQuery.js。設計は claude/daily_page_design.md。
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
const demandQuery = require('./demandQuery');
const marketQuery = require('./marketQuery');
const eventsQuery = require('./eventsQuery');
const referenceQuery = require('./referenceQuery');
const dailyQuery = require('./dailyQuery');
const journalRoutes = require('./journalRoutes');
const purchaseRoutes = require('./purchaseRoutes');
const purchaseQuery = require('./purchaseQuery');
const { fetchMarginChecks } = require('./marginCheck');
const stockLookup = require('./stockLookup');
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
// 全銘柄シグナル(第三階層 3)は全銘柄 × 15か月の信用残を走査する。
// 毎日流すものではないので、当たったときは長めに保持する。
const CACHE_TTL_HEAVY_MS = 30 * 60 * 1000;
// 騰落率一覧に加えて需給3階層の結果(銘柄詳細はウォッチ銘柄の数だけ)が入るため、
// 騰落率の結果が押し出されないよう枠を広げてある。
const CACHE_MAX_ENTRIES = 120;

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

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + (ttlMs || CACHE_TTL_MS) });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

//------------------------------------------------------------------
// キャッシュ + 同時実行のまとめ
//
// 需給3階層には重いクエリがある(全銘柄シグナルは全銘柄×15か月を走査する)。
// 素のキャッシュだけだと、まだ結果が返っていない間に2回押されると
// 同じ重いクエリが2本走る。実行中の Promise を持っておいて相乗りさせる。
//------------------------------------------------------------------
const inFlight = new Map();

async function withCache(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit) return hit;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    try {
      const value = await fn();
      cacheSet(key, value, ttlMs);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
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
function parseSectors(value, knownSectors) {
  const uniq = Array.from(new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean)));
  if (uniq.length === 0) {
    throw new BadRequest('33業種を1つ以上選択してください');
  }
  const unknown = uniq.filter((s) => !knownSectors.has(s));
  if (unknown.length > 0) {
    throw new BadRequest(`存在しない業種コードです: ${unknown.join(', ')}`);
  }
  return uniq;
}

/**
 * 銘柄コードの直接指定(騰落率一覧の「銘柄コード」タブ)。カンマ区切り。
 * 全角のカンマ・読点・空白・改行も区切りとして受ける(貼り付けたときのため)。4桁は5桁に揃える。
 * 指定 stocks= は /chart の codes=(表でチェックした銘柄をそのまま描く)と意味が違うので名前を分けている。
 */
const STOCKS_MAX = 300;
function parseStocks(value) {
  const list = String(value || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new BadRequest('銘柄コードを1つ以上入力してください');
  const bad = list.filter((c) => !/^[0-9A-Za-z]{4,5}$/.test(c));
  if (bad.length) throw new BadRequest(`銘柄コードの形が不正です: ${bad.join(', ')}`);
  const uniq = Array.from(new Set(list.map(normalizeCode)));
  if (uniq.length > STOCKS_MAX) throw new BadRequest(`一度に指定できる銘柄コードは${STOCKS_MAX}件までです(指定: ${uniq.length}件)`);
  return uniq;
}

/**
 * 騰落率一覧・チャートの対象の指定を解釈する。
 * all=1(全銘柄) / stocks=(銘柄コード) / sectors=(33業種コード) / tags=(タグ名) のどれか1つ。
 */
function parseTarget(query, meta) {
  const allStocks = query.all === '1' || query.all === 'true';
  if (allStocks) return { allStocks, stocks: [], sectors: [], tags: [] };
  if (query.stocks !== undefined) {
    return { allStocks, stocks: parseStocks(query.stocks), sectors: [], tags: [] };
  }
  if (query.sectors) {
    const known = new Set(meta.sectors.map((s) => s.code));
    return { allStocks, stocks: [], sectors: parseSectors(query.sectors, known), tags: [] };
  }
  const knownTags = new Set(meta.tags.map((t) => t.tagName));
  return { allStocks, stocks: [], sectors: [], tags: parseTags(query.tags, knownTags) };
}

/** 4桁で出す(67520 → 6752)。画面の表示と同じ */
function shortCode(c) { return c.length === 5 && c[4] === '0' ? c.slice(0, 4) : c; }

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
    // 33業種の一覧は銘柄購入(/purchase)と同じもの(上場中・TOKYO PRO MARKET 除く・件数付き)
    const [latestDate, tags, sectors] = await Promise.all([
      webQuery.fetchLatestPriceDate(conn),
      webQuery.fetchTags(conn),
      purchaseQuery.fetchSectors(conn),
    ]);
    return { latestDate, tags, sectors };
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
      sectors: meta.sectors,
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

//---------------------------------------------------------- 前営業日(期間「1日」の起点)
app.get('/api/prev-trading-date', async (req, res, next) => {
  try {
    const meta = await getMeta();
    const to = req.query.to ? parseDate(req.query.to, '終了日') : meta.latestDate;
    const date = await withCache('prevdate:' + to, CACHE_TTL_MS, () =>
      db.withConnection((conn) => webQuery.fetchPrevTradingDate(conn, to))
    );
    if (!date) throw new BadRequest(`${to} より前の営業日がありません`);
    res.json({ to, date });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 企業名から銘柄コードを引く
// 騰落率一覧の「銘柄コード」タブと、銘柄購入の購入検討銘柄の欄で使う。
// 上場中の銘柄マスタを丸ごとメモリに持ち(数千行)、打つたびの検索はメモリ上で行う(stockLookup.js 冒頭)。
const STOCK_NAMES_TTL_MS = 6 * 60 * 60 * 1000;
app.get('/api/stock-lookup', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 50);
    const limit = parseInt0(req.query.limit, 'limit', 1, 50, stockLookup.LIMIT_DEFAULT);
    const index = await withCache('stock-names', STOCK_NAMES_TTL_MS, async () =>
      stockLookup.buildIndex(await db.withConnection((conn) => stockLookup.fetchStockNames(conn)))
    );
    res.json(stockLookup.search(index, q, limit));
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 騰落率一覧
app.get('/api/performance', async (req, res, next) => {
  try {
    const meta = await getMeta();
    const { allStocks, stocks, sectors, tags } = parseTarget(req.query, meta);
    const { from, to, notice } = resolvePeriod(req.query, meta.latestDate, TABLE_MAX_YEARS);
    const minDays = parseInt0(req.query.minDays, '最低営業日数', 0, 3000, 0);
    const excludeFund = parseBool(req.query.excludeFund, true);
    const excludeDelisted = parseBool(req.query.excludeDelisted, true);

    const key = JSON.stringify([
      'perf', allStocks, stocks.slice().sort(), sectors.slice().sort(), tags.slice().sort(), from, to, minDays, excludeFund, excludeDelisted,
    ]);
    let rows = cacheGet(key);
    if (!rows) {
      rows = await db.withConnection((conn) =>
        webQuery.fetchPerformance(conn, {
          tags, sectors, stocks, allStocks, from, to, minDays, excludeFund, excludeDelisted,
        })
      );
      cacheSet(key, rows);
    }

    // 銘柄コード指定で一覧に出なかったもの(コードの誤り・ETF等や上場廃止の除外・期間中に株価が無い など)
    if (stocks.length) {
      const got = new Set(rows.map((r) => r.code));
      const missing = stocks.filter((c) => !got.has(c));
      if (missing.length) {
        notice.push(`一覧に出なかった銘柄コード: ${missing.map(shortCode).join(', ')}(コードの誤り、オプションの除外、期間中の株価なし のどれか)`);
      }
    }

    res.json({
      params: { tags, sectors, stocks, allStocks, from, to, minDays, excludeFund, excludeDelisted },
      notice,
      count: rows.length,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 33業種のグラフ
// 騰落率一覧の「33業種のグラフ」タブ。東証業種別株価指数の期間騰落率と TOPIX(webQuery.fetchSectorPerformance)
app.get('/api/sector-performance', async (req, res, next) => {
  try {
    const meta = await getMeta();
    const { from, to, notice } = resolvePeriod(req.query, meta.latestDate, TABLE_MAX_YEARS);
    const data = await withCache(JSON.stringify(['sectorPerf', from, to]), CACHE_TTL_MS, () =>
      db.withConnection((conn) => webQuery.fetchSectorPerformance(conn, { from, to }))
    );
    if (data.sectors.length === 0) notice.push(`${from} 〜 ${to} に東証業種別株価指数の値がありません`);
    res.json({ params: { from, to }, notice, topix: data.topix, sectors: data.sectors });
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
      const { allStocks, stocks, sectors, tags } = parseTarget(req.query, meta);
      const minDays = parseInt0(req.query.minDays, '最低営業日数', 0, 3000, 0);
      const excludeFund = parseBool(req.query.excludeFund, true);
      const excludeDelisted = parseBool(req.query.excludeDelisted, true);

      const key = JSON.stringify([
        'perf', allStocks, stocks.slice().sort(), sectors.slice().sort(), tags.slice().sort(), from, to, minDays, excludeFund, excludeDelisted,
      ]);
      let perf = cacheGet(key);
      if (!perf) {
        perf = await db.withConnection((conn) =>
          webQuery.fetchPerformance(conn, {
            tags, sectors, stocks, allStocks, from, to, minDays, excludeFund, excludeDelisted,
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
        (allStocks
          ? '全銘柄'
          : stocks.length
            ? `銘柄コード指定(${stocks.length}件)`
          : sectors.length
            ? `33業種: ${sectors.map((c) => (meta.sectors.find((s) => s.code === c) || {}).name || c).join(' / ')}`
            : `タグ: ${tags.map((n) => {
              // 短縮表記(TAG_SHORT_JA)、無ければ日本語名、それも無ければタグ名のまま(騰落率一覧の表と同じ)
              const t = meta.tags.find((x) => x.tagName === n);
              return t ? t.shortLabel || t.label || n : n;
            }).join(' / ')}`) +
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

//==================================================================
// 需給3階層 (/demand)
//
// 【この画面の約束】
//   ・SIGNAL_SCORE は「買いシグナル」ではない。「先に中身を見る順番」でしかない。
//     需給5指標の予測力は10年分で検証済みで、いずれも先行リターンの方向を
//     予測できなかった。さらに手元のデータは上昇相場10年分しかなく、
//     上昇依存の手法は反証できない。**煽らないこと。**
//   ・NULL と 0 は別物。表示層で潰すと、この3階層の意味がまるごと消える。
//     どの列で何を意味するかは docs/DEMAND_SIGNAL_RUNBOOK.md 4章。
//   ・較正クエリ(05〜11)はここに出さない。全期間の分位を使っていて
//     先読みバイアスを含むため、日々の判断に混ぜない。
//     画面に出すのは「最後に較正した日」と「いま使っているしきい値」だけ。
//==================================================================

const DEMAND_MAX_WEEKS = 520;   // 10年。株価の取込範囲がローリング10年なので、これ以上は無意味
const DEMAND_MIN_WEEKS = 4;

/** 需給用のメタ情報(しきい値・SECTION一覧・ウォッチリスト) */
async function getDemandMeta() {
  return withCache('demand:meta', CACHE_TTL_MS, () =>
    db.withConnection(async (conn) => {
      const [sections, watchlist] = await Promise.all([
        demandQuery.fetchSections(conn),
        demandQuery.fetchWatchlist(conn),
      ]);
      return { sections, watchlist: watchlist.codes, lvsDocs: watchlist.lvsDocs };
    })
  );
}

function parseWeeks(value, fallback) {
  return parseInt0(value, '週数', DEMAND_MIN_WEEKS, DEMAND_MAX_WEEKS, fallback);
}

//---------------------------------------------------------- 画面
// /demand と /demand/ の両方を public/demand.html に向ける。
// express.static は /demand.html しか拾わないため。
app.get(['/demand', '/demand/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demand.html'));
});

//---------------------------------------------------------- メタ情報
app.get('/api/demand/meta', async (req, res, next) => {
  try {
    const meta = await getDemandMeta();
    res.json({
      params: demandQuery.PARAMS,
      calibratedAt: demandQuery.CALIBRATED_AT,
      sections: meta.sections,
      watchlist: meta.watchlist,
      lvsDocs: meta.lvsDocs,
      limits: { maxWeeks: DEMAND_MAX_WEEKS, minWeeks: DEMAND_MIN_WEEKS },
    });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 鮮度
//
// **シグナルより先に、常に見える位置に置くこと。**
// シグナルは最新値で判定するので、どれか1つでも取込が止まっていると静かに誤判定する。
app.get('/api/demand/freshness', async (req, res, next) => {
  try {
    // 信用残の要確認(marginCheck.js)も一緒に返す。週の値は週の最後の申込日を使うので、
    // 要確認の日が週の最後のうちは、3階層の信用残を使う列がその日の値になる
    const out = await withCache('demand:freshness', CACHE_TTL_MS, () =>
      db.withConnection(async (conn) => {
        const today = marketQuery.ymdIn(new Date(), marketQuery.TZ_JP);
        const rows = await demandQuery.fetchFreshness(conn);
        const checks = await fetchMarginChecks(conn, marketQuery.addDays(today, -14));
        return { rows, marginChecks: checks.filter((c) => c.kind === 'jump') };
      })
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 第一階層
app.get('/api/demand/macro', async (req, res, next) => {
  try {
    const meta = await getDemandMeta();
    const known = new Map(meta.sections.map((s) => [s.section, s]));

    const section = req.query.section || 'TokyoNagoya';
    if (!known.has(section)) {
      throw new BadRequest(
        `存在しない SECTION です: ${section}(候補: ${Array.from(known.keys()).join(', ')})`
      );
    }
    const weeks = parseWeeks(req.query.weeks, 52);

    // 【黙ってNULLが並ぶのを防ぐ】
    //   2022年4月の市場区分再編で TSE1st 等は終了し、TSEPrime 等はそこから始まる。
    //   終了した系列や短い系列を選んで長く遡ると、エラーにならずに投資部門別の列だけが
    //   空になる。これが一番危ない失敗の仕方なので、期間が系列をはみ出すときは警告を返す。
    const notice = [];
    const info = known.get(section);
    const spanWeeks = info.fromDate
      ? Math.floor((Date.parse(info.toDate) - Date.parse(info.fromDate)) / (7 * 86400000)) + 1
      : 0;
    if (weeks > spanWeeks) {
      notice.push(
        `${section} のデータは ${info.fromDate} 〜 ${info.toDate}(約${spanWeeks}週)です。` +
          `指定した${weeks}週のうち、それより前の週は投資部門別の列が空になります` +
          `(取込漏れではありません)。`
      );
    }
    const staleDays = Math.floor((Date.now() - Date.parse(info.toDate)) / 86400000);
    if (staleDays > 60) {
      notice.push(
        `${section} は ${info.toDate} で系列が終わっています` +
          `(2022年4月の市場区分再編で終了した系列の可能性があります)。` +
          `再編をまたいで連続しているのは TokyoNagoya です。`
      );
    }

    const key = JSON.stringify(['demand:macro', section, weeks]);
    const rows = await withCache(key, CACHE_TTL_MS, () =>
      db.withConnection((conn) => demandQuery.fetchMacro(conn, { section, weeksBack: weeks }))
    );
    res.json({ params: { section, weeks }, sectionInfo: info, notice, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 第二階層
app.get('/api/demand/watchlist', async (req, res, next) => {
  try {
    const [rows, meta] = await Promise.all([
      withCache('demand:watchlist', CACHE_TTL_MS, () =>
        db.withConnection((conn) => demandQuery.fetchWatchlistSheet(conn))
      ),
      getDemandMeta(),
    ]);
    res.json({ count: rows.length, rows, lvsDocs: meta.lvsDocs });
  } catch (err) {
    next(err);
  }
});

// 疑似浮動株比率。**JPXの公式な浮動株比率ではない。**
// 絶対値は信用せず、銘柄間の相対比較と経年の変化方向にだけ使う。
app.get('/api/demand/pseudo-float', async (req, res, next) => {
  try {
    const rows = await withCache('demand:pseudoFloat', CACHE_TTL_MS, () =>
      db.withConnection((conn) => demandQuery.fetchPseudoFloat(conn))
    );
    res.json({ count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

// 銘柄詳細(時系列・現在の大量保有者・提出履歴)
app.get('/api/demand/detail', async (req, res, next) => {
  try {
    if (!req.query.code) throw new BadRequest('銘柄コードを指定してください');
    const code = normalizeCode(req.query.code);
    const weeks = parseWeeks(req.query.weeks, 104);

    const key = JSON.stringify(['demand:detail', code, weeks]);
    const data = await withCache(key, CACHE_TTL_MS, () =>
      db.withConnection(async (conn) => {
        const [timeseries, holders, history] = await Promise.all([
          demandQuery.fetchCodeTimeseries(conn, code, weeks),
          demandQuery.fetchCodeHolders(conn, code),
          demandQuery.fetchCodeLvsHistory(conn, code, 200),
        ]);
        return { timeseries, holders, history };
      })
    );
    res.json({ params: { code, weeks }, ...data });
  } catch (err) {
    next(err);
  }
});

//---------------------------------------------------------- 第三階層
app.get('/api/demand/signals', async (req, res, next) => {
  try {
    const rows = await withCache('demand:signals', CACHE_TTL_MS, () =>
      db.withConnection((conn) => demandQuery.fetchSignals(conn))
    );
    res.json({ scope: 'watchlist', count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

// 全銘柄版。**重い**(全銘柄 × 15か月の信用残を走査する)。
// 画面から明示的に押されたときだけ実行する。毎日流す必要は無い。
app.get('/api/demand/signals/all', async (req, res, next) => {
  try {
    const rows = await withCache('demand:signalsAll', CACHE_TTL_HEAVY_MS, () =>
      db.withConnection((conn) => demandQuery.fetchSignalsAll(conn))
    );
    res.json({ scope: 'all', count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/demand/supplementary', async (req, res, next) => {
  try {
    const rows = await withCache('demand:supplementary', CACHE_TTL_MS, () =>
      db.withConnection((conn) => demandQuery.fetchSupplementary(conn))
    );
    res.json({ count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

//==================================================================
// 日々の確認 (/daily)
//   保有・ウォッチ・検討中の銘柄の出来事・値動きと、これからの予定。前回「確認した」日時から今まで。
//   データは dailyQuery.js、表は ddl/32_daily_seen.sql、設計は claude/daily_page_design.md。
//   確認した日時で中身が変わるのでキャッシュしない。
//==================================================================
app.get(['/daily', '/daily/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'daily.html'));
});

app.get('/api/daily', async (req, res, next) => {
  try {
    const date = req.query.date ? parseDate(String(req.query.date), '日付') : null;
    const out = await db.withConnection(async (conn) => {
      const seen = await dailyQuery.fetchSeen(conn);
      const seenOk = seen && !seen.missing ? seen : null;
      let opts;
      if (date) opts = { mode: 'date', fromDate: date };
      else if (seenOk) opts = { mode: 'seen', sinceUtc: seenOk.utc, sinceJstDate: seenOk.jst.slice(0, 10) };
      else opts = { mode: 'first' };
      const d = await dailyQuery.fetchDaily(conn, opts);
      d.seen = seenOk ? { jst: seenOk.jst } : null;
      d.seenTableMissing = Boolean(seen && seen.missing);
      return d;
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// 過去の確認の一覧と、1件の内容(残した JSON をそのまま返す。画面は今と同じ描き方で出す)
app.get('/api/daily/history', async (req, res, next) => {
  try {
    const rows = await db.withConnection((conn) => dailyQuery.fetchHistory(conn));
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/daily/history/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequest('確認の番号が不正です');
    const item = await db.withConnection((conn) => dailyQuery.fetchHistoryItem(conn, id));
    if (!item) {
      res.status(404).json({ error: 'その確認はありません' });
      return;
    }
    if (!item.payload) throw new BadRequest('この確認は内容が残っていません(ddl/33 を流す前に押した確認)');
    res.type('application/json').send(`{"jst":${JSON.stringify(item.jst)},"payload":${item.payload}}`);
  } catch (err) {
    next(err);
  }
});

// 「確認した」: 押したときに画面に出ていた内容(GET /api/daily の結果そのもの)を受け取って残す
app.post('/api/daily/seen', express.json({ limit: '5mb' }), async (req, res, next) => {
  try {
    const p = req.body && req.body.payload;
    if (!p || typeof p !== 'object' || !Array.isArray(p.events) || !Array.isArray(p.moves)) {
      throw new BadRequest('画面の内容(payload)がありません');
    }
    const seen = await db.withConnection((conn) => dailyQuery.insertSeen(conn, JSON.stringify(p)));
    res.json({ seen: seen && !seen.missing ? { jst: seen.jst } : null, payloadSaved: Boolean(seen && seen.payloadSaved) });
  } catch (err) {
    if (err && err.errorNum === 942) {
      next(new BadRequest('確認した日時の表がありません。ddl/32_daily_seen.sql を GD_JQUANTS で流してください'));
      return;
    }
    next(err);
  }
});

//==================================================================
// 市場 (/market)
//   1枚の表(行 = 項目、列 = 前の週の月曜から今日まで)。データと列の置き方は marketQuery.js 冒頭、
//   設計は claude/market_page_design.md。米国3指数と日経先物は Yahoo Finance から取り、DBには保存しない。
//==================================================================
const MARKET_TTL_MS = 10 * 60 * 1000;
// Yahoo が取れなかったときは、10分待たせずに1分で取り直す
const MARKET_RETRY_MS = 60 * 1000;
// 日経先物の現在値は、開いた時点の値段を見たいので1分(2026-10-19 ユーザー判断)
const MARKET_LIVE_TTL_MS = 60 * 1000;

app.get(['/market', '/market/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'market.html'));
});

app.get('/api/market', async (req, res, next) => {
  try {
    const now = Date.now();
    const today = marketQuery.ymdIn(new Date(now), marketQuery.TZ_JP);
    const from = marketQuery.periodStart(today);

    const dbPart = await withCache('market:db:' + today, MARKET_TTL_MS, () =>
      db.withConnection((conn) =>
        marketQuery.fetchDbPart(conn, {
          lookFrom: marketQuery.addDays(from, -14), // 前日比・期間前比のため
          weekFrom: marketQuery.addDays(from, -35), // 週次の前回比のため
          histFrom: marketQuery.addDays(from, -380), // Zスコアの平均・標準偏差(過去1年)のため
          to: today,
        })
      )
    );

    const extKey = 'market:ext:' + today;
    let ext = cacheGet(extKey);
    if (!ext) {
      ext = await marketQuery.fetchExternalPart(now);
      cacheSet(extKey, ext, ext.errors.length ? MARKET_RETRY_MS : MARKET_TTL_MS);
    }

    let live = cacheGet('market:live');
    if (!live) {
      live = await marketQuery.fetchLivePart(now);
      cacheSet('market:live', live, MARKET_LIVE_TTL_MS);
    }

    res.json(marketQuery.buildMarketTable({ today, db: dbPart, ext, live }));
  } catch (err) {
    next(err);
  }
});

//==================================================================
// 参考情報 (/reference)
//   1つのテーマを1枚の表で出す。テーマと決めごとは src/web/referenceQuery.js の冒頭。
//   設計は Project の claude/reference_page_design.md
//==================================================================
const REFERENCE_TTL_MS = 10 * 60 * 1000;

function referenceMeta() {
  return withCache('reference:meta', REFERENCE_TTL_MS, () => db.withConnection((conn) => referenceQuery.fetchMeta(conn)));
}

app.get(['/reference', '/reference/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reference.html'));
});

app.get('/api/reference/meta', async (req, res, next) => {
  try {
    res.json(await referenceMeta());
  } catch (err) {
    next(err);
  }
});

app.get('/api/reference', async (req, res, next) => {
  try {
    const meta = await referenceMeta();
    const theme = String(req.query.theme || '');
    if (!referenceQuery.THEMES.some((t) => t.key === theme)) throw new BadRequest(`テーマが不正です: "${theme}"`);
    const date = req.query.date ? parseDate(String(req.query.date), '日付') : meta.latestDate;
    if (!date) throw new BadRequest('株価がまだありません');
    let sectors = [];
    if (req.query.sectors) {
      const known = new Set(meta.sectors.map((s) => s.code));
      sectors = Array.from(new Set(String(req.query.sectors).split(',').map((s) => s.trim()).filter(Boolean)));
      const unknown = sectors.filter((s) => !known.has(s));
      if (unknown.length) throw new BadRequest(`存在しない業種コードです: ${unknown.join(', ')}`);
    }
    const n = parseInt0(req.query.n, '業種ごとの件数', 1, 50, 5);
    const minStreak = parseInt0(req.query.minStreak, '最低連続日数', 2, referenceQuery.STREAK_WINDOW, 5);
    const minTv = Number(req.query.minTv === undefined || req.query.minTv === '' ? 1 : req.query.minTv);
    if (!Number.isFinite(minTv) || minTv < 0 || minTv > 10000) throw new BadRequest('売買代金の下限は 0〜10000(億円)で指定してください');
    const includeTbd = parseBool(req.query.includeTbd, false);
    const opts = { theme, date, sectors, n, minStreak, minTv, includeTbd };
    const key = 'reference:' + JSON.stringify(opts);
    const data = await withCache(key, REFERENCE_TTL_MS, () =>
      db.withConnection((conn) => referenceQuery.fetchReference(conn, opts)));
    res.json({ params: opts, ...data });
  } catch (err) {
    next(err);
  }
});

//==================================================================
// 材料 (/events)
//   縦長の月間カレンダー。数字と見出しは src/loadEventCalendar.js が DB に取り込んだもの(Mac で毎日1回)。
//   設計は Project の claude/event_calendar_design.md
//==================================================================
const EVENTS_TTL_MS = 10 * 60 * 1000;

app.get(['/events', '/events/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'events.html'));
});

app.get('/api/events', async (req, res, next) => {
  try {
    const todayUs = marketQuery.ymdIn(new Date(), 'America/New_York');
    const period = eventsQuery.resolvePeriod(req.query, todayUs.slice(0, 7));
    const data = await withCache(`events:${period.from}:${period.to}`, EVENTS_TTL_MS, () =>
      db.withConnection((conn) => eventsQuery.fetchEvents(conn, period))
    );
    res.json(eventsQuery.buildCalendar(period, data, todayUs));
  } catch (err) {
    next(err);
  }
});

//==================================================================
// 売買記録 (/journal)
//   判断は追記のみ・保有は約定から計算・写真は画面側で縮小、の約束は journalRoutes.js 冒頭。
//==================================================================
// タグを付け直したら、騰落率一覧のタグ件数・結果のキャッシュ(5分)を捨てる
app.use(journalRoutes({ db, onTagsChanged: () => cache.clear() }));

//==================================================================
// 銘柄購入の流れ (/purchase)
//   購入検討リスト → 参考情報 → 損失回避チェック → 判断メモ。約束は purchaseRoutes.js 冒頭、
//   設計は claude/purchase_flow_design.md。タグ一覧は騰落率一覧と同じキャッシュ(getMeta)を使う。
//==================================================================
app.use(purchaseRoutes({ db, getTags: getMeta }));

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
