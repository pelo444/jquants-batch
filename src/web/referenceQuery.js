'use strict';

/**
 * 参考情報(/reference)のデータ。1つのテーマを1枚の表で出す。設計は Project の claude/reference_page_design.md。
 *
 * 【テーマ】(2026-10-20 ユーザー指定。これまで騰落率一覧から自分で拾っていたもの)
 *   down_up_sectors  TOPIX が下げた日に上がった業種と、その業種の中の値上がり上位 N 銘柄
 *   up_down_sectors  TOPIX が上げた日に下がった業種と、その業種の中の値下がり上位 N 銘柄
 *   up_streak        指定日まで値上がりが続いている銘柄(連続 minStreak 日以上)
 *   down_streak      指定日まで値下がりが続いている銘柄(連続 minStreak 日以上)
 *   earnings_schedule 指定日以降の決算発表予定(DB にあるものすべて。2026-10-21 追加)
 *
 * 【決めごと】
 *   - 市場全体の判定は TOPIX(INDEX_PRICE_DAILY の 0000)。業種は東証業種別指数(0040〜0060)
 *   - 日付は日本の営業日 = TOPIX の終値がある日。休みの日を指定したら、その前の営業日にする
 *   - 前日比は分割を調整する: 終値 ÷ (前日終値 × その日の ADJ_FACTOR) − 1
 *   - 「続いている」は、毎日の終値が前日(分割調整後)より高い(低い)日が指定日まで途切れずに続くこと。
 *     変わらずは途切れ扱い。見るのは指定日から遡って STREAK_WINDOW 営業日まで(それ以上は「以上」と出す)
 *   - 業種のテーマで、TOPIX の向きがテーマと合わない日(下げた日のテーマで TOPIX が上げた日)も、
 *     逆向きの業種を出したうえで、そのことを notice で知らせる
 *   - 対象は ETF・REIT 等(17業種 99)・上場廃止・TOKYO PRO MARKET を除いた銘柄
 *   - 売買代金の下限(億円)は指定日の売買代金で見る。業種のテーマで、売買の少ない小型株が上位を埋めるのを避けるため
 *   - 33業種の名前は銘柄マスタが半角の中黒「･」、指数名が全角「・」なので、そろえて突き合わせる
 *   - 決算発表予定は EARNINGS_SCHEDULE(公表日ごとの履歴)の、銘柄×決算区分で最新の公表(V_EARNINGS_SCHEDULE_LATEST と同じ選び方)。
 *     指定日は営業日に読み替えない。予定日が前の公表から変わっていれば、前の予定日(未定なら「未定」)を添える
 *     (前の公表が SCHEDULE_CHANGE_DAYS 日以内のものだけ。去年の同じ四半期と比べないため)
 */

const THEMES = [
  { key: 'down_up_sectors', label: 'TOPIXが下げた日に上がった業種と、その値上がり上位', kind: 'sector', market: -1 },
  { key: 'up_down_sectors', label: 'TOPIXが上げた日に下がった業種と、その値下がり上位', kind: 'sector', market: 1 },
  { key: 'up_streak', label: '値上がりが続いている銘柄', kind: 'streak', dir: 1 },
  { key: 'down_streak', label: '値下がりが続いている銘柄', kind: 'streak', dir: -1 },
  { key: 'earnings_schedule', label: '決算発表の予定(指定日以降)', kind: 'schedule' },
];
const SCHEDULE_CHANGE_DAYS = 120;
const FQ_LABEL = { '1Q': '第1四半期', '2Q': '第2四半期', '3Q': '第3四半期', FY: '本決算' };
const STREAK_WINDOW = 60;  // 遡る営業日数
const STREAK_LIMIT = 500;  // 継続のテーマで出す最大件数
const RECENT_DAYS = 20;    // 日付の候補として出す、直近の TOPIX の前日比

const TARGET_FILTER = `NVL(em.sector17_code, '0') <> '99' AND em.delisted_flag = 'N'
       AND (em.market_name IS NULL OR em.market_name <> 'TOKYO PRO MARKET')`;

const normName = (s) => String(s || '').replace(/･/g, '・');

function sectorBinds(sectors, binds) {
  return sectors.map((s, i) => { binds['sc' + i] = s; return ':sc' + i; }).join(', ');
}

