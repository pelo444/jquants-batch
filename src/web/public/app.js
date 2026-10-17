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
  var targetTab = 'tag';    // 絞り込みのタブ('sector' | 'tag')。開いているほうの選択だけを使う

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
  // 銘柄コードは4桁で出す(J-Quants の5桁 67520 → 6752。285A0 → 285A)。CSV はデータのままの5桁
  function short(code) { return code && code.length === 5 && code[4] === '0' ? code.slice(0, 4) : code; }

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
      shown = '全銘柄(絞り込みなし)';
    } else if (params.sectors && params.sectors.length) {
      var names = {};
      (meta ? meta.sectors : []).forEach(function (s) { names[s.code] = s.name; });
      var secs = params.sectors.map(function (c) { return names[c] || c; });
      shown = '33業種: ' + secs.slice(0, 4).join('・') + (secs.length > 4 ? ' ほか' + (secs.length - 4) : '');
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
        renderSectors(m.sectors || []);
        $('dTo').value = m.latestDate || isoToday();
        // 期間の初期値は「1日」(前営業日比)。前営業日が取れるまでの仮の値として1年を入れておく
        $('dFrom').value = shiftMonths($('dTo').value, 12);
        setPrevDay($('dTo').value);
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
      // 番号なし(THEME)でも大分類名があるもの(例: 売買記録の jnl_* タグ、ddl/28)は別のグループにする
      var key = t.majorCode || (t.majorLabel ? 'label:' + t.majorLabel : 'theme');
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

  //---------------------------------------------------------------- 33業種選択
  function renderSectors(sectors) {
    $('sectorBox').innerHTML = sectors.map(function (s) {
      return '<label class="sector-item"><input type="checkbox" class="seccb" value="' + esc(s.code) +
        '"><span>' + esc(s.name) + '</span>' +
        '<span class="sector-count">' + s.count + '</span></label>';
    }).join('');
  }

  function selectedSectors() {
    return Array.prototype.map.call(
      document.querySelectorAll('.seccb:checked'), function (c) { return c.value; }
    );
  }

  function showTargetTab(name) {
    targetTab = name;
    Array.prototype.forEach.call(document.querySelectorAll('#targetTabs .tab'), function (t) {
      t.setAttribute('aria-selected', t.dataset.target === name ? 'true' : 'false');
    });
    $('sectorBox').hidden = name !== 'sector';
    $('tagGroups').hidden = name !== 'tag';
  }

  function selectedTags() {
    return Array.prototype.map.call(
      document.querySelectorAll('.tagcb:checked'), function (c) { return c.value; }
    );
  }

  //---------------------------------------------------------------- 期間プリセット
  // key は 'd1'(日) / 'm12'(月) / 'ytd' / null(手入力)
  function presetKey(c) {
    return c.dataset.days ? 'd' + c.dataset.days : (c.dataset.months ? 'm' + c.dataset.months : 'ytd');
  }
  function markPreset(key) {
    Array.prototype.forEach.call(document.querySelectorAll('#presets .chip'), function (c) {
      c.setAttribute('aria-pressed', key !== null && presetKey(c) === key ? 'true' : 'false');
    });
  }

  // 期間「1日」: 前営業日を開始日にする。土日・祝日をまたぐので、カレンダーで1日戻すのではなくサーバーに聞く
  function setPrevDay(to) {
    return fetch('/api/prev-trading-date?to=' + encodeURIComponent(to))
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
      .then(function (j) { $('dFrom').value = j.date; markPreset('d1'); })
      .catch(function (e) { setStatus('前営業日を取得できませんでした: ' + e.message, true); });
  }

  function shiftDays(iso, days) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  //---------------------------------------------------------------- 取得と描画
  function buildParams() {
    var allStocks = $('optAllStocks').checked;
    var p = new URLSearchParams();
    if (allStocks) {
      p.set('all', '1');
    } else if (targetTab === 'sector') {
      var secs = selectedSectors();
      if (secs.length === 0) {
        throw new Error('33業種を1つ以上選択するか、「絞り込みなし(全銘柄)」にチェックしてください');
      }
      p.set('sectors', secs.join(','));
    } else {
      var tags = selectedTags();
      if (tags.length === 0) {
        throw new Error('タグを1つ以上選択するか、「絞り込みなし(全銘柄)」にチェックしてください');
      }
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
        '<td class="code">' + esc(short(r.code)) + '</td>' +
        '<td class="name" title="' + esc(r.name) + '">' + esc(r.name) + splitBadge + '</td>' +
        '<td class="num-col pct ' + pc + '">' + fmtPct(r.changePct) + '</td>' +
        '<td class="bar-cell">' + bar + '</td>' +
        '<td class="num-col">' + fmtNum(r.p1, 1) + '</td>' +
        '<td class="num-col">' + fmtNum(r.p2, 1) + '</td>' +
        '<td class="num-col ' + pc + '">' + fmtNum(r.diff, 1) + '</td>' +
        '<td class="num-col dim">' + r.tradingDays + '</td>' +
        '<td class="dim">' + esc(r.market) + '</td>' +
        '<td class="dim">' + esc(r.sector33) + '</td>' +
        '<td class="tags" title="' + esc(tagText(r.tags, false)) + '">' + esc(tagText(r.tags, true)) + '</td>' +
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

  /** チャートの見出し。件数は入力欄の値ではなく、実際に描く銘柄数(一覧の件数と入力欄の小さいほう) */
  function chartCaptionText(order) {
    var n = Number($('chartLimit').value) || 30;
    var k = rows.length ? Math.min(n, rows.length) : n;
    return '騰落率' + (order === 'asc' ? '下位' : '上位') + k + '件';
  }

  function chartByOrder(order) {
    var p;
    try { p = buildParams(); } catch (e) { setStatus(e.message, true); return; }
    showChart(prepareChartUrl(p, order), chartCaptionText(order));
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
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (t) {
      t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
    });
    $('paneTable').hidden = name !== 'table';
    $('paneChart').hidden = name !== 'chart';

    // チャートタブを初めて開いたときに読み込む(不要なクエリを避けるため)
    if (name === 'chart') {
      var f = $('chartFrame');
      if (!f.src && f.dataset.pending) {
        f.src = f.dataset.pending;
        $('chartCaption').textContent = chartCaptionText('desc');
      }
    }
  }

  /** タグ名の並びを表示用にする。short=true は短縮表記(無ければ日本語名)、false は日本語名。どちらも無ければタグ名のまま */
  function tagText(names, short) {
    var by = {};
    (meta ? meta.tags : []).forEach(function (t) { by[t.tagName] = t; });
    return names.map(function (n) {
      var t = by[n];
      if (!t) return n;
      return (short && t.shortLabel) || t.label || n;
    }).join('・');
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
        r.splitCount, r.d1, r.d2, r.market, r.sector33, tagText(r.tags, true),
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

    // 開いているタブ(33業種かタグ)の選択だけを外す
    $('tagClear').addEventListener('click', function () {
      var cls = targetTab === 'sector' ? '.seccb' : '.tagcb';
      Array.prototype.forEach.call(document.querySelectorAll(cls), function (c) { c.checked = false; });
    });

    $('targetTabs').addEventListener('click', function (ev) {
      var t = ev.target.closest('.tab');
      if (t) showTargetTab(t.dataset.target);
    });

    // 「絞り込みなし(全銘柄)」: ONの間は33業種・タグの選択UIを無効化する
    $('optAllStocks').addEventListener('change', function () {
      var on = this.checked;
      $('tagGroups').classList.toggle('disabled', on);
      $('sectorBox').classList.toggle('disabled', on);
      $('targetTabs').classList.toggle('disabled', on);
      $('tagClear').disabled = on;
      $('tagReq').hidden = on;
    });

    $('presets').addEventListener('click', function (ev) {
      var b = ev.target.closest('.chip');
      if (!b) return;
      var to = $('dTo').value || isoToday();
      if (b.dataset.ytd) {
        $('dFrom').value = to.slice(0, 4) + '-01-01';
        markPreset('ytd');
      } else if (b.dataset.days === '1') {
        setStatus('');
        setPrevDay(to);
      } else if (b.dataset.days) {
        $('dFrom').value = shiftDays(to, Number(b.dataset.days));
        markPreset('d' + b.dataset.days);
      } else {
        var m = Number(b.dataset.months);
        $('dFrom').value = shiftMonths(to, m);
        markPreset('m' + m);
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

    // Enterで実行
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) run();
    });
  }

  init();
})();
