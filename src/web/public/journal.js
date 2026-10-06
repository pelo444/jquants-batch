/*
 * 売買記録(/journal)の画面。ライブラリ非依存。
 * API は src/web/journalRoutes.js、表の意味は ddl/26_trading_journal.sql、運用は docs/JOURNAL.md。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var LABELS = {
    action: { BUY: '新規買い', ADD: '買い増し', TRIM: '一部売り', SELL: '全部売り', PASS: '見送り', HOLD: '継続保有' },
    reason: {
      EARNINGS: '決算・業績', DIP: '押し目', MOMENTUM: '上昇の勢い', NEWS: 'ニュース', THEME: 'テーマ',
      VALUE: '割安', DIVIDEND: '配当・優待', RECOMMEND: '人の推奨', REBALANCE: '比率の調整',
      STOPLOSS: '損切り', TAKEPROFIT: '利益確定', OTHER: 'その他'
    },
    source: {
      OWN_SCREEN: '自分の調べ', NEWS: 'ニュース', SNS: 'SNS', DISCLOSURE: '適時開示・決算資料',
      MEDIA: '雑誌・本・番組', PERSON: '人から', APP: '証券アプリ', OTHER: 'その他'
    },
    verdict: { RIGHT: '当たっていた', PARTLY: '一部当たった', WRONG: '外れた', UNKNOWN: 'まだ分からない' },
    kind: { CASH: '現物', MLONG: '信用買', MSHORT: '信用売' },
    effect: { OPEN: '新規', CLOSE: '決済', CONVERT: '現引/現渡' }
  };
  var EMOTIONS = ['冷静', '自信', '迷い', '焦り', '取り残される不安', '恐怖', '興奮'];

  var meta = null;
  var lastPositions = null;
  var pendingImages = [];       // メモに添付する写真(縮小済み)
  var editingNoteId = null;
  var importBuffer = null;      // 取込プレビュー中のCSV

  //------------------------------------------------------------------ 共通
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function yen(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Math.round(v).toLocaleString('ja-JP');
  }
  function num(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function signed(v, d, unit) {
    if (v === null || v === undefined || isNaN(v)) return '<span class="pending">—</span>';
    var dd = d === undefined ? 1 : d;
    var s = (v > 0 ? '+' : v < 0 ? '−' : '±') +
      Math.abs(v).toLocaleString('ja-JP', { minimumFractionDigits: dd, maximumFractionDigits: dd }) + (unit || '');
    return '<span class="' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '') + '">' + s + '</span>';
  }
  function short(code) { return code && code.length === 5 && code[4] === '0' ? code.slice(0, 4) : code; }

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
  function setStatus(id, msg, isError) {
    var el = $(id);
    el.textContent = msg || '';
    el.className = 'status' + (isError ? ' error' : '');
  }
  function fillSelect(sel, values, labels, withBlank) {
    sel.innerHTML = (withBlank ? '<option value="">(選ばない)</option>' : '') +
      values.map(function (v) { return '<option value="' + v + '">' + esc(labels[v] || v) + '</option>'; }).join('');
  }
  function formData(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.type === 'file') return;
      if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; return; }
      o[el.name] = el.value;
    });
    return o;
  }

  //------------------------------------------------------------------ タブ
  var loaded = {};
  function showTab(name) {
    document.querySelectorAll('#tabs .tab').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    });
    var panes = { positions: 'panePositions', decisions: 'paneDecisions', notes: 'paneNotes', import: 'paneImport', account: 'paneAccount' };
    Object.keys(panes).forEach(function (k) { $(panes[k]).hidden = k !== name; });
    if (!loaded[name]) {
      loaded[name] = true;
      ({ positions: loadPositions, decisions: loadDecisions, notes: loadNotes, import: loadImports, account: loadSnapshots })[name]();
    }
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* noop */ }
  }

  //------------------------------------------------------------------ 銘柄コードの確認
  function attachLookup(input, out) {
    var timer = null;
    function run() {
      var v = input.value.trim();
      if (!v) { out.textContent = ''; out.className = 'lookup'; return; }
      api('GET', '/api/journal/lookup?code=' + encodeURIComponent(v)).then(function (r) {
        out.textContent = r.name + (r.delisted ? '(上場廃止)' : '') + ' ・ ' + (r.sector || '');
        out.className = 'lookup';
      }).catch(function (e) {
        out.textContent = e.message;
        out.className = 'lookup bad';
      });
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 400); });
    input.addEventListener('blur', run);
  }

  //================================================================== 保有
  async function loadPositions() {
    try {
      var r = await api('GET', '/api/journal/positions');
      lastPositions = r;
      renderPositions(r);
      $('dataMeta').textContent = '約定 ' + r.tradeCount + '件';
    } catch (e) {
      $('posSummary').textContent = '';
      $('posTable').innerHTML = '';
      flash('保有を読み込めませんでした: ' + e.message, true);
    }
    loadTrades();
  }

  function renderPositions(r) {
    var t = r.totals;
    var snap = r.snapshot;
    var html = '<span>現物の評価額 <b>' + yen(t.cashStockValue) + '</b> 円</span>' +
      '<span>取得額 <b>' + yen(t.cashStockCost) + '</b> 円</span>' +
      '<span>含み損益 ' + signed(t.cashStockValue - t.cashStockCost, 0, ' 円') + '</span>';
    if (snap && snap.cash !== null) {
      var total = (t.cashStockValue || 0) + snap.cash;
      html += '<span>投資比率 <b>' + (total > 0 ? (t.cashStockValue / total * 100).toFixed(1) : '—') + '%</b>' +
        '(現金は ' + esc(snap.snapDate) + ' の記録 ' + yen(snap.cash) + ' 円)</span>';
    } else {
      html += '<span class="pending">投資比率は「口座」タブで現金を記録すると出ます</span>';
    }
    $('posSummary').innerHTML = html;

    $('posWarnings').innerHTML = r.warnings.length
      ? '<div class="warn"><strong>確認が必要な約定 ' + r.warnings.length + '件</strong><ul>' +
        r.warnings.slice(0, 20).map(function (w) {
          return '<li>' + esc(w.tradeDate) + ' ' + esc(short(w.code)) + ': ' + esc(w.message) + '</li>';
        }).join('') + '</ul></div>'
      : '';

    if (!r.positions.length) {
      $('posTable').innerHTML = '<tbody><tr><td class="dim">保有はありません。「約定の取込」タブで楽天証券のCSVを取り込んでください。</td></tr></tbody>';
    } else {
      $('posTable').innerHTML =
        '<thead><tr><th>口座</th><th>種別</th><th>コード</th><th>銘柄</th><th class="num-col">数量</th>' +
        '<th class="num-col">平均取得単価</th><th class="num-col">終値</th><th>終値の日</th>' +
        '<th class="num-col">評価額</th><th class="num-col">含み損益</th><th class="num-col">損益率</th><th>保有開始</th><th></th></tr></thead><tbody>' +
        r.positions.map(function (p) {
          return '<tr><td>' + esc(p.account) + '</td><td class="kind">' + esc(LABELS.kind[p.kind]) + '</td>' +
            '<td class="code">' + esc(short(p.code)) + '</td><td class="name">' + esc(p.name || '') +
            (p.splitAdjusted ? '<span class="badge" title="取得後に分割があり、数量と単価を今の株数に直しています">分割調整</span>' : '') + '</td>' +
            '<td class="num-col">' + num(p.qty) + '</td><td class="num-col">' + num(p.avgCost, 1) + '</td>' +
            '<td class="num-col">' + num(p.close, 1) + '</td><td class="dim">' + esc(p.closeDate || '—') + '</td>' +
            '<td class="num-col">' + yen(p.value) + '</td><td class="num-col">' + signed(p.pnl, 0) + '</td>' +
            '<td class="num-col">' + signed(p.pnlPct, 1, '%') + '</td><td class="dim">' + esc(p.firstDate) + '</td>' +
            '<td><button class="link" data-decide="' + esc(p.code) + '" type="button">判断を記録</button></td></tr>';
        }).join('') + '</tbody>';
    }

    $('realizedTable').innerHTML = r.realizedByYear.length
      ? '<thead><tr><th>年</th><th>口座</th><th class="num-col">実現損益</th><th class="num-col">件数</th>' +
        '<th class="num-col">勝ち</th><th class="num-col">損益不明</th></tr></thead><tbody>' +
        r.realizedByYear.map(function (s) {
          return '<tr><td>' + esc(s.year) + '</td><td>' + esc(s.account) + '</td><td class="num-col">' + signed(s.pnl, 0) +
            '</td><td class="num-col">' + s.count + '</td><td class="num-col">' + s.wins + '</td><td class="num-col">' +
            (s.unknown ? '<span class="neg">' + s.unknown + '</span>' : '0') + '</td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td class="dim">まだ売りの約定がありません</td></tr></tbody>';
  }

  async function loadTrades() {
    try {
      var r = await api('GET', '/api/journal/trades');
      $('tradesNote').textContent = '新しい順。全' + r.count + '件' + (r.count > r.rows.length ? '(先頭' + r.rows.length + '件)' : '');
      $('tradesTable').innerHTML = r.rows.length
        ? '<thead><tr><th>約定日</th><th>口座</th><th>取引</th><th>売買</th><th>コード</th><th>銘柄</th>' +
          '<th class="num-col">数量</th><th class="num-col">単価</th><th class="num-col">手数料</th><th class="num-col">税</th><th class="num-col">受渡金額</th></tr></thead><tbody>' +
          r.rows.map(function (t) {
            return '<tr><td>' + esc(t.tradeDate) + '</td><td>' + esc(t.accountType || '') + '</td><td>' + esc(t.tradeType || '') +
              '</td><td>' + esc(t.sideRaw || '') + '</td><td class="code">' + esc(short(t.code)) + '</td><td class="name">' + esc(t.name || '') +
              '</td><td class="num-col">' + num(t.qty) + '</td><td class="num-col">' + num(t.price, 1) + '</td><td class="num-col">' +
              yen(t.fee) + '</td><td class="num-col">' + yen(t.tax) + '</td><td class="num-col">' + yen(t.settleAmount) + '</td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="dim">約定はまだありません</td></tr></tbody>';
    } catch (e) {
      $('tradesTable').innerHTML = '<tbody><tr><td class="dim">' + esc(e.message) + '</td></tr></tbody>';
    }
  }

  //================================================================== 判断
  function initDecisionForm() {
    var f = $('decisionForm');
    fillSelect(f.elements.action, meta.actions, LABELS.action, false);
    fillSelect(f.elements.reasonCat, meta.reasons, LABELS.reason, false);
    fillSelect(f.elements.ideaSource, meta.sources, LABELS.source, true);
    f.elements.decisionDate.value = meta.today;
    f.elements.decisionDate.max = meta.today;
    $('confRadios').innerHTML = [1, 2, 3, 4, 5].map(function (n) {
      return '<label><input type="radio" name="confidence" value="' + n + '">' + n + '</label>';
    }).join('') + '<span class="unit">(5=強い)</span>';
    $('emotionChips').innerHTML = EMOTIONS.map(function (e) {
      return '<button type="button" class="chip" aria-pressed="false" data-emotion="' + esc(e) + '">' + esc(e) + '</button>';
    }).join('');
    $('emotionChips').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-emotion]');
      if (b) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    });
    attachLookup(f.elements.code, f.querySelector('[data-lookup-for="code"]'));
    f.addEventListener('submit', submitDecision);
  }

  var supersedesId = null;
  function setSupersede(d) {
    supersedesId = d ? d.decisionId : null;
    var b = $('supersedeBanner');
    if (!d) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = '判断 #' + d.decisionId + '(' + esc(d.decisionDate) + ' ' + esc(LABELS.action[d.action]) + ' ' +
      esc(short(d.code)) + ')の<strong>訂正</strong>として記録します。元の記録は残ります。 ' +
      '<button class="link" type="button" id="cancelSupersede">やめる</button>';
    $('cancelSupersede').onclick = function () { setSupersede(null); };
  }

  async function submitDecision(ev) {
    ev.preventDefault();
    var f = ev.target;
    var d = formData(f);
    d.emotion = Array.prototype.map.call(document.querySelectorAll('#emotionChips [aria-pressed="true"]'),
      function (b) { return b.dataset.emotion; });
    d.supersedesId = supersedesId;
    setStatus('decisionStatus', '保存中…');
    try {
      var r = await api('POST', '/api/journal/decisions', d);
      setStatus('decisionStatus', '');
      flash('判断 #' + r.decisionId + ' を記録しました');
      f.reset();
      f.elements.decisionDate.value = meta.today;
      f.querySelector('[data-lookup-for="code"]').textContent = '';
      document.querySelectorAll('#emotionChips .chip').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      setSupersede(null);
      loadDecisions();
    } catch (e) {
      setStatus('decisionStatus', e.message, true);
    }
  }

  var decisionCache = [];
  async function loadDecisions() {
    var code = $('decisionFilter').value.trim();
    setStatus('decisionListStatus', '読み込み中…');
    try {
      var r = await api('GET', '/api/journal/decisions' + (code ? '?code=' + encodeURIComponent(code) : ''));
      decisionCache = r.rows;
      setStatus('decisionListStatus', r.count + '件');
      renderDecisions(r.rows);
    } catch (e) {
      setStatus('decisionListStatus', e.message, true);
    }
  }

  function evalHtml(e) {
    var pre = '<span class="grp"><span class="grp-label">判断前</span>' +
      '<span>20日 ' + signed(e.ret20Pre, 1, '%') + '</span>' +
      '<span>日次ボラ <b>' + (e.vol20 === null ? '—' : Number(e.vol20).toFixed(2) + '%') + '</b></span>' +
      '<span>高値から ' + signed(e.dd250, 1, '%') + '</span>' +
      '<span>売買代金 <b>' + (e.turnover20 === null ? '—' : Number(e.turnover20).toFixed(1) + '億/日') + '</b></span></span>';
    var post = '<span class="grp"><span class="grp-label">その後(対TOPIX)</span>' +
      '<span>20日 ' + (e.exr20 === null ? '<span class="pending">未到来</span>' : signed(e.exr20, 1, 'pt')) + '</span>' +
      '<span>60日 ' + (e.exr60 === null ? '<span class="pending">未到来</span>' : signed(e.exr60, 1, 'pt')) + '</span></span>';
    return '<div class="evals">' + pre + post + (e.baseDate ? '<span class="pending">基準 ' + esc(e.baseDate) + ' 終値 ' + num(e.baseClose, 1) + '</span>' : '') + '</div>';
  }

  function renderDecisions(rows) {
    if (!rows.length) {
      $('decisionList').innerHTML = '<p class="empty">まだ判断の記録がありません。</p>';
      return;
    }
    $('decisionList').innerHTML = rows.map(function (d) {
      var metaBits = [];
      metaBits.push('<span><span class="k">理由</span>' + esc(LABELS.reason[d.reasonCat] || d.reasonCat) + '</span>');
      if (d.ideaSource) metaBits.push('<span><span class="k">情報源</span>' + esc(LABELS.source[d.ideaSource]) + '</span>');
      if (d.confidence) metaBits.push('<span><span class="k">確信度</span>' + d.confidence + '/5</span>');
      if (d.expectRetPct !== null || d.horizonWeeks !== null) {
        metaBits.push('<span><span class="k">想定</span>' + (d.expectRetPct !== null ? d.expectRetPct + '%' : '—') +
          (d.horizonWeeks !== null ? ' / ' + d.horizonWeeks + '週' : '') + '</span>');
      }
      if (d.plannedStopPct !== null) metaBits.push('<span><span class="k">損切り</span>' + d.plannedStopPct + '%下</span>');
      if (d.emotion) metaBits.push('<span><span class="k">状態</span>' + esc(d.emotion) + '</span>');
      if (d.sizeNote) metaBits.push('<span><span class="k">サイズ</span>' + esc(d.sizeNote) + '</span>');
      return '<div class="dcard' + (d.superseded ? ' superseded' : '') + '" data-id="' + d.decisionId + '">' +
        '<div class="dhead"><span class="id">#' + d.decisionId + '</span><span>' + esc(d.decisionDate) + '</span>' +
        '<span class="act ' + d.action + '">' + esc(LABELS.action[d.action]) + '</span>' +
        '<span class="code">' + esc(short(d.code)) + '</span><span class="nm">' + esc(d.name || '') + '</span>' +
        (d.supersedesId ? '<span class="flag">#' + d.supersedesId + ' の訂正</span>' : '') +
        (d.superseded ? '<span class="flag">訂正済み</span>' : '') +
        (d.lateEntry ? '<span class="flag late" title="判断した日より2日以上あとに書いた記録">後から記録</span>' : '') +
        '</div>' +
        '<div class="dbody">' + esc(d.reasonText) + '</div>' +
        (d.invalidation ? '<div class="dmeta"><span><span class="k">間違いと認める条件</span>' + esc(d.invalidation) + '</span></div>' : '') +
        '<div class="dmeta">' + metaBits.join('') + '</div>' +
        evalHtml(d.eval) +
        (d.reviews.length ? '<div class="reviews">' + d.reviews.map(function (v) {
          return '<div class="review"><span class="verdict">' + esc(v.reviewDate) + ' ' + esc(LABELS.verdict[v.reasonVerdict]) + '</span>' +
            esc(v.outcomeNote || '') + (v.lesson ? '<br><span class="pending">教訓: </span>' + esc(v.lesson) : '') + '</div>';
        }).join('') + '</div>' : '') +
        '<div class="dactions"><button class="link" type="button" data-review="' + d.decisionId + '">振り返りを書く</button>' +
        '<button class="link" type="button" data-supersede="' + d.decisionId + '">訂正する</button></div>' +
        '<div class="review-slot"></div></div>';
    }).join('');
  }

  function openReviewForm(card, id) {
    var slot = card.querySelector('.review-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = '<form class="review-form card"><div class="grid">' +
      '<label class="field-label">振り返りの日<input type="date" name="reviewDate" value="' + meta.today + '" max="' + meta.today + '"></label>' +
      '<label class="field-label">理由は当たっていたか(値動きの結果とは分けて)<select name="reasonVerdict">' +
      meta.verdicts.map(function (v) { return '<option value="' + v + '">' + esc(LABELS.verdict[v]) + '</option>'; }).join('') +
      '</select></label></div>' +
      '<label class="field-label">結果<textarea name="outcomeNote" rows="2"></textarea></label>' +
      '<label class="field-label">教訓<textarea name="lesson" rows="2"></textarea></label>' +
      '<div class="submit-row"><button class="btn primary" type="submit">振り返りを記録</button><span class="status"></span></div></form>';
    var form = slot.querySelector('form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var st = form.querySelector('.status');
      st.textContent = '保存中…';
      try {
        await api('POST', '/api/journal/decisions/' + id + '/reviews', formData(form));
        flash('振り返りを記録しました');
        loadDecisions();
      } catch (e) {
        st.textContent = e.message;
        st.className = 'status error';
      }
    });
  }

  function startSupersede(id) {
    var d = decisionCache.filter(function (x) { return x.decisionId === id; })[0];
    if (!d) return;
    var f = $('decisionForm');
    f.elements.decisionDate.value = d.decisionDate;
    f.elements.code.value = short(d.code);
    f.elements.action.value = d.action;
    f.elements.reasonCat.value = d.reasonCat;
    f.elements.ideaSource.value = d.ideaSource || '';
    f.elements.reasonText.value = d.reasonText;
    f.elements.invalidation.value = d.invalidation || '';
    f.elements.expectRetPct.value = d.expectRetPct === null ? '' : d.expectRetPct;
    f.elements.horizonWeeks.value = d.horizonWeeks === null ? '' : d.horizonWeeks;
    f.elements.plannedStopPct.value = d.plannedStopPct === null ? '' : d.plannedStopPct;
    f.elements.sizeNote.value = d.sizeNote || '';
    Array.prototype.forEach.call(f.querySelectorAll('input[name="confidence"]'), function (r) {
      r.checked = Number(r.value) === d.confidence;
    });
    var em = (d.emotion || '').split(',');
    document.querySelectorAll('#emotionChips .chip').forEach(function (b) {
      b.setAttribute('aria-pressed', em.indexOf(b.dataset.emotion) >= 0 ? 'true' : 'false');
    });
    setSupersede(d);
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  //================================================================== メモ
  function initNoteForm() {
    var f = $('noteForm');
    fillSelect(f.elements.ideaSource, meta.sources, LABELS.source, true);
    f.elements.noteDate.value = meta.today;
    f.elements.noteDate.max = meta.today;
    $('workDir').textContent = meta.workDir;
    $('noteImages').addEventListener('change', onPickImages);
    f.addEventListener('submit', submitNote);
    $('noteCancel').addEventListener('click', resetNoteForm);
  }

  function resetNoteForm() {
    var f = $('noteForm');
    f.reset();
    f.elements.noteDate.value = meta.today;
    pendingImages = [];
    renderThumbs();
    editingNoteId = null;
    $('noteEditBanner').hidden = true;
    $('noteCancel').hidden = true;
    $('noteSubmit').textContent = 'メモを保存';
  }

  /** 写真を長辺1600pxのJPEGに縮める。canvas で描き直すので EXIF(位置情報など)は残らない */
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600;
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        var s = Math.min(1, max / Math.max(w, h));
        var cw = Math.round(w * s);
        var ch = Math.round(h * s);
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        resolve({
          fileName: file.name.replace(/\.(heic|heif|png|jpe?g)$/i, '') + '.jpg',
          dataBase64: b64, width: cw, height: ch, preview: dataUrl,
          bytes: Math.floor(b64.length * 3 / 4)
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(file.name + ' を読めませんでした' +
          (/hei[cf]$/i.test(file.name) ? '(HEIC は Safari なら読めます。または写真を JPEG で共有してください)' : '')));
      };
      img.src = url;
    });
  }

  async function onPickImages(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    setStatus('noteStatus', files.length ? '写真を縮小中…' : '');
    for (var i = 0; i < files.length; i++) {
      try {
        pendingImages.push(await resizeImage(files[i]));
      } catch (e) {
        flash(e.message, true);
      }
    }
    ev.target.value = '';
    setStatus('noteStatus', '');
    renderThumbs();
  }

  function renderThumbs() {
    $('noteThumbs').innerHTML = pendingImages.map(function (p, i) {
      return '<div class="thumb"><img src="' + p.preview + '" alt=""><button class="btn" type="button" data-unpick="' + i +
        '" title="外す">×</button><span class="sz">' + p.width + '×' + p.height + ' ・ ' + Math.round(p.bytes / 1024) + 'KB</span></div>';
    }).join('');
  }

  async function submitNote(ev) {
    ev.preventDefault();
    var f = ev.target;
    var d = formData(f);
    d.images = pendingImages.map(function (p) {
      return { fileName: p.fileName, dataBase64: p.dataBase64, width: p.width, height: p.height };
    });
    setStatus('noteStatus', '保存中…');
    try {
      if (editingNoteId) {
        await api('PUT', '/api/journal/notes/' + editingNoteId, d);
        flash('メモ #' + editingNoteId + ' を更新しました');
      } else {
        var r = await api('POST', '/api/journal/notes', d);
        flash('メモ #' + r.noteId + ' を保存しました');
      }
      setStatus('noteStatus', '');
      resetNoteForm();
      loadNotes();
    } catch (e) {
      setStatus('noteStatus', e.message, true);
    }
  }

  var noteCache = [];
  async function loadNotes() {
    var q = $('noteQ').value.trim();
    var code = $('noteCode').value.trim();
    var qs = [];
    if (q) qs.push('q=' + encodeURIComponent(q));
    if (code) qs.push('code=' + encodeURIComponent(code));
    setStatus('noteListStatus', '読み込み中…');
    try {
      var r = await api('GET', '/api/journal/notes' + (qs.length ? '?' + qs.join('&') : ''));
      noteCache = r.rows;
      setStatus('noteListStatus', r.count + '件');
      renderNotes(r.rows);
    } catch (e) {
      setStatus('noteListStatus', e.message, true);
    }
  }

  function renderNotes(rows) {
    if (!rows.length) {
      $('noteList').innerHTML = '<p class="empty">メモはまだありません。</p>';
      return;
    }
    $('noteList').innerHTML = rows.map(function (n) {
      return '<div class="ncard" data-note="' + n.noteId + '"><div class="nhead"><span class="date">' + esc(n.noteDate) + '</span>' +
        '<span class="id">#' + n.noteId + '</span>' +
        (n.codes.length ? '<span>' + n.codes.map(function (c) { return esc(short(c)); }).join(', ') + '</span>' : '') +
        (n.ideaSource ? '<span>' + esc(LABELS.source[n.ideaSource]) + '</span>' : '') +
        '<span class="spacer"></span><button class="link" type="button" data-edit-note="' + n.noteId + '">編集</button>' +
        '<button class="link" type="button" data-del-note="' + n.noteId + '">削除</button></div>' +
        (n.body ? '<div class="nbody">' + esc(n.body) + '</div>' : '') +
        (n.images.length ? '<div class="nimgs">' + n.images.map(function (im) {
          return '<div class="nimg"><a href="/api/journal/images/' + im.imageId + '" target="_blank" rel="noopener">' +
            '<img loading="lazy" src="/api/journal/images/' + im.imageId + '" alt="写真 #' + im.imageId + '"></a>' +
            '<textarea rows="3" data-trans="' + im.imageId + '" placeholder="文字起こし(未)">' + esc(im.transcription || '') + '</textarea>' +
            '<div class="row"><button class="link" type="button" data-save-trans="' + im.imageId + '">文字起こしを保存</button>' +
            '<button class="link" type="button" data-del-img="' + im.imageId + '">写真を削除</button>' +
            '<span>#' + im.imageId + (im.transcribedAt ? '' : ' ・ 未') + '</span></div></div>';
        }).join('') + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function startEditNote(id) {
    var n = noteCache.filter(function (x) { return x.noteId === id; })[0];
    if (!n) return;
    var f = $('noteForm');
    f.elements.noteDate.value = n.noteDate;
    f.elements.codes.value = n.codes.map(short).join(', ');
    f.elements.ideaSource.value = n.ideaSource || '';
    f.elements.body.value = n.body;
    pendingImages = [];
    renderThumbs();
    editingNoteId = id;
    var b = $('noteEditBanner');
    b.hidden = false;
    b.textContent = 'メモ #' + id + ' を編集中。写真を選ぶと追加されます(既存の写真は下の一覧で削除できます)。';
    $('noteCancel').hidden = false;
    $('noteSubmit').textContent = 'メモを更新';
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  //================================================================== 取込
  function initImport() {
    $('csvFile').addEventListener('change', async function (ev) {
      var file = ev.target.files[0];
      if (!file) return;
      var buf = await file.arrayBuffer();
      importBuffer = { name: file.name, b64: arrayToB64(buf) };
      runImport(false);
    });
  }

  function arrayToB64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  async function runImport(commit) {
    if (!importBuffer) return;
    setStatus('importStatus', commit ? '取込中…' : 'プレビューを作成中…');
    try {
      var r = await api('POST', '/api/journal/import', { fileName: importBuffer.name, dataBase64: importBuffer.b64, commit: commit });
      setStatus('importStatus', '');
      if (commit) {
        flash(r.inserted + '件を取り込みました(重複 ' + r.duplicate + '件は飛ばしました)');
        importBuffer = null;
        $('csvFile').value = '';
        $('importPreview').innerHTML = '';
        loadImports();
        loaded.positions = false;
        return;
      }
      renderImportPreview(r);
    } catch (e) {
      setStatus('importStatus', e.message, true);
      $('importPreview').innerHTML = '';
    }
  }

  function renderImportPreview(r) {
    var canCommit = r.inserted > 0 && r.errors.length === 0;
    var html = '<div class="counts"><span>文字コード <b>' + esc(r.encoding) + '</b></span>' +
      '<span>約定 <b>' + r.total + '</b> 件</span><span>新規 <b>' + r.inserted + '</b> 件</span>' +
      '<span>取込済み(重複) <b>' + r.duplicate + '</b> 件</span>' +
      '<span>解釈できない行 <b class="' + (r.errors.length ? 'neg' : '') + '">' + r.errors.length + '</b> 件</span></div>';
    if (r.unknownHeaders.length) {
      html += '<p class="unit">使っていない列(元の行はそのまま保存します): ' + r.unknownHeaders.map(esc).join('、') + '</p>';
    }
    if (r.errors.length) {
      html += '<div class="warn"><strong>解釈できない行があるため取り込めません</strong><ul>' +
        r.errors.slice(0, 30).map(function (e) { return '<li>' + e.line + '行目: ' + esc(e.message) + '</li>'; }).join('') + '</ul></div>';
    }
    html += '<div class="submit-row"><button class="btn primary" id="commitImportBtn" type="button"' + (canCommit ? '' : ' disabled') + '>' +
      r.inserted + '件を取り込む</button>' + (r.inserted === 0 && !r.errors.length ? '<span class="unit">新しい約定はありません</span>' : '') + '</div>';
    html += '<div class="table-wrap"><table><thead><tr><th></th><th>行</th><th>約定日</th><th>口座</th><th>取引</th><th>売買</th><th>解釈</th>' +
      '<th>コード</th><th>銘柄</th><th class="num-col">数量</th><th class="num-col">単価</th><th class="num-col">手数料</th>' +
      '<th class="num-col">税</th><th class="num-col">受渡金額</th></tr></thead><tbody>' +
      r.rows.map(function (t) {
        return '<tr class="' + (t.duplicate ? 'dup' : '') + '"><td>' + (t.duplicate ? '<span class="dup-badge">取込済み</span>' : '<span class="new-badge">新規</span>') +
          '</td><td class="dim">' + t.line + '</td><td>' + esc(t.tradeDate) + '</td><td>' + esc(t.accountType || '') + '</td><td>' +
          esc(t.tradeType || '') + '</td><td>' + esc(t.sideRaw || '') + '</td><td class="kind">' + esc(LABELS.kind[t.positionKind]) + '・' +
          esc(LABELS.effect[t.positionEffect]) + '</td><td class="code">' + esc(short(t.code)) + '</td><td class="name">' + esc(t.name || '') +
          '</td><td class="num-col">' + num(t.qty) + '</td><td class="num-col">' + num(t.price, 1) + '</td><td class="num-col">' + yen(t.fee) +
          '</td><td class="num-col">' + yen(t.tax) + '</td><td class="num-col">' + yen(t.settleAmount) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    $('importPreview').innerHTML = html;
    var btn = $('commitImportBtn');
    if (btn) btn.onclick = function () { btn.disabled = true; runImport(true); };
  }

  async function loadImports() {
    try {
      var r = await api('GET', '/api/journal/imports');
      $('importHistory').innerHTML = r.rows.length
        ? '<thead><tr><th>#</th><th>取込日時</th><th>ファイル</th><th>文字コード</th><th class="num-col">行</th>' +
          '<th class="num-col">新規</th><th class="num-col">重複</th></tr></thead><tbody>' +
          r.rows.map(function (b) {
            return '<tr><td class="dim">' + b.batchId + '</td><td>' + esc(new Date(b.importedAt).toLocaleString('ja-JP')) + '</td><td>' +
              esc(b.fileName || '') + '</td><td>' + esc(b.encoding || '') + '</td><td class="num-col">' + b.total + '</td><td class="num-col">' +
              b.inserted + '</td><td class="num-col">' + b.duplicate + '</td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="dim">まだ取り込んでいません</td></tr></tbody>';
    } catch (e) {
      $('importHistory').innerHTML = '<tbody><tr><td class="dim">' + esc(e.message) + '</td></tr></tbody>';
    }
  }

  //================================================================== 口座
  function initSnapForm() {
    var f = $('snapForm');
    f.elements.snapDate.value = meta.today;
    f.elements.snapDate.max = meta.today;
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      setStatus('snapStatus', '保存中…');
      try {
        await api('POST', '/api/journal/snapshots', formData(f));
        setStatus('snapStatus', '');
        flash('記録しました');
        loadSnapshots();
        loaded.positions = false;
      } catch (e) {
        setStatus('snapStatus', e.message, true);
      }
    });
    $('fillStockBtn').addEventListener('click', async function () {
      try {
        var r = lastPositions || await api('GET', '/api/journal/positions');
        lastPositions = r;
        f.elements.stock.value = Math.round(r.totals.cashStockValue);
      } catch (e) {
        flash(e.message, true);
      }
    });
  }

  async function loadSnapshots() {
    try {
      var r = await api('GET', '/api/journal/snapshots');
      $('snapTable').innerHTML = r.rows.length
        ? '<thead><tr><th>日付</th><th class="num-col">現金</th><th class="num-col">株式評価額</th><th class="num-col">合計</th>' +
          '<th class="num-col">投資比率</th><th class="num-col">入金</th><th class="num-col">出金</th><th>メモ</th><th></th></tr></thead><tbody>' +
          r.rows.map(function (s) {
            var tot = (s.cash || 0) + (s.stock || 0);
            var ratio = s.cash !== null && s.stock !== null && tot > 0 ? (s.stock / tot * 100).toFixed(1) + '%' : '—';
            return '<tr><td>' + esc(s.snapDate) + '</td><td class="num-col">' + yen(s.cash) + '</td><td class="num-col">' + yen(s.stock) +
              '</td><td class="num-col">' + yen(tot) + '</td><td class="num-col">' + ratio + '</td><td class="num-col">' + yen(s.deposit) +
              '</td><td class="num-col">' + yen(s.withdrawal) + '</td><td class="wrap">' + esc(s.note || '') +
              '</td><td><button class="link" type="button" data-del-snap="' + esc(s.snapDate) + '">削除</button></td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="dim">まだ記録がありません</td></tr></tbody>';
    } catch (e) {
      $('snapTable').innerHTML = '<tbody><tr><td class="dim">' + esc(e.message) + '</td></tr></tbody>';
    }
  }

  //================================================================== イベントの委譲
  document.addEventListener('click', async function (ev) {
    var t = ev.target;
    var el;
    if ((el = t.closest('#tabs .tab'))) { showTab(el.dataset.tab); return; }
    if ((el = t.closest('[data-decide]'))) {
      showTab('decisions');
      var f = $('decisionForm');
      f.elements.code.value = short(el.dataset.decide);
      f.elements.code.dispatchEvent(new Event('blur'));
      f.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if ((el = t.closest('[data-review]'))) { openReviewForm(el.closest('.dcard'), Number(el.dataset.review)); return; }
    if ((el = t.closest('[data-supersede]'))) { startSupersede(Number(el.dataset.supersede)); return; }
    if ((el = t.closest('[data-unpick]'))) { pendingImages.splice(Number(el.dataset.unpick), 1); renderThumbs(); return; }
    if ((el = t.closest('[data-edit-note]'))) { startEditNote(Number(el.dataset.editNote)); return; }
    if ((el = t.closest('[data-del-note]'))) {
      if (!window.confirm('メモ #' + el.dataset.delNote + ' を写真ごと削除します。よろしいですか?')) return;
      try { await api('DELETE', '/api/journal/notes/' + el.dataset.delNote); flash('削除しました'); loadNotes(); } catch (e) { flash(e.message, true); }
      return;
    }
    if ((el = t.closest('[data-del-img]'))) {
      if (!window.confirm('写真 #' + el.dataset.delImg + ' を削除します。よろしいですか?')) return;
      try { await api('DELETE', '/api/journal/images/' + el.dataset.delImg); flash('削除しました'); loadNotes(); } catch (e) { flash(e.message, true); }
      return;
    }
    if ((el = t.closest('[data-save-trans]'))) {
      var id = el.dataset.saveTrans;
      var ta = document.querySelector('[data-trans="' + id + '"]');
      try { await api('PUT', '/api/journal/images/' + id + '/transcription', { text: ta.value }); flash('文字起こしを保存しました'); } catch (e) { flash(e.message, true); }
      return;
    }
    if ((el = t.closest('[data-del-snap]'))) {
      if (!window.confirm(el.dataset.delSnap + ' の記録を削除します。よろしいですか?')) return;
      try { await api('DELETE', '/api/journal/snapshots/' + el.dataset.delSnap); loadSnapshots(); } catch (e) { flash(e.message, true); }
      return;
    }
  });

  //================================================================== 起動
  function initTheme() {
    var btn = $('themeBtn');
    var saved = null;
    try { saved = localStorage.getItem('jqb-theme'); } catch (e) { /* noop */ }
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    function label() {
      var cur = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      btn.textContent = cur === 'dark' ? 'ライト' : 'ダーク';
      return cur;
    }
    label();
    btn.addEventListener('click', function () {
      var next = label() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('jqb-theme', next); } catch (e) { /* noop */ }
      label();
    });
  }

  async function init() {
    initTheme();
    try {
      meta = await api('GET', '/api/journal/meta');
    } catch (e) {
      flash('初期化に失敗しました: ' + e.message, true);
      return;
    }
    initDecisionForm();
    initNoteForm();
    initImport();
    initSnapForm();
    $('decisionFilterBtn').onclick = loadDecisions;
    $('decisionFilterClear').onclick = function () { $('decisionFilter').value = ''; loadDecisions(); };
    $('noteSearchBtn').onclick = loadNotes;
    $('noteSearchClear').onclick = function () { $('noteQ').value = ''; $('noteCode').value = ''; loadNotes(); };
    $('exportImagesBtn').onclick = async function () {
      setStatus('transStatus', '書き出し中…');
      try {
        var r = await api('POST', '/api/journal/transcriptions/export');
        setStatus('transStatus', r.count + '枚を書き出しました');
      } catch (e) { setStatus('transStatus', e.message, true); }
    };
    $('importTransBtn').onclick = async function () {
      setStatus('transStatus', '取込中…');
      try {
        var r = await api('POST', '/api/journal/transcriptions/import');
        setStatus('transStatus', r.updated + '枚に反映しました' + (r.skipped.length ? '(飛ばした写真: ' + r.skipped.join(', ') + ')' : ''));
        loadNotes();
      } catch (e) { setStatus('transStatus', e.message, true); }
    };
    var tab = (location.hash || '').replace('#', '');
    showTab(['positions', 'decisions', 'notes', 'import', 'account'].indexOf(tab) >= 0 ? tab : 'positions');
  }

  init();
})();
