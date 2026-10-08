'use strict';

/**
 * 約定から保有と実現損益を計算する。DBには触らない純粋な関数。
 *
 * 【方針】
 *   保有の表は持たず、毎回 JNL_TRADE から計算する(二重管理にすると必ずずれる)。
 *   取得単価は移動平均(買うたびに平均を取り直す)。国内株式の税務上の
 *   「総平均法に準ずる方法」と同じ考え方。口座区分(特定/一般/NISA)ごとに別の建玉として扱う。
 *
 * 【株式分割】
 *   約定の数量・単価は約定時点のまま入っている。その後に分割があると、
 *   数量は増え単価は下がっているので、AdjFactor(分割の日に 1:2 なら 0.5)で今の株数に直す。
 *   約定日より後の AdjFactor の積を f として、数量 ÷ f、単価 × f。
 *
 * 【金額】
 *   現物の買いは受渡金額(手数料・税込み)を取得額にする。無ければ 数量×単価+手数料+税+諸費用。
 *   現物の売りは受渡金額を手取りにする。無ければ 数量×単価−手数料−税−諸費用。
 *   信用返済は CSV の受渡金額(=決済損益)をそのまま実現損益にする。無ければ単価差から概算。
 *
 * 【入庫(楽天は株式分割で増えた株も「入庫」で記録する)】
 *   DB の分割日(AdjFactor≠1)の前後10日以内に同じ銘柄の入庫があれば、その分割は証券会社の記録に
 *   反映済みとみなし、(1) 入庫は取得費0で株数だけ増やす(分割では取得費の総額は変わらない)、
 *   (2) その分割を上の AdjFactor による換算から外す(二重に数えないため)。
 *   入庫の株数が「その時の保有 × (1/AdjFactor − 1)」と合わなければ警告を出す。
 *   分割と対応しない入庫は他社からの移管とみなし、CSVの単価を取得単価にして警告を出す。
 *   出庫は平均単価で株数を減らすだけで、損益は付けない。
 *
 * 【履歴が足りないとき】
 *   CSVの期間より前に買った株を売ると、持っていない株を売ったことになる。
 *   その場合は数量を0で止め、実現損益は「不明」として警告に出す(黙って負の保有にしない)。
 */

const EPS = 1e-9;

function splitFactorAfter(splits, code, date) {
  const list = splits.get(code);
  if (!list) return 1;
  let f = 1;
  for (const s of list) {
    if (s.date > date) f *= s.factor;
  }
  return f;
}

function costOfBuy(t, qa, pa) {
  if (t.settleAmount !== null && t.settleAmount !== undefined && t.settleAmount !== 0) {
    return Math.abs(t.settleAmount);
  }
  return qa * pa + (t.fee || 0) + (t.tax || 0) + (t.otherCost || 0);
}

function proceedsOfSell(t, qa, pa) {
  if (t.settleAmount !== null && t.settleAmount !== undefined && t.settleAmount !== 0) {
    return Math.abs(t.settleAmount);
  }
  return qa * pa - (t.fee || 0) - (t.tax || 0) - (t.otherCost || 0);
}

/**
 * @param {object[]} trades JNL_TRADE の行(tradeId, tradeDate 'YYYY-MM-DD', code, name, accountType,
 *                          positionKind, positionEffect, qty, price, fee, tax, otherCost, settleAmount)
 * @param {Map<string, {date:string, factor:number}[]>} splits 銘柄ごとの AdjFactor≠1 の日
 * @returns {{positions:object[], realized:object[], warnings:object[]}}
 */
