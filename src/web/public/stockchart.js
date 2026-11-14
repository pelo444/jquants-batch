'use strict';

/*
 * 個別チャート(/stockchart)。1銘柄のローソク足・移動平均線・出来高・信用残・決算発表日を1枚に描く。
 * 依存ライブラリなし・外部CDNなしで SVG を直接組み立てる(demandChart.js / chartHtml.js と同じ方針)。
 *
 * 【データ】/api/stockchart?code= が、分割調整済みの日足・信用残・決算発表日を全期間ぶん返す(src/web/stockChartQuery.js)。
 *   週足・月足へのまとめ、移動平均、高安値の位置は stockchartCalc.js。足や期間を変えても取り直さない。
 *
 * 【大きさ】固定しない。幅は枠の幅、高さは「ウィンドウの高さ − グラフより上の部分」。ウィンドウを変えると描き直す。
 *   文字の大きさは変えず、足の幅と値幅の目盛りが伸び縮みする。高さの下限は MIN_H(下回るとページが縦にスクロールする)。
 *
 * 【段の分け方】株価 / 出来高 / 信用残 を縦に並べ、横軸(日付)を共有する。単位の違うものを1つの段に重ねない。
 *
 * 【株価に重ねる指標】移動平均線 と ボリンジャーバンド は切り替え(同時に出すと線が多すぎて足が読めない)。
 *   縦の範囲は足と、重ねている線の両方が入るように取る。ただし線が足から大きく離れているときは、
 *   足が潰れないよう足の値幅の2割までに留める(超えた分は切れる)。
 *
 * 【操作】グラフの上で動かすとその足の値を上の行に出す。左右に引くと期間を前後にずらす。
 *
 * 【URL】?code=6613&tf=d&range=6m。開いている状態をそのまま URL に持つ(ブックマーク・貼り付け用)。
 */
