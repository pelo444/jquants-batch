'use strict';

/**
 * 取得したデータから、自己完結型のHTML(単一ファイル)を生成する。
 *
 * 外部CDNに一切依存しない。グラフはブラウザ側でSVGを組み立てて描画する。
 * ライブラリを使わないのは、
 *   ・出力したHTMLをオフラインでも開けるようにするため
 *   ・数年後にCDNのURLが失効しても表示が壊れないようにするため
 *   ・1銘柄1系列の折れ線という単純な形なので、自前で十分に足りるため
 *
 * 配色は Anthropic のデータ可視化ガイドラインの検証済みパレットを使用。
 * 1系列のみなので凡例は置かず、行見出しの企業名が系列名を兼ねる。
 */

//------------------------------------------------------------------
// スタイル
//------------------------------------------------------------------
const STYLE = `
*, *::before, *::after { box-sizing: border-box; }

.viz-root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --baseline: #c3c2b7;
  --series-1: #2a78d6;
  --border: rgba(11,11,11,0.10);
  --good: #006300;
  --critical: #d03b3b;
  --hover-wash: rgba(11,11,11,0.04);
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --baseline: #383835;
    --series-1: #3987e5;
    --border: rgba(255,255,255,0.10);
    --good: #0ca30c;
    --critical: #d03b3b;
    --hover-wash: rgba(255,255,255,0.06);
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --surface-1: #1a1a19;
  --page: #0d0d0d;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --muted: #898781;
  --grid: #2c2c2a;
  --baseline: #383835;
  --series-1: #3987e5;
  --border: rgba(255,255,255,0.10);
  --good: #0ca30c;
  --critical: #d03b3b;
  --hover-wash: rgba(255,255,255,0.06);
}

html, body { margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  background: var(--page);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
}
.viz-root { background: var(--page); min-height: 100vh; padding-bottom: 48px; }

/* ---------- ツールバー ---------- */
.toolbar {
  position: sticky; top: 0; z-index: 20;
  background: var(--page);
  border-bottom: 1px solid var(--border);
  padding: 10px 20px;
  display: flex; flex-wrap: wrap; gap: 16px; align-items: center;
}
.toolbar h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .01em; }
.toolbar .meta { font-size: 12px; color: var(--text-secondary); }
.toolbar .spacer { flex: 1 1 auto; }
.ctl { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg button {
  font: inherit; font-size: 12px; padding: 4px 10px; border: 0; cursor: pointer;
  background: transparent; color: var(--text-secondary);
}
.seg button[aria-pressed="true"] { background: var(--series-1); color: #fff; }
.seg button:hover:not([aria-pressed="true"]) { background: var(--hover-wash); }
select, .btn {
  font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
  cursor: pointer;
}
.btn:hover { background: var(--hover-wash); }
.cursor-date {
  font-size: 12px; color: var(--text-primary); font-weight: 600;
  font-variant-numeric: tabular-nums; min-width: 96px;
}
.cursor-date.idle { color: var(--muted); font-weight: 400; }

/* ---------- 行 ---------- */
main { padding: 16px 20px 0; display: flex; flex-direction: column; gap: 10px; }
.row {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px 6px;
}
.row-head { display: flex; align-items: baseline; gap: 10px; }
.row-code {
  font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums;
  min-width: 48px;
}
.row-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.row-market { font-size: 11px; color: var(--muted); }
.row-head .spacer { flex: 1 1 auto; }
.row-val {
  font-size: 14px; font-weight: 600; color: var(--text-primary);
  font-variant-numeric: tabular-nums; min-width: 92px; text-align: right;
}
.row-val.hovered { color: var(--series-1); }
.row-unit { font-size: 11px; color: var(--muted); margin-left: 2px; font-weight: 400; }
.row-delta {
  font-size: 13px; font-variant-numeric: tabular-nums;
  min-width: 78px; text-align: right;
}
.row-delta.up { color: var(--good); }
.row-delta.down { color: var(--critical); }
.row-delta.flat { color: var(--text-secondary); }
.row-split {
  font-size: 11px; color: var(--muted); border: 1px solid var(--border);
  border-radius: 4px; padding: 0 4px;
}
.tbl-btn {
  font: inherit; font-size: 11px; padding: 1px 7px; border-radius: 4px;
  border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
  cursor: pointer;
}
.tbl-btn:hover { background: var(--hover-wash); }
.chart-wrap { position: relative; }
.chart-wrap svg { display: block; width: 100%; }
.no-data { font-size: 12px; color: var(--muted); padding: 24px 0 28px 56px; }

/* ---------- ツールチップ ---------- */
.tip {
  position: fixed; z-index: 40; pointer-events: none;
  background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0,0,0,.14);
  padding: 6px 9px; font-size: 12px; line-height: 1.45;
  font-variant-numeric: tabular-nums; white-space: nowrap;
  opacity: 0; transition: opacity .08s;
}
.tip.on { opacity: 1; }
.tip .tip-name { font-weight: 600; }
.tip .tip-sub { color: var(--text-secondary); }

/* ---------- 表形式 ---------- */
.tbl-box { max-height: 320px; overflow: auto; margin: 4px 0 8px; }
table.vals { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
table.vals th, table.vals td {
  text-align: right; padding: 2px 10px; border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
table.vals th {
  position: sticky; top: 0; background: var(--surface-1);
  color: var(--text-secondary); font-weight: 600;
}
table.vals td.d { text-align: left; color: var(--text-secondary); }

@media print {
  .toolbar { position: static; }
  .tbl-btn, .seg, select, .btn { display: none; }
  .row { break-inside: avoid; }
}
`;