//------------------------------------------------------------------ メタ
async function fetchMeta(conn) {
  const sec = await conn.execute(
    `SELECT sector33_code, MIN(sector33_name) FROM equity_master em
      WHERE ${TARGET_FILTER} AND sector33_code IS NOT NULL
      GROUP BY sector33_code ORDER BY sector33_code`);
  const recent = await conn.execute(
    `SELECT TO_CHAR(price_date, 'YYYY-MM-DD'), ROUND((close_price / prev - 1) * 100, 2) FROM (
       SELECT price_date, close_price, LAG(close_price) OVER (ORDER BY price_date) prev
         FROM index_price_daily WHERE index_code = '0000' AND price_date >= SYSDATE - 60)
      WHERE prev IS NOT NULL ORDER BY price_date DESC FETCH FIRST ${RECENT_DAYS} ROWS ONLY`);
  return {
    themes: THEMES.map(({ key, label, kind }) => ({ key, label, kind })),
    sectors: sec.rows.map(([code, name]) => ({ code, name: normName(name) })),
    recentTopix: recent.rows.map(([date, chg]) => ({ date, chg })),
    latestDate: recent.rows.length ? recent.rows[0][0] : null,
  };
}

/** 指定日以前で最も新しい営業日と、その前の営業日 */
async function resolveDay(conn, date) {
  const r = await conn.execute(
    `SELECT TO_CHAR(d, 'YYYY-MM-DD'),
            TO_CHAR((SELECT MAX(price_date) FROM index_price_daily WHERE index_code = '0000' AND price_date < d), 'YYYY-MM-DD')
       FROM (SELECT MAX(price_date) d FROM index_price_daily WHERE index_code = '0000'
              AND price_date <= TO_DATE(:d, 'YYYY-MM-DD'))`, { d: date });
  const [day, prev] = r.rows[0] || [];
  return { day: day || null, prev: prev || null };
}

//------------------------------------------------------------------ 業種のテーマ
async function fetchSectorTheme(conn, theme, { day, prev, sectors, n, minTv }) {
  const binds = { d: day, p: prev };
  const topix = await conn.execute(
    `SELECT ROUND((c.close_price / p.close_price - 1) * 100, 2) FROM index_price_daily c
       JOIN index_price_daily p ON p.index_code = c.index_code AND p.price_date = TO_DATE(:p, 'YYYY-MM-DD')
      WHERE c.index_code = '0000' AND c.price_date = TO_DATE(:d, 'YYYY-MM-DD')`, binds);
  const topixChg = topix.rows.length ? topix.rows[0][0] : null;

  const secRows = await conn.execute(
    `SELECT REPLACE(m.index_name, '東証業種別 ', ''), (c.close_price / p.close_price - 1) * 100
       FROM index_price_daily c
       JOIN index_price_daily p ON p.index_code = c.index_code AND p.price_date = TO_DATE(:p, 'YYYY-MM-DD')
       JOIN index_master m ON m.index_code = c.index_code
      WHERE c.price_date = TO_DATE(:d, 'YYYY-MM-DD') AND c.index_code BETWEEN '0040' AND '0060'`, binds);
  const secChg = new Map(secRows.rows.map(([nm, chg]) => [normName(nm), chg]));

  const secFilter = sectors.length ? `AND em.sector33_code IN (${sectorBinds(sectors, binds)})` : '';
  const st = await conn.execute(
    `SELECT em.sector33_code, em.sector33_name, em.code, em.co_name,
            (c.close_price / (p.close_price * NVL(NULLIF(c.adj_factor, 0), 1)) - 1) * 100 AS r,
            c.close_price, c.turnover_value
       FROM equity_price_daily c
       JOIN equity_price_daily p ON p.code = c.code AND p.price_date = TO_DATE(:p, 'YYYY-MM-DD')
       JOIN equity_master em ON em.code = c.code
      WHERE c.price_date = TO_DATE(:d, 'YYYY-MM-DD') AND c.close_price IS NOT NULL AND p.close_price > 0
        AND ${TARGET_FILTER} ${secFilter}`, binds);

  return buildSectorTable(theme, { day, prev, topixChg, secChg, stocks: st.rows, n, minTv });
}

