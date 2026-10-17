/*
 * 銘柄購入(/purchase)の画面。ライブラリ非依存。
 * API は src/web/purchaseRoutes.js、表は ddl/29_purchase_flow.sql、設計は claude/purchase_flow_design.md。
 *
 * 状態の持ち方:
 *   items      いま画面で編集中のリストの中身 [{code, from, detail}](未保存の変更を含む)
 *   savedCodes 最後に保存(または読み込み)した時点のコードの並び。items と比べて「未保存」を出す
 *   info       コード → 一覧の数字(銘柄名・株価など)。表示用のキャッシュ
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var FROM_LABEL = { SECTOR: '業種', TAG: 'タグ', MANUAL: '手入力' };

  var meta = null;
  var currentList = null;   // {listId, name, createdAt, closedAt, removed}
  var items = [];
  var savedCodes = [];
  var info = {};
  var results = [];         // 銘柄一覧の結果
  var resultSource = null;  // {from: 'SECTOR'|'TAG', tags?: string[]}
  var sortKey = 'code';
  var sortDir = 1;
  var searchTab = 'sector';
  var avoid = null;         // 外す候補 {asOf, population, d10: {code: {...}}}(読み込み中は null)

  //------------------------------------------------------------------ 共通
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function short(code) { return code && code.length === 5 && code[4] === '0' ? code.slice(0, 4) : code; }
  function num(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function oku(v, d) { return v === null || v === undefined ? '—' : num(v / 1e8, d); }
  function pct(v) {
    if (v === null || v === undefined || isNaN(v)) return '<span class="pct flat">—</span>';
    var cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    return '<span class="pct ' + cls + '">' + (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + '%</span>';
  }

  async function api(method, url, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var res = await fetch(url, opt);
    var data = null;
    try { data = await res.json(); } catch (e) { /* 本文なし */ }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  var flashTimer = null;
  function flash(msg, isError) {
    var el = $('flash');
    el.textContent = msg;
    el.className = 'flash' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.hidden = true; }, isError ? 9000 : 4000);
  }

  /** 4桁(5桁)に揃える。不正なら null */
  function normCode(s) {
    var c = String(s).trim().toUpperCase().replace(/[０-９Ａ-Ｚ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
    if (/^[0-9A-Z]{4}$/.test(c)) return c + '0';
    if (/^[0-9A-Z]{5}$/.test(c)) return c;
    return null;
  }

  function isDirty() {
    var a = items.map(function (i) { return i.code; }).sort().join(',');
    var b = savedCodes.slice().sort().join(',');
    return a !== b;
  }

  //------------------------------------------------------------------ 初期化
  async function init() {
    bindEvents();
    try {
      meta = await api('GET', '/api/purchase/meta');
    } catch (e) {
      $('dataMeta').textContent = '接続エラー';
      flash('初期情報を取得できませんでした: ' + e.message, true);
      return;
    }
    $('dataMeta').textContent = '株価の最新日 ' + (meta.latestDate || '—');
    renderSectors(meta.sectors);
    renderTags(meta.tags);
    renderListSelect(meta.lists);
    loadAvoid();
    // 前回開いていたリストを開き直す
    var last = null;
    try { last = localStorage.getItem('jqb-purchase-list'); } catch (e) { /* noop */ }
    if (last && meta.lists.some(function (l) { return String(l.listId) === last; })) {
      $('listSelect').value = last;
      await openList(Number(last));
    }
  }

  async function reloadLists(selectId) {
    meta.lists = (await api('GET', '/api/purchase/meta')).lists;
    renderListSelect(meta.lists);
    if (selectId) $('listSelect').value = String(selectId);
  }

  function renderListSelect(lists) {
    var html = '<option value="">— リストを選ぶ —</option>';
    lists.forEach(function (l) {
      html += '<option value="' + l.listId + '">' + esc(l.name) + '(' + l.count + '銘柄)' +
        (l.closedAt ? ' [終了]' : '') + '</option>';
    });
    $('listSelect').innerHTML = html;
    if (currentList) $('listSelect').value = String(currentList.listId);
  }

  //------------------------------------------------------------------ 業種・タグ
  function renderSectors(sectors) {
    $('sectorBox').innerHTML = sectors.map(function (s) {
      return '<label class="sector-item"><input type="checkbox" class="seccb" value="' + esc(s.code) +
        '"><span>' + esc(s.name) + '</span>' +
        '<span class="sector-count">' + s.count + '</span></label>';
    }).join('');
  }

  function renderTags(tags) {
    var groups = [];
    var byMajor = {};
    tags.forEach(function (t) {
      // 番号なし(THEME)でも大分類名があるもの(売買記録の jnl_* タグ)は別のグループにする(app.js と同じ)
      var key = t.majorCode || (t.majorLabel ? 'label:' + t.majorLabel : 'theme');
      if (!byMajor[key]) {
        byMajor[key] = { label: t.majorLabel || 'テーマ(番号なし)', items: [] };
        groups.push(byMajor[key]);
      }
      byMajor[key].items.push(t);
    });
    $('tagBox').innerHTML = groups.map(function (g) {
      return '<div class="tag-group"><div class="tag-group-head"><span>' + esc(g.label) + '</span></div>' +
        '<div class="tag-list">' + g.items.map(function (t) {
          return '<label class="tag-item' + (t.count === 0 ? ' zero' : '') + '">' +
            '<input type="checkbox" class="tagcb" value="' + esc(t.tagName) + '">' +
            '<span class="tag-code">' + esc(t.tagCode || '') + '</span>' +
            '<span class="tag-name" title="' + esc(t.tagName) + '">' + esc(t.label) + '</span>' +
            '<span class="tag-count">' + t.count + '</span></label>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function checked(cls) {
    return Array.prototype.slice.call(document.querySelectorAll('.' + cls + ':checked'));
  }

  async function showStocks() {
    var url;
    var src;
    if (searchTab === 'sector') {
      var secs = checked('seccb');
      if (!secs.length) { $('searchStatus').textContent = '業種を1つ以上選んでください'; return; }
      url = '/api/purchase/stocks?sectors=' + encodeURIComponent(secs.map(function (c) { return c.value; }).join(','));
      src = { from: 'SECTOR' };
    } else {
      var tags = checked('tagcb');
      if (!tags.length) { $('searchStatus').textContent = 'タグを1つ以上選んでください'; return; }
      url = '/api/purchase/stocks?tags=' + encodeURIComponent(tags.map(function (c) { return c.value; }).join(','));
      src = { from: 'TAG', tags: tags.map(function (c) { return c.value; }) };
    }
    $('searchStatus').textContent = '読み込み中…';
    $('showBtn').disabled = true;
    try {
      var data = await api('GET', url);
      results = data.rows;
      resultSource = src;
      results.forEach(function (r) { info[r.code] = r; });
      $('searchStatus').textContent = '';
      $('resultPane').hidden = false;
      renderResults();
    } catch (e) {
      $('searchStatus').textContent = '';
      flash('一覧を取得できませんでした: ' + e.message, true);
    } finally {
      $('showBtn').disabled = false;
    }
  }

  var COLS = [
    { key: 'code', label: 'コード' },
    { key: 'name', label: '銘柄名' },
    { key: 'market', label: '市場' },
    { key: 'sector', label: '業種' },
    { key: 'close', label: '株価', num: true },
    { key: 'marketCap', label: '時価総額(億円)', num: true },
    { key: 'turnover20', label: '売買代金(億円/日)', num: true },
    { key: 'pos52w', label: '52週高値から', num: true },
    { key: 'avoid', label: '外す候補' },
  ];

  function cellHtml(r, key) {
    switch (key) {
      case 'code': return '<td class="code">' + esc(short(r.code)) + '</td>';
      case 'name': return '<td class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</td>';
      case 'market': return '<td class="dim">' + esc(r.market || '') + '</td>';
      case 'sector': return '<td class="dim">' + esc(r.sector || '') + '</td>';
      case 'close': return '<td class="num-col">' + num(r.close, r.close && r.close % 1 ? 1 : 0) + '</td>';
      case 'marketCap': return '<td class="num-col">' + oku(r.marketCap, 0) + '</td>';
      case 'turnover20': return '<td class="num-col">' + oku(r.turnover20, 2) + '</td>';
      case 'pos52w': return '<td class="num-col">' + pct(r.pos52w) +
        (r.days250 !== null && r.days250 !== undefined && r.days250 < 200
          ? '<span class="badge" title="上場から日が浅く、250営業日に足りない">' + r.days250 + '日</span>' : '') + '</td>';
      case 'avoid': {
        if (!avoid) return '<td class="dim">…</td>';
        var a = avoid.d10[r.code];
        if (!a) return '<td></td>';
        return '<td><span class="avoid-badge" title="追加下落スコアの上位10%(' + esc(avoid.asOf) + ' 時点、母集団 ' + avoid.population +
          '銘柄)。52週高値から ' + a.dd.toFixed(1) + '%、週次ボラ ' + a.vol13.toFixed(1) + '%、4週 ' + a.ret4w.toFixed(1) +
          '%、売買代金 ' + a.turnover.toFixed(1) + '億円/日">外す候補</span></td>';
      }
      default: return '<td></td>';
    }
  }

  function sorted(rows) {
    var val = function (r) {
      if (sortKey === 'avoid') return avoid && avoid.d10[r.code] ? 1 : 0;
      return r[sortKey];
    };
    return rows.slice().sort(function (a, b) {
      var x = val(a);
      var y = val(b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'string') return x.localeCompare(y, 'ja') * sortDir;
      return (x - y) * sortDir;
    });
  }

  /** 外す候補は全銘柄を計算するので時間がかかる(初回10秒ほど)。表示とは別に読み込み、届いたら描き直す */
  async function loadAvoid() {
    try {
      avoid = await api('GET', '/api/purchase/avoid');
    } catch (e) {
      avoid = { asOf: null, population: 0, d10: {}, error: e.message };
      flash('外す候補を計算できませんでした: ' + e.message, true);
    }
    if (results.length) renderResults();
    if (currentList) renderList();
  }

  function renderResults() {
    var inList = {};
    items.forEach(function (i) { inList[i.code] = true; });
    var head = '<thead><tr><th class="c-sel"><input type="checkbox" id="selAll" title="すべて選ぶ"></th>' +
      COLS.map(function (c) {
        return '<th class="sortable' + (c.num ? ' num-col' : '') + '" data-key="' + c.key + '"' +
          (sortKey === c.key ? ' aria-sort="' + (sortDir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + c.label + '</th>';
      }).join('') + '</tr></thead>';
    var body = '<tbody>' + sorted(results).map(function (r) {
      var on = inList[r.code];
      return '<tr class="' + (on ? 'in-list' : '') + '"><td class="c-sel">' +
        (on ? '<span class="inlist-badge">リスト</span>'
            : '<input type="checkbox" class="pick" value="' + esc(r.code) + '">') + '</td>' +
        COLS.map(function (c) { return cellHtml(r, c.key); }).join('') + '</tr>';
    }).join('') + '</tbody>';
    $('resultTable').innerHTML = head + body;
    $('resultCount').textContent = results.length + '銘柄';

    Array.prototype.forEach.call($('resultTable').querySelectorAll('th.sortable'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-key');
        if (sortKey === k) sortDir = -sortDir;
        else { sortKey = k; sortDir = COLS.some(function (c) { return c.key === k && c.num; }) ? -1 : 1; }
        renderResults();
      });
    });
    $('selAll').addEventListener('change', function (e) {
      Array.prototype.forEach.call($('resultTable').querySelectorAll('.pick'), function (cb) { cb.checked = e.target.checked; });
    });
  }

  /** タグ一覧から追加したときの「追加元の詳細」= 選択中のタグ名(複数ならカンマ区切り、100文字まで) */
  function tagDetail() {
    if (!resultSource || resultSource.from !== 'TAG') return null;
    return resultSource.tags.join(',').slice(0, 100);
  }

  function addPicked() {
    if (!currentList) { flash('先にリストを選ぶか作成してください', true); return; }
    var picks = Array.prototype.map.call($('resultTable').querySelectorAll('.pick:checked'), function (cb) { return cb.value; });
    if (!picks.length) { flash('追加する銘柄にチェックを入れてください', true); return; }
    var room = meta.maxItems - items.length;
    if (picks.length > room) {
      flash('追加すると' + meta.maxItems + '銘柄を超えます。あと' + Math.max(room, 0) + '銘柄まで追加できます', true);
      return;
    }
    picks.forEach(function (code) {
      var r = info[code];
      items.push({
        code: code,
        from: resultSource.from,
        detail: resultSource.from === 'SECTOR' ? (r && r.sectorCode) : tagDetail(),
      });
    });
    renderList();
    renderResults();
    flash(picks.length + '銘柄を追加しました(まだ保存していません)');
  }

  //------------------------------------------------------------------ リスト
  async function openList(listId) {
    try {
      var l = await api('GET', '/api/purchase/lists/' + listId);
      // 別のリストに切り替えたら、前のリストの参考情報は消す
      if (!currentList || currentList.listId !== l.listId) { $('refPane').hidden = true; checkSel = []; }
      currentList = l;
      items = l.items.map(function (i) { return { code: i.code, from: i.from, detail: i.detail, addedAt: i.addedAt }; });
      savedCodes = items.map(function (i) { return i.code; });
      l.rows.forEach(function (r) { info[r.code] = r; });
      try { localStorage.setItem('jqb-purchase-list', String(listId)); } catch (e) { /* noop */ }
      renderList();
      if (results.length) renderResults();
    } catch (e) {
      flash('リストを開けませんでした: ' + e.message, true);
    }
  }

  function renderList() {
    var has = !!currentList;
    $('listBody').hidden = !has;
    $('listEmpty').hidden = has;
    $('closeListBtn').hidden = !has;
    if (!has) { $('listMeta').textContent = ''; return; }

    $('listMeta').textContent = '作成 ' + currentList.createdAt + (currentList.closedAt ? ' / 終了 ' + currentList.closedAt : '');
    $('closeListBtn').textContent = currentList.closedAt ? '検討を再開する' : '検討を終える';
    $('codesInput').value = items.map(function (i) { return short(i.code); }).join(', ');
    $('countLabel').textContent = items.length + ' / ' + meta.maxItems + ' 銘柄';
    $('countLabel').className = 'count' + (items.length >= meta.maxItems ? ' full' : '');
    $('dirtyLabel').hidden = !isDirty();

    var head = '<thead><tr>' + COLS.map(function (c) {
      return '<th' + (c.num ? ' class="num-col"' : '') + '>' + c.label + '</th>';
    }).join('') + '<th>追加元</th><th></th></tr></thead>';
    var body = '<tbody>' + items.map(function (i) {
      var r = info[i.code] || { code: i.code, name: '(未確認)' };
      var src = FROM_LABEL[i.from] || '';
      if (i.from === 'SECTOR' && r.sector) src += ':' + r.sector;
      if (i.from === 'TAG' && i.detail) src += ':' + i.detail;
      return '<tr>' + COLS.map(function (c) { return cellHtml(r, c.key); }).join('') +
        '<td class="from">' + esc(src) + (i.addedAt ? ' / ' + esc(i.addedAt) : ' / 未保存') + '</td>' +
        '<td><button class="link rm" type="button" data-code="' + esc(i.code) + '">外す</button></td></tr>';
    }).join('') + '</tbody>';
    $('memberTable').innerHTML = items.length ? head + body : '<tbody><tr><td class="dim">まだ銘柄がありません</td></tr></tbody>';
    Array.prototype.forEach.call($('memberTable').querySelectorAll('.rm'), function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-code');
        items = items.filter(function (i) { return i.code !== code; });
        renderList();
        if (results.length) renderResults();
      });
    });
    var rem = currentList.removed || [];
    // 外した銘柄は注記の大きさで、横に5〜6列並べる。新しく外した順。全件出す
    $('removedBox').hidden = rem.length === 0;
    $('removedGrid').innerHTML = rem.map(function (x) {
      return '<span class="rm-item" title="' + esc(short(x.code) + ' ' + (x.name || '')) + '">' +
        '<span class="rm-code">' + esc(short(x.code)) + '</span>' +
        '<span class="rm-name">' + esc(x.name || '') + '</span>' +
        '<span class="rm-date">(' + esc((x.removedAt || '').slice(5, 10)) + ')</span></span>';
    }).join('');
  }

  /** カンマ区切り欄を手で書き換えたとき: 新しいコードを手入力として足し、消えたコードを外す */
  async function applyCodesInput() {
    var parts = $('codesInput').value.split(/[,\s、]+/).filter(Boolean);
    var bad = [];
    var codes = [];
    parts.forEach(function (p) {
      var c = normCode(p);
      if (!c) bad.push(p);
      else if (codes.indexOf(c) < 0) codes.push(c);
    });
    if (bad.length) flash('コードの形ではないため無視しました: ' + bad.join(', '), true);
    if (codes.length > meta.maxItems) {
      flash(meta.maxItems + '銘柄までです。先頭の' + meta.maxItems + '銘柄だけ残しました', true);
      codes = codes.slice(0, meta.maxItems);
    }
    var byCode = {};
    items.forEach(function (i) { byCode[i.code] = i; });
    var fresh = codes.filter(function (c) { return !byCode[c]; });
    if (fresh.length) {
      try {
        var data = await api('GET', '/api/purchase/stocks?codes=' + encodeURIComponent(fresh.join(',')));
        data.rows.forEach(function (r) { info[r.code] = r; });
        if (data.missing.length) {
          flash('銘柄マスタにないコードです: ' + data.missing.map(short).join(', '), true);
          codes = codes.filter(function (c) { return data.missing.indexOf(c) < 0; });
        }
      } catch (e) {
        flash('コードを確認できませんでした: ' + e.message, true);
        return;
      }
    }
    items = codes.map(function (c) { return byCode[c] || { code: c, from: 'MANUAL', detail: null }; });
    renderList();
    if (results.length) renderResults();
  }

  /** 保存。b) のボタンからも呼ぶので、成否を返す */
  async function saveList() {
    if (!currentList) return false;
    $('saveBtn').disabled = true;
    try {
      var out = await api('PUT', '/api/purchase/lists/' + currentList.listId + '/items', {
        items: items.map(function (i) { return { code: i.code, from: i.from, detail: i.detail }; }),
      });
      await openList(currentList.listId);
      await reloadLists(currentList.listId);
      flash('保存しました(追加 ' + out.added.length + ' / 外した ' + out.removed.length + ')');
      return true;
    } catch (e) {
      flash('保存できませんでした: ' + e.message, true);
      return false;
    } finally {
      $('saveBtn').disabled = false;
    }
  }

  async function createList() {
    var name = $('newListName').value.trim();
    if (!name) { flash('リスト名を入れてください', true); return; }
    if (currentList && isDirty() && !confirm('いまのリストに保存していない変更があります。破棄して新しいリストを作りますか?')) return;
    try {
      var out = await api('POST', '/api/purchase/lists', { name: name });
      $('newListName').value = '';
      await reloadLists(out.listId);
      await openList(out.listId);
      flash('リスト「' + name + '」を作成しました');
    } catch (e) {
      flash('作成できませんでした: ' + e.message, true);
    }
  }

  async function toggleClose() {
    if (!currentList) return;
    var reopen = !!currentList.closedAt;
    if (!reopen && !confirm('このリストの検討を終えますか?(リストは消えず、プルダウンにも残ります)')) return;
    try {
      await api('POST', '/api/purchase/lists/' + currentList.listId + '/close', { reopen: reopen });
      await openList(currentList.listId);
      await reloadLists(currentList.listId);
    } catch (e) {
      flash('変更できませんでした: ' + e.message, true);
    }
  }

  //------------------------------------------------------------------ b) ファンダメンタル参考情報
  var SYM = { good: '◎', ok: '〇', bad: '×', na: '-' };
  var GROUPS = [
    { key: 'F1', label: 'F1 成長', nos: [1, 2, 3, 4, 5] },
    { key: 'F2', label: 'F2 割安', nos: [6, 7, 8, 9] },
    { key: 'F3', label: 'F3 収益・財務', nos: [10, 11, 12, 13] },
  ];
  var KIND_JA = { UP: '上方', DOWN: '下方', SMALL: '小幅' };

  function symHtml(it) {
    if (!it) return '<span class="sym-na">-</span>';
    return '<span class="sym-' + it.level + '">' + SYM[it.level] + '</span>' + (it.warn ? '<span class="sym-warn" title="' + esc(it.warn) + '">⚠</span>' : '');
  }
  function f1(v, unit) { return v === null || v === undefined || isNaN(v) ? '—' : num(v, 1) + (unit || ''); }
  function growthHtml(p) {
    var g = p.g;
    var t;
    if (!g) t = '—';
    else if (g.special) t = g.special;
    else t = (g.pct > 0 ? '+' : g.pct < 0 ? '−' : '±') + Math.abs(g.pct).toFixed(1) + '%';
    return '<span class="lbl">' + esc(p.label) + '</span>' + esc(t) + (p.level ? ' <span class="sym-' + p.level + '">' + SYM[p.level] + '</span>' : '');
  }

  /** 詳細の1行を文字にする(項目ごとに中身の形が違う) */
  function lineHtml(no, ln) {
    if (ln.text) return esc(ln.text);
    if (ln.parts) {
      return (ln.label ? '<span class="lbl">' + esc(ln.label) + '</span>' : '') +
        ln.parts.filter(function (p) { return p.key !== 'odp' || p.g; }).map(growthHtml).join('  ');
    }
    if (ln.progress) {
      return '<span class="lbl">' + esc(ln.label) + '</span>' + ln.progress.map(function (p) {
        return '<span class="lbl">' + esc(p.label) + '</span>' + f1(p.p, '%');
      }).join('  ');
    }
    if (ln.past) {
      return '<span class="lbl">' + esc(ln.label) + '</span>' + ln.past.map(function (p) {
        return esc(p.fyEn.slice(0, 7)) + '期 ' + f1(p.p, '%');
      }).join(' / ');
    }
    if (ln.revision) {
      var r = ln.revision;
      return esc(r.discDate) + ' ' + (r.verified ? '業績予想の修正' : '決算短信での予想変更') +
        ' 営業利益予想 REV ' + (r.rev > 0 ? '+' : '') + f1(r.rev, 'pt') + '(' + (KIND_JA[r.kind] || '') + ')';
    }
    if (ln.per) {
      var p = ln.per;
      return '<span class="lbl">予想</span>' + (p.lossF ? '赤字予想' : f1(p.forecast, '倍')) +
        (p.epsF !== null && p.epsF !== undefined ? '(EPS ' + num(p.epsF, 1) + '円)' : '') +
        '  <span class="lbl">実績</span>' + (p.lossA ? '赤字' : f1(p.actual, '倍')) +
        '  <span class="lbl">業種中央値</span>' + f1(p.sectorMedian, '倍') +
        '  <span class="lbl">市場中央値</span>' + f1(p.marketMedian, '倍') +
        (p.basis === '実績' ? '  (会社予想がないため実績で判定)' : '');
    }
    var v = ln.value || {};
    switch (no) {
      case 7: return f1(v.pbr, '倍') + (v.bps ? '(BPS ' + num(v.bps, 0) + '円、' + esc(v.from) + ')' : '');
      case 8: return f1(v.yield, '%') + (v.div !== null && v.div !== undefined ? '(1株配当 ' + num(v.div, 1) + '円、' + v.basis + ')' : '');
      case 9: return v.note ? esc(v.note) + '(EPSの伸び ' + f1(v.epsGrowth, '%') + ')'
        : f1(v.peg, '') + (v.per ? '(予想PER ' + f1(v.per, '') + ' ÷ EPSの伸び ' + f1(v.epsGrowth, '%') + ')' : '');
      case 10: return f1(v.roe, '%') + (v.from ? '(' + esc(v.from) + ' の本決算)' : '');
      case 11:
      case 12: {
        var val = no === 11 ? v.opm : v.eqar;
        var rk = v.rank;
        return f1(val, '%') + (rk ? '  業種内 上位' + Math.round(rk.topPct) + '%(' + rk.n + '社中)  業種中央値 ' + f1(rk.median, '%') : '') +
          (v.groupName ? '  [' + esc(v.groupName) + ']' : '') + (v.from ? '(' + esc(v.from) + ')' : '');
      }
      case 13: return v.cfo === null || v.cfo === undefined ? '—'
        : '営業CF ' + oku(v.cfo, 0) + '億円 / 純益 ' + oku(v.np, 0) + '億円(' + esc(v.from) + ')';
      default: return '';
    }
  }

  function detailHtml(row) {
    var byNo = {};
    row.items.forEach(function (it) { byNo[it.no] = it; });
    var html = GROUPS.map(function (g) {
      return '<div class="d-grp">' + esc(g.label) + '</div>' + g.nos.map(function (no) {
        var it = byNo[no];
        return '<div class="d-item"><span class="d-no">' + noTag(no) + '</span><span>' + symHtml(it) + '</span>' +
          '<span class="d-label">' + esc(it.label) + '</span><div class="d-lines">' +
          it.lines.map(function (ln) { return '<div>' + lineHtml(no, ln) + '</div>'; }).join('') +
          (it.warn ? '<div class="d-warn">⚠ ' + esc(it.warn) + '</div>' : '') + '</div></div>';
      }).join('');
    }).join('');
    var a = row.asOf || {};
    var ls = a.latestStatement;
    html += '<div class="d-asof">株価 ' + esc(a.priceDate || '—') + ' の終値 ' + num(a.close, 1) + '円。' +
      (ls ? '直近の決算短信 ' + esc(ls.fyEn.slice(0, 7)) + '期 ' + esc(ls.perType) + '(' + esc(ls.discDate) + ' 開示)' : '決算短信なし') + '</div>';
    return html;
  }

  function renderFundamentals(data) {
    var head1 = '<tr><th rowspan="2" class="c-sel" title="損失回避チェックに進める銘柄(最大5)">選ぶ</th><th rowspan="2">コード</th><th rowspan="2">銘柄名</th>' + GROUPS.map(function (g) {
      return '<th class="grp" colspan="' + g.nos.length + '">' + esc(g.label) + '</th>';
    }).join('') + '</tr>';
    var head2 = '<tr>' + GROUPS.map(function (g) {
      return g.nos.map(function (no, i) { return '<th class="no' + (i === 0 ? ' first' : '') + '">' + noTag(no) + ' ' + esc(FUND_SHORT[no]) + '</th>'; }).join('');
    }).join('') + '</tr>';
    var colspan = 3 + 13;
    var body = data.rows.map(function (row, idx) {
      var byNo = {};
      row.items.forEach(function (it) { byNo[it.no] = it; });
      return '<tr class="main" data-idx="' + idx + '">' + chkCell(row.code) + '<td class="code">' + esc(short(row.code)) + '</td>' +
        '<td class="name" title="' + esc(row.name) + '">' + esc(row.name) + '</td>' +
        GROUPS.map(function (g) {
          return g.nos.map(function (no, i) {
            var it = byNo[no];
            return '<td class="sym' + (i === 0 ? ' first' : '') + '" title="' + esc(it ? it.label : '') + '">' + symHtml(it) + '</td>';
          }).join('');
        }).join('') + '</tr>' +
        '<tr class="detail" data-idx="' + idx + '" hidden><td colspan="' + colspan + '">' + detailHtml(row) + '</td></tr>';
    }).join('');
    $('refTable').innerHTML = '<thead>' + head1 + head2 + '</thead><tbody>' + body + '</tbody>';
    bindDetailToggle();
    $('refTitle').textContent = 'ファンダメンタル参考情報';
    $('refNote').textContent = data.rows.length + '銘柄。業種内の比較は上場中の全銘柄(33業種、20社未満の業種は17業種)';
    $('refPane').hidden = false;
  }

  //------------------------------------------------------------------ b) テクニカル参考情報
  var TECH_IDS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '19'];
  /** 見出しに出す短い名前(番号は札で添える) */
  var FUND_SHORT = { 1: '年間増収益', 2: '四半期増収益', 3: '進捗率', 4: '来期予想', 5: '予想修正', 6: 'PER', 7: 'PBR',
    8: '配当利回り', 9: 'PEG', 10: 'ROE', 11: '営業利益率', 12: '自己資本比率', 13: '営業CF' };
  var TECH_SHORT = { '①': '200日線', '②': 'GC', '③': '乖離率', '④': 'ローソク足', '⑤': '出来高', '⑥': 'レジスタンス',
    '⑦': 'RSI', '19': '信用倍率' };
  /** テクニカルの番号は画面では T1〜T7 で出す(サーバーが返す id は ①〜⑦ のまま) */
  var TECH_TAG = { '①': 'T1', '②': 'T2', '③': 'T3', '④': 'T4', '⑤': 'T5', '⑥': 'T6', '⑦': 'T7', '19': '19' };
  function noTag(no) { return '<span class="no-tag">' + esc(String(TECH_TAG[no] || no)) + '</span>'; }
  function yenP(v) { return v === null || v === undefined || isNaN(v) ? '—' : num(v, v < 1000 ? 1 : 0) + '円'; }
  function sgn(v, d, unit) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d === undefined ? 1 : d) + (unit || '');
  }

  function techLineHtml(id, ln) {
    if (ln.text) return esc(ln.text);
    if (ln.ma) {
      return '<span class="lbl">株価</span>' + yenP(ln.ma.price) + '  <span class="lbl">200日線</span>' + yenP(ln.ma.ma200) +
        '  <span class="lbl">乖離</span>' + sgn(ln.ma.dev, 1, '%');
    }
    if (ln.gc) {
      var g = ln.gc;
      return '<span class="lbl">5日線</span>' + yenP(g.ma5) + (g.ma5 > g.ma5p ? '↑' : '↓') +
        '  <span class="lbl">25日線</span>' + yenP(g.ma25) + (g.ma25 > g.ma25p ? '↑' : '↓') +
        '  ' + (g.above ? '5日線が上' : '5日線が下') +
        (g.crossDays !== null && g.crossDays !== undefined ? '  (ゴールデンクロスから ' + g.crossDays + '営業日)' : '');
    }
    if (ln.candle) {
      var c = ln.candle;
      if (c.note) return esc(c.note);
      return '<span class="lbl">始</span>' + yenP(c.o) + ' <span class="lbl">高</span>' + yenP(c.h) +
        ' <span class="lbl">安</span>' + yenP(c.l) + ' <span class="lbl">終</span>' + yenP(c.c) +
        '  <span class="lbl">前日比</span>' + sgn(c.chg, 1, '%') + '  ' + (c.yang ? '陽線' : '陰線') +
        '  <span class="lbl">実体</span>' + f1(c.body, '%') + '  <span class="lbl">上ヒゲ</span>' + f1(c.upper, '%') +
        '  <span class="lbl">高値からの押し</span>' + f1(c.push, '%');
    }
    if (ln.volume) {
      var v = ln.volume;
      return '<span class="lbl">当日</span>' + num(v.v, 0) + '株  <span class="lbl">5日平均</span>' + num(v.avg5, 0) +
        '  <span class="lbl">25日平均</span>' + num(v.avg25, 0) + '  <span class="lbl">倍率</span>' + num(v.ratio, 2) + '倍' +
        (v.up ? '(上昇日)' : v.down ? '(下落日)' : '');
    }
    if (ln.resistance) {
      var list = ln.resistance.list;
      if (!list.length) return '現在値より上に抵抗線の候補なし';
      return list.map(function (x) {
        return '<div>' + esc(x.kind) + ' ' + yenP(x.price) + (x.priceHi ? '〜' + yenP(x.priceHi) : '') +
          '(' + sgn(x.distPct, 1, '%') + ')' + (x.dates ? ' <span class="lbl">' + esc(x.dates.join(', ')) + '</span>' : '') + '</div>';
      }).join('');
    }
    if (ln.margin) {
      var m = ln.margin;
      return (m.ratio !== null ? num(m.ratio, 2) + '倍' : '売残ゼロ') + '  <span class="lbl">買残</span>' + num(m.long, 0) +
        '株  <span class="lbl">売残</span>' + num(m.shrt, 0) + '株(' + esc(m.date) + ')';
    }
    var val = ln.value || {};
    if (id === '③') return f1(val.gap, '%') + '(5日線 ' + yenP(val.ma5) + ' / 25日線 ' + yenP(val.ma25) + ')';
    if (id === '⑦') return f1(val.rsi, '');
    return '';
  }

  function renderTechnicals(data) {
    var head = '<tr><th rowspan="2" class="c-sel" title="損失回避チェックに進める銘柄(最大5)">選ぶ</th><th rowspan="2">コード</th><th rowspan="2">銘柄名</th><th class="grp" colspan="8">T 値動き・需給</th></tr><tr>' +
      TECH_IDS.map(function (id, i) { return '<th class="no' + (i === 0 ? ' first' : '') + '">' + noTag(id) + ' ' + esc(TECH_SHORT[id]) + '</th>'; }).join('') + '</tr>';
    var body = data.rows.map(function (row, idx) {
      var byId = {};
      row.items.forEach(function (it) { byId[it.id] = it; });
      var detail = row.items.map(function (it) {
        return '<div class="d-item"><span class="d-no">' + noTag(it.id) + '</span><span>' + symHtml(it) + '</span>' +
          '<span class="d-label">' + esc(it.label) + '</span><div class="d-lines">' +
          it.lines.map(function (ln) { return '<div>' + techLineHtml(it.id, ln) + '</div>'; }).join('') +
          (it.warn ? '<div class="d-warn">⚠ ' + esc(it.warn) + '</div>' : '') + '</div></div>';
      }).join('') + '<div class="d-asof">' + esc(row.asOf && row.asOf.priceDate || '—') + ' までの日足(分割調整後)</div>';
      return '<tr class="main" data-idx="' + idx + '">' + chkCell(row.code) + '<td class="code">' + esc(short(row.code)) + '</td>' +
        '<td class="name" title="' + esc(row.name) + '">' + esc(row.name) + '</td>' +
        TECH_IDS.map(function (id, i) {
          var it = byId[id];
          return '<td class="sym' + (i === 0 ? ' first' : '') + '" title="' + esc(it ? it.label : '') + '">' + symHtml(it) + '</td>';
        }).join('') + '</tr>' +
        '<tr class="detail" data-idx="' + idx + '" hidden><td colspan="11">' + detail + '</td></tr>';
    }).join('');
    $('refTable').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    bindDetailToggle();
    $('refTitle').textContent = 'テクニカル参考情報';
    $('refNote').textContent = data.rows.length + '銘柄';
    $('refPane').hidden = false;
  }

  //------------------------------------------------------------------ c) へ進む銘柄の選択
  var MAX_CHECK = 5;
  var checkSel = [];        // 損失回避チェックに進める銘柄(ファンダメンタル・テクニカルの表示を切り替えても残す)

  function chkCell(code) {
    return '<td class="c-sel"><input type="checkbox" class="chk" value="' + esc(code) + '"' +
      (checkSel.indexOf(code) >= 0 ? ' checked' : '') + '></td>';
  }
  function renderCheckCount() {
    $('checkCount').textContent = checkSel.length + ' / ' + MAX_CHECK + ' 銘柄を選択';
    $('checkBtn').disabled = !checkSel.length;
  }
  function bindChecks() {
    Array.prototype.forEach.call($('refTable').querySelectorAll('.chk'), function (cb) {
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        var code = cb.value;
        if (cb.checked) {
          if (checkSel.length >= MAX_CHECK) {
            cb.checked = false;
            flash('損失回避チェックは' + MAX_CHECK + '銘柄までです', true);
            return;
          }
          if (checkSel.indexOf(code) < 0) checkSel.push(code);
        } else {
          checkSel = checkSel.filter(function (c) { return c !== code; });
        }
        renderCheckCount();
      });
    });
    // リストから外れた銘柄は選択からも外す
    var inList = items.map(function (i) { return i.code; });
    checkSel = checkSel.filter(function (c) { return inList.indexOf(c) >= 0; });
    renderCheckCount();
  }
  function openCheck() {
    if (!currentList || !checkSel.length) return;
    var url = '/purchase/check?list=' + currentList.listId + '&codes=' + encodeURIComponent(checkSel.map(short).join(','));
    window.open(url, '_blank');
  }

  function bindDetailToggle() {
    bindChecks();
    Array.prototype.forEach.call($('refTable').querySelectorAll('tr.main'), function (tr) {
      tr.addEventListener('click', function () {
        var d = $('refTable').querySelector('tr.detail[data-idx="' + tr.getAttribute('data-idx') + '"]');
        d.hidden = !d.hidden;
        tr.classList.toggle('open', !d.hidden);
      });
    });
  }

  async function showRef(kind) {
    if (!currentList) { flash('先にリストを選んでください', true); return; }
    if (!items.length) { flash('リストに銘柄がありません', true); return; }
    var ok = await saveList();   // 設計どおり、表示の前に保存する
    if (!ok) return;
    var btn = $(kind === 'tech' ? 'techBtn' : 'fundBtn');
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = '計算中…';
    try {
      var data = await api('GET', '/api/purchase/lists/' + currentList.listId + (kind === 'tech' ? '/technicals' : '/fundamentals'));
      if (kind === 'tech') renderTechnicals(data); else renderFundamentals(data);
      $('refPane').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      flash('参考情報を取得できませんでした: ' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  //------------------------------------------------------------------ イベント
  function bindEvents() {
    $('fundBtn').addEventListener('click', function () { showRef('fund'); });
    $('techBtn').addEventListener('click', function () { showRef('tech'); });
    $('checkBtn').addEventListener('click', openCheck);
    var prevSel = '';
    $('listSelect').addEventListener('focus', function () { prevSel = $('listSelect').value; });
    $('listSelect').addEventListener('change', function () {
      var v = $('listSelect').value;
      if (currentList && isDirty() && !confirm('保存していない変更があります。破棄してリストを切り替えますか?')) {
        $('listSelect').value = prevSel || String(currentList.listId);
        return;
      }
      prevSel = v;
      if (!v) {
        currentList = null; items = []; savedCodes = [];
        try { localStorage.removeItem('jqb-purchase-list'); } catch (e) { /* noop */ }
        renderList();
        if (results.length) renderResults();
        return;
      }
      openList(Number(v));
    });
    $('createListBtn').addEventListener('click', createList);
    $('newListName').addEventListener('keydown', function (e) { if (e.key === 'Enter') createList(); });
    $('closeListBtn').addEventListener('click', toggleClose);
    $('codesInput').addEventListener('change', applyCodesInput);
    $('saveBtn').addEventListener('click', saveList);
    $('showBtn').addEventListener('click', showStocks);
    $('addBtn').addEventListener('click', addPicked);
    $('clearSelBtn').addEventListener('click', function () {
      checked(searchTab === 'sector' ? 'seccb' : 'tagcb').forEach(function (c) { c.checked = false; });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#searchTabs .tab'), function (t) {
      t.addEventListener('click', function () {
        searchTab = t.getAttribute('data-tab');
        Array.prototype.forEach.call(document.querySelectorAll('#searchTabs .tab'), function (x) {
          x.setAttribute('aria-selected', x === t ? 'true' : 'false');
        });
        $('sectorBox').hidden = searchTab !== 'sector';
        $('tagBox').hidden = searchTab !== 'tag';
        $('searchStatus').textContent = '';
      });
    });
    window.addEventListener('beforeunload', function (e) {
      if (currentList && isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
  }


  init();
})();
