'use strict';

/**
 * 個別チャート(/stockchart)の最下段「決算」の一覧。1銘柄の financial_summary を、直近5年ぶん表にして返す。
 *
 * 【行】
 *   開示1件 = 1行(新しい順)。決算短信・業績予想の修正・配当予想の修正。訂正で同じ期の短信が2件出れば2行。
 *   表は4つ。
 *     actual   … 実績(決算短信だけ)。四半期は期首からの累計(短信の書き方のまま)
 *     forecast … 業績予想(決算短信・業績予想の修正)。四半期の短信と修正は今期、本決算の短信は来期の予想
 *     dividend … 配当(決算短信・配当予想の修正・業績予想の修正のうち配当の値があるもの)
 *     balance  … 財務・キャッシュフロー・株式数・変更の有無(決算短信だけ)
 *
 * 【連結・非連結】
 *   決算短信は、非連結の会社でも SALES などの列に入っている。そのまま使う。
 *   業績予想の修正は、非連結の会社だと F_* が空で FNC_*(非連結の列)に入っている(全 26,849 件のうち 3,453 件)。
 *   F_* がどれも空なら FNC_* を使う。連結の会社の FNC_*(親会社単体の予想)は出さない。
 *
 * 【前年同期比】(ddl/38 の v_earn_yoy と同じ相手)
 *   期の種類(1Q/2Q/3Q/FY)が同じで、期末日がちょうど12か月前の決算短信。同じ期に複数あれば連結を優先し、その中で一番新しい開示。
 *   前年が0より大きいときは増減率(%)。前年が0以下のときは 黒字転換・赤字縮小・赤字拡大 のことば。前年が正で今年が負なら 赤字転落。
 *   営業利益率は前年同期との差(ポイント)。
 *   EPS は、2つの開示の間に分割・併合があれば前年の値に AdjFactor を掛けて(株価と同じ向き)今の株数にそろえてから比べる(表に出す値は開示のまま)。
 *
 * 【単位】金額は百万円(決算短信と同じ)。1株あたりは円。比率は % で返す(DB は 0.384 のような小数)。
 */

const oracledb = require('oracledb');

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const YEARS = 5;

const MIL = 1e6;

function num(v) { return v == null ? null : Number(v); }
function mil(v) { return v == null ? null : Math.round(Number(v) / MIL); }
function pct(v) { return v == null ? null : Math.round(Number(v) * 1000) / 10; }
function isStatement(docType) { return /FinancialStatements/.test(docType || ''); }
function isCons(docType) { return !/NonConsolidated/.test(docType || ''); }

/** 期の表示。cur_fy_en '2027-03-31' → '27/3期' */
function fyLabel(fyEn) {
  if (!fyEn) return '';
  return fyEn.slice(2, 4) + '/' + Number(fyEn.slice(5, 7)) + '期';
}
function perLabel(perType) { return perType === 'FY' ? '本決算' : perType === 'Other' ? 'その他' : (perType || ''); }

/** 決算短信の書類の種類から、連結・非連結と会計基準のことば */
function basisLabel(docType) {
  const t = docType || '';
  const scope = /NonConsolidated/.test(t) ? '非連結' : '連結';
  const std = /_IFRS/.test(t) ? 'IFRS' : /_US/.test(t) ? '米国基準' : /_REIT/.test(t) ? 'REIT' : /_Foreign/.test(t) ? '外国基準' : '日本基準';
  return scope + '・' + std;
}

/** 開示の種類のことば */
function kindLabel(r) {
  const t = r.docType || '';
  if (isStatement(t)) return '決算短信 ' + perLabel(r.perType);
  if (/EarnForecastRevision/.test(t)) return '業績予想の修正';
  if (/DividendForecastRevision/.test(t)) return '配当予想の修正';
  return t;
}

/**
 * 前年同期比(純粋関数)。
 * @returns {{p:number}|{t:string}|null} p は増減率(%)、t はことば
 */
function yoy(cur, prev) {
  if (cur == null || prev == null) return null;
  if (prev > 0) {
    if (cur < 0) return { t: '赤字転落' };
    return { p: Math.round((cur / prev - 1) * 1000) / 10 };
  }
  if (cur > 0) return { t: '黒字転換' };
  if (prev === 0 && cur === 0) return { t: '0のまま' };
  if (cur > prev) return { t: '赤字縮小' };
  if (cur < prev) return { t: '赤字拡大' };
  return { t: '前年と同じ' };
}

/** d1 より後で d2 以前の分割・併合の係数の積(splits は adjustDaily の splits) */
function splitFactor(splits, d1, d2) {
  let k = 1;
  for (const s of splits || []) if (s.d > d1 && s.d <= d2) k *= s.af;
  return k;
}

/** F_* がどれも空なら FNC_*(非連結の列)を使う(業績予想の修正) */
function pickForecast(r, keys) {
  const main = keys.map((k) => r[k]);
  if (main.some((v) => v != null)) return main;
  return keys.map((k) => r[k.replace(/^F_/, 'FNC_')]);
}

