'use strict';

/**
 * 市場 (/market) の「マクロ」タブ。週次の TOPIX・投資部門別・裁定残・信用残・空売り比率。
 * もとは需給3階層(/demand、いまの「シグナル」)の第一階層にあったもの。データは /api/demand/macro。
 * グラフは demandChart.js(DemandChart)を使う。
 *
 * 表示の約束は demand.js と同じ:
 *  - 値が無いセルは 0 にも空白にもせず — で出し、title に「なぜ無いのか」を持たせる
 *  - しきい値や判定を文言に書かない
 *
 * タブを開いたときに初めて読み込む(直近タブだけを見る日に重いクエリを流さない)。
 */
(function () {
  var cache = {};
  var $ = function (id) { return document.getElementById(id); };

  //================================================================ 整形
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmt(v, d) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return n.toLocaleString('ja-JP', {
      minimumFractionDigits: d === undefined ? 0 : d,
      maximumFractionDigits: d === undefined ? 0 : d,
    });
  }

  /** 「値が無い」の表示。0 にしない。空欄にもしない。理由を title に持たせる */
  function na(reason) {
    return '<span class="na" title="' + esc(reason) + '">—</span>';
  }

  /** 列ごとの「無い」の意味(demand.js の NA_NOTE のうちマクロで使うもの) */
  var NA_NOTE = {
    margin: '信用取引残高が公表されていません。営業日が2日以下の週(GW・年末年始)はJPXが集計・公表しません。残高ゼロではありません',
    inv: 'この週の投資部門別情報がありません。市場区分再編で終了した系列を選んでいないか確認してください',
    arb: 'この週の裁定取引残高がありません(JPXの週間資料を手動で取り込んでいます。バックナンバーは直近4年分のみ)',
    generic: 'この週のデータがありません。0という意味ではありません',
  };

  function numCell(v, digits, reasonKey, suffix) {
    var s = fmt(v, digits);
    if (s === null) return na(NA_NOTE[reasonKey] || NA_NOTE.generic);
    return esc(s + (suffix || ''));
  }

  /** 前週比などの符号付き。色だけに頼らないよう符号を必ず数値に併記する */
  function signedCell(v, digits, reasonKey, suffix) {
    var s = fmt(v, digits);
    if (s === null) return na(NA_NOTE[reasonKey] || NA_NOTE.generic);
    var cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
    return '<span class="pct ' + cls + '">' + (v > 0 ? '+' : '') + esc(s + (suffix || '')) + '</span>';
  }

  //================================================================ 表(2段ヘッダー・列見出しで並べ替え)
  function grpLabel(s) {
    return String(s).replace(/^[①-⑨]\s*/, '');
  }

  function renderTable(tableEl, cols, rows) {
    var sortKey = null;
    var sortAsc = false;

    function headHtml() {
      var groups = [];
      cols.forEach(function (c) {
        var g = c.grp || '';
        if (groups.length && groups[groups.length - 1].name === g) groups[groups.length - 1].n++;
        else groups.push({ name: g, n: 1 });
      });
      var h1 = '<tr class="grp">' + groups.map(function (g, i) {
        return '<th colspan="' + g.n + '"' + (i > 0 ? ' class="grp-start"' : '') + '>' +
          esc(grpLabel(g.name)) + '</th>';
      }).join('') + '</tr>';
      var h2 = '<tr class="col">' + cols.map(function (c) {
        var cls = [];
        if (c.num) cls.push('num-col');
        if (c.sortable !== false) cls.push('sortable');
        var aria = sortKey === c.key ? ' aria-sort="' + (sortAsc ? 'ascending' : 'descending') + '"' : '';
        return '<th class="' + cls.join(' ') + '" data-key="' + esc(c.key) + '"' + aria +
          (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label) + '</th>';
      }).join('') + '</tr>';
      return h1 + h2;
    }

    function bodyHtml(list) {
      if (list.length === 0) {
        return '<tr><td colspan="' + cols.length + '" class="dim">該当する行がありません。</td></tr>';
      }
      return list.map(function (r) {
        return '<tr>' + cols.map(function (c) {
          return '<td class="' + (c.num ? 'num-col ' : '') + (c.cls || '') + '">' +
            (c.html ? c.html(r) : esc(r[c.key] === null || r[c.key] === undefined ? '' : r[c.key])) +
            '</td>';
        }).join('') + '</tr>';
      }).join('');
    }

    function sorted() {
      if (!sortKey) return rows;
      var col = cols.filter(function (c) { return c.key === sortKey; })[0];
      if (!col) return rows;
      var val = col.sortVal || function (r) { return r[sortKey]; };
      return rows.slice().sort(function (a, b) {
        var x = val(a), y = val(b);
        if (x === null || x === undefined) return 1;   // 「無い」は常に末尾
        if (y === null || y === undefined) return -1;
        if (typeof x === 'string' || typeof y === 'string') {
          x = String(x); y = String(y);
          return sortAsc ? (x < y ? -1 : x > y ? 1 : 0) : (x > y ? -1 : x < y ? 1 : 0);
        }
        return sortAsc ? x - y : y - x;
      });
    }

    function paint() {
      tableEl.querySelector('thead').innerHTML = headHtml();
      tableEl.querySelector('tbody').innerHTML = bodyHtml(sorted());
    }

    tableEl.onclick = function (ev) {
      var th = ev.target.closest ? ev.target.closest('th.sortable') : null;
      if (!th) return;
      var k = th.getAttribute('data-key');
      if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
      paint();
    };
    paint();
  }

  //================================================================ CSV
  function toCsv(cols, rows) {
    function q(v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var head = cols.map(function (c) {
      return q((c.grp ? c.grp + '_' : '') + c.label);
    }).join(',');
    var body = rows.map(function (r) {
      return cols.map(function (c) {
        return q(c.csv ? c.csv(r) : r[c.key]);
      }).join(',');
    }).join('\n');
    return '﻿' + head + '\n' + body + '\n';
  }

  function downloadCsv(name, cols, rows) {
    var blob = new Blob([toCsv(cols, rows)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  //================================================================ 通信
  function api(path) {
    return fetch(path).then(function (r) {
      if (r.ok) return r.json();
      return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); },
        function () { throw new Error('HTTP ' + r.status); });
    });
  }

  function setStatus(el, msg, isError) {
    el.textContent = msg || '';
    el.className = 'status' + (isError ? ' error' : '');
  }

  function macroCols() {
    return [
      { key: 'weekStart', label: '週(月曜)', grp: '週' },
      {
        key: 'topixClose', label: 'TOPIX', grp: '指数', num: true,
        html: function (r) { return numCell(r.topixClose, 2, 'generic'); },
      },
      {
        key: 'topixWowPct', label: '前週比', grp: '指数', num: true,
        html: function (r) { return signedCell(r.topixWowPct, 2, 'generic', '%'); },
      },
      {
        key: 'gvRatio', label: 'G/V', grp: '指数', num: true,
        title: 'グロース指数 ÷ バリュー指数。上昇はグロース優位',
        html: function (r) { return numCell(r.gvRatio, 4, 'generic'); },
      },
      {
        key: 'gvRatioWow', label: '前週比', grp: '指数', num: true,
        html: function (r) { return signedCell(r.gvRatioWow, 2, 'generic', '%'); },
      },
      {
        key: 'elecWowPct', label: '電機', grp: '指数', num: true,
        title: '電気機器指数の前週比',
        html: function (r) { return signedCell(r.elecWowPct, 2, 'generic', '%'); },
      },
      {
        key: 'frgnOku', label: '海外', grp: '投資部門別ネット(億円)', num: true,
        title: 'プラスが買い越し。空欄はこの区分のその週のデータがありません(0ではありません)',
        html: function (r) { return signedCell(r.frgnOku, 0, 'inv'); },
      },
      {
        key: 'frgnWowOku', label: '海外前週差', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.frgnWowOku, 0, 'inv'); },
      },
      {
        key: 'indOku', label: '個人', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.indOku, 0, 'inv'); },
      },
      {
        key: 'trstBnkOku', label: '信託銀行', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.trstBnkOku, 0, 'inv'); },
      },
      {
        key: 'busCoOku', label: '事業法人', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.busCoOku, 0, 'inv'); },
      },
      {
        key: 'propOku', label: '自己', grp: '投資部門別ネット(億円)', num: true,
        title: '証券会社が自己勘定で売買した分の差引',
        html: function (r) { return signedCell(r.propOku, 0, 'inv'); },
      },
      {
        key: 'arbNetOku', label: '裁定ネット', grp: '裁定取引残高(億円)', num: true,
        title: '買残 − 売残。増加は将来の解消売り圧力の蓄積で、強気とは限りません',
        html: function (r) { return signedCell(r.arbNetOku, 0, 'arb'); },
      },
      {
        key: 'arbNetWowOku', label: '前週差', grp: '裁定取引残高(億円)', num: true,
        html: function (r) { return signedCell(r.arbNetWowOku, 0, 'arb'); },
      },
      {
        key: 'marginRatio', label: '信用倍率', grp: '信用取引残高(金額)', num: true,
        title: '申込日終値で金額換算してから合計した倍率。低いほど売り長。3月・9月はつなぎ売りで必ず下がります',
        html: function (r) { return numCell(r.marginRatio, 2, 'margin'); },
      },
      {
        key: 'marginRatioWow', label: '前週差', grp: '信用取引残高(金額)', num: true,
        html: function (r) { return signedCell(r.marginRatioWow, 2, 'margin'); },
      },
      {
        key: 'marginLongOku', label: '買残(億円)', grp: '信用取引残高(金額)', num: true,
        html: function (r) { return numCell(r.marginLongOku, 0, 'margin'); },
      },
      {
        key: 'marginShrtOku', label: '売残(億円)', grp: '信用取引残高(金額)', num: true,
        html: function (r) { return numCell(r.marginShrtOku, 0, 'margin'); },
      },
      {
        key: 'marginCodesCnt', label: '銘柄数', grp: '信用取引残高(金額)', num: true,
        title: '集計に入った銘柄数。急に減った週は取込を疑ってください',
        html: function (r) { return numCell(r.marginCodesCnt, 0, 'margin'); },
      },
      {
        key: 'shortRatioPct', label: '空売り比率', grp: '空売り', num: true,
        title: '高いほど売り圧力が強い一方で、極端な高水準は反転の目印にもなります',
        html: function (r) { return numCell(r.shortRatioPct, 2, 'generic', '%'); },
      },
      {
        key: 'shortRatioWow', label: '前週差', grp: '空売り', num: true,
        html: function (r) { return signedCell(r.shortRatioWow, 2, 'generic', 'pt'); },
      },
    ];
  }

  var macroState = { cols: null, rows: [] };

  function renderMacroCharts(rows) {
    var host = $('macroCharts');
    host.innerHTML = '';
    DemandChart.resetGroup('macro');
    if (rows.length === 0) return;
    var dates = rows.map(function (r) { return r.weekStart; });
    function col(key) {
      return rows.map(function (r) {
        var v = r[key];
        return (v === null || v === undefined) ? null : Number(v);
      });
    }
    function card(spec) {
      var d = document.createElement('div');
      host.appendChild(d);
      spec.group = 'macro';
      spec.dates = dates;
      spec.monthGrid = true;
      DemandChart.draw(d, spec);
    }

    card({
      title: 'TOPIX(週の最終営業日)',
      series: [{ name: 'TOPIX', values: col('topixClose'), mode: 'line', colorVar: '--series-1', digits: 2 }],
    });

    card({
      title: '投資部門別ネット(億円)',
      note: 'プラスが買い越し。線が切れている週はこの区分のデータがありません(0ではありません)。' +
        '2022年4月の市場区分再編で系列が断絶しているので、長期は TokyoNagoya で見ます',
      zeroBase: true,
      height: 250,
      series: [
        { name: '海外', values: col('frgnOku'), mode: 'line', colorVar: '--inv-1', digits: 0, unit: '億円' },
        { name: '個人', values: col('indOku'), mode: 'line', colorVar: '--inv-2', digits: 0, unit: '億円' },
        { name: '信託銀行', values: col('trstBnkOku'), mode: 'line', colorVar: '--inv-3', digits: 0, unit: '億円' },
        { name: '事業法人', values: col('busCoOku'), mode: 'line', colorVar: '--inv-4', digits: 0, unit: '億円' },
      ],
    });

    card({
      title: '自己の差引(億円)',
      note: '証券会社が自己勘定で売買した分。プラスが買い越し',
      zeroBase: true,
      series: [{ name: '自己', values: col('propOku'), mode: 'line', colorVar: '--series-1', digits: 0, unit: '億円' }],
    });

    card({
      title: '裁定取引残高ネット(億円)',
      note: '増加は将来の解消売り圧力の蓄積で、両義的に読みます。' +
        'JPXの週間資料を手動取込しており、バックナンバーが直近4年分しかないためそれ以前は空です',
      zeroBase: true,
      series: [{ name: '裁定ネット', values: col('arbNetOku'), mode: 'line', colorVar: '--series-1', digits: 0, unit: '億円' }],
    });

    card({
      title: '信用倍率(金額ベース)',
      note: '低いほど売り長で踏み上げ余地が大きい。ただし3月・9月はつなぎ売りで必ず下がります',
      series: [{ name: '信用倍率', values: col('marginRatio'), mode: 'line', colorVar: '--series-1', digits: 2, unit: '倍' }],
    });

    card({
      title: '空売り比率(%)',
      note: '高いほど売り圧力が強い一方で、極端な高水準は反転の目印にもなります',
      series: [{ name: '空売り比率', values: col('shortRatioPct'), mode: 'line', colorVar: '--series-1', digits: 2, unit: '%' }],
    });
  }

  function loadMacro(force) {
    var section = $('macroSection').value || 'TokyoNagoya';
    var weeks = $('macroWeeks').value || '52';
    var key = 'macro:' + section + ':' + weeks;
    if (cache[key] && !force) { renderMacro(cache[key]); return; }
    setStatus($('macroStatus'), '読み込み中…');
    api(BASE_PATH + '/api/demand/macro?section=' + encodeURIComponent(section) +
        '&weeks=' + encodeURIComponent(weeks))
      .then(function (d) {
        cache[key] = d;
        renderMacro(d);
      })
      .catch(function (e) { setStatus($('macroStatus'), e.message, true); });
  }

  function renderMacro(d) {
    var cols = macroCols();
    macroState = { cols: cols, rows: d.rows };
    setStatus($('macroStatus'), d.count + '週');

    // 系列をはみ出した期間・終了した系列の警告。黙ってNULLが並ぶのを防ぐ
    var notice = $('macroNotice');
    if (d.notice && d.notice.length) {
      notice.hidden = false;
      notice.innerHTML = '<span class="pct down">⚠</span> ' +
        d.notice.map(function (s) { return esc(s); }).join('<br>');
    } else {
      notice.hidden = true;
      notice.innerHTML = '';
    }

    // 表は新しい週が上、グラフは古い週が左
    renderMacroCharts(d.rows.slice().reverse());
    renderTable($('macroTable'), cols, d.rows, {});
  }

  //================================================================ 投資部門別の区分
  // 区分の一覧は /api/demand/meta の sections から取る
  var sectionsReady = null;
  function loadSections() {
    if (sectionsReady) return sectionsReady;
    sectionsReady = api(BASE_PATH + '/api/demand/meta').then(function (meta) {
      var sel = $('macroSection');
      sel.innerHTML = (meta.sections || []).map(function (s) {
        return '<option value="' + esc(s.section) + '">' + esc(s.section) +
          '(' + esc(s.fromDate) + '〜' + esc(s.toDate) + ')</option>';
      }).join('');
      // 市場区分再編をまたいで連続している唯一の系列を既定にする
      var has = (meta.sections || []).some(function (s) { return s.section === 'TokyoNagoya'; });
      if (has) sel.value = 'TokyoNagoya';
    }).catch(function (e) {
      sectionsReady = null;   // 次にタブを開いたときに取り直す
      throw e;
    });
    return sectionsReady;
  }

  //================================================================ タブ
  var TABS = ['now', 'macro'];
  var macroLoaded = false;

  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = 'now';
    Array.prototype.forEach.call($('marketTabs').querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === name));
    });
    $('marketPanel').hidden = name !== 'now';
    $('paneMacro').hidden = name !== 'macro';
    // グラフは幅を測って描くので、表示してから読み込む
    if (name === 'macro' && !macroLoaded) {
      macroLoaded = true;
      setStatus($('macroStatus'), '読み込み中…');
      loadSections().then(function () { loadMacro(); })
        .catch(function (e) { macroLoaded = false; setStatus($('macroStatus'), e.message, true); });
    }
    try { history.replaceState(null, '', name === 'now' ? location.pathname : '#' + name); } catch (e) { /* 無視 */ }
  }

  function init() {
    $('marketTabs').addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('.tab') : null;
      if (t) showTab(t.getAttribute('data-tab'));
    });
    $('macroCsvBtn').addEventListener('click', function () {
      if (macroState.cols) downloadCsv('demand_macro', macroState.cols, macroState.rows);
    });
    $('macroSection').addEventListener('change', function () { loadMacro(); });
    $('macroWeeks').addEventListener('change', function () { loadMacro(); });

    showTab((location.hash || '').replace('#', ''));
  }

  init();
})();