/** 純粋関数(テスト用に分けている) */
function buildSectorTable(theme, { day, prev, topixChg, secChg, stocks, n, minTv }) {
  const dir = -theme.market;
  const by = new Map(); // 業種名 → {code, name, up, down, flat, list}
  for (const [scode, sname, code, name, r, close, tv] of stocks) {
    const nm = normName(sname);
    if (!by.has(nm)) by.set(nm, { sectorCode: scode, name: nm, up: 0, down: 0, flat: 0, list: [] });
    const g = by.get(nm);
    if (r > 0) g.up++; else if (r < 0) g.down++; else g.flat++;
    if (r * dir > 0 && (tv || 0) >= minTv * 1e8) g.list.push({ code, name, chg: r, close, tvOku: tv == null ? null : tv / 1e8 });
  }
  const groups = [];
  for (const g of by.values()) {
    const chg = secChg.get(g.name);
    if (chg == null || chg * dir <= 0) continue;
    g.list.sort((a, b) => (b.chg - a.chg) * dir || a.code.localeCompare(b.code));
    groups.push({ sectorCode: g.sectorCode, name: g.name, chg, up: g.up, down: g.down, flat: g.flat, stocks: g.list.slice(0, n) });
  }
  groups.sort((a, b) => (b.chg - a.chg) * dir);

  const notice = [];
  if (topixChg != null && topixChg * theme.market <= 0) {
    notice.push(`この日の TOPIX は ${topixChg > 0 ? '+' : ''}${topixChg.toFixed(2)}% で、${theme.market < 0 ? '下げた' : '上げた'}日ではありません。参考として${dir > 0 ? '上がった' : '下がった'}業種を出しています`);
  }
  return { kind: 'sector', day, prev, topixChg, groups, notice };
}

//------------------------------------------------------------------ 継続のテーマ
async function fetchStreakTheme(conn, theme, { day, sectors, minStreak, minTv }) {
  const binds = { d: day, dir: theme.dir, minStreak, minTv: minTv * 1e8 };
  const secFilter = sectors.length ? `AND em.sector33_code IN (${sectorBinds(sectors, binds)})` : '';
  const sql = `
    WITH days AS (
        SELECT price_date FROM index_price_daily
         WHERE index_code = '0000' AND price_date <= TO_DATE(:d, 'YYYY-MM-DD')
         ORDER BY price_date DESC FETCH FIRST ${STREAK_WINDOW + 1} ROWS ONLY
    ),
    target AS (SELECT em.code FROM equity_master em WHERE ${TARGET_FILTER} ${secFilter}),
    px AS (
        SELECT p.code, p.price_date, p.close_price, p.adj_factor, p.turnover_value,
               LAG(p.close_price) OVER (PARTITION BY p.code ORDER BY p.price_date) AS prev_close
          FROM equity_price_daily p
         WHERE p.close_price IS NOT NULL
           AND p.price_date BETWEEN (SELECT MIN(price_date) FROM days) AND TO_DATE(:d, 'YYYY-MM-DD')
           AND p.code IN (SELECT code FROM target)
    ),
    s AS (
        SELECT code, price_date, close_price, turnover_value,
               CASE WHEN prev_close > 0 THEN LN(close_price / (prev_close * NVL(NULLIF(adj_factor, 0), 1))) END AS lr,
               ROW_NUMBER() OVER (PARTITION BY code ORDER BY price_date DESC) AS rn
          FROM px
    ),
    k AS (
        -- 指定日から遡って、向きが違う(または前日が無い)最初の日の手前までが連続
        SELECT code,
               MAX(CASE WHEN rn = 1 THEN price_date END) AS last_d,
               MAX(CASE WHEN rn = 1 THEN close_price END) AS last_close,
               MAX(CASE WHEN rn = 1 THEN turnover_value END) AS last_tv,
               NVL(MIN(CASE WHEN lr IS NULL OR SIGN(lr) <> :dir THEN rn END), COUNT(*) + 1) - 1 AS streak
          FROM s GROUP BY code
    ),
    agg AS (
        SELECT s.code, SUM(s.lr) AS slr, MIN(s.price_date) AS d_start
          FROM s JOIN k ON k.code = s.code
         WHERE s.rn <= k.streak AND k.streak >= :minStreak
         GROUP BY s.code
    )
    SELECT k.code, em.co_name, em.sector33_name, k.streak,
           TO_CHAR(agg.d_start, 'YYYY-MM-DD'), (EXP(agg.slr) - 1) * 100, k.last_close, k.last_tv
      FROM k
      JOIN agg ON agg.code = k.code
      JOIN equity_master em ON em.code = k.code
     WHERE k.last_d = TO_DATE(:d, 'YYYY-MM-DD')
       AND NVL(k.last_tv, 0) >= :minTv
     ORDER BY k.streak DESC, (EXP(agg.slr) - 1) * :dir DESC, k.code
     FETCH FIRST ${STREAK_LIMIT + 1} ROWS ONLY`;
  const r = await conn.execute(sql, binds);
  const rows = r.rows.slice(0, STREAK_LIMIT).map(([code, name, sector, streak, start, ret, close, tv]) => ({
    code, name, sector33: normName(sector), streak, capped: streak >= STREAK_WINDOW, startDate: start,
    chg: ret, close, tvOku: tv == null ? null : tv / 1e8,
  }));
  const notice = [];
  if (r.rows.length > STREAK_LIMIT) notice.push(`${STREAK_LIMIT}件を超えたので、連続日数の長い順に${STREAK_LIMIT}件だけ出しています`);
  return { kind: 'streak', day, rows, window: STREAK_WINDOW, notice };
}

