'use strict';

/**
 * 需給3階層の折れ線グラフ。依存ライブラリなし・外部CDNなしで SVG を直接組み立てる。
 * (chart.js / chartHtml.js と同じ方針。オフラインで開けること、数年後にURLが失効しても
 *  壊れないことを優先する。)
 *
 * 【この画面でのいちばん大事な仕様: 欠測を 0 で描かない】
 *   需給データは「値が無い」の意味が系列ごとに違う。
 *     ・信用取引残高    … 営業日2日以下の週(GW・年末年始)は JPX が公表しない。
 *                         残高ゼロではない。→ 線を切る(mode: 'line')
 *     ・空売り残高報告  … 0.5%以上の報告があった日にしか行が無い。報告が無い週は
 *                         「残高が消えた」のではなく「動きの報告が無かった」。
 *                         → 連続した線で結ばず、観測した点だけを打つ(mode: 'points')
 *     ・空売り 0.00     … 0.5%を割ったことを知らせる最終報告。ゼロではない。
 *                         → terminalIdx に入れると中空の四角で終端を示す
 *   values に null を入れれば線は切れる。**0 を入れてはいけない。**
 *
 * 【一軸しか使わない】
 *   単位の違う指標を1枚に重ねない(第二軸を作らない)。別のカードに分ける。
 *
 * 【色】
 *   系列色は style.css / demand.css のトークン(--series-1〜4)を固定順で使う。
 *   ライトモードでは 3・4 がサーフェスに対して3:1を下回るので、
 *   凡例と終点の直接ラベル、および同じ数値の表を必ず併置する(色だけに頼らない)。
 */