/**
 * 表を作る(純粋関数)。
 * @param {object[]} rows financial_summary の行(列名は大文字、日付は 'YYYY-MM-DD')。開示日・時刻・開示番号の昇順
 * @param {Array<{d:string,af:number}>} splits 分割・併合の日
 * @param {string} since この日以降の開示を表に出す(前年同期比の相手はこれより前の行も使う)
 */
function buildFinTables(rows, splits, since) {
  // 前年同期比の相手: 期の種類・期末日ごとに、連結を優先し、その中で一番新しい短信
  const base = new Map();
  for (const r of rows) {
    if (!isStatement(r.DOC_TYPE)) continue;
    const key = r.CUR_PER_TYPE + '|' + r.CUR_PER_EN;
    const prev = base.get(key);
    const cons = isCons(r.DOC_TYPE);
    if (!prev || (cons && !isCons(prev.DOC_TYPE)) || cons === isCons(prev.DOC_TYPE)) base.set(key, r);
  }
  const prevYear = (r) => {
    const en = r.CUR_PER_EN;
    if (!en) return null;
    const y = Number(en.slice(0, 4)) - 1;
    // 期末日がちょうど12か月前。月末の日付は、前年のその月の末日(2/29 → 2/28)
    const m = Number(en.slice(5, 7));
    const dd = Number(en.slice(8, 10));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lastCur = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
    const day = dd === lastCur ? last : Math.min(dd, last);
    const key = r.CUR_PER_TYPE + '|' + y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    return base.get(key) || null;
  };

  const out = { actual: [], forecast: [], dividend: [], balance: [] };
  const list = rows.filter((r) => r.DISC_DATE >= since).slice().reverse();
  for (const r of list) {
    const head = {
      d: r.DISC_DATE,
      time: r.DISC_TIME ? String(r.DISC_TIME).slice(0, 5) : null,
      kind: kindLabel({ docType: r.DOC_TYPE, perType: r.CUR_PER_TYPE }),
      per: fyLabel(r.CUR_FY_EN) + (isStatement(r.DOC_TYPE) ? ' ' + perLabel(r.CUR_PER_TYPE) : ''),
    };
    const stmt = isStatement(r.DOC_TYPE);
    const isFy = r.CUR_PER_TYPE === 'FY';

    if (stmt) {
      const p = prevYear(r);
      const sales = num(r.SALES), op = num(r.OP), odp = num(r.ODP), np = num(r.NP), eps = num(r.EPS);
      const margin = sales > 0 && op != null ? Math.round(op / sales * 1000) / 10 : null;
      let marginDiff = null, epsYoy = null;
      if (p) {
        const ps = num(p.SALES), po = num(p.OP);
        const pm = ps > 0 && po != null ? Math.round(po / ps * 1000) / 10 : null;
        if (margin != null && pm != null) marginDiff = Math.round((margin - pm) * 10) / 10;
        if (p.EPS != null && eps != null) epsYoy = yoy(eps, num(p.EPS) * splitFactor(splits, p.DISC_DATE, r.DISC_DATE));
      }
      out.actual.push(Object.assign({}, head, {
        basis: basisLabel(r.DOC_TYPE),
        sales: mil(sales), salesYoy: p ? yoy(sales, num(p.SALES)) : null,
        op: mil(op), opYoy: p ? yoy(op, num(p.OP)) : null,
        margin, marginDiff,
        odp: mil(odp), odpYoy: p ? yoy(odp, num(p.ODP)) : null,
        np: mil(np), npYoy: p ? yoy(np, num(p.NP)) : null,
        eps, epsYoy,
        deps: num(r.DEPS),
      }));

      const changes = [];
      if (r.MAT_CHG_SUB === 'true') changes.push('重要な子会社の異動');
      if (r.SIG_CHG_IN_C === 'true') changes.push('連結範囲の重要な変更');
      if (r.CHG_BY_AS_REV === 'true') changes.push('会計基準の改正による方針変更');
      if (r.CHG_NO_AS_REV === 'true') changes.push('それ以外の方針変更');
      if (r.CHG_AC_EST === 'true') changes.push('見積りの変更');
      if (r.RETRO_RST === 'true') changes.push('修正再表示');
      out.balance.push(Object.assign({}, head, {
        ta: mil(r.TA), eq: mil(r.EQ), shEq: mil(r.SH_EQ), eqAr: pct(r.EQ_AR), bps: num(r.BPS), roe: pct(r.ROE),
        cfo: mil(r.CFO), cfi: mil(r.CFI), cff: mil(r.CFF), cash: mil(r.CASH_EQ),
        shOut: num(r.SH_OUT_FY), trSh: num(r.TR_SH_FY), avgSh: num(r.AVG_SH),
        changes,
      }));
    }

    // 業績予想: 本決算の短信は来期、それ以外は今期
    let fc;
    if (stmt && isFy) {
      fc = {
        target: fyLabel(r.NXT_FY_EN),
        v: [r.NXF_SALES_2Q, r.NXF_OP_2Q, r.NXF_ODP_2Q, r.NXF_NP_2Q, r.NXF_EPS_2Q,
          r.NXF_SALES, r.NXF_OP, r.NXF_ODP, r.NXF_NP, r.NXF_EPS],
      };
    } else if (stmt || /EarnForecastRevision/.test(r.DOC_TYPE)) {
      const keys = ['F_SALES_2Q', 'F_OP_2Q', 'F_ODP_2Q', 'F_NP_2Q', 'F_EPS_2Q', 'F_SALES', 'F_OP', 'F_ODP', 'F_NP', 'F_EPS'];
      fc = { target: fyLabel(r.CUR_FY_EN), v: pickForecast(r, keys) };
    }
    if (fc && fc.v.some((x) => x != null)) {
      const v = fc.v.map(num);
      out.forecast.push(Object.assign({}, head, {
        target: fc.target,
        s2: mil(v[0]), op2: mil(v[1]), odp2: mil(v[2]), np2: mil(v[3]), eps2: v[4],
        s: mil(v[5]), op: mil(v[6]), odp: mil(v[7]), np: mil(v[8]), eps: v[9],
      }));
    }

    // 配当: 実績(今期)と予想(四半期・修正は今期、本決算は来期)
    const act = stmt ? [r.DIV_1Q, r.DIV_2Q, r.DIV_3Q, r.DIV_FY, r.DIV_ANN].map(num) : [null, null, null, null, null];
    const fd = stmt && isFy
      ? [r.NXF_DIV_1Q, r.NXF_DIV_2Q, r.NXF_DIV_3Q, r.NXF_DIV_FY, r.NXF_DIV_ANN].map(num)
      : [r.F_DIV_1Q, r.F_DIV_2Q, r.F_DIV_3Q, r.F_DIV_FY, r.F_DIV_ANN].map(num);
    const payout = stmt ? pct(r.PAYOUT_RATIO_ANN) : null;
    const fPayout = pct(stmt && isFy ? r.NXF_PAYOUT_RATIO_ANN : r.F_PAYOUT_RATIO_ANN);
    const total = stmt ? mil(r.DIV_TOTAL_ANN) : null;
    const fTotal = stmt && isFy ? null : mil(r.F_DIV_TOTAL_ANN);
    const unit = stmt ? num(r.DIV_UNIT) : null;
    const fUnit = num(stmt && isFy ? r.NXF_DIV_UNIT : r.F_DIV_UNIT);
    if (act.concat(fd).some((x) => x != null) || [payout, fPayout, total, fTotal, unit, fUnit].some((x) => x != null)) {
      out.dividend.push(Object.assign({}, head, {
        a1: act[0], a2: act[1], a3: act[2], aFy: act[3], aAnn: act[4], payout, total, unit,
        target: fyLabel(stmt && isFy ? r.NXT_FY_EN : r.CUR_FY_EN),
        f1: fd[0], f2: fd[1], f3: fd[2], fFy: fd[3], fAnn: fd[4], fPayout, fTotal, fUnit,
      }));
    }
  }
  return out;
}