function computePositions(trades, splits = new Map()) {
  const sorted = trades.slice().sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : a.tradeId - b.tradeId);

  // 入庫と DB の分割を突き合わせる
  const DAY = 86400000;
  const splitDeposit = new Map();   // tradeId → 対応する分割 {date, factor}
  const effSplits = new Map();      // 入庫で反映済みの分割を除いた残り
  for (const [code, list] of splits) {
    const deps = sorted.filter((t) => t.code === code && t.positionEffect === 'DEPOSIT');
    const rest = [];
    for (const sp of list) {
      const hit = deps.filter((t) => Math.abs(Date.parse(t.tradeDate) - Date.parse(sp.date)) <= 10 * DAY);
      if (hit.length) hit.forEach((t) => splitDeposit.set(t.tradeId, sp));
      else rest.push(sp);
    }
    if (rest.length) effSplits.set(code, rest);
  }

  const book = new Map();
  const realized = [];
  const warnings = [];
  const adjustedCodes = new Set();   // DB の AdjFactor で株数を直した銘柄(画面の「分割調整」の印)

  function pos(account, kind, t) {
    const key = `${account}|${kind}|${t.code}`;
    let p = book.get(key);
    if (!p) {
      p = { account, kind, code: t.code, name: t.name, qty: 0, cost: 0, firstDate: t.tradeDate, lastDate: t.tradeDate };
      book.set(key, p);
    }
    if (t.name) p.name = t.name;
    p.lastDate = t.tradeDate;
    if (p.qty <= EPS) p.firstDate = t.tradeDate;
    return p;
  }

  function reduce(p, qa, t) {
    if (qa > p.qty + EPS) {
      warnings.push({
        tradeId: t.tradeId, code: t.code, tradeDate: t.tradeDate,
        message: `保有(${round(p.qty)}株)より多く減らしています(${round(qa)}株)。` +
          'CSVの期間より前の約定が入っていない可能性があります。',
      });
      const avg = p.qty > EPS ? p.cost / p.qty : null;
      p.qty = 0;
      p.cost = 0;
      return { avg, complete: false };
    }
    const avg = p.cost / p.qty;
    p.qty -= qa;
    p.cost -= avg * qa;
    if (p.qty <= EPS) { p.qty = 0; p.cost = 0; }
    return { avg, complete: true };
  }

  for (const t of sorted) {
    const f = splitFactorAfter(effSplits, t.code, t.tradeDate);
    const qa = t.qty / f;
    const pa = t.price * f;
    const account = t.accountType || '(不明)';
    const year = t.tradeDate.slice(0, 4);
    if (f !== 1) adjustedCodes.add(t.code);

    if (t.positionKind === 'CASH' && (t.positionEffect === 'DEPOSIT' || t.positionEffect === 'WITHDRAW')) {
      const p = pos(account, 'CASH', t);
      if (t.positionEffect === 'WITHDRAW') {
        reduce(p, qa, t);
        continue;
      }
      const sp = splitDeposit.get(t.tradeId);
      if (sp) {
        const expected = p.qty * (1 / sp.factor - 1);
        if (Math.abs(expected - qa) > 0.5) {
          warnings.push({
            tradeId: t.tradeId, code: t.code, tradeDate: t.tradeDate,
            message: `分割(${sp.date}、1株→${round(1 / sp.factor)}株)の入庫が${round(qa)}株ですが、` +
              `その時点の保有(${round(p.qty)}株)からは${round(expected)}株のはずです。他の口座の分か、履歴の不足を確認してください。`,
          });
        }
        p.qty += qa;            // 分割: 取得費の総額は変わらない
      } else {
        p.qty += qa;
        p.cost += qa * pa;
        warnings.push({
          tradeId: t.tradeId, code: t.code, tradeDate: t.tradeDate,
          message: `入庫(${round(qa)}株)に対応する分割が見つからないため、移管とみなしてCSVの単価を取得単価にしました。`,
        });
      }
      continue;
    }

    if (t.positionKind === 'CASH') {
      const p = pos(account, 'CASH', t);
      if (t.positionEffect === 'OPEN') {
        p.qty += qa;
        p.cost += costOfBuy(t, qa, pa);
      } else {
        const { avg, complete } = reduce(p, qa, t);
        const proceeds = proceedsOfSell(t, qa, pa);
        realized.push({
          tradeId: t.tradeId, tradeDate: t.tradeDate, year, account, kind: 'CASH', code: t.code, name: p.name,
          qty: qa, proceeds, costBasis: complete ? avg * qa : null,
          pnl: complete ? proceeds - avg * qa : null,
        });
      }
    } else {
      const kind = t.positionKind; // MLONG / MSHORT
      const p = pos(account, kind, t);
      if (t.positionEffect === 'OPEN') {
        p.qty += qa;
        p.cost += qa * pa;
      } else if (t.positionEffect === 'CLOSE') {
        const { avg, complete } = reduce(p, qa, t);
        let pnl = null;
        let approx = false;
        if (t.settleAmount !== null && t.settleAmount !== undefined) {
          pnl = t.settleAmount;
        } else if (complete) {
          pnl = (kind === 'MLONG' ? pa - avg : avg - pa) * qa - (t.fee || 0) - (t.tax || 0) - (t.otherCost || 0);
          approx = true;
        }
        realized.push({
          tradeId: t.tradeId, tradeDate: t.tradeDate, year, account, kind, code: t.code, name: p.name,
          qty: qa, proceeds: null, costBasis: complete ? avg * qa : null, pnl, approx,
        });
      } else {
        // CONVERT: 現引(MLONG → 現物が増える) / 現渡(MSHORT → 現物が減る)
        const { avg, complete } = reduce(p, qa, t);
        const cash = pos(account, 'CASH', t);
        if (kind === 'MLONG') {
          cash.qty += qa;
          cash.cost += (complete ? avg : pa) * qa;
        } else {
          const r = reduce(cash, qa, t);
          const pnl = complete && r.complete ? (avg - r.avg) * qa : null;
          realized.push({
            tradeId: t.tradeId, tradeDate: t.tradeDate, year, account, kind, code: t.code, name: p.name,
            qty: qa, proceeds: null, costBasis: null, pnl, approx: true,
          });
        }
      }
    }
  }

  const positions = [];
  for (const p of book.values()) {
    if (p.qty > EPS) {
      positions.push({
        account: p.account, kind: p.kind, code: p.code, name: p.name,
        qty: round(p.qty), avgCost: p.cost / p.qty, cost: p.cost,
        firstDate: p.firstDate, lastDate: p.lastDate, splitAdjusted: adjustedCodes.has(p.code),
      });
    }
  }
  positions.sort((a, b) => (a.account + a.kind + a.code).localeCompare(b.account + b.kind + b.code));
  return { positions, realized, warnings };
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * 実現損益を年・口座で集計する(損益が不明な行は件数だけ数える)
 */
function summarizeRealized(realized) {
  const m = new Map();
  for (const r of realized) {
    const key = `${r.year}|${r.account}`;
    let s = m.get(key);
    if (!s) {
      s = { year: r.year, account: r.account, pnl: 0, count: 0, wins: 0, unknown: 0 };
      m.set(key, s);
    }
    s.count += 1;
    if (r.pnl === null || r.pnl === undefined) {
      s.unknown += 1;
    } else {
      s.pnl += r.pnl;
      if (r.pnl > 0) s.wins += 1;
    }
  }
  return Array.from(m.values()).sort((a, b) =>
    a.year === b.year ? a.account.localeCompare(b.account) : b.year.localeCompare(a.year));
}

module.exports = { computePositions, summarizeRealized, _internal: { splitFactorAfter } };