//------------------------------------------------------------------ 決算発表の予定
async function fetchSchedule(conn, { date, sectors, includeTbd }) {
  const binds = { d: date };
  const secFilter = sectors.length ? `AND em.sector33_code IN (${sectorBinds(sectors, binds)})` : '';
  const sql = `
    WITH h AS (
        SELECT e.code, e.fq_name, e.fye, e.pub_date, e.sch_date, e.co_name,
               LAG(e.sch_date) OVER (PARTITION BY e.code, e.fq_name ORDER BY e.pub_date) AS prev_sch,
               LAG(e.pub_date) OVER (PARTITION BY e.code, e.fq_name ORDER BY e.pub_date) AS prev_pub,
               ROW_NUMBER() OVER (PARTITION BY e.code, e.fq_name ORDER BY e.pub_date DESC) AS rn
          FROM earnings_schedule e
    ),
    last_day AS (SELECT MAX(price_date) AS d FROM index_price_daily WHERE index_code = '0000')
    SELECT TO_CHAR(h.sch_date, 'YYYY-MM-DD'), h.fq_name, h.fye, h.code, NVL(em.co_name, h.co_name),
           em.sector33_name, em.market_name, TO_CHAR(h.pub_date, 'YYYY-MM-DD'),
           CASE WHEN h.prev_pub >= h.pub_date - ${SCHEDULE_CHANGE_DAYS} AND DECODE(h.prev_sch, h.sch_date, 0, 1) = 1
                THEN 1 ELSE 0 END AS changed,
           TO_CHAR(h.prev_sch, 'YYYY-MM-DD'),
           px.turnover_value
      FROM h
      LEFT JOIN equity_master em ON em.code = h.code
      LEFT JOIN equity_price_daily px ON px.code = h.code AND px.price_date = (SELECT d FROM last_day)
     WHERE h.rn = 1
       AND (h.sch_date >= TO_DATE(:d, 'YYYY-MM-DD') ${includeTbd ? 'OR h.sch_date IS NULL' : ''})
       ${secFilter}
     ORDER BY h.sch_date NULLS LAST, px.turnover_value DESC NULLS LAST, h.code`;
  const r = await conn.execute(sql, binds);
  const rows = r.rows.map(([sch, fq, fye, code, name, sector, market, pub, changed, prevSch, tv]) => ({
    date: sch, fq, fqLabel: FQ_LABEL[fq] || fq, fye, fyeMonth: fye ? Number(fye.slice(0, 2)) : null,
    code, name, sector33: normName(sector), market, pubDate: pub,
    changed: changed === 1, prevDate: prevSch, tvOku: tv == null ? null : tv / 1e8,
  }));
  return { kind: 'schedule', day: date, rows, notice: [] };
}

//------------------------------------------------------------------ 入口
async function fetchReference(conn, opts) {
  const theme = THEMES.find((t) => t.key === opts.theme);
  if (!theme) throw new Error('unknown theme');
  if (theme.kind === 'schedule') {
    const res = await fetchSchedule(conn, { date: opts.date, sectors: opts.sectors, includeTbd: opts.includeTbd });
    return { theme: theme.key, themeLabel: theme.label, ...res };
  }
  const { day, prev } = await resolveDay(conn, opts.date);
  if (!day || !prev) return { theme: theme.key, kind: theme.kind, day: null, empty: true, notice: ['指定日以前の株価がありません'] };
  const res = theme.kind === 'sector'
    ? await fetchSectorTheme(conn, theme, { day, prev, sectors: opts.sectors, n: opts.n, minTv: opts.minTv })
    : await fetchStreakTheme(conn, theme, { day, sectors: opts.sectors, minStreak: opts.minStreak, minTv: opts.minTv });
  if (day !== opts.date) res.notice.unshift(`${opts.date} は営業日ではないので、その前の営業日 ${day} で出しています`);
  return { theme: theme.key, themeLabel: theme.label, ...res };
}

module.exports = { THEMES, STREAK_WINDOW, fetchMeta, fetchReference, buildSectorTable, normName };