/**
 * @param {oracledb.Connection} conn
 * @param {string} code 5桁
 * @param {Array<{d:string,af:number}>} splits
 * @param {string} today 'YYYY-MM-DD'(5年前の日を決める)
 */
async function fetchFinTables(conn, code, splits, today) {
  const y = Number(today.slice(0, 4)) - YEARS;
  const since = y + today.slice(4);
  const r = await conn.execute(
    `SELECT f.*, TO_CHAR(disc_date, 'YYYY-MM-DD') AS disc_d,
            TO_CHAR(cur_per_en, 'YYYY-MM-DD') AS per_en_d,
            TO_CHAR(cur_fy_en, 'YYYY-MM-DD') AS fy_en_d,
            TO_CHAR(nxt_fy_en, 'YYYY-MM-DD') AS nxt_fy_en_d
       FROM financial_summary f
      WHERE code = :code AND disc_date >= ADD_MONTHS(TO_DATE(:since, 'YYYY-MM-DD'), -13)
      ORDER BY disc_date, disc_time, disc_no`, { code, since }, OBJ);
  const rows = r.rows.map((x) => Object.assign({}, x, {
    DISC_DATE: x.DISC_D, CUR_PER_EN: x.PER_EN_D, CUR_FY_EN: x.FY_EN_D, NXT_FY_EN: x.NXT_FY_EN_D,
  }));
  return Object.assign({ since }, buildFinTables(rows, splits, since));
}

module.exports = { fetchFinTables, _internal: { buildFinTables, yoy, fyLabel, basisLabel, splitFactor } };
