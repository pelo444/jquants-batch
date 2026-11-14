'use strict';

/**
 * 個別チャート(/stockchart)のデータ取得。1銘柄の日足・信用残・決算発表日を、取込済みの全期間ぶん返す。
 *
 * 【返すのは日足だけ】
 *   週足・月足は画面側で日足からまとめる(public/stockchartCalc.js)。移動平均線・高安値も画面側。
 *   1銘柄10年で約2,450行なので、全期間をまとめて返しても軽い。足種や期間を変えるたびに DB へ行かない。
 *
 * 【株価の調整】(technicals.js の adjust と同じ決まり)
 *   四本値には「その日より後の AdjFactor の累積積」を掛けて、今の株数の水準にそろえる。
 *   出来高と信用残(株数)は同じ累積積で割る(2:1 の分割なら過去の株数を 2 倍にする)。
 *   値が付かなかった日(終値が NULL)は足を作らない。ただし AdjFactor はその日のぶんも累積に入れる。
 *
 * 【信用残】
 *   equity_margin_interest をそのまま使う。2026/9/24 以前は週末時点(週1回)、9/25 以降は日次。
 *   無い日は「無い」のまま返す(0 で埋めない)。線をどこで切るかは画面側で決める。
 *
 * 【決算発表日】
 *   financial_summary のうち決算短信(doc_type に FinancialStatements を含むもの)の開示日。
 *   業績予想の修正・配当予想の修正だけの開示は含めない。同じ日に複数あれば1つにまとめる。
 */

const oracledb = require('oracledb');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };

/** 4桁で出す(66130 → 6613)。画面の表示と同じ */
function shortCode(c) { return c && c.length === 5 && c[4] === '0' ? c.slice(0, 4) : c; }

/** 浮動小数の端数を落とす(調整後の値を JSON にするとき 1234.5000000001 のようにしない) */
function round4(x) { return Math.round(x * 10000) / 10000; }

/**
 * 日足を調整して、列ごとの配列にする(純粋関数)。
 * @param {Array<{d:string,o:number,h:number,l:number,c:number,v:number,af:number}>} rows 昇順
 * @returns {{d:string[],o:number[],h:number[],l:number[],c:number[],v:number[],splits:Array<{d:string,af:number}>}}
 */
function adjustDaily(rows) {
  const n = rows.length;
  const cum = new Array(n);
  let f = 1;
  for (let i = n - 1; i >= 0; i--) {
    cum[i] = f; // その日より後の係数だけを掛ける
    const af = rows[i].af != null && rows[i].af !== 0 ? Number(rows[i].af) : 1;
    f *= af;
  }
  const out = { d: [], o: [], h: [], l: [], c: [], v: [], splits: [] };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (r.af != null && Number(r.af) !== 1 && Number(r.af) !== 0) out.splits.push({ d: r.d, af: Number(r.af) });
    if (r.c == null) continue;
    const k = cum[i];
    const c = r.c * k;
    // 始値・高値・安値だけ欠けている行は終値で埋める(足は横棒1本になる)
    out.d.push(r.d);
    out.o.push(round4(r.o != null ? r.o * k : c));
    out.h.push(round4(r.h != null ? r.h * k : c));
    out.l.push(round4(r.l != null ? r.l * k : c));
    out.c.push(round4(c));
    out.v.push(r.v != null ? Math.round(r.v / k) : 0);
  }
  return out;
}

/**
 * 信用残の株数を今の株数の水準にそろえる(純粋関数)。
 * @param {Array<{d:string,long:number,short:number}>} rows 申込日の昇順
 * @param {Array<{d:string,af:number}>} splits 分割などの日(昇順)
 */
function adjustMargin(rows, splits) {
  const out = { d: [], long: [], short: [] };
  for (const r of rows) {
    let k = 1;
    for (const s of splits) if (s.d > r.d) k *= s.af;
    out.d.push(r.d);
    out.long.push(r.long != null ? Math.round(r.long / k) : null);
    out.short.push(r.short != null ? Math.round(r.short / k) : null);
  }
  return out;
}

/** 決算期の種類の表示(1Q・2Q・3Q・本決算) */
function periodLabel(perType) {
  if (perType === 'FY') return '本決算';
  return perType || '決算';
}

/** 同じ日の開示を1つにまとめる(純粋関数)。rows は開示日・開示番号の昇順 */
function mergeEarnings(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    const label = periodLabel(r.perType);
    if (last && last.d === r.d) {
      if (last.label.split('・').indexOf(label) < 0) last.label += '・' + label;
      continue;
    }
    out.push({ d: r.d, time: r.time ? String(r.time).slice(0, 5) : null, label });
  }
  return out;
}

/**
 * @param {oracledb.Connection} conn
 * @param {string} code 5桁の銘柄コード
 * @returns {Promise<object|null>} 銘柄マスタに無いコードは null
 */
async function fetchStockChart(conn, code) {
  const m = await conn.execute(
    `SELECT code, co_name, market_name, sector33_name, delisted_flag
       FROM equity_master WHERE code = :code`, { code }, OBJ);
  if (m.rows.length === 0) return null;
  const master = m.rows[0];

  const p = await conn.execute(
    `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d,
            open_price AS o, high_price AS h, low_price AS l, close_price AS c, volume AS v, adj_factor AS af
       FROM equity_price_daily
      WHERE code = :code
      ORDER BY price_date`, { code }, OBJ);
  const daily = adjustDaily(p.rows.map((x) => ({ d: x.D, o: x.O, h: x.H, l: x.L, c: x.C, v: x.V, af: x.AF })));

  const mg = await conn.execute(
    `SELECT TO_CHAR(app_date, 'YYYY-MM-DD') AS d, long_vol, shrt_vol
       FROM equity_margin_interest
      WHERE code = :code
      ORDER BY app_date`, { code }, OBJ);
  const margin = adjustMargin(mg.rows.map((x) => ({ d: x.D, long: x.LONG_VOL, short: x.SHRT_VOL })), daily.splits);

  const e = await conn.execute(
    `SELECT TO_CHAR(disc_date, 'YYYY-MM-DD') AS d, disc_time, cur_per_type
       FROM financial_summary
      WHERE code = :code AND doc_type LIKE '%FinancialStatements%'
      ORDER BY disc_date, disc_no`, { code }, OBJ);
  const earnings = mergeEarnings(e.rows.map((x) => ({ d: x.D, time: x.DISC_TIME, perType: x.CUR_PER_TYPE })));

  return {
    code,
    shortCode: shortCode(code),
    name: master.CO_NAME,
    market: master.MARKET_NAME || '',
    sector: master.SECTOR33_NAME || '',
    delisted: master.DELISTED_FLAG === 'Y',
    d: daily.d, o: daily.o, h: daily.h, l: daily.l, c: daily.c, v: daily.v,
    margin,
    earnings,
  };
}

module.exports = { fetchStockChart, _internal: { adjustDaily, adjustMargin, mergeEarnings, periodLabel } };