(function (global) {
  var NS = 'http://www.w3.org/2000/svg';
  var PAD = { l: 58, r: 62, t: 14, b: 22 };

  /** 同じ x 軸を共有するグラフ群。クロスヘアを同期させる */
  var groups = Object.create(null);
  var tooltipEl = null;

  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  //---------------------------------------------------------------- 目盛り
  function niceTicks(lo, hi, target) {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    var raw = (hi - lo) / Math.max(2, target);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var start = Math.ceil(lo / step) * step;
    var ticks = [];
    for (var v = start; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
    return { ticks: ticks, step: step };
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Number(v).toLocaleString('ja-JP', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits === undefined ? 2 : digits,
    });
  }

  /** 目盛りラベル。桁が大きいときは 万 / 億 に丸めて軸を短く保つ */
  function fmtTick(v, step) {
    var a = Math.abs(v);
    if (a >= 1e8 && step >= 1e6) return fmtNum(v / 1e8, 1) + '億';
    if (a >= 1e4 && step >= 1e3) return fmtNum(v / 1e4, 0) + '万';
    var d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    return fmtNum(v, d);
  }

  //---------------------------------------------------------------- 描画
  /**
   * @param {HTMLElement} host   描画先(中身は置き換える)
   * @param {object} spec
   *   spec.group     {string} クロスヘアを同期させる単位
   *   spec.title     {string}
   *   spec.note      {string}  読み方の注記(欠測の意味など)。省略しない
   *   spec.dates     {string[]}
   *   spec.height    {number}  既定 130
   *   spec.zeroBase  {boolean} 0 を必ず含めるか(残高など量の系列で true)
   *   spec.series[]  {name, values, mode:'line'|'points', colorVar, digits, unit,
   *                   terminalIdx:number[]}
   */
  function draw(host, spec) {
    host.innerHTML = '';
    var series = (spec.series || []).filter(function (s) {
      return s.values && s.values.some(function (v) { return v !== null && v !== undefined; });
    });

    var card = document.createElement('div');
    card.className = 'chart-card';

    var head = document.createElement('div');
    head.className = 'chart-head';
    var h = '<span class="chart-title">' + esc(spec.title) + '</span>';
    if (spec.note) h += '<span class="chart-note">' + esc(spec.note) + '</span>';
    // 凡例は2系列以上で必ず出す。1系列ならタイトルが系列名を兼ねる。
    if (series.length >= 2) {
      h += '<span class="legend">';
      series.forEach(function (s) {
        h += '<span class="legend-item"><span class="legend-swatch' +
          (s.mode === 'points' ? ' dashed' : '') + '" style="background:' +
          (s.mode === 'points' ? 'none' : 'var(' + s.colorVar + ')') +
          ';color:var(' + s.colorVar + ')"></span>' + esc(s.name) + '</span>';
      });
      h += '</span>';
    }
    head.innerHTML = h;
    card.appendChild(head);

    var plot = document.createElement('div');
    card.appendChild(plot);
    host.appendChild(card);

    if (series.length === 0) {
      plot.innerHTML = '<p class="chart-note" style="padding:14px 2px">' +
        'この期間に描ける値がありません(取込漏れとは限りません。表の欄を確認してください)。</p>';
      return;
    }

    var dates = spec.dates;
    var n = dates.length;
    var H = spec.height || 130;
    var w = Math.max(320, plot.clientWidth || host.clientWidth || 640);
    var innerW = w - PAD.l - PAD.r;
    var innerH = H - PAD.t - PAD.b;

    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
      s.values.forEach(function (v) {
        if (v === null || v === undefined || !isFinite(v)) return;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
    });
    if (spec.zeroBase) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.08;
    var t = niceTicks(lo - pad, hi + pad, 3);
    var dlo = Math.min(lo - pad, t.ticks[0]);
    var dhi = Math.max(hi + pad, t.ticks[t.ticks.length - 1]);

    function X(i) { return PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW); }
    function Y(v) { return PAD.t + (1 - (v - dlo) / (dhi - dlo)) * innerH; }

    var svg = el('svg', {
      width: w, height: H, viewBox: '0 0 ' + w + ' ' + H,
      role: 'img', class: 'chart-svg',
    });
    svg.setAttribute('aria-label',
      spec.title + ' の折れ線グラフ。同じ数値は下の表にあります。');

    // --- 目盛り線(控えめに) ---
    t.ticks.forEach(function (tv) {
      var y = Y(tv);
      svg.appendChild(el('line', {
        x1: PAD.l, x2: w - PAD.r, y1: y, y2: y,
        stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }));
      var lb = el('text', {
        x: PAD.l - 6, y: y + 3, 'text-anchor': 'end',
        fill: 'var(--muted)', 'font-size': 10,
      });
      lb.style.fontVariantNumeric = 'tabular-nums';
      lb.textContent = fmtTick(tv, t.step);
      svg.appendChild(lb);
    });
    // 0 のラインは他の目盛りより少し強く(符号の境目なので)
    if (dlo < 0 && dhi > 0) {
      svg.appendChild(el('line', {
        x1: PAD.l, x2: w - PAD.r, y1: Y(0), y2: Y(0),
        stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }));
    }

    // --- x 軸ラベル(端と中央だけ。全点には打たない) ---
    var xs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    var anchors = ['start', 'middle', 'end'];
    xs.forEach(function (i, k) {
      var xl = el('text', {
        x: X(i), y: H - 5, 'text-anchor': anchors[k],
        fill: 'var(--muted)', 'font-size': 10,
      });
      xl.style.fontVariantNumeric = 'tabular-nums';
      xl.textContent = dates[i];
      svg.appendChild(xl);
    });

    // --- 系列 ---
    series.forEach(function (s) {
      var vals = s.values;
      var color = 'var(' + s.colorVar + ')';
      var terminal = {};
      (s.terminalIdx || []).forEach(function (i) { terminal[i] = true; });

      if (s.mode === 'points') {
        // 観測した点だけを打つ。間は「報告が無かった」だけで残高が消えたのではないので、
        // 実線では結ばず破線で「同じ系列である」ことだけを示す。
        var prev = -1, dd = '';
        for (var i = 0; i < vals.length; i++) {
          if (vals[i] === null || vals[i] === undefined) continue;
          if (prev >= 0 && !terminal[prev]) {
            dd += 'M' + X(prev).toFixed(1) + ' ' + Y(vals[prev]).toFixed(1) +
                  'L' + X(i).toFixed(1) + ' ' + Y(vals[i]).toFixed(1) + ' ';
          }
          prev = i;
        }
        if (dd) {
          svg.appendChild(el('path', {
            d: dd, fill: 'none', stroke: color, 'stroke-width': 1.5,
            'stroke-dasharray': '3 3', opacity: 0.75,
          }));
        }
        for (var j = 0; j < vals.length; j++) {
          if (vals[j] === null || vals[j] === undefined) continue;
          if (terminal[j]) {
            // 報告終了(0.5%割れ)。塗りつぶさない四角で「ここで終わり」を示す
            svg.appendChild(el('rect', {
              x: X(j) - 4, y: Y(vals[j]) - 4, width: 8, height: 8,
              fill: 'var(--surface-1)', stroke: color, 'stroke-width': 2,
            }));
          } else {
            svg.appendChild(el('circle', {
              cx: X(j), cy: Y(vals[j]), r: 4,
              fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2,
            }));
          }
        }
      } else {
        // 欠測(null)で線を切る。**0 で埋めて繋がない。**
        var d = '', pen = false;
        for (var p = 0; p < vals.length; p++) {
          if (vals[p] === null || vals[p] === undefined) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + X(p).toFixed(1) + ' ' + Y(vals[p]).toFixed(1) + ' ';
          pen = true;
        }
        svg.appendChild(el('path', {
          d: d, fill: 'none', stroke: color, 'stroke-width': 2,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }));
      }

      // 終点の直接ラベル(4系列までは色だけに頼らず名前も出す)
      var last = -1;
      for (var q = vals.length - 1; q >= 0; q--) {
        if (vals[q] !== null && vals[q] !== undefined) { last = q; break; }
      }
      if (last >= 0) {
        var lb2 = el('text', {
          x: X(last) + 8, y: Y(vals[last]) + 4,
          fill: 'var(--text-secondary)', 'font-size': 10,
        });
        lb2.style.fontVariantNumeric = 'tabular-nums';
        lb2.textContent = fmtNum(vals[last], s.digits);
        svg.appendChild(lb2);
      }
    });

    // --- クロスヘア ---
    var cg = el('g', { visibility: 'hidden' });
    var cl = el('line', {
      y1: PAD.t, y2: H - PAD.b, stroke: 'var(--baseline)', 'stroke-width': 1,
      'shape-rendering': 'crispEdges',
    });
    cg.appendChild(cl);
    var dots = series.map(function (s) {
      var c = el('circle', {
        r: 4, fill: 'var(' + s.colorVar + ')',
        stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden',
      });
      cg.appendChild(c);
      return c;
    });
    svg.appendChild(cg);

    var hit = el('rect', { x: 0, y: 0, width: w, height: H, fill: 'transparent' });
    hit.style.cursor = 'crosshair';
    hit.setAttribute('tabindex', '0');
    svg.appendChild(hit);
    plot.appendChild(svg);

    var chart = {
      spec: spec, series: series, dates: dates, X: X, Y: Y,
      cg: cg, cl: cl, dots: dots, hit: hit, n: n,
    };
    var g = groups[spec.group] || (groups[spec.group] = []);
    g.push(chart);

    hit.addEventListener('pointermove', function (ev) {
      var r = svg.getBoundingClientRect();
      var rel = (ev.clientX - r.left - PAD.l) / Math.max(1, innerW);
      var i = Math.round(rel * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      showAt(spec.group, i, ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', function () { hideAll(spec.group); });
    hit.addEventListener('keydown', function (ev) {
      var cur = chart._kb === undefined ? n - 1 : chart._kb;
      if (ev.key === 'ArrowLeft') cur = Math.max(0, cur - 1);
      else if (ev.key === 'ArrowRight') cur = Math.min(n - 1, cur + 1);
      else if (ev.key === 'Home') cur = 0;
      else if (ev.key === 'End') cur = n - 1;
      else return;
      ev.preventDefault();
      chart._kb = cur;
      var r2 = svg.getBoundingClientRect();
      showAt(spec.group, cur, r2.left + X(cur), r2.top + PAD.t);
    });
    hit.addEventListener('blur', function () { hideAll(spec.group); });
  }

  //---------------------------------------------------------------- 同期表示
  function ensureTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'tooltip';
      tooltipEl.hidden = true;
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function showAt(group, i, clientX, clientY) {
    var g = groups[group] || [];
    var html = '';
    g.forEach(function (c) {
      if (i >= c.n) return;
      c.cg.setAttribute('visibility', 'visible');
      c.cl.setAttribute('x1', c.X(i));
      c.cl.setAttribute('x2', c.X(i));
      c.series.forEach(function (s, k) {
        var v = s.values[i];
        if (v === null || v === undefined) {
          c.dots[k].setAttribute('visibility', 'hidden');
        } else {
          c.dots[k].setAttribute('visibility', 'visible');
          c.dots[k].setAttribute('cx', c.X(i));
          c.dots[k].setAttribute('cy', c.Y(v));
        }
        html += '<div class="tt-row"><span class="tt-sw" style="background:var(' +
          s.colorVar + ')"></span><span class="tt-name">' + esc(s.name) +
          '</span><span class="tt-val">' +
          (v === null || v === undefined
            ? '<span class="na">—</span>'
            : esc(fmtNum(v, s.digits) + (s.unit || ''))) +
          '</span></div>';
      });
    });
    var date = g.length ? g[0].dates[i] : '';
    var tip = ensureTooltip();
    tip.innerHTML = '<div class="tt-date">' + esc(date) + ' の週</div>' + html;
    tip.hidden = false;
    var pad = 14;
    var rect = tip.getBoundingClientRect();
    var left = clientX + pad;
    if (left + rect.width > window.innerWidth - 8) left = clientX - pad - rect.width;
    var top = Math.min(clientY + pad, window.innerHeight - rect.height - 8);
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }

  function hideAll(group) {
    (groups[group] || []).forEach(function (c) {
      c.cg.setAttribute('visibility', 'hidden');
    });
    if (tooltipEl) tooltipEl.hidden = true;
  }

  /** グループを作り直す前に呼ぶ(再描画でチャートが二重登録されるのを防ぐ) */
  function resetGroup(group) { groups[group] = []; }

  global.DemandChart = { draw: draw, resetGroup: resetGroup, fmtNum: fmtNum };
})(window);