//------------------------------------------------------------------
// クライアントスクリプト
//
// 注意: この文字列はテンプレートリテラルで囲んでいるため、
//       中では ${...} を使わないこと(文字列連結で書いている)。
//------------------------------------------------------------------
const CLIENT = `
(function () {
  'use strict';
  var DATA = window.__DATA__;
  var dates = DATA.dates;
  var charts = [];
  var state = { scale: 'abs', sort: 'given' };

  var tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);

  //---------------------------------------------------------------- 数値整形
  function fmtPrice(v) {
    if (v == null) return '—';
    var d = v >= 1000 ? 0 : (v >= 100 ? 1 : 2);
    return v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtIndex(v) {
    if (v == null) return '—';
    return v.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  function fmtVal(v) { return state.scale === 'abs' ? fmtPrice(v) : fmtIndex(v); }
  function fmtPct(p) {
    if (p == null) return '—';
    return (p > 0 ? '+' : '') + p.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  }
  /**
   * 目盛りを 1/2/5×10^n のきりの良い値に丸めて返す。
   * 銘柄ごとに株価の桁が違うので、データのmin/maxをそのまま出すより読みやすい。
   */
  function niceTicks(lo, hi, target) {
    var span = hi - lo;
    if (!(span > 0)) return [lo];
    var raw = span / target;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      out.push(Math.round(v / step) * step);
    }
    return { ticks: out, step: step };
  }
  function fmtTick(v, step) {
    var d = step >= 1 ? 0 : (step >= 0.1 ? 1 : 2);
    return v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  //---------------------------------------------------------------- 系列の前処理
  function prepare(s) {
    var vals = s.values;
    var firstIdx = -1, lastIdx = -1;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] != null) { if (firstIdx < 0) firstIdx = i; lastIdx = i; }
    }
    var base = firstIdx >= 0 ? vals[firstIdx] : null;
    var idx = new Array(vals.length);
    for (var j = 0; j < vals.length; j++) {
      idx[j] = (vals[j] == null || !base) ? null : (vals[j] / base) * 100;
    }
    s._first = firstIdx;
    s._last = lastIdx;
    s._idx = idx;
    s._pct = (firstIdx >= 0 && lastIdx >= 0 && base)
      ? (vals[lastIdx] / base - 1) * 100 : null;
    return s;
  }

  //---------------------------------------------------------------- SVG生成
  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  var H = 132, PL = 58, PR = 66, PT = 12, PB = 20;

  function draw(c) {
    var wrap = c.wrap;
    var w = Math.max(320, wrap.clientWidth);
    var series = c.series;
    var vals = state.scale === 'abs' ? series.values : series._idx;

    wrap.textContent = '';
    if (series._first < 0) {
      var nd = document.createElement('div');
      nd.className = 'no-data';
      nd.textContent = 'この期間のデータがありません';
      wrap.appendChild(nd);
      c.hit = null;
      return;
    }

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    var span = hi - lo;
    if (span === 0) { lo -= 1; hi += 1; span = 2; }
    var pad = span * 0.08;
    lo -= pad; hi += pad; span = hi - lo;

    var innerW = w - PL - PR, innerH = H - PT - PB;
    var n = dates.length;
    function X(i) { return PL + (n <= 1 ? 0 : (i / (n - 1)) * innerW); }
    function Y(v) { return PT + (1 - (v - lo) / span) * innerH; }

    var svg = el('svg', { width: w, height: H, viewBox: '0 0 ' + w + ' ' + H, role: 'img' });
    svg.setAttribute('aria-label',
      series.name + ' の' + (state.scale === 'abs' ? '調整後終値' : '指数') + '推移');

    // --- グリッド(きりの良い目盛り3本前後。hairline・実線・後退色) ---
    var tk = niceTicks(lo, hi, 3);
    for (var t = 0; t < tk.ticks.length; t++) {
      var ty = Y(tk.ticks[t]);
      svg.appendChild(el('line', {
        x1: PL, y1: ty, x2: w - PR, y2: ty,
        stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }));
      var lb = el('text', {
        x: PL - 8, y: ty + 3.5, 'text-anchor': 'end',
        fill: 'var(--muted)', 'font-size': 10
      });
      lb.style.fontVariantNumeric = 'tabular-nums';
      lb.textContent = fmtTick(tk.ticks[t], tk.step);
      svg.appendChild(lb);
    }

    // --- 指数モードの基準線(100) ---
    if (state.scale === 'idx' && lo < 100 && hi > 100) {
      var by = Y(100);
      svg.appendChild(el('line', {
        x1: PL, y1: by, x2: w - PR, y2: by,
        stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }));
    }

    // --- X軸ラベル(始点・中間・終点のみ) ---
    var xs = [series._first, Math.round((series._first + series._last) / 2), series._last];
    var anchors = ['start', 'middle', 'end'];
    for (var k = 0; k < xs.length; k++) {
      var xl = el('text', {
        x: X(xs[k]), y: H - 6, 'text-anchor': anchors[k],
        fill: 'var(--muted)', 'font-size': 10
      });
      xl.style.fontVariantNumeric = 'tabular-nums';
      xl.textContent = dates[xs[k]];
      svg.appendChild(xl);
    }

    // --- 折れ線(2px、round join/cap、欠損は線を切る) ---
    var d = '', pen = false;
    for (var p = 0; p < vals.length; p++) {
      if (vals[p] == null) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(p).toFixed(1) + ' ' + Y(vals[p]).toFixed(1) + ' ';
      pen = true;
    }
    svg.appendChild(el('path', {
      d: d, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    // --- 終点のドット(2pxのサーフェスリング)と直接ラベル ---
    var ex = X(series._last), ey = Y(vals[series._last]);
    svg.appendChild(el('circle', {
      cx: ex, cy: ey, r: 4,
      fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2
    }));
    var endLb = el('text', {
      x: ex + 9, y: ey + 4, fill: 'var(--text-secondary)', 'font-size': 11
    });
    endLb.style.fontVariantNumeric = 'tabular-nums';
    endLb.textContent = fmtVal(vals[series._last]);
    svg.appendChild(endLb);

    // --- クロスヘア(初期は非表示) ---
    var cg = el('g', { visibility: 'hidden' });
    var cl = el('line', {
      y1: PT, y2: H - PB, stroke: 'var(--baseline)', 'stroke-width': 1,
      'shape-rendering': 'crispEdges'
    });
    var cd = el('circle', {
      r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2
    });
    cg.appendChild(cl); cg.appendChild(cd);
    svg.appendChild(cg);

    // --- ヒットエリア(マークより広く取る。キーボード操作も受け付ける) ---
    var hit = el('rect', { x: 0, y: 0, width: w, height: H, fill: 'transparent' });
    hit.style.cursor = 'crosshair';
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('role', 'application');
    hit.setAttribute('aria-label',
      series.name + ' のグラフ。左右キーで日付を移動、Home/Endで期間の両端へ。');
    svg.appendChild(hit);

    wrap.appendChild(svg);

    c.X = X; c.Y = Y; c.vals = vals; c.cg = cg; c.cl = cl; c.cd = cd;
    c.hit = hit; c.w = w;
    c.endText = endLb;
  }

  //---------------------------------------------------------------- クロスヘア同期
  function nearestIndex(c, clientX) {
    var r = c.hit.getBoundingClientRect();
    var rel = (clientX - r.left) / r.width * c.w;
    var n = dates.length;
    var i = Math.round((rel - PL) / Math.max(1, (c.w - PL - PR)) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  }

  function showAt(i, srcChart, clientX, clientY) {
    var dEl = document.getElementById('cursorDate');
    dEl.textContent = dates[i];
    dEl.classList.remove('idle');

    for (var k = 0; k < charts.length; k++) {
      var c = charts[k];
      if (!c.hit) continue;
      // 欠損日はその銘柄の直近の値を指す
      var j = i, v = c.vals[j];
      while (v == null && j > 0) { j--; v = c.vals[j]; }
      if (v == null) { c.cg.setAttribute('visibility', 'hidden'); continue; }
      var x = c.X(i), y = c.Y(v);
      c.cl.setAttribute('x1', x); c.cl.setAttribute('x2', x);
      c.cd.setAttribute('cx', x); c.cd.setAttribute('cy', y);
      c.cg.setAttribute('visibility', 'visible');
      c.valEl.textContent = fmtVal(v);
      c.valEl.classList.add('hovered');
    }

    if (srcChart) {
      var jj = i, vv = srcChart.vals[jj];
      while (vv == null && jj > 0) { jj--; vv = srcChart.vals[jj]; }
      var raw = srcChart.series.values[jj];
      tip.innerHTML =
        '<div class="tip-name">' + esc(srcChart.series.name) + '</div>' +
        '<div>' + dates[i] + (jj !== i ? '<span class="tip-sub"> (直近 ' + dates[jj] + ')</span>' : '') + '</div>' +
        '<div>' + (state.scale === 'abs'
            ? fmtPrice(vv) + ' 円'
            : fmtIndex(vv) + ' <span class="tip-sub">(実額 ' + fmtPrice(raw) + ' 円)</span>') + '</div>';
      tip.classList.add('on');
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = clientX + 14, top = clientY - th - 12;
      if (left + tw > window.innerWidth - 8) left = clientX - tw - 14;
      if (top < 8) top = clientY + 18;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
  }

  function hideAll() {
    tip.classList.remove('on');
    var dEl = document.getElementById('cursorDate');
    dEl.textContent = '日付にカーソル';
    dEl.classList.add('idle');
    for (var k = 0; k < charts.length; k++) {
      var c = charts[k];
      if (!c.hit) continue;
      c.cg.setAttribute('visibility', 'hidden');
      c.valEl.textContent = fmtVal(c.vals[c.series._last]);
      c.valEl.classList.remove('hovered');
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  //---------------------------------------------------------------- 行の構築
  function buildRow(series) {
    var row = document.createElement('section');
    row.className = 'row';

    var head = document.createElement('div');
    head.className = 'row-head';

    var code = document.createElement('span');
    code.className = 'row-code';
    code.textContent = series.code;

    var name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = series.name;

    var mkt = document.createElement('span');
    mkt.className = 'row-market';
    mkt.textContent = series.market || '';

    var sp = document.createElement('span');
    sp.className = 'spacer';

    var splitBadge = null;
    if (series.splits > 0) {
      splitBadge = document.createElement('span');
      splitBadge.className = 'row-split';
      splitBadge.textContent = '分割調整 ' + series.splits;
      splitBadge.title = 'この期間に株式分割・併合が ' + series.splits + ' 回あり、調整済みの終値を表示しています';
    }

    var tblBtn = document.createElement('button');
    tblBtn.className = 'tbl-btn';
    tblBtn.type = 'button';
    tblBtn.textContent = '表';
    tblBtn.setAttribute('aria-expanded', 'false');

    var val = document.createElement('span');
    val.className = 'row-val';

    var unit = document.createElement('span');
    unit.className = 'row-unit';

    var delta = document.createElement('span');
    delta.className = 'row-delta';
    var p = series._pct;
    delta.textContent = fmtPct(p);
    delta.className = 'row-delta ' + (p == null ? 'flat' : (p > 0.05 ? 'up' : (p < -0.05 ? 'down' : 'flat')));
    delta.title = '期間騰落率(分割調整済み)';

    head.appendChild(code);
    head.appendChild(name);
    head.appendChild(mkt);
    head.appendChild(sp);
    if (splitBadge) head.appendChild(splitBadge);
    head.appendChild(tblBtn);
    head.appendChild(val);
    head.appendChild(unit);
    head.appendChild(delta);
    row.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    row.appendChild(wrap);

    var tblBox = document.createElement('div');
    tblBox.className = 'tbl-box';
    tblBox.hidden = true;
    row.appendChild(tblBox);

    var c = { series: series, wrap: wrap, valEl: val, unitEl: unit, tblBox: tblBox, tblBuilt: false };

    tblBtn.addEventListener('click', function () {
      var open = tblBox.hidden;
      tblBox.hidden = !open;
      tblBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !c.tblBuilt) { buildTable(c); c.tblBuilt = true; }
    });

    return { row: row, chart: c };
  }

  function buildTable(c) {
    var s = c.series;
    var t = document.createElement('table');
    t.className = 'vals';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>日付</th><th>調整後終値</th><th>指数</th><th>前営業日比</th></tr>';
    t.appendChild(thead);
    var tb = document.createElement('tbody');
    var prev = null;
    var html = [];
    for (var i = 0; i < dates.length; i++) {
      var v = s.values[i];
      if (v == null) continue;
      var chg = prev == null ? null : (v / prev - 1) * 100;
      html.push('<tr><td class="d">' + dates[i] + '</td><td>' + fmtPrice(v) + '</td><td>' +
        fmtIndex(s._idx[i]) + '</td><td>' + (chg == null ? '—' : fmtPct(chg)) + '</td></tr>');
      prev = v;
    }
    tb.innerHTML = html.join('');
    t.appendChild(tb);
    c.tblBox.textContent = '';
    c.tblBox.appendChild(t);
  }

  //---------------------------------------------------------------- 並べ替え・再描画
  function sortedSeries() {
    var arr = DATA.series.slice();
    if (state.sort === 'pct') {
      arr.sort(function (a, b) {
        var av = a._pct == null ? -Infinity : a._pct;
        var bv = b._pct == null ? -Infinity : b._pct;
        return bv - av;
      });
    } else if (state.sort === 'code') {
      arr.sort(function (a, b) { return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0); });
    } else {
      arr.sort(function (a, b) { return a.order - b.order; });
    }
    return arr;
  }

  function render() {
    var main = document.getElementById('charts');
    main.textContent = '';
    charts = [];
    var list = sortedSeries();
    for (var i = 0; i < list.length; i++) {
      var built = buildRow(list[i]);
      main.appendChild(built.row);
      charts.push(built.chart);
    }
    for (var k = 0; k < charts.length; k++) {
      draw(charts[k]);
      var c = charts[k];
      c.unitEl.textContent = state.scale === 'abs' ? '円' : '';
      c.valEl.textContent = fmtVal(c.vals ? c.vals[c.series._last] : null);
      bindHover(c);
    }
  }

  function redraw() {
    for (var k = 0; k < charts.length; k++) {
      draw(charts[k]);
      var c = charts[k];
      c.unitEl.textContent = state.scale === 'abs' ? '円' : '';
      c.valEl.textContent = fmtVal(c.vals ? c.vals[c.series._last] : null);
      c.valEl.classList.remove('hovered');
      bindHover(c);
      if (c.tblBuilt) buildTable(c);
    }
  }

  function bindHover(c) {
    if (!c.hit) return;
    c.hit.addEventListener('pointermove', function (ev) {
      showAt(nearestIndex(c, ev.clientX), c, ev.clientX, ev.clientY);
    });
    c.hit.addEventListener('pointerleave', hideAll);

    // キーボードでもホバーと同じ情報に到達できるようにする
    c.hit.addEventListener('keydown', function (ev) {
      var n = dates.length;
      var cur = c.kbIndex == null ? c.series._last : c.kbIndex;
      var step = ev.shiftKey ? 20 : 1;
      var nx = cur;
      if (ev.key === 'ArrowLeft') nx = Math.max(0, cur - step);
      else if (ev.key === 'ArrowRight') nx = Math.min(n - 1, cur + step);
      else if (ev.key === 'Home') nx = c.series._first;
      else if (ev.key === 'End') nx = c.series._last;
      else return;
      ev.preventDefault();
      c.kbIndex = nx;
      var r = c.hit.getBoundingClientRect();
      showAt(nx, c, r.left + (c.X(nx) / c.w) * r.width, r.top + 8);
    });
    c.hit.addEventListener('blur', function () { c.kbIndex = null; hideAll(); });
  }

  //---------------------------------------------------------------- 初期化
  for (var i = 0; i < DATA.series.length; i++) prepare(DATA.series[i]);
  render();

  document.getElementById('scaleAbs').addEventListener('click', function () { setScale('abs'); });
  document.getElementById('scaleIdx').addEventListener('click', function () { setScale('idx'); });
  function setScale(v) {
    state.scale = v;
    document.getElementById('scaleAbs').setAttribute('aria-pressed', v === 'abs' ? 'true' : 'false');
    document.getElementById('scaleIdx').setAttribute('aria-pressed', v === 'idx' ? 'true' : 'false');
    redraw();
  }

  document.getElementById('sortSel').addEventListener('change', function (ev) {
    state.sort = ev.target.value;
    render();
  });

  document.getElementById('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    this.textContent = next === 'dark' ? 'ライト' : 'ダーク';
    redraw();
  });

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(redraw, 150);
  });

  hideAll();
})();
`;

