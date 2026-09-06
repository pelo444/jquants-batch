'use strict';

/**
 * 株価タグ分析 Webアプリのフロントエンド。
 * 依存ライブラリなし(サーバー側と同じ方針)。
 */
(function () {
  var meta = null;          // /api/meta の結果
  var rows = [];            // 現在表示中の騰落率一覧
  var maxAbsPct = 1;        // 横棒のスケール
  var selected = new Set(); // チェックした銘柄コード
  var sortKey = 'changePct';
  var sortAsc = false;

  var $ = function (id) { return document.getElementById(id); };

  //---------------------------------------------------------------- 整形
  function fmtNum(v, digits) {
    if (v === null || v === undefined) return '—';
    return Number(v).toLocaleString('ja-JP', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  }
  function fmtPct(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  }
  function pctClass(v) {
    if (v === null || v === undefined) return 'flat';
    return v > 0.005 ? 'up' : (v < -0.005 ? 'down' : 'flat');
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function isoToday() { return new Date().toISOString().slice(0, 10); }

  function shiftMonths(iso, months) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  }

  function collapseFilter(on) {
    $('filterPanel').classList.toggle('collapsed', on);
    $('panelSummary').hidden = !on;
  }

  function summarize(params) {
    var opt = [];
    if (params.minDays > 0) opt.push('最低' + params.minDays + '営業日');
    if (!params.excludeFund) opt.push('ETF含む');
    if (!params.excludeDelisted) opt.push('上場廃止含む');

    var shown;
    if (params.allStocks) {
      shown = '全銘柄(タグ絞り込みなし)';
    } else {
      var labels = {};
      (meta ? meta.tags : []).forEach(function (t) { labels[t.tagName] = t.label; });
      var tags = params.tags.map(function (t) { return labels[t] || t; });
      shown = tags.slice(0, 4).join('・') + (tags.length > 4 ? ' ほか' + (tags.length - 4) : '');
    }
    return shown + '　/　' + params.from + ' 〜 ' + params.to +
      (opt.length ? '　/　' + opt.join('・') : '');
  }

  function setStatus(msg, isError) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (isError ? ' error' : '');
  }

  //---------------------------------------------------------------- 初期化
  function init() {
    fetch('/api/meta')
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error); }); })
      .then(function (m) {
        meta = m;
        $('dataMeta').textContent =
          '取込済みデータの最新営業日: ' + (m.latestDate || '—') +
          ' ・タグ ' + m.tags.length + '件';
        renderTagGroups(m.tags);
        $('dTo').value = m.latestDate || isoToday();
        $('dFrom').value = shiftMonths($('dTo').value, 12);
        markPreset(12);
        $('chartLimit').max = m.limits.chartMaxCodes;
      })
      .catch(function (e) {
        $('dataMeta').textContent = '接続エラー';
        setStatus('メタ情報を取得できませんでした: ' + e.message, true);
      });

    bindEvents();
  }

  //---------------------------------------------------------------- タグ選択
  function renderTagGroups(tags) {
    var groups = [];
    var byMajor = {};
    tags.forEach(function (t) {
      var key = t.majorCode || 'theme';
      if (!byMajor[key]) {
        byMajor[key] = { key: key, label: t.majorLabel || 'テーマ(番号なし)', items: [] };
        groups.push(byMajor[key]);
      }
      byMajor[key].items.push(t);
    });

    var html = groups.map(function (g) {
      var items = g.items.map(function (t) {
        return '<label class="tag-item' + (t.count === 0 ? ' zero' : '') + '">' +
          '<input type="checkbox" class="tagcb" value="' + esc(t.tagName) + '">' +
          '<span class="tag-code">' + esc(t.tagCode || '') + '</span>' +
          '<span class="tag-name" title="' + esc(t.tagName) + '">' + esc(t.label) + '</span>' +
          '<span class="tag-count">' + t.count + '</span>' +
          '</label>';
      }).join('');
      return '<div class="tag-group">' +
        '<div class="tag-group-head"><span>' + esc(g.label) + '</span>' +
        '<button class="link grp" type="button" data-group="' + esc(g.key) + '">全選択</button></div>' +
        '<div class="tag-list">' + items + '</div></div>';
    }).join('');

    $('tagGroups').innerHTML = html;

    Array.prototype.forEach.call(document.querySelectorAll('.grp'), function (b) {
      b.addEventListener('click', function () {
        var box = b.closest('.tag-group');
        var cbs = box.querySelectorAll('.tagcb');
        // 1つでも未チェックがあれば全部オン、全部オンなら全部オフにする
        var allOn = Array.prototype.every.call(cbs, function (c) { return c.checked; });
        Array.prototype.forEach.call(cbs, function (c) { c.checked = !allOn; });
      });
    });
  }

  function selectedTags() {
    return Array.prototype.map.call(
      document.querySelectorAll('.tagcb:checked'), function (c) { return c.value; }
    );
  }

  //---------------------------------------------------------------- 期間プリセット
  function markPreset(months) {
    Array.prototype.forEach.call(document.querySelectorAll('#presets .chip'), function (c) {
      var m = Number(c.dataset.months);
      c.setAttribute('aria-pressed', months !== null && m === months ? 'true' : 'false');
    });
  }

  //---------------------------------------------------------------- 取得と描画
  function buildParams() {
    var allStocks = $('optAllStocks').checked;
    var tags = allStocks ? [] : selectedTags();
    if (!allStocks && tags.length === 0) {
      throw new Error('タグを1つ以上選択するか、「タグ絞り込みなし(全銘柄)」にチェックしてください');
    }
    var p = new URLSearchParams();
    if (allStocks) {
      p.set('all', '1');
    } else {
      p.set('tags', tags.join(','));
    }
    p.set('from', $('dFrom').value);
    p.set('to', $('dTo').value);
    p.set('minDays', $('optMinDays').value || '0');
    p.set('excludeFund', $('optFund').checked ? '1' : '0');
    p.set('excludeDelisted', $('optDelisted').checked ? '1' : '0');
    return p;
  }

  function run() {
    var p;
    try { p = buildParams(); } catch (e) { setStatus(e.message, true); return; }

    setStatus('取得中…');
    $('runBtn').disabled = true;

    fetch('/api/performance?' + p.toString())
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      })
      .then(function (j) {
        rows = j.rows;
        selected.clear();
        maxAbsPct = 1;
        rows.forEach(function (r) {
          var a = Math.abs(r.changePct || 0);
          if (a > maxAbsPct) maxAbsPct = a;
        });
        sortKey = 'changePct'; sortAsc = false;
        updateSortIndicators();
        renderTable();

        $('empty').hidden = true;
        $('tabs').hidden = false;
        showTab('table');

        $('summaryText').textContent = summarize(j.params);
        collapseFilter(true);

        var up = rows.filter(function (r) { return r.changePct > 0; }).length;
        $('resultCount').textContent =
          j.count + '銘柄 ・' + j.params.from + ' 〜 ' + j.params.to +
          ' ・上昇 ' + up + ' / 下落 ' + (j.count - up);
        setStatus(j.notice && j.notice.length ? j.notice.join(' ') : '');

        // チャート側の条件も同期しておく(タブを切り替えたときすぐ見られるように)
        prepareChartUrl(p, 'desc');
      })
      .catch(function (e) { setStatus(e.message, true); })
      .finally(function () { $('runBtn').disabled = false; });
  }

  //---------------------------------------------------------------- テーブル
  function sortRows() {
    var k = sortKey;
    rows.sort(function (a, b) {
      var av = a[k], bv = b[k];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      var r = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ja');
      return sortAsc ? r : -r;
    });
  }

  function updateSortIndicators() {
    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      if (th.dataset.key === sortKey) {
        th.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });
  }

  function renderTable() {
    sortRows();
    var html = rows.map(function (r) {
      var pc = pctClass(r.changePct);
      var w = Math.min(50, Math.abs(r.changePct || 0) / maxAbsPct * 50);
      var bar = '<div class="bar">' +
        (r.changePct > 0
          ? '<i class="up" style="width:' + w + '%"></i>'
          : (r.changePct < 0 ? '<i class="down" style="width:' + w + '%"></i>' : '')) +
        '</div>';
      var splitBadge = r.splitCount > 0
        ? '<span class="badge" title="期間中に株式分割・併合が' + r.splitCount + '回">分割' + r.splitCount + '</span>'
        : '';
      return '<tr data-code="' + esc(r.code) + '"' + (selected.has(r.code) ? ' class="selected"' : '') + '>' +
        '<td class="c-sel"><input type="checkbox" class="rowcb"' + (selected.has(r.code) ? ' checked' : '') + '></td>' +
        '<td class="code">' + esc(r.code) + '</td>' +
        '<td class="name" title="' + esc(r.name) + '">' + esc(r.name) + splitBadge + '</td>' +
        '<td class="num-col pct ' + pc + '">' + fmtPct(r.changePct) + '</td>' +
        '<td class="bar-cell">' + bar + '</td>' +
        '<td class="num-col">' + fmtNum(r.p1, 1) + '</td>' +
        '<td class="num-col">' + fmtNum(r.p2, 1) + '</td>' +
        '<td class="num-col ' + pc + '">' + fmtNum(r.diff, 1) + '</td>' +
        '<td class="num-col dim">' + r.tradingDays + '</td>' +
        '<td class="dim">' + esc(r.market) + '</td>' +
        '<td class="dim">' + esc(r.sector33) + '</td>' +
        '<td class="tags" title="' + esc(r.tags.join(' ')) + '">' + esc(r.tags.join(' ')) + '</td>' +
        '</tr>';
    }).join('');
    $('resultBody').innerHTML = html;
    $('selAll').checked = false;
    updateSelButton();
  }

  function updateSelButton() {
    $('chartSelBtn').disabled = selected.size === 0;
    $('chartSelBtn').textContent = selected.size === 0
      ? '選択をグラフ表示'
      : '選択' + selected.size + '件をグラフ表示';
  }

  //---------------------------------------------------------------- チャート
  function prepareChartUrl(params, order) {
    var p = new URLSearchParams(params.toString());
    p.set('limit', $('chartLimit').value || '30');
    p.set('order', order);
    var url = '/chart?' + p.toString();
    $('chartFrame').dataset.pending = url;
    $('chartOpenBtn').href = url;
    return url;
  }

  function showChart(url, caption) {
    $('chartFrame').src = url;
    $('chartOpenBtn').href = url;
    $('chartCaption').textContent = caption;
    $('empty').hidden = true;
    $('tabs').hidden = false;
    showTab('chart');
  }

  function chartByOrder(order) {
    var p;
    try { p = buildParams(); } catch (e) { setStatus(e.message, true); return; }
    var n = $('chartLimit').value || '30';
    showChart(prepareChartUrl(p, order),
      '騰落率' + (order === 'asc' ? '下位' : '上位') + n + '件');
  }

  function chartBySelection() {
    if (selected.size === 0) return;
    var maxCodes = meta ? meta.limits.chartMaxCodes : 60;
    if (selected.size > maxCodes) {
      setStatus('一度に表示できる銘柄は' + maxCodes + '件までです(選択: ' + selected.size + '件)', true);
      return;
    }
    // 表の並び順のまま渡す
    var codes = rows.filter(function (r) { return selected.has(r.code); }).map(function (r) { return r.code; });
    var p = new URLSearchParams();
    p.set('codes', codes.join(','));
    p.set('from', $('dFrom').value);
    p.set('to', $('dTo').value);
    showChart('/chart?' + p.toString(), '選択した' + codes.length + '銘柄');
  }

  //---------------------------------------------------------------- タブ
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
    });
    $('paneTable').hidden = name !== 'table';
    $('paneChart').hidden = name !== 'chart';

    // チャートタブを初めて開いたときに読み込む(不要なクエリを避けるため)
    if (name === 'chart') {
      var f = $('chartFrame');
      if (!f.src && f.dataset.pending) {
        f.src = f.dataset.pending;
        $('chartCaption').textContent = '騰落率上位' + ($('chartLimit').value || '30') + '件';
      }
    }
  }

  //---------------------------------------------------------------- CSV
  function downloadCsv() {
    if (rows.length === 0) return;
    var head = ['コード', '企業名', '騰落率(%)', '起点', '期間末', '差', '営業日数',
      '分割回数', '起点日', '期間末日', '市場', '33業種', 'タグ'];
    var lines = [head.join(',')];
    rows.forEach(function (r) {
      lines.push([
        r.code, r.name, r.changePct, r.p1, r.p2, r.diff, r.tradingDays,
        r.splitCount, r.d1, r.d2, r.market, r.sector33, r.tags.join(' '),
      ].map(function (v) {
        var s = String(v === null || v === undefined ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    // Excelで文字化けしないようBOMを付ける
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'performance_' + $('dFrom').value + '_' + $('dTo').value + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  //---------------------------------------------------------------- イベント
  function bindEvents() {
    $('runBtn').addEventListener('click', run);
    $('editBtn').addEventListener('click', function () { collapseFilter(false); });
    $('panelSummary').addEventListener('click', function (ev) {
      if (ev.target.id !== 'editBtn') collapseFilter(false);
    });

    $('tagClear').addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tagcb'), function (c) { c.checked = false; });
    });

    // 「タグ絞り込みなし(全銘柄)」: ONの間はタグ選択UIを無効化する
    $('optAllStocks').addEventListener('change', function () {
      var on = this.checked;
      $('tagGroups').classList.toggle('disabled', on);
      $('tagClear').disabled = on;
      $('tagReq').hidden = on;
    });

    $('presets').addEventListener('click', function (ev) {
      var b = ev.target.closest('.chip');
      if (!b) return;
      var to = $('dTo').value || isoToday();
      if (b.dataset.ytd) {
        $('dFrom').value = to.slice(0, 4) + '-01-01';
        markPreset(null);
      } else {
        var m = Number(b.dataset.months);
        $('dFrom').value = shiftMonths(to, m);
        markPreset(m);
      }
    });

    ['dFrom', 'dTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { markPreset(null); });
    });

    // ヘッダクリックで並べ替え
    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      th.addEventListener('click', function () {
        var k = th.dataset.key;
        if (sortKey === k) { sortAsc = !sortAsc; } else { sortKey = k; sortAsc = false; }
        updateSortIndicators();
        renderTable();
      });
    });

    // 行のチェック(イベント委譲)
    $('resultBody').addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb.classList.contains('rowcb')) return;
      var tr = cb.closest('tr');
      var code = tr.dataset.code;
      if (cb.checked) { selected.add(code); tr.classList.add('selected'); }
      else { selected.delete(code); tr.classList.remove('selected'); }
      updateSelButton();
    });

    $('selAll').addEventListener('change', function () {
      var on = $('selAll').checked;
      selected.clear();
      if (on) rows.forEach(function (r) { selected.add(r.code); });
      renderTable();
      $('selAll').checked = on;
    });

    $('chartTopBtn').addEventListener('click', function () { chartByOrder('desc'); });
    $('chartBottomBtn').addEventListener('click', function () { chartByOrder('asc'); });
    $('chartSelBtn').addEventListener('click', chartBySelection);
    $('csvBtn').addEventListener('click', downloadCsv);

    $('tabs').addEventListener('click', function (ev) {
      var t = ev.target.closest('.tab');
      if (t) showTab(t.dataset.tab);
    });

    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      this.textContent = next === 'dark' ? 'ライト' : 'ダーク';
      // iframe内のチャートにもテーマを伝えるため読み直す
      var f = $('chartFrame');
      if (f.src) { var s = f.src; f.src = 'about:blank'; setTimeout(function () { f.src = s; }, 0); }
    });

    // Enterで実行
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) run();
    });
  }

  init();
})();
