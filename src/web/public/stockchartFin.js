/* 個別チャートの最下段「決算」の一覧。データは /api/stockchart の fin(src/web/stockFinQuery.js)。
   表は 実績 / 業績予想 / 配当 / 財務・キャッシュフロー の4つ。行は開示1件 = 1行、新しい順 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(v, n) {
    if (v == null) return '';
    return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: n || 0, maximumFractionDigits: n || 0 });
  }
  function signed(v, n, unit) {
    if (v == null) return '';
    var s = fmt(Math.abs(v), n) + (unit || '');
    return v > 0 ? '+' + s : v < 0 ? '-' + s : s;
  }
  function ymd(d) { return d ? d.slice(0, 4) + '/' + Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : ''; }

  // セル
  function num(v, n) { return '<td class="num-col">' + fmt(v, n) + '</td>'; }
  // 配当: 端数があるときだけ小数を出す(50 / 12.5)
  function div(v) {
    return '<td class="num-col">' + (v == null ? '' : Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 2 })) + '</td>';
  }
  function pctCell(v) { return '<td class="num-col">' + (v == null ? '' : fmt(v, 1) + '%') + '</td>'; }
  var GOOD_WORDS = { '黒字転換': 1, '赤字縮小': 1 };
  var BAD_WORDS = { '赤字転落': 1, '赤字拡大': 1 };
  function yoyCell(y) {
    if (!y) return '<td class="num-col"></td>';
    if (y.t) {
      var c = GOOD_WORDS[y.t] ? 'up' : BAD_WORDS[y.t] ? 'down' : 'flat';
      return '<td class="num-col pct ' + c + '">' + esc(y.t) + '</td>';
    }
    return '<td class="num-col pct ' + (y.p > 0 ? 'up' : y.p < 0 ? 'down' : 'flat') + '">' + signed(y.p, 1, '%') + '</td>';
  }
  function diffCell(v) {
    if (v == null) return '<td class="num-col"></td>';
    return '<td class="num-col pct ' + (v > 0 ? 'up' : v < 0 ? 'down' : 'flat') + '">' + signed(v, 1, 'pt') + '</td>';
  }
  function dateCell(r) {
    return '<td class="fin-date">' + ymd(r.d) + (r.time ? ' <span class="fin-time">' + esc(r.time) + '</span>' : '') + '</td>';
  }
  function txt(s, cls) { return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(s) + '</td>'; }

  // 2段の見出し。cols は [見出し, 列数] か 文字列(2段ぶち抜き)。sub は2段目の見出し
  function head(groups) {
    var top = '', bottom = '';
    groups.forEach(function (g) {
      if (typeof g === 'string') { top += '<th rowspan="2">' + esc(g) + '</th>'; return; }
      top += '<th colspan="' + g[1].length + '" class="fin-group">' + esc(g[0]) + '</th>';
      g[1].forEach(function (s) { bottom += '<th class="num-col">' + esc(s) + '</th>'; });
    });
    return '<thead><tr>' + top + '</tr><tr>' + bottom + '</tr></thead>';
  }
  function table(title, groups, rows, rowFn) {
    var body = rows.length
      ? rows.map(function (r) { return '<tr>' + rowFn(r) + '</tr>'; }).join('')
      : '<tr><td class="dim" colspan="40">開示がありません</td></tr>';
    return '<h3 class="fin-title">' + esc(title) + '</h3>' +
      '<div class="table-wrap fin-wrap"><table class="fin-table">' + head(groups) + '<tbody>' + body + '</tbody></table></div>';
  }

  function render(fin) {
    var html = '';

    html += table('実績(四半期は期首からの累計)', [
      '開示日', '期', '基準',
      ['売上高', ['百万円', '前年同期比']],
      ['営業利益', ['百万円', '前年同期比']],
      ['営業利益率', ['%', '前年同期差']],
      ['経常利益', ['百万円', '前年同期比']],
      ['純利益', ['百万円', '前年同期比']],
      ['EPS', ['円', '前年同期比', '潜在株式調整後']],
    ], fin.actual, function (r) {
      return dateCell(r) + txt(r.per) + txt(r.basis, 'dim') +
        num(r.sales) + yoyCell(r.salesYoy) +
        num(r.op) + yoyCell(r.opYoy) +
        num(r.margin, 1) + diffCell(r.marginDiff) +
        num(r.odp) + yoyCell(r.odpYoy) +
        num(r.np) + yoyCell(r.npYoy) +
        num(r.eps, 2) + yoyCell(r.epsYoy) + num(r.deps, 2);
    });

    html += table('業績予想(四半期の決算短信と修正は今期、本決算の決算短信は来期)', [
      '開示日', '開示', '予想の期',
      ['中間(第2四半期までの累計)', ['売上高', '営業利益', '経常利益', '純利益', 'EPS(円)']],
      ['通期', ['売上高', '営業利益', '経常利益', '純利益', 'EPS(円)']],
    ], fin.forecast, function (r) {
      return dateCell(r) + txt(r.kind) + txt(r.target) +
        num(r.s2) + num(r.op2) + num(r.odp2) + num(r.np2) + num(r.eps2, 2) +
        num(r.s) + num(r.op) + num(r.odp) + num(r.np) + num(r.eps, 2);
    });

    var hasUnit = fin.dividend.some(function (r) { return r.unit != null || r.fUnit != null; });
    var aCols = ['1Q末', '2Q末', '3Q末', '期末', '年間', '配当性向', '総額(百万円)'];
    if (hasUnit) aCols.push('1口あたり分配金');
    html += table('配当(1株あたり、円)', [
      '開示日', '開示', '期',
      ['実績', aCols],
      '予想の期',
      ['予想', aCols],
    ], fin.dividend, function (r) {
      var s = dateCell(r) + txt(r.kind) + txt(r.per) +
        div(r.a1) + div(r.a2) + div(r.a3) + div(r.aFy) + div(r.aAnn) + pctCell(r.payout) + num(r.total);
      if (hasUnit) s += num(r.unit, 0);
      s += txt(r.target) +
        div(r.f1) + div(r.f2) + div(r.f3) + div(r.fFy) + div(r.fAnn) + pctCell(r.fPayout) + num(r.fTotal);
      if (hasUnit) s += num(r.fUnit, 0);
      return s;
    });

    html += table('財務・キャッシュフロー(金額は百万円)', [
      '開示日', '期',
      ['財政状態', ['総資産', '純資産', '自己資本', '自己資本比率', 'BPS(円)', 'ROE']],
      ['キャッシュフロー', ['営業', '投資', '財務', '現金同等物の残高']],
      ['株式数(株)', ['期末発行済', '期末自己株式', '期中平均']],
      '期中の変更',
    ], fin.balance, function (r) {
      return dateCell(r) + txt(r.per) +
        num(r.ta) + num(r.eq) + num(r.shEq) + pctCell(r.eqAr) + num(r.bps, 2) + pctCell(r.roe) +
        num(r.cfo) + num(r.cfi) + num(r.cff) + num(r.cash) +
        num(r.shOut) + num(r.trSh) + num(r.avgSh) +
        txt(r.changes.join('、'));
    });

    return html;
  }

  window.StockFin = { render: render, ymd: ymd };
})();