(function () {
  var C = window.StockChartCalc;
  var $ = function (id) { return document.getElementById(id); };

  // 足の種類ごとの移動平均線の本数(株探と同じ)と、最初に出す期間
  var TF = {
    d: { ma: [5, 25, 75, 200], maUnit: '日線', chg: '前日比', range: '6m' },
    w: { ma: [13, 26, 52], maUnit: '週線', chg: '前週比', range: '2y' },
    m: { ma: [9, 24, 60], maUnit: 'か月線', chg: '前月比', range: 'all' },
  };
  var IND = { ma: '移動平均線', bb: 'ボリンジャーバンド' };
  // ボリンジャーバンドは足の種類によらず25本・±1σ と ±2σ
  // (±3σ まで出すと、値動きの荒い時期にバンドが縦の範囲いっぱいに広がってローソク足が読めなくなる)
  var BB_LEN = 25;
  var BB_SIGMA = [1, 2];
  var RANGE_MONTHS = { '3m': 3, '6m': 6, '1y': 12, '2y': 24, '5y': 60, all: 0 };
  var WD = ['日', '月', '火', '水', '木', '金', '土'];

  var PAD_L = 8;
  var PAD_R = 66;      // 右の目盛りの文字の幅
  var AXIS_H = 22;     // 下の日付の行
  var GAP = 12;        // 段と段の間
  var SUB_TITLE_H = 16; // 出来高・信用残の段の見出しの高さ
  var MIN_H = { withMargin: 500, noMargin: 420 };
  var MARGIN_BREAK_DAYS = 10; // 信用残の線: 申込日の間がこれより空いたら線を切る(公表が無い週をまたいで結ばない)

  var state = {
    code: null,
    tf: 'd',
    ind: 'ma',    // 株価に重ねる指標(移動平均線 / ボリンジャーバンド)
    range: { d: TF.d.range, w: TF.w.range, m: TF.m.range },
    show: { pivot: true, margin: true, earn: true },
    data: null,   // API の返り値
    bars: null,   // いまの足種の足
    ma: null,     // 移動平均(日足は4本、週足・月足は3本)
    bb: null,     // ボリンジャーバンドの中心線と標準偏差
    bbLines: null,// ±1σ〜±3σ の線
    mg: null,     // 信用残(足の位置つき)
    er: null,     // 決算発表日(足の位置つき)
    i0: 0, i1: 0, // 表示している範囲 [i0, i1)
    hover: null,  // { i, y } カーソルのある足
    geo: null,    // 直近の描画の寸法
  };

  var svg = $('chart');
  var wrap = $('chartWrap');

  //---------------------------------------------------------------- 表示用の小物
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function f1(x) { return (Math.round(x * 10) / 10).toString(); }
  function px(x) { return Math.round(x) + 0.5; } // 1px の線をにじませない
  function int(v) { return Math.round(v).toLocaleString('ja-JP'); }
  function fix(v, n) { return v.toLocaleString('ja-JP', { minimumFractionDigits: n, maximumFractionDigits: n }); }
  /** 株価。小数があるとき(分割調整後など)だけ小数1桁 */
  function price(v) {
    var r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? int(r) : fix(r, 1);
  }
  function signed(v, s) { return v > 0 ? '+' + s : v < 0 ? '-' + s : s; }
  function ymd(d) { return { y: +d.slice(0, 4), m: +d.slice(5, 7), d: +d.slice(8, 10) }; }
  function wd(d) { var p = ymd(d); return WD[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]; }
  function md(d) { var p = ymd(d); return p.m + '/' + p.d; }
  function ymdSlash(d) { var p = ymd(d); return p.y + '/' + p.m + '/' + p.d; }
  function yymd(d) { var p = ymd(d); return String(p.y).slice(2) + '/' + p.m + '/' + p.d; }
  function shiftMonths(d, n) {
    var p = ymd(d);
    var t = new Date(Date.UTC(p.y, p.m - 1 - n, p.d));
    return t.toISOString().slice(0, 10);
  }
  /** 株数の軸の単位。大きいときは万株 */
  function shareUnit(max) { return max >= 100000 ? { div: 10000, label: '万株' } : { div: 1, label: '株' }; }

  /** その足の日付の表示 */
  function barDateLabel(i) {
    var b = state.bars;
    if (state.tf === 'd') return ymdSlash(b.d[i]) + '(' + wd(b.d[i]) + ')';
    if (state.tf === 'w') return ymdSlash(b.d0[i]) + '〜' + md(b.d[i]);
    var p = ymd(b.d[i]);
    return p.y + '年' + p.m + '月';
  }

  function flash(msg) {
    var el = $('flash');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg; el.hidden = false;
  }

  //---------------------------------------------------------------- 状態と URL
  function readUrl() {
    var q = new URLSearchParams(location.search);
    var tf = q.get('tf');
    if (TF[tf]) state.tf = tf;
    var r = q.get('range');
    if (r in RANGE_MONTHS) state.range[state.tf] = r;
    var ind = q.get('ind');
    if (IND[ind]) state.ind = ind;
    return (q.get('code') || '').trim();
  }
  function writeUrl() {
    if (!state.code) return;
    var q = new URLSearchParams();
    q.set('code', state.data ? state.data.shortCode : state.code);
    q.set('tf', state.tf);
    q.set('range', state.range[state.tf]);
    q.set('ind', state.ind);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
    try { localStorage.setItem('stockchart.last', JSON.stringify({ code: q.get('code'), tf: state.tf, ind: state.ind })); } catch (e) { /* 保存できなくても動く */ }
  }
  function syncControls() {
    Array.prototype.forEach.call(document.querySelectorAll('#tfSeg .seg-btn'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tf') === state.tf));
    });
    Array.prototype.forEach.call(document.querySelectorAll('#rangeSeg .seg-btn'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-range') === state.range[state.tf]));
    });
    Array.prototype.forEach.call(document.querySelectorAll('#indSeg .seg-btn'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-ind') === state.ind));
    });
  }

  //---------------------------------------------------------------- データ
  function normalizeCode(raw) {
    // 企業名の候補から選ぶと「6613, 6758」のように足されるので、最後の1つを採る
    var list = String(raw || '').split(/[,，、\s]+/).filter(Boolean);
    return list.length ? list[list.length - 1].toUpperCase() : '';
  }

  var loadingCode = null;
  function load(rawCode) {
    var code = normalizeCode(rawCode);
    $('codeInput').value = code;
    if (!code) return;
    if (!/^[0-9A-Z]{4,5}$/.test(code)) { flash('銘柄コードは4桁または5桁で入力してください: ' + code); return; }
    // Enter と欄から出たときの両方で呼ばれるので、同じ銘柄を続けて取りに行かない
    if (code === loadingCode) return;
    if (state.data && (code === state.data.shortCode || code === state.data.code) && !$('chartPanel').hidden) {
      // いま出している銘柄と同じ: 取り直さず、欄と前のエラー表示だけ元に戻す
      $('codeInput').value = state.data.shortCode;
      flash('');
      return;
    }
    loadingCode = code;
    flash('');
    $('dataMeta').textContent = '読み込み中…';
    fetch(BASE_PATH + '/api/stockchart?code=' + encodeURIComponent(code))
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); })
      .then(function (j) {
        loadingCode = null;
        state.code = j.code;
        state.data = j;
        $('codeInput').value = j.shortCode;
        $('dataMeta').textContent = '';
        if (j.d.length === 0) {
          $('chartPanel').hidden = true;
          flash(j.shortCode + ' ' + j.name + ' の株価データがありません');
          return;
        }
        $('chartPanel').hidden = false;
        $('stockTitle').textContent = j.shortCode + ' ' + j.name;
        $('stockMeta').textContent = [j.market, j.sector, j.delisted ? '上場廃止' : '', '株価は ' + ymdSlash(j.d[j.d.length - 1]) + ' まで']
          .filter(Boolean).join(' ・ ');
        document.title = j.shortCode + ' ' + j.name + ' - 個別チャート';
        prepare();
        applyRange();
        writeUrl();
        render();
      })
      .catch(function (e) {
        loadingCode = null;
        $('dataMeta').textContent = '';
        flash('表示できませんでした: ' + e.message);
      });
  }

  /** 足種に合わせて、足・移動平均・信用残・決算発表日を作り直す */
  function prepare() {
    var d = state.data;
    state.bars = C.aggregate(d, state.tf);
    state.ma = TF[state.tf].ma.map(function (len) { return C.sma(state.bars.c, len); });
    state.bb = C.bollinger(state.bars.c, BB_LEN);
    state.bbLines = BB_SIGMA.map(function (k) {
      return {
        k: k,
        up: state.bb.mid.map(function (m, j) { return m == null ? null : m + k * state.bb.sd[j]; }),
        lo: state.bb.mid.map(function (m, j) { return m == null ? null : m - k * state.bb.sd[j]; }),
      };
    });
    state.mg = C.attachMargin(state.bars, d.margin);
    state.er = C.attachEarnings(state.bars, d.earnings);
    state.hover = null;
  }

  /** 期間のボタンに合わせて、表示する範囲を最新の足で終わるように置く */
  function applyRange() {
    var b = state.bars;
    var n = b.d.length;
    var months = RANGE_MONTHS[state.range[state.tf]];
    var i0 = 0;
    if (months > 0) {
      var from = shiftMonths(b.d[n - 1], months);
      // from の翌日以降の足から(6か月なら 5/13 の翌営業日 〜 11/13)
      i0 = C.barIndexOnOrAfter(b.d, from);
      if (i0 >= 0 && b.d[i0] === from) i0++;
      if (i0 < 0) i0 = n - 1;
    }
    i0 = Math.max(0, Math.min(i0, n - Math.min(n, 10))); // 少なくとも10本は出す
    state.i0 = i0; state.i1 = n;
  }

  /** いま重ねている指標の線。描画の順(先に描いたものが下)で返す。縦の範囲もこれで決める */
  function overlayLines() {
    if (state.ind === 'bb') {
      var out = [];
      for (var k = state.bbLines.length - 1; k >= 0; k--) { // 外側(3σ)から描く
        out.push({ cls: 'bb bb' + state.bbLines[k].k, vals: state.bbLines[k].up });
        out.push({ cls: 'bb bb' + state.bbLines[k].k, vals: state.bbLines[k].lo });
      }
      out.push({ cls: 'bb bb-mid', vals: state.bb.mid });
      return out;
    }
    return state.ma.map(function (arr, idx) { return { cls: 'ma ma' + (idx + 1), vals: arr }; });
  }

  //---------------------------------------------------------------- 寸法
  function layout() {
    var hasMargin = state.show.margin && state.mg.length > 0;
    var W = Math.max(320, Math.floor(wrap.clientWidth));
    var top = svg.getBoundingClientRect().top + window.pageYOffset;
    var minH = hasMargin ? MIN_H.withMargin : MIN_H.noMargin;
    var H = Math.max(minH, Math.floor(window.innerHeight - top - 30));
    var avail = H - AXIS_H - GAP * (hasMargin ? 2 : 1) - 1;
    var hp = Math.round(avail * (hasMargin ? 0.60 : 0.76));
    var hv = hasMargin ? Math.round(avail * 0.16) : avail - hp;
    var hm = hasMargin ? avail - hp - hv : 0;
    var n = state.i1 - state.i0;
    var plotW = W - PAD_L - PAD_R;
    var g = {
      W: W, H: H, plotW: plotW, n: n, step: plotW / n,
      x0: PAD_L, x1: PAD_L + plotW,
      price: { top: 1, h: hp },
      vol: { top: 1 + hp + GAP, h: hv },
      mg: hasMargin ? { top: 1 + hp + GAP + hv + GAP, h: hm } : null,
      axisY: H - AXIS_H,
    };
    g.bottom = (g.mg || g.vol).top + (g.mg || g.vol).h;
    g.x = function (i) { return PAD_L + (i - state.i0 + 0.5) * g.step; };
    return g;
  }

  //---------------------------------------------------------------- 描画
  function render() {
    if (!state.bars) return;
    var b = state.bars;
    var i0 = state.i0, i1 = state.i1;
    var g = layout();
    state.geo = g;
    var s = [];
    var i, k;

    svg.setAttribute('width', g.W);
    svg.setAttribute('height', g.H);
    svg.setAttribute('viewBox', '0 0 ' + g.W + ' ' + g.H);

    s.push('<defs>' +
      '<clipPath id="stkClipP"><rect x="' + g.x0 + '" y="' + g.price.top + '" width="' + g.plotW + '" height="' + g.price.h + '"/></clipPath>' +
      (g.mg ? '<clipPath id="stkClipM"><rect x="' + g.x0 + '" y="' + g.mg.top + '" width="' + g.plotW + '" height="' + g.mg.h + '"/></clipPath>' : '') +
      '</defs>');

    //---- 株価の段の縦の目盛り
    var lo = Infinity, hi = -Infinity;
    for (i = i0; i < i1; i++) { if (b.l[i] < lo) lo = b.l[i]; if (b.h[i] > hi) hi = b.h[i]; }
    if (hi === lo) { hi = lo * 1.01 + 1; lo = lo * 0.99 - 1; }
    // 重ねている線も入るように広げる。足の値幅の2割より外は、足が潰れるので広げない(線はそこで切れる)。
    // 株価は0より下にならないので、下は0で止める(ボリンジャーバンドの下側はマイナスになることがある)
    var lines = overlayLines();
    var limLo = Math.max(0, lo - (hi - lo) * 0.2), limHi = hi + (hi - lo) * 0.2;
    lines.forEach(function (ln) {
      for (var j = i0; j < i1; j++) {
        var v = ln.vals[j];
        if (v == null) continue;
        if (v < lo && v >= limLo) lo = v;
        if (v > hi && v <= limHi) hi = v;
      }
    });
    // 高安値のラベルと決算発表日の札が入る分だけ、上下を空ける
    var padT = 8 + (state.show.pivot ? 28 : 0) + (state.show.earn ? 16 : 0);
    var padB = 8 + (state.show.pivot ? 28 : 0);
    var pr = g.price;
    var unitPx = (pr.h - padT - padB) / (hi - lo);
    var yP = function (v) { return pr.top + padT + (hi - v) * unitPx; };
    g.yP = yP;
    g.priceAt = function (y) { return hi - (y - pr.top - padT) / unitPx; };
    var vTop = hi + padT / unitPx, vBot = lo - padB / unitPx;
    var pt = C.niceTicks(vBot, vTop, Math.max(3, Math.floor(pr.h / 62)));
    g.priceDec = pt.step >= 1 ? 0 : pt.step >= 0.1 ? 1 : 2;

    //---- 横軸: 月(または年)の変わり目に縦線と日付
    var xt = xTicks(g);
    xt.forEach(function (t) {
      s.push('<line class="grid" x1="' + px(t.x) + '" x2="' + px(t.x) + '" y1="' + g.price.top + '" y2="' + g.bottom + '"/>');
      s.push('<text x="' + f1(t.x + 3) + '" y="' + (g.axisY + 15) + '">' + esc(t.label) + '</text>');
    });

    //---- 株価の段: 横の目盛り
    pt.ticks.forEach(function (v) {
      var y = yP(v);
      if (v < 0 || y < pr.top + 6 || y > pr.top + pr.h - 2) return;
      s.push('<line class="grid" x1="' + g.x0 + '" x2="' + g.x1 + '" y1="' + px(y) + '" y2="' + px(y) + '"/>');
      s.push('<text x="' + (g.x1 + 6) + '" y="' + f1(y + 4) + '">' + fix(v, g.priceDec) + '</text>');
    });

    //---- 決算発表日(足より後ろに置く)
    var earnIn = [];
    if (state.show.earn) {
      state.er.forEach(function (e) { if (e.i >= i0 && e.i < i1) earnIn.push(e); });
      var lastLabelX = -Infinity;
      earnIn.forEach(function (e) {
        var x = g.x(e.i);
        var label = e.items.map(function (it) { return it.label; }).join('・');
        var w = label.length * 10 + 8;
        s.push('<line class="earn-line" x1="' + px(x) + '" x2="' + px(x) + '" y1="' + (pr.top + 16) + '" y2="' + (pr.top + pr.h) + '"/>');
        var bx = Math.max(g.x0 + 1, Math.min(g.x1 - w - 1, x - w / 2));
        if (bx - lastLabelX >= 3) { // 札が重なるときは線だけにする
          s.push('<rect class="earn-box" x="' + px(bx) + '" y="' + px(pr.top + 2) + '" width="' + w + '" height="14" rx="3"/>');
          s.push('<rect class="earn-wash" x="' + px(bx) + '" y="' + px(pr.top + 2) + '" width="' + w + '" height="14" rx="3"/>');
          s.push('<text class="earn-text" text-anchor="middle" x="' + f1(bx + w / 2 + 0.5) + '" y="' + (pr.top + 13) + '">' + esc(label) + '</text>');
          lastLabelX = bx + w;
        }
      });
    }

    //---- ローソク足
    var bodyW = Math.max(1, Math.min(22, Math.round(g.step * 0.68)));
    if (bodyW > 2 && bodyW % 2 === 0) bodyW -= 1; // 奇数幅にして、ヒゲを真ん中に通す
    var thin = bodyW < 3;
    var wu = '', wdn = '', bu = '', bd = '';
    for (i = i0; i < i1; i++) {
      var cx = Math.round(g.x(i)) + 0.5;
      var yH = yP(b.h[i]), yL = yP(b.l[i]);
      var yO = Math.round(yP(b.o[i])) + 0.5, yC = Math.round(yP(b.c[i])) + 0.5;
      var up = b.c[i] >= b.o[i];
      var wick = 'M' + cx + ' ' + f1(yH) + 'V' + f1(yL);
      var top = Math.min(yO, yC), hgt = Math.abs(yO - yC);
      var body = bodyW <= 1
        ? 'M' + cx + ' ' + top + 'V' + (top + Math.max(1, hgt))
        : 'M' + (cx - (bodyW - 1) / 2) + ' ' + top + 'h' + (bodyW - 1) + 'v' + hgt + 'h' + (-(bodyW - 1)) + 'Z';
      if (up) { wu += wick; bu += body; } else { wdn += wick; bd += body; }
    }
    s.push('<path class="wick-up" d="' + wu + '"/><path class="wick-down" d="' + wdn + '"/>');
    s.push('<path class="body-up' + (thin ? ' thin' : '') + '" d="' + bu + '"/><path class="body-down" d="' + bd + '"/>');

    //---- 移動平均線 または ボリンジャーバンド(範囲の外の1本も結んで、端で線が途切れないようにする)
    var a0 = Math.max(0, i0 - 1), a1 = Math.min(b.d.length, i1 + 1);
    lines.forEach(function (ln) {
      var d = '', pen = false;
      for (var j = a0; j < a1; j++) {
        if (ln.vals[j] == null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + f1(g.x(j)) + ' ' + f1(yP(ln.vals[j]));
        pen = true;
      }
      if (d) s.push('<path class="' + ln.cls + '" clip-path="url(#stkClipP)" d="' + d + '"/>');
    });

    //---- 高安値
    if (state.show.pivot) {
      var kk = Math.max(3, Math.round(g.n / 14));
      var longSpan = C.dayDiff(b.d[i0], b.d[i1 - 1]) > 370;
      var fmtD = longSpan ? yymd : md;
      var boxes = [];
      C.pivots(b.h, b.l, i0, i1, kk).forEach(function (p) {
        var isH = p.type === 'H';
        var x = Math.max(g.x0 + 22, Math.min(g.x1 - 22, g.x(p.i)));
        var y = isH ? yP(b.h[p.i]) : yP(b.l[p.i]);
        var dateTxt = fmtD(isH ? b.hd[p.i] : b.ld[p.i]);
        var valTxt = price(isH ? b.h[p.i] : b.l[p.i]);
        var w = Math.max(dateTxt.length, valTxt.length) * 6.6 + 4;
        var box = { x0: x - w / 2, x1: x + w / 2, y0: isH ? y - 28 : y + 3, y1: isH ? y - 3 : y + 28 };
        for (var q = 0; q < boxes.length; q++) {
          var o = boxes[q];
          if (box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0) return; // 重なるラベルは出さない
        }
        boxes.push(box);
        // 山は 日付・値 の順に上へ、谷は 値・日付 の順に下へ(値を足に近い側に置く)
        var y1 = isH ? y - 17 : y + 13, y2 = isH ? y - 5 : y + 25;
        s.push('<text class="pv" text-anchor="middle" x="' + f1(x) + '" y="' + f1(y1) + '">' + esc(isH ? dateTxt : valTxt) + '</text>');
        s.push('<text class="pv" text-anchor="middle" x="' + f1(x) + '" y="' + f1(y2) + '">' + esc(isH ? valTxt : dateTxt) + '</text>');
      });
    }
    s.push('<rect class="frame" x="' + px(g.x0 - 0.5) + '" y="' + px(pr.top - 0.5) + '" width="' + g.plotW + '" height="' + pr.h + '"/>');

    //---- 出来高の段
    var vr = g.vol;
    var vmax = 0;
    for (i = i0; i < i1; i++) if (b.v[i] > vmax) vmax = b.v[i];
    var vu = shareUnit(vmax);
    var vBase = vr.top + vr.h;
    var vH = vr.h - SUB_TITLE_H - 2;
    var yV = function (v) { return vBase - (vmax > 0 ? v / vmax : 0) * vH; };
    var vt = C.niceTicks(0, vmax / vu.div, Math.max(2, Math.floor(vH / 34)));
    vt.ticks.forEach(function (v) {
      if (v === 0) return;
      var y = yV(v * vu.div);
      s.push('<line class="grid" x1="' + g.x0 + '" x2="' + g.x1 + '" y1="' + px(y) + '" y2="' + px(y) + '"/>');
      s.push('<text x="' + (g.x1 + 6) + '" y="' + f1(y + 4) + '">' + fix(v, vt.step >= 1 ? 0 : 1) + '</text>');
    });
    var barW = Math.max(1, bodyW);
    var pu = '', pd = '', pf = '';
    for (i = i0; i < i1; i++) {
      if (!b.v[i]) continue;
      var bx0 = Math.round(g.x(i) - barW / 2);
      var by = Math.min(vBase - 1, Math.round(yV(b.v[i])));
      var rect = 'M' + bx0 + ' ' + by + 'h' + barW + 'V' + vBase + 'h' + (-barW) + 'Z';
      // 色は前の足の終値と比べる(株探と同じ)
      var prev = i > 0 ? b.c[i - 1] : b.o[i];
      if (b.c[i] > prev) pu += rect; else if (b.c[i] < prev) pd += rect; else pf += rect;
    }
    s.push('<path class="vol-up" d="' + pu + '"/><path class="vol-down" d="' + pd + '"/><path class="vol-flat" d="' + pf + '"/>');
    s.push('<text class="ptitle" x="' + (g.x0 + 5) + '" y="' + (vr.top + 12) + '">出来高(' + vu.label + ')</text>');
    s.push('<rect class="frame" x="' + px(g.x0 - 0.5) + '" y="' + px(vr.top - 0.5) + '" width="' + g.plotW + '" height="' + vr.h + '"/>');

    //---- 信用残の段
    if (g.mg) {
      var mr = g.mg;
      // 範囲の中の点と、線を端までつなぐための両隣の1点
      var pts = [];
      var before = null, after = null;
      state.mg.forEach(function (p) {
        if (p.i < i0) before = p;
        else if (p.i >= i1) { if (!after) after = p; }
        else pts.push(p);
      });
      var mmax = 0;
      pts.forEach(function (p) { mmax = Math.max(mmax, p.long || 0, p.short || 0); });
      var mu = shareUnit(mmax);
      var mBase = mr.top + mr.h;
      var mH = mr.h - SUB_TITLE_H - 4;
      var yM = function (v) { return mBase - (mmax > 0 ? v / mmax : 0) * mH; };
      var mt = C.niceTicks(0, mmax / mu.div, Math.max(2, Math.floor(mH / 34)));
      mt.ticks.forEach(function (v) {
        if (v === 0) return;
        var y = yM(v * mu.div);
        s.push('<line class="grid" x1="' + g.x0 + '" x2="' + g.x1 + '" y1="' + px(y) + '" y2="' + px(y) + '"/>');
        s.push('<text x="' + (g.x1 + 6) + '" y="' + f1(y + 4) + '">' + fix(v, mt.step >= 1 ? 0 : 1) + '</text>');
      });
      var all = (before ? [before] : []).concat(pts, after ? [after] : []);
      ['short', 'long'].forEach(function (key) { // 買残を上に描く
        var d = '', dots = '';
        var prevP = null, segLen = 0;
        function closeSeg() {
          // 前後とつながらなかった1点は、点で打つ
          if (prevP && segLen === 1 && prevP.i >= i0 && prevP.i < i1) {
            dots += '<circle class="mg-dot-' + key + '" cx="' + f1(g.x(prevP.i)) + '" cy="' + f1(yM(prevP[key])) + '" r="2.5"/>';
          }
        }
        all.forEach(function (p) {
          if (p[key] == null) return;
          var joined = prevP && (state.tf === 'm' ? p.i - prevP.i <= 1 : C.dayDiff(prevP.d, p.d) <= MARGIN_BREAK_DAYS);
          if (!joined) { closeSeg(); segLen = 0; }
          d += (joined ? 'L' : 'M') + f1(g.x(p.i)) + ' ' + f1(yM(p[key]));
          segLen++;
          prevP = p;
        });
        closeSeg();
        if (d) s.push('<path class="mg mg-' + key + '" clip-path="url(#stkClipM)" d="' + d + '"/>' + dots);
      });
      s.push('<text class="ptitle" x="' + (g.x0 + 5) + '" y="' + (mr.top + 12) + '">信用残(' + mu.label + ')</text>');
      s.push('<rect class="frame" x="' + px(g.x0 - 0.5) + '" y="' + px(mr.top - 0.5) + '" width="' + g.plotW + '" height="' + mr.h + '"/>');
    }

    s.push('<g id="stkHover"></g>');
    svg.innerHTML = s.join('');
    renderLegend(g);
    renderHover();
  }

  /** 横軸の目盛り。月の変わり目のうち、間が詰まりすぎない間隔(1・2・3・6・12・24・60か月)で出す */
  function xTicks(g) {
    var b = state.bars;
    var i0 = state.i0, i1 = state.i1;
    var months = Math.max(1, C.dayDiff(b.d[i0], b.d[i1 - 1]) / 30.4);
    var pxPerMonth = g.plotW / months;
    var steps = [1, 2, 3, 6, 12, 24, 60];
    var every = steps[steps.length - 1];
    for (var k = 0; k < steps.length; k++) { if (pxPerMonth * steps[k] >= 58) { every = steps[k]; break; } }
    var out = [];
    var firstDone = false;
    for (var i = Math.max(1, i0); i < i1; i++) {
      var cur = ymd(b.d[i]), prev = ymd(b.d[i - 1]);
      if (cur.m === prev.m && cur.y === prev.y) continue;
      // 月足は1本が1か月なので、足の中心ではなく左端に線を引く必要はない(どの足種も足の中心に引く)
      var idx = cur.y * 12 + (cur.m - 1);
      if (idx % every !== 0) continue;
      var label;
      if (every >= 12) label = String(cur.y);
      else if (cur.m === 1 || !firstDone) label = cur.y + '/' + cur.m;
      else label = cur.m + '月';
      firstDone = true;
      var x = g.x(i) - g.step / 2; // その月の最初の足の左端
      if (x + 3 + label.length * 6.5 > g.x1) continue;
      out.push({ x: x, label: label });
    }
    return out;
  }

  /** 線の凡例(色と名前)。値はカーソルのある足のもの */
  function renderLegend() {
    var tf = TF[state.tf];
    var i = hoverIndex();
    var html = '';
    if (state.ind === 'bb') {
      var mid = state.bb.mid[i], sd = state.bb.sd[i];
      html += '<span><i class="sw bb-mid"></i><span class="lbl">' + BB_LEN + tf.maUnit + '</span>' +
        (mid == null ? '—' : fix(mid, 2)) + '</span>';
      state.bbLines.forEach(function (bl) {
        // 値動きの大きい銘柄では下側がマイナスになる(株価としてはあり得ない水準)
        var low = mid == null ? null : mid - bl.k * sd;
        html += '<span><i class="sw bb' + bl.k + '"></i><span class="lbl">±' + bl.k + 'σ</span>' +
          (mid == null ? '—' : (low < 0 ? '0未満' : fix(low, 2)) + '〜' + fix(mid + bl.k * sd, 2)) + '</span>';
      });
    } else {
      state.ma.forEach(function (arr, idx) {
        html += '<span><i class="sw ma' + (idx + 1) + '"></i><span class="lbl">' + tf.ma[idx] + tf.maUnit + '</span>' +
          (arr[i] == null ? '—' : fix(arr[i], 2)) + '</span>';
      });
    }
    if (state.geo && state.geo.mg) {
      var p = marginAt(i);
      html += '<span><i class="sw long"></i><span class="lbl">買残</span>' + (p && p.long != null ? int(p.long) + '株' : '—') + '</span>' +
        '<span><i class="sw short"></i><span class="lbl">売残</span>' + (p && p.short != null ? int(p.short) + '株' : '—') +
        (p ? ' <span class="lbl">(' + md(p.d) + ' 申込分)</span>' : '') + '</span>';
    }
    if (state.show.earn) {
      var e = earningsAt(i);
      if (e) {
        html += '<span class="earn-tag">決算発表 ' + e.items.map(function (it) {
          return esc(it.label) + '(' + md(it.d) + (it.time ? ' ' + esc(it.time) : '') + ')';
        }).join(' ') + '</span>';
      }
    }
    $('legendRow').innerHTML = html;
  }

  function hoverIndex() {
    return state.hover ? state.hover.i : state.i1 - 1;
  }
  /** その足の時点で分かっている、いちばん新しい信用残 */
  function marginAt(i) {
    var a = state.mg, lo = 0, hi = a.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (a[mid].i <= i) lo = mid + 1; else hi = mid; }
    return lo > 0 ? a[lo - 1] : null;
  }
  function earningsAt(i) {
    for (var k = 0; k < state.er.length; k++) if (state.er[k].i === i) return state.er[k];
    return null;
  }

  /** 上の行(その足の値)と、カーソルの十字線 */
  function renderHover() {
    var b = state.bars, g = state.geo;
    var i = hoverIndex();
    var prev = i > 0 ? b.c[i - 1] : null;
    var chg = prev == null ? null : b.c[i] - prev;
    var cls = chg == null || chg === 0 ? '' : chg > 0 ? 'up' : 'down';
    var info = '<span class="date">' + esc(barDateLabel(i)) + '</span>' +
      '<span><span class="lbl">始値</span>' + price(b.o[i]) + '</span>' +
      '<span><span class="lbl">高値</span>' + price(b.h[i]) + '</span>' +
      '<span><span class="lbl">安値</span>' + price(b.l[i]) + '</span>' +
      '<span><span class="lbl">終値</span>' + price(b.c[i]) + '</span>';
    if (chg != null) {
      info += '<span><span class="lbl">' + TF[state.tf].chg + '</span><span class="' + cls + '">' +
        signed(chg, price(Math.abs(chg))) + ' (' + signed(chg, fix(Math.abs(chg / prev * 100), 2)) + '%)</span></span>';
    }
    info += '<span><span class="lbl">出来高</span>' + int(b.v[i]) + '株</span>';
    $('infoRow').innerHTML = info;
    renderLegend();

    var layer = document.getElementById('stkHover');
    if (!layer) return;
    if (!state.hover) { layer.innerHTML = ''; return; }
    var x = px(g.x(i));
    var h = '<line class="cross" x1="' + x + '" x2="' + x + '" y1="' + g.price.top + '" y2="' + g.bottom + '"/>';
    // 下の日付の札
    var dl = state.tf === 'd' ? md(b.d[i]) + '(' + wd(b.d[i]) + ')' : state.tf === 'w' ? md(b.d0[i]) + '〜' + md(b.d[i]) : barDateLabel(i);
    var dw = dl.length * 7 + 10;
    var dx = Math.max(g.x0, Math.min(g.x1 - dw, x - dw / 2));
    h += '<rect class="tag-box" x="' + f1(dx) + '" y="' + (g.axisY + 3) + '" width="' + dw + '" height="16" rx="3"/>' +
      '<text class="tag-text" text-anchor="middle" x="' + f1(dx + dw / 2) + '" y="' + (g.axisY + 15) + '">' + esc(dl) + '</text>';
    // 株価の段の中にいるときは、横線とその高さの株価
    var y = state.hover.y;
    if (y >= g.price.top && y <= g.price.top + g.price.h) {
      h += '<line class="cross" x1="' + g.x0 + '" x2="' + g.x1 + '" y1="' + px(y) + '" y2="' + px(y) + '"/>' +
        '<rect class="tag-box" x="' + (g.x1 + 1) + '" y="' + f1(y - 8) + '" width="' + (PAD_R - 3) + '" height="16" rx="3"/>' +
        '<text class="tag-text" x="' + (g.x1 + 6) + '" y="' + f1(y + 4) + '">' + fix(g.priceAt(y), g.priceDec) + '</text>';
    }
    layer.innerHTML = h;
  }

  //---------------------------------------------------------------- 操作
  var drag = null;      // { x, i0, moved }
  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; render(); });
  }
  function localPoint(ev) {
    var r = svg.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function indexAt(x) {
    var g = state.geo;
    var i = state.i0 + Math.floor((x - g.x0) / g.step);
    return Math.max(state.i0, Math.min(state.i1 - 1, i));
  }

  svg.addEventListener('pointerdown', function (ev) {
    if (!state.geo || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    drag = { x: ev.clientX, i0: state.i0, moved: false, id: ev.pointerId };
  });
  svg.addEventListener('pointermove', function (ev) {
    if (!state.geo) return;
    var p = localPoint(ev);
    if (drag && drag.id === ev.pointerId) {
      var dx = ev.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        svg.classList.add('dragging');
        try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* 取れなくても動く */ }
      }
      var n = state.i1 - state.i0;
      var total = state.bars.d.length;
      var ni0 = Math.max(0, Math.min(total - n, drag.i0 - Math.round(dx / state.geo.step)));
      if (ni0 !== state.i0) {
        state.i0 = ni0; state.i1 = ni0 + n;
        state.hover = null;
        scheduleRender();
      }
      return;
    }
    state.hover = { i: indexAt(p.x), y: p.y };
    renderHover();
  });
  function endDrag(ev) {
    if (drag && drag.id === ev.pointerId) {
      if (drag.moved) { svg.classList.remove('dragging'); }
      drag = null;
    }
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', function (ev) {
    if (drag && drag.moved) return;
    if (ev.pointerType === 'touch') return; // 指を離しても、最後に触れた足の値を出したままにする
    state.hover = null;
    if (state.geo) renderHover();
  });

  $('tfSeg').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    state.tf = btn.getAttribute('data-tf');
    syncControls();
    if (!state.data) return;
    prepare(); applyRange(); writeUrl(); render();
  });
  $('rangeSeg').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    state.range[state.tf] = btn.getAttribute('data-range');
    syncControls();
    if (!state.data) return;
    state.hover = null;
    applyRange(); writeUrl(); render();
  });
  $('indSeg').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    state.ind = btn.getAttribute('data-ind');
    syncControls();
    if (!state.data) return;
    writeUrl(); render();
  });
  [['showPivot', 'pivot'], ['showMargin', 'margin'], ['showEarn', 'earn']].forEach(function (pair) {
    $(pair[0]).addEventListener('change', function () {
      state.show[pair[1]] = $(pair[0]).checked;
      if (state.data) render();
    });
  });

  var codeInput = $('codeInput');
  function submit() {
    // 企業名の候補を開いたままにしない
    var pop = document.querySelector('.stk-controls .lookup-pop');
    var li = document.querySelector('.stk-controls .lookup-input');
    if (pop) pop.hidden = true;
    if (li) li.value = '';
    load(codeInput.value);
  }
  codeInput.addEventListener('change', submit);
  codeInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
  $('showBtn').addEventListener('click', submit);

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (state.data && !$('chartPanel').hidden) render(); }, 80);
  });

  //---------------------------------------------------------------- 開始
  var initial = readUrl();
  if (!initial) {
    try {
      var last = JSON.parse(localStorage.getItem('stockchart.last') || 'null');
      if (last && last.code) {
        initial = last.code;
        if (TF[last.tf]) state.tf = last.tf;
        if (IND[last.ind] && !new URLSearchParams(location.search).get('ind')) state.ind = last.ind;
      }
    } catch (e) { /* 読めなくても動く */ }
  }
  syncControls();
  if (initial) load(initial);
  else codeInput.focus();
})();
