/*
 * 銘柄グループ(/groups)。
 *   上: 33業種かタグを選んで「銘柄一覧を表示」で表を出し、チェックした銘柄を「カードにする」でカードに足す
 *       (2026-11-25 銘柄購入から移した。API は銘柄購入と共用の /api/purchase/meta・stocks・avoid)。
 *   左: 銘柄コードか企業名の一部を入れて候補から選ぶと、下に横長カードが積み上がる。✗ でカードを消す。
 *   右: グループの一覧。＋ で作る、行を押して選び − で削除・編集で名前を変える。
 *       各行の「追加」で、いま出ているカードの銘柄をそのグループに足す(足したらカードは消える)。
 *       三角でグループの中の銘柄を開く(✗ でグループから外す)。
 *       「リスト」で、そのグループの銘柄コード(4桁)をカンマ区切りでクリップボードにコピーする。
 * サーバー側の扱いは src/web/stockGroups.js 冒頭。銘柄の検索は /api/stock-lookup(stockLookup.js)。
 */
(function () {
  'use strict';

  var BP = window.BASE_PATH || '';
  var $ = function (id) { return document.getElementById(id); };

  var groups = [];
  var cards = [];          // { code, shortCode, name }
  var selectedId = null;
  var openIds = {};        // 開いているグループ
  var creating = false;    // ＋ の入力欄を出しているか
  var editingId = null;    // 名前を変えているグループ
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(method, url, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(BP + url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || r.statusText);
        return j;
      });
    });
  }

  function flash(msg) {
    var el = $('flash');
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  function status(msg, bad) {
    var el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('bad', !!bad);
  }

  function findGroup(id) {
    for (var i = 0; i < groups.length; i++) if (groups[i].id === id) return groups[i];
    return null;
  }

  // 変更の API は毎回グループの一覧を丸ごと返す
  function apply(j) {
    if (j && j.groups) groups = j.groups;
    if (selectedId != null && !findGroup(selectedId)) selectedId = null;
    flash('');
    renderGroups();
  }

  function run(p) {
    busy = true;
    return p.then(function (j) { busy = false; return j; }, function (e) { busy = false; flash(e.message); throw e; });
  }

  //---------------------------------------------------------- 横長カード
  function renderCards() {
    $('cards').innerHTML = cards.map(function (c, i) {
      return '<div class="grp-card"><button class="x" type="button" data-i="' + i + '" title="カードを消す" aria-label="カードを消す">✗</button>' +
        '<span class="code">' + esc(c.shortCode) + '</span><span class="name">' + esc(c.name) + '</span></div>';
    }).join('');
    // カードが無いときは「追加」を押せない
    Array.prototype.forEach.call(document.querySelectorAll('.grp-add'), function (b) { b.disabled = cards.length === 0; });
    // 業種・タグの表で、カードになっている銘柄の印を付け直す
    if (results.length) renderResults();
  }

  $('cards').addEventListener('click', function (e) {
    var b = e.target.closest('.x');
    if (!b) return;
    cards.splice(Number(b.getAttribute('data-i')), 1);
    renderCards();
    renderPop();
  });

  function hasCard(code) {
    for (var i = 0; i < cards.length; i++) if (cards[i].code === code) return true;
    return false;
  }

  //---------------------------------------------------------- 入力欄と候補
  var input = $('q'), pop = $('pop'), popList = $('popList'), popFoot = $('popFoot');
  var items = [], total = 0, active = -1, timer = null, seq = 0;

  function closePop() { pop.hidden = true; active = -1; }

  function renderPop() {
    if (pop.hidden) return;
    popList.innerHTML = items.map(function (it, i) {
      var on = hasCard(it.code);
      return '<li role="option" data-i="' + i + '" class="' + (on ? 'added' : '') + (i === active ? ' active' : '') + '">' +
        '<span class="lk-code">' + esc(it.shortCode) + '</span>' +
        '<span class="lk-name">' + esc(it.name) + '</span>' +
        '<span class="lk-mkt">' + esc(it.market) + '</span>' +
        '<span class="lk-state">' + (on ? 'カードあり' : '') + '</span></li>';
    }).join('');
    if (!items.length) popFoot.textContent = '一致する銘柄はありません';
    else if (total > items.length) popFoot.textContent = total + '件のうち先頭' + items.length + '件';
    else popFoot.textContent = total + '件';
  }

  function query() {
    var q = input.value.trim();
    var my = ++seq;
    if (!q) { items = []; closePop(); return; }
    fetch(BP + '/api/stock-lookup?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); })
      .then(function (j) {
        if (my !== seq) return; // 後から打った分の結果が先に来ていたら捨てる
        items = j.items || [];
        total = j.total || 0;
        active = items.length ? 0 : -1;
        pop.hidden = false;
        renderPop();
      })
      .catch(function (e) {
        if (my !== seq) return;
        items = [];
        popList.innerHTML = '';
        popFoot.textContent = '検索できませんでした: ' + e.message;
        pop.hidden = false;
      });
  }

  function pick(i) {
    var it = items[i];
    if (!it) return;
    if (!hasCard(it.code)) {
      cards.push({ code: it.code, shortCode: it.shortCode, name: it.name });
      renderCards();
    }
    // 続けて別の銘柄も選べるよう、候補は開いたままにする
    active = i;
    renderPop();
    input.focus();
  }

  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(query, 150); });
  input.addEventListener('focus', function () { if (items.length && input.value.trim()) { pop.hidden = false; renderPop(); } });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePop(); return; }
    if (pop.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; renderPop(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; renderPop(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active < 0 ? 0 : active); }
  });
  popList.addEventListener('mousedown', function (e) {
    var li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();   // 入力欄からフォーカスを外さない
    e.stopPropagation();  // 描き直しで li が消えても、下の「外側を押したら閉じる」が働かないように
    pick(Number(li.getAttribute('data-i')));
  });
  document.addEventListener('mousedown', function (e) { if (!$('searchBox').contains(e.target)) closePop(); });

  //---------------------------------------------------------- グループの一覧
  function renderGroups() {
    var h = [];
    groups.forEach(function (g) {
      var open = !!openIds[g.id];
      var name = editingId === g.id
        ? '<input type="text" class="grp-name-input" data-edit="' + g.id + '" maxlength="100" value="' + esc(g.name) + '">'
        : '<span class="grp-label">' + esc(g.name) + '</span>';
      h.push('<div class="grp-r grp-head' + (selectedId === g.id ? ' sel' : '') + '" data-id="' + g.id + '">' +
        '<div class="grp-cell"><button class="grp-tri" type="button" aria-expanded="' + open + '" title="' + (open ? '閉じる' : '開く') + '">' +
        (open ? '▼' : '▶') + '</button>' + name + '</div>' +
        '<div class="grp-act">' +
        '<button class="btn grp-add" type="button"' + (cards.length ? '' : ' disabled') + '>追加</button>' +
        '<button class="btn grp-list" type="button"' + (g.items.length ? '' : ' disabled') + '>リスト</button>' +
        '</div></div>');
      if (open) {
        if (!g.items.length) {
          h.push('<div class="grp-r grp-item empty-item"><div class="grp-cell">銘柄はまだありません</div><div></div></div>');
        }
        g.items.forEach(function (it) {
          h.push('<div class="grp-r grp-item" data-id="' + g.id + '" data-code="' + esc(it.code) + '"><div class="grp-cell">' +
            '<button class="x" type="button" title="グループから外す" aria-label="グループから外す">✗</button>' +
            '<span class="code">' + esc(it.shortCode) + '</span><span class="name">' + esc(it.name) + '</span></div><div></div></div>');
        });
      }
    });
    if (creating) {
      h.push('<div class="grp-r"><div class="grp-cell"><input type="text" class="grp-name-input" data-new="1" maxlength="100" placeholder="グループ名"></div><div></div></div>');
    }
    h.push('<div class="grp-r filler"><div class="grp-cell"></div><div></div></div>');
    $('groups').innerHTML = h.join('');

    $('delGroupBtn').disabled = selectedId == null;
    $('editGroupBtn').disabled = selectedId == null;

    var inp = $('groups').querySelector('.grp-name-input');
    if (inp) { inp.focus(); if (inp.value) inp.select(); }
  }

  $('groups').addEventListener('click', function (e) {
    var row = e.target.closest('.grp-r');
    if (!row) return;
    var id = Number(row.getAttribute('data-id'));

    if (row.classList.contains('grp-item')) {
      var x = e.target.closest('.x');
      if (x && !busy) {
        var code = row.getAttribute('data-code');
        run(api('DELETE', '/api/groups/' + id + '/items/' + encodeURIComponent(code))).then(apply, function () {});
      }
      return;
    }
    if (!row.classList.contains('grp-head')) return;

    if (e.target.closest('.grp-tri')) {
      openIds[id] = !openIds[id];
      renderGroups();
      return;
    }
    if (e.target.closest('.grp-add')) { addTo(id); return; }
    if (e.target.closest('.grp-list')) { copyList(id); return; }
    if (e.target.closest('.grp-name-input')) return;
    // 行を押すと選ぶ。もう一度押すと選ぶのをやめる
    selectedId = selectedId === id ? null : id;
    renderGroups();
  });

  // グループ名の入力欄: Enter で決める、Esc でやめる
  $('groups').addEventListener('keydown', function (e) {
    var inp = e.target.closest('.grp-name-input');
    if (!inp) return;
    if (e.key === 'Escape') { creating = false; editingId = null; renderGroups(); return; }
    if (e.key !== 'Enter' || e.isComposing || busy) return;
    e.preventDefault();
    var name = inp.value;
    if (inp.getAttribute('data-new')) {
      run(api('POST', '/api/groups', { name: name })).then(function (j) {
        creating = false;
        apply(j);
      }, function () {});
    } else {
      var id = Number(inp.getAttribute('data-edit'));
      run(api('PATCH', '/api/groups/' + id, { name: name })).then(function (j) {
        editingId = null;
        apply(j);
      }, function () {});
    }
  });

  // 入力欄から離れたら、何も入っていない＋の欄と、名前を変えていない編集はやめる
  $('groups').addEventListener('focusout', function (e) {
    var inp = e.target.closest('.grp-name-input');
    if (!inp || busy) return;
    setTimeout(function () {
      if (busy || !document.body.contains(inp)) return;
      if (inp.getAttribute('data-new') && !inp.value.trim()) { creating = false; renderGroups(); }
      else if (inp.getAttribute('data-edit')) {
        var g = findGroup(Number(inp.getAttribute('data-edit')));
        if (g && inp.value.trim() === g.name) { editingId = null; renderGroups(); }
      }
    }, 0);
  });

  $('addGroupBtn').addEventListener('click', function () {
    editingId = null;
    creating = true;
    renderGroups();
  });

  $('editGroupBtn').addEventListener('click', function () {
    if (selectedId == null) return;
    creating = false;
    editingId = selectedId;
    renderGroups();
  });

  $('delGroupBtn').addEventListener('click', function () {
    var g = findGroup(selectedId);
    if (!g || busy) return;
    var msg = 'グループ「' + g.name + '」を削除します。' + (g.items.length ? '中の銘柄 ' + g.items.length + '件もグループから外れます。' : '');
    if (!window.confirm(msg)) return;
    run(api('DELETE', '/api/groups/' + g.id)).then(function (j) {
      delete openIds[g.id];
      selectedId = null;
      apply(j);
    }, function () {});
  });

  //---------------------------------------------------------- 追加・リスト
  function addTo(id) {
    var g = findGroup(id);
    if (!g || !cards.length || busy) return;
    var codes = cards.map(function (c) { return c.code; });
    run(api('POST', '/api/groups/' + id + '/items', { codes: codes })).then(function (j) {
      cards = [];
      renderCards();
      renderPop();
      apply(j);
      var parts = [];
      if (j.added.length) parts.push(j.added.length + '件追加しました');
      if (j.already.length) parts.push('すでに入っていた: ' + j.already.join(', '));
      if (j.unknown.length) parts.push('銘柄マスタに無い: ' + j.unknown.join(', '));
      status('「' + g.name + '」に' + parts.join('。'), !j.added.length && !j.already.length);
    }, function () {});
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    // http で 127.0.0.1 以外から開いたとき(clipboard API が使えない)
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('クリップボードにコピーできませんでした'));
    });
  }

  function copyList(id) {
    var g = findGroup(id);
    if (!g || !g.items.length) return;
    var text = g.items.map(function (it) { return it.shortCode; }).join(',');
    copyText(text).then(function () {
      status('「' + g.name + '」の銘柄コード ' + g.items.length + '件をコピーしました: ' + text);
    }, function (e) { status(e.message, true); });
  }

  //---------------------------------------------------------- 業種・タグから探す(銘柄購入から移した)
  var results = [];        // 銘柄一覧の結果
  var sortKey = 'code';
  var sortDir = 1;
  var searchTab = 'sector';
  var avoid = null;        // 外す候補 {asOf, population, d10: {code: {...}}}(読み込み中は null)
  var avoidRequested = false;

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
  function short(code) { return code && code.length === 5 && code[4] === '0' ? code.slice(0, 4) : code; }
  // 銘柄コードのセル。株予報Pro(IFIS)のその銘柄のアナリスト予想のページへのリンク(銘柄購入と同じ)
  function codeCell(code) {
    var c = short(code);
    return '<td class="code"><a class="ifis" href="' + esc('https://kabuyoho.jp/reportAnalyst?bcode=' + encodeURIComponent(c)) +
      '" target="_blank" rel="noopener noreferrer" title="株予報Proのアナリスト予想を開く">' + esc(c) + '</a></td>';
  }

  function renderSectors(sectors) {
    $('sectorBox').innerHTML = sectors.map(function (s) {
      return '<label class="sector-item"><input type="checkbox" class="seccb" value="' + esc(s.code) +
        '"><span>' + esc(s.name) + '</span>' +
        '<span class="sector-count">' + s.count + '</span></label>';
    }).join('');
  }

  function renderTags(tags) {
    var tg = [];
    var byMajor = {};
    tags.forEach(function (t) {
      // 番号なし(THEME)でも大分類名があるもの(売買記録の jnl_* タグ)は別のグループにする(app.js と同じ)
      var key = t.majorCode || (t.majorLabel ? 'label:' + t.majorLabel : 'theme');
      if (!byMajor[key]) {
        byMajor[key] = { label: t.majorLabel || 'テーマ(番号なし)', items: [] };
        tg.push(byMajor[key]);
      }
      byMajor[key].items.push(t);
    });
    $('tagBox').innerHTML = tg.map(function (g) {
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

  function checkedValues(cls) {
    return Array.prototype.map.call(document.querySelectorAll('.' + cls + ':checked'), function (c) { return c.value; });
  }

  /** 外す候補は全銘柄を計算するので時間がかかる(初回10秒ほど)。初めて一覧を出したときに読み込み、届いたら描き直す */
  function loadAvoid() {
    if (avoidRequested) return;
    avoidRequested = true;
    api('GET', '/api/purchase/avoid').then(function (j) { avoid = j; }, function (e) {
      avoid = { asOf: null, population: 0, d10: {}, error: e.message };
      flash('外す候補を計算できませんでした: ' + e.message);
    }).then(function () { if (results.length) renderResults(); });
  }

  function showStocks() {
    var q;
    if (searchTab === 'sector') {
      var secs = checkedValues('seccb');
      if (!secs.length) { $('searchStatus').textContent = '業種を1つ以上選んでください'; return; }
      q = 'sectors=' + encodeURIComponent(secs.join(','));
    } else {
      var tags = checkedValues('tagcb');
      if (!tags.length) { $('searchStatus').textContent = 'タグを1つ以上選んでください'; return; }
      q = 'tags=' + encodeURIComponent(tags.join(','));
    }
    $('searchStatus').textContent = '読み込み中…';
    $('showBtn').disabled = true;
    loadAvoid();
    api('GET', '/api/purchase/stocks?' + q).then(function (data) {
      results = data.rows || [];
      $('searchStatus').textContent = '';
      $('resultPane').hidden = false;
      renderResults();
    }, function (e) {
      $('searchStatus').textContent = '';
      flash('一覧を取得できませんでした: ' + e.message);
    }).then(function () { $('showBtn').disabled = false; });
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
      case 'code': return codeCell(r.code);
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

  function renderResults() {
    // 描き直してもチェックは残す
    var picked = {};
    checkedValues('pick').forEach(function (c) { picked[c] = true; });
    var head = '<thead><tr><th class="c-sel"><input type="checkbox" id="selAll" title="すべて選ぶ"></th>' +
      COLS.map(function (c) {
        return '<th class="sortable' + (c.num ? ' num-col' : '') + '" data-key="' + c.key + '"' +
          (sortKey === c.key ? ' aria-sort="' + (sortDir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + c.label + '</th>';
      }).join('') + '</tr></thead>';
    var body = '<tbody>' + sorted(results).map(function (r) {
      var on = hasCard(r.code);
      return '<tr class="' + (on ? 'as-card' : '') + '"><td class="c-sel">' +
        (on ? '<span class="card-badge">カード</span>'
            : '<input type="checkbox" class="pick" value="' + esc(r.code) + '"' + (picked[r.code] ? ' checked' : '') + '>') + '</td>' +
        COLS.map(function (c) { return cellHtml(r, c.key); }).join('') + '</tr>';
    }).join('') + '</tbody>';
    $('resultTable').innerHTML = head + body;
    $('resultCount').textContent = results.length + '銘柄';
  }

  $('resultTable').addEventListener('click', function (e) {
    var th = e.target.closest('th.sortable');
    if (!th) return;
    var k = th.getAttribute('data-key');
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = COLS.some(function (c) { return c.key === k && c.num; }) ? -1 : 1; }
    renderResults();
  });
  $('resultTable').addEventListener('change', function (e) {
    if (e.target.id !== 'selAll') return;
    Array.prototype.forEach.call($('resultTable').querySelectorAll('.pick'), function (cb) { cb.checked = e.target.checked; });
  });

  $('toCardBtn').addEventListener('click', function () {
    var picks = checkedValues('pick');
    if (!picks.length) { status('カードにする銘柄にチェックを入れてください', true); return; }
    var byCode = {};
    results.forEach(function (r) { byCode[r.code] = r; });
    picks.forEach(function (code) {
      var r = byCode[code];
      if (r && !hasCard(code)) cards.push({ code: code, shortCode: short(code), name: r.name });
    });
    renderCards();   // 表もここで描き直す(カードになった行に印が付く)
    renderPop();
    status(picks.length + '銘柄をカードにしました');
  });

  $('showBtn').addEventListener('click', showStocks);
  $('clearSelBtn').addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll(searchTab === 'sector' ? '.seccb:checked' : '.tagcb:checked'), function (c) { c.checked = false; });
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

  api('GET', '/api/purchase/meta').then(function (m) {
    $('dataMeta').textContent = '株価の最新日 ' + (m.latestDate || '—');
    renderSectors(m.sectors || []);
    renderTags(m.tags || []);
  }, function (e) {
    $('dataMeta').textContent = '接続エラー';
    flash('業種・タグを読み込めませんでした: ' + e.message);
  });

  //---------------------------------------------------------- 起動
  renderCards();
  renderGroups();
  api('GET', '/api/groups').then(function (j) {
    groups = j.groups || [];
    renderGroups();
    if (j.tableMissing) flash('銘柄グループの表がありません。ddl/40_stock_group.sql を GD_JQUANTS で流してください');
  }, function (e) { flash('グループを読み込めませんでした: ' + e.message); });
})();