//------------------------------------------------------------------
// HTML生成
//------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} payload
 * @param {string} payload.from
 * @param {string} payload.to
 * @param {string} payload.generatedAt
 * @param {string} [payload.source] 銘柄の指定方法(タグ名など)の説明
 * @param {string[]} payload.dates
 * @param {object[]} payload.series
 * @returns {string} HTML全文
 */
function buildHtml(payload) {
  const title = `株価チャート一覧 ${payload.from} 〜 ${payload.to}`;
  // </script> がデータ中に現れてもHTMLが壊れないようにエスケープする
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="viz-root">
  <header class="toolbar">
    <h1>株価チャート一覧</h1>
    <span class="meta">${escapeHtml(payload.from)} 〜 ${escapeHtml(payload.to)}
      ・${payload.series.length}銘柄${payload.source ? '・' + escapeHtml(payload.source) : ''}
      ・分割調整済み</span>
    <span class="spacer"></span>
    <span class="ctl">表示
      <span class="seg">
        <button id="scaleAbs" type="button" aria-pressed="true">実額</button>
        <button id="scaleIdx" type="button" aria-pressed="false">指数(起点=100)</button>
      </span>
    </span>
    <span class="ctl">並び順
      <select id="sortSel">
        <option value="given">指定順</option>
        <option value="pct">騰落率順</option>
        <option value="code">コード順</option>
      </select>
    </span>
    <span class="cursor-date idle" id="cursorDate">日付にカーソル</span>
    <button class="btn" id="themeBtn" type="button">ダーク</button>
  </header>
  <main id="charts"></main>
</div>
<script>window.__DATA__ = ${json};</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

module.exports = { buildHtml };
