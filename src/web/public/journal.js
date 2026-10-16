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
    effect: { OPEN: '新規', CLOSE: '決済', CONVERT: '現引/現渡', DEPOSIT: '入庫', WITHDRAW: '出庫' },
    assignee: { SELF: '自分', CLAUDE: 'Claude' },
    qstatus: { OPEN: '未着手', DOING: '調査中', DONE: '答えあり', DROPPED: '見送り' },
    priority: { 1: '高', 2: '中', 3: '低' }
  };
  var EMOTIONS = ['冷静', '自信', '迷い', '焦り', '取り残される不安', '恐怖', '興奮'];

  var meta = null;
  var lastPositions = null;
  var pendingImages = [];       // メモに添付する写真(縮小済み)
  var editingNoteId = null;
  var importBuffer = null;      // 取込プレビュー中のCSV
  var pendingQ = { decision: [], note: [] };   // 判断・メモと一緒に保存する「調べたいこと」
  var qLinks = [];              // 判断・メモに付いた問い(カードの件数表示用)
  var qLinkCtx = null;          // 調べたいことフォームの紐付け先 {decisionId|noteId, codes, label}
  var qFilterCtx = null;        // 一覧の絞り込み {decisionId|noteId, label}

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
    var panes = { positions: 'panePositions', decisions: 'paneDecisions', notes: 'paneNotes', questions: 'paneQuestions', import: 'paneImport', account: 'paneAccount' };
    Object.keys(panes).forEach(function (k) { $(panes[k]).hidden = k !== name; });
    if (!loaded[name]) {
      loaded[name] = true;
      ({ positions: loadPositions, decisions: loadDecisions, notes: loadNotes, questions: loadQuestions, import: loadImports, account: loadAccount })[name]();
    }
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* noop */ }
  }

  //------------------------------------------------------------------ 銘柄コードの確認
  function attachLookup(input, out, onResult) {
    var timer = null;
    function run() {
      var v = input.value.trim();
      if (!v) { out.textContent = ''; out.className = 'lookup'; if (onResult) onResult(null); return; }
      api('GET', '/api/journal/lookup?code=' + encodeURIComponent(v)).then(function (r) {
        if (input.value.trim() !== v) return;   // 打ち直されていたら古い結果は捨てる
        out.textContent = r.name + (r.delisted ? '(上場廃止)' : '') + ' ・ ' + (r.sector || '');
        out.className = 'lookup';
        if (onResult) onResult(r.code);
      }).catch(function (e) {
        if (input.value.trim() !== v) return;
        out.textContent = e.message;
        out.className = 'lookup bad';
        if (onResult) onResult(null);
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
    var cap = r.capital;
    var html = '<span>現物の評価額 <b>' + yen(t.cashStockValue) + '</b> 円</span>' +
      '<span>取得額 <b>' + yen(t.cashStockCost) + '</b> 円</span>' +
      '<span>含み損益 ' + signed(t.cashStockValue - t.cashStockCost, 0, ' 円') + '</span>';
    if (cap && cap.current) {
      html += '<span>まだ使っていない元手 <b>' + yen(cap.unused) + '</b> 円(元手 ' + yen(cap.current.amount) + ' 円 − 株に入れた正味の額 ' +
        yen(cap.netInvested) + ' 円)</span>';
    } else {
      html += '<span class="pending">「口座」タブで元手を記録すると、まだ使っていない元手が出ます</span>';
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
        '<th class="num-col">評価額</th><th class="num-col">含み損益</th><th class="num-col">損益率</th><th>保有開始</th><th>判断・メモ</th></tr></thead><tbody>' +
        r.positions.map(function (p) {
          return '<tr><td>' + esc(p.account) + '</td><td class="kind">' + esc(LABELS.kind[p.kind]) + '</td>' +
            '<td class="code">' + esc(short(p.code)) + '</td><td class="name">' + esc(p.name || '') +
            (p.splitAdjusted ? '<span class="badge" title="取得後に分割があり、数量と単価を今の株数に直しています">分割調整</span>' : '') + '</td>' +
            '<td class="num-col">' + num(p.qty) + '</td><td class="num-col">' + num(p.avgCost, 1) + '</td>' +
            '<td class="num-col">' + num(p.close, 1) + '</td><td class="dim">' + esc(p.closeDate || '—') + '</td>' +
            '<td class="num-col">' + yen(p.value) + '</td><td class="num-col">' + signed(p.pnl, 0) + '</td>' +
            '<td class="num-col">' + signed(p.pnlPct, 1, '%') + '</td><td class="dim">' + esc(p.firstDate) + '</td>' +
            '<td class="rec-cell"><button class="link" data-decide="' + esc(p.code) + '" type="button" title="この銘柄の判断を記録する">記録</button>' +
            recCount('decisions', p.code, p.records.decisions, '判断') + recCount('notes', p.code, p.records.notes, 'メモ') + '</td></tr>';
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

  /** 保有の行の「判断 n」「メモ n」。0件は薄く出すだけ(押せない) */
  function recCount(kind, code, n, label) {
    if (!n) return '<span class="rec-count zero">' + label + ' 0</span>';
    return '<button class="link rec-count" type="button" data-goto-' + kind + '="' + esc(code) + '" title="この銘柄の' +
      label + 'を一覧で見る">' + label + ' ' + n + '</button>';
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

  //------------------------------------------------------------------ 騰落率一覧用のタグ
  var TAG_LABELS = { jnl_held: '保有中', jnl_held_past: '過去に保有', jnl_passed: '見送った銘柄' };

  /** タグの付け直しの結果を1行にする。エラーや未登録があれば isError */
  function tagSyncText(r) {
    if (!r) return { text: '', isError: false };
    if (r.error) return { text: 'タグの更新に失敗しました: ' + r.error, isError: true };
    var parts = r.tags.map(function (t) {
      var diff = [];
      if (t.added) diff.push('+' + t.added);
      if (t.removed) diff.push('−' + t.removed);
      return (TAG_LABELS[t.tag] || t.tag) + ' ' + t.count + '銘柄' + (diff.length ? '(' + diff.join(' ') + ')' : '') +
        (t.missing.length ? '・マスタに無い ' + t.missing.join(',') : '');
    });
    if (r.skipped.length) parts.push('未登録のタグ: ' + r.skipped.join(', ') + '(ddl/28 を流してください)');
    return { text: 'タグ: ' + parts.join(' / '), isError: r.skipped.length > 0 };
  }

  async function syncTags() {
    setStatus('syncTagsStatus', '更新中…');
    try {
      var r = await api('POST', '/api/journal/tags/sync');
      var t = tagSyncText(r);
      setStatus('syncTagsStatus', t.text, t.isError);
    } catch (e) {
      setStatus('syncTagsStatus', e.message, true);
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
    attachLookup(f.elements.code, f.querySelector('[data-lookup-for="code"]'), showCodeHistory);
    f.addEventListener('submit', submitDecision);
  }

  /**
   * 判断を書くときに、その銘柄の過去の売買と今の保有を、銘柄コードと行動の間に出す。
   * 約定が無ければ「売買はまだありません」と出す(見送り・新規の判断でも、無いことが分かるように)。
   */
  var historySeq = 0;
  async function showCodeHistory(code) {
    var box = $('codeHistory');
    var seq = ++historySeq;
    if (!code) { box.hidden = true; box.innerHTML = ''; return; }
    try {
      var r = await api('GET', '/api/journal/code-history?code=' + encodeURIComponent(code));
      if (seq !== historySeq) return;
      box.hidden = false;
      if (!r.total) {
        box.innerHTML = '<div class="ch-head">売買記録</div><div class="ch-none">この銘柄の売買はまだありません</div>';
        return;
      }
      var held = r.positions.length
        ? r.positions.map(function (p) {
          return esc(p.account) + (p.kind !== 'CASH' ? '・' + esc(LABELS.kind[p.kind]) : '') + ' ' + num(p.qty) + '株' +
            '(平均 ' + num(p.avgCost, 1) + ')';
        }).join('、')
        : 'いまは保有なし';
      var shown = r.trades.slice(0, 8);
      box.innerHTML = '<div class="ch-head">売買記録 ' + r.total + '件 ・ <span class="ch-held">' + held + '</span></div>' +
        '<ul class="ch-list">' + shown.map(function (t) {
          var dir = t.side === 'B' ? 'buy' : 'sell';
          var noPrice = t.positionEffect === 'DEPOSIT' || t.positionEffect === 'WITHDRAW';
          return '<li><span class="ch-date">' + esc(t.tradeDate) + '</span>' +
            '<span class="ch-side ' + dir + '">' + esc(t.sideRaw || (t.side === 'B' ? '買' : '売')) + '</span>' +
            '<span class="ch-qty">' + num(t.qty) + '株' + (noPrice ? '' : ' @' + num(t.price, t.price % 1 ? 1 : 0)) + '</span>' +
            '<span class="ch-acc">' + esc(t.accountType || '') + '</span></li>';
        }).join('') + '</ul>' +
        (r.total > shown.length ? '<div class="ch-more">ほか ' + (r.total - shown.length) + '件(最初の売買 ' + esc(r.firstDate) + ')</div>' : '');
    } catch (e) {
      if (seq !== historySeq) return;
      box.hidden = false;
      box.innerHTML = '<div class="ch-none">売買記録を読めませんでした: ' + esc(e.message) + '</div>';
    }
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

  /**
   * 損失回避チェック(/purchase/check)の「判断メモへ」「見送りとして記録」から開いたとき。
   * URL の値をフォームに入れ、記録した直後に、その時点の値(F・T・チェック)を /api/purchase/snapshot で残す。
   */
  var fromCheck = null;
  function applyFromCheck() {
    var q = new URLSearchParams(location.search);
    if (q.get('from') !== 'check' || !Number(q.get('list'))) return;
    fromCheck = { listId: Number(q.get('list')), runId: Number(q.get('run')) || null, listName: q.get('listName') || '' };
    showTab('decisions');
    var f = $('decisionForm');
    var set = function (name, v) { if (v !== null && v !== undefined && v !== '') f.elements[name].value = v; };
    set('code', q.get('code'));
    set('action', q.get('action'));
    set('ideaSource', 'OWN_SCREEN');
    set('reasonText', q.get('reason'));
    set('invalidation', q.get('inv'));
    set('plannedStopPct', q.get('stop'));
    set('sizeNote', q.get('size'));
    f.elements.code.dispatchEvent(new Event('blur'));   // 銘柄名と売買記録を出す
    var b = $('fromCheckBanner');
    b.hidden = false;
    b.innerHTML = '損失回避チェック(リスト「' + esc(fromCheck.listName) + '」' + (fromCheck.runId ? '、記録 #' + fromCheck.runId : '') +
      ')から開きました。記録すると、その時点のファンダメンタル・テクニカル・チェックの値も残します。 ' +
      '<button class="link" type="button" id="cancelFromCheck">値を残さない</button>';
    $('cancelFromCheck').onclick = clearFromCheck;
    f.scrollIntoView({ block: 'start' });
  }
  function clearFromCheck() {
    fromCheck = null;
    $('fromCheckBanner').hidden = true;
    history.replaceState(null, '', '/journal#decisions');
  }

  async function submitDecision(ev) {
    ev.preventDefault();
    var f = ev.target;
    var d = formData(f);
    d.emotion = Array.prototype.map.call(document.querySelectorAll('#emotionChips [aria-pressed="true"]'),
      function (b) { return b.dataset.emotion; });
    d.supersedesId = supersedesId;
    d.questions = pendingQ.decision.slice();
    setStatus('decisionStatus', '保存中…');
    try {
      var r = await api('POST', '/api/journal/decisions', d);
      setStatus('decisionStatus', '');
      var dts = tagSyncText(r.tagSync);
      var snapText = '';
      var snapErr = false;
      if (fromCheck) {
        setStatus('decisionStatus', '判断時の値を残しています…');
        try {
          var sr = await api('POST', '/api/purchase/snapshot', { decisionId: r.decisionId, listId: fromCheck.listId, runId: fromCheck.runId });
          snapText = '。判断時の値を残しました(株価 ' + (sr.asOf || '—') + ' 時点)';
        } catch (e2) {
          snapText = '。判断時の値は残せませんでした: ' + e2.message;
          snapErr = true;
        }
        setStatus('decisionStatus', '');
        clearFromCheck();
      }
      flash('判断 #' + r.decisionId + ' を記録しました' + (r.questionIds.length ? '(調べたいこと ' + r.questionIds.length + '件)' : '') +
        (dts.text ? '。' + dts.text : '') + snapText, dts.isError || snapErr);
      pendingQ.decision = [];
      renderPendingQ('decision');
      loaded.positions = false;   // 保有タブの判断・メモの件数を、次に開いたときに取り直す
      if (r.questionIds.length) refreshQuestionMeta();
      f.reset();
      f.elements.decisionDate.value = meta.today;
      f.querySelector('[data-lookup-for="code"]').textContent = '';
      showCodeHistory(null);
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

  // 右の列: 「項目名 値」を縦に並べる(dt/dd)。判断前・その後は小見出しで区切る
  function kv(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

  function evalHtml(e) {
    return '<dt class="dside-h first">判断したとき</dt>' +
      kv('20日', signed(e.ret20Pre, 1, '%')) +
      kv('日次ボラ', e.vol20 === null ? '—' : Number(e.vol20).toFixed(2) + '%') +
      kv('高値から', signed(e.dd250, 1, '%')) +
      kv('売買代金', e.turnover20 === null ? '—' : Number(e.turnover20).toFixed(1) + '億/日') +
      '<dt class="dside-h">その後(株価増減率 − TOPIX増減率)</dt>' +
      kv('20日後', e.exr20 === null ? '<span class="pending">未到来</span>' : signed(e.exr20, 1, 'pt')) +
      kv('60日後', e.exr60 === null ? '<span class="pending">未到来</span>' : signed(e.exr60, 1, 'pt')) +
      (e.baseDate ? kv('基準', esc(e.baseDate) + ' 終値 ' + num(e.baseClose, 1)) : '');
  }

  function renderDecisions(rows) {
    if (!rows.length) {
      $('decisionList').innerHTML = '<p class="empty">まだ判断の記録がありません。</p>';
      return;
    }
    $('decisionList').innerHTML = rows.map(function (d) {
      // 判断のときの項目(枠の下部に、1項目ずつ角丸の背景で並べる)
      function chip(k, v) { return '<span class="dchip">' + k + '：' + v + '</span>'; }
      var chips = chip('理由の分類', esc(LABELS.reason[d.reasonCat] || d.reasonCat));
      if (d.ideaSource) chips += chip('情報源', esc(LABELS.source[d.ideaSource]));
      if (d.confidence) chips += chip('確信度', d.confidence + '/5');
      if (d.emotion) chips += chip('状態', esc(d.emotion));
      if (d.expectRetPct !== null || d.horizonWeeks !== null) {
        chips += chip('想定', (d.expectRetPct !== null ? d.expectRetPct + '%' : '—') +
          (d.horizonWeeks !== null ? ' / ' + d.horizonWeeks + '週' : ''));
      }
      if (d.plannedStopPct !== null) chips += chip('損切り', d.plannedStopPct + '%下');
      if (d.sizeNote) chips += chip('サイズ', esc(d.sizeNote));
      return '<div class="dcard' + (d.superseded ? ' superseded' : '') + '" data-id="' + d.decisionId + '">' +
        '<div class="dhead"><span class="id">#' + d.decisionId + '</span><span>' + esc(d.decisionDate) + '</span>' +
        '<span class="act ' + d.action + '">' + esc(LABELS.action[d.action]) + '</span>' +
        '<span class="code">' + esc(short(d.code)) + '</span><span class="nm">' + esc(d.name || '') + '</span>' +
        (d.supersedesId ? '<span class="flag">#' + d.supersedesId + ' の訂正</span>' : '') +
        (d.superseded ? '<span class="flag">訂正済み</span>' : '') +
        (d.lateEntry ? '<span class="flag late" title="判断した日より2日以上あとに書いた記録">後から記録</span>' : '') +
        '</div>' +
        '<div class="dgrid"><div class="dmain">' +
        '<div class="dbody">' + esc(d.reasonText) + '</div>' +
        (d.invalidation ? '<div class="dsec"><div class="dsec-k">次の行動への条件</div><div class="dsec-v">' + esc(d.invalidation) + '</div></div>' : '') +
        (d.reviews.length ? '<div class="reviews">' + d.reviews.map(function (v) {
          return '<div class="review"><span class="verdict">' + esc(v.reviewDate) + ' ' + esc(LABELS.verdict[v.reasonVerdict]) + '</span>' +
            esc(v.outcomeNote || '') + (v.lesson ? '<br><span class="pending">教訓: </span>' + esc(v.lesson) : '') + '</div>';
        }).join('') + '</div>' : '') +
        '</div><dl class="dside">' + evalHtml(d.eval) + '</dl></div>' +
        '<div class="dchips">' + chips + '</div>' +
        '<div class="dactions">' +
        (d.hasSnapshot ? '<button class="link" type="button" data-snap="' + d.decisionId + '">判断時の値</button>' : '') +
        '<button class="link" type="button" data-review="' + d.decisionId + '">振り返りを書く</button>' +
        '<button class="link" type="button" data-supersede="' + d.decisionId + '">訂正する</button>' +
        '<button class="link" type="button" data-q-add="decision:' + d.decisionId + ':' + esc(d.code) + '">調べたいことを追加</button>' +
        qLinkHtml('decision', d.decisionId) + '</div>' +
        '<div class="snap-slot"></div><div class="review-slot"></div></div>';
    }).join('');
  }

  //------------------------------------------------------------------ 判断時の値(損失回避チェックから記録したとき)
  var SYM = { good: '◎', ok: '〇', bad: '×', na: '-' };
  var ANSWER_LABEL = { 'P-SEMI': '半導体の銘柄数', 'S-SIZE': 'この株数で買うか', 'S-STOP': '損切り' };

  async function toggleSnapshot(card, id) {
    var slot = card.querySelector('.snap-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = '<div class="snap"><span class="pending">読み込み中…</span></div>';
    try {
      var p = await api('GET', '/api/journal/decisions/' + id + '/snapshot');
      slot.innerHTML = snapshotHtml(p);
    } catch (e) {
      slot.innerHTML = '<div class="snap"><span class="status error">' + esc(e.message) + '</span></div>';
    }
  }

  function symItems(items) {
    return items.map(function (it) {
      return '<span class="snap-item" title="' + esc(it.warn || '') + '"><span class="snap-no">' + esc(it.id || it.no) + '</span>' +
        esc(it.label) + ' <span class="sym-' + esc(it.level) + '">' + (SYM[it.level] || '-') + '</span>' +
        (it.warn ? '<span class="sym-warn">⚠</span>' : '') + '</span>';
    }).join('');
  }

  function snapshotHtml(p) {
    var c = p.check || {};
    var stopAns = c.answers ? c.answers['S-STOP'] : null;
    var h = '<div class="snap">';
    h += '<div class="snap-head">株価 ' + esc(c.asOf || '—') + ' 時点(終値 ' + num(c.lastClose, c.lastClose % 1 ? 1 : 0) + '円)' +
      (p.list ? ' ・ リスト「' + esc(p.list.name) + '」' : '') + (p.run ? ' ・ チェックの記録 #' + p.run.runId : '') +
      ' ・ 記録 ' + esc((p.savedAt || '').slice(0, 10)) + '</div>';

    // 赤信号
    h += '<div class="snap-row"><span class="snap-k">赤信号</span>' + (c.flags || []).map(function (f) {
      return '<span class="snap-flag' + (f.hit ? ' hit' : '') + '">' + esc(f.label) + (f.hit ? ' 要確認' : ' -') + '</span>';
    }).join('') + (c.excluded ? '<span class="snap-flag hit">「外す」にした</span>' : '') + '</div>';

    // 金額と損切り価格
    var buyTxt = num(c.buy, c.buy % 1 ? 1 : 0) + '円' + (c.buyIsDefault ? '(終値)' : '(指定)');
    h += '<div class="snap-row"><span class="snap-k">損切り価格</span>' +
      '<span>買値 ' + buyTxt + (c.shares ? ' × ' + num(c.shares) + '株 = ' + num((c.yen || 0) / 10000, 1) + '万円' : '') + '</span>' +
      (c.stops || []).map(function (s) {
        var chosen = stopAns === s.pct + '%';
        return '<span class="snap-stop' + (chosen ? ' chosen' : '') + '">' + s.pct + '%: ' + num(s.price, s.price % 1 ? 1 : 0) + '円' +
          (s.lossYen != null ? '(損失 ' + num(s.lossYen / 10000, 1) + '万円)' : '') + (chosen ? ' ← 選んだ' : '') + '</span>';
      }).join('') + (stopAns === '置かない' ? '<span class="snap-stop chosen">損切りは置かない</span>' : '') + '</div>';

    h += '<div class="snap-row"><span class="snap-k">値動き</span>' +
      '<span>ふつうの1週の動き ' + (c.vol13 != null ? num(c.vol13, 1) + '%' : '—') + '</span>' +
      '<span>高値から ' + signed(c.dd250, 1, '%') + '</span><span>20営業日 ' + signed(c.ret20d, 1, '%') + '</span>' +
      '<span>下方修正 ' + (c.downRevisions && c.downRevisions.length ? c.downRevisions.map(function (r) { return esc(r.discDate); }).join('、') : 'なし') + '</span></div>';

    // F・T
    var f = p.F && p.F.items ? p.F.items : [];
    ['F1', 'F2', 'F3'].forEach(function (g) {
      var its = f.filter(function (it) { return it.group === g; });
      if (its.length) h += '<div class="snap-row"><span class="snap-k">' + g + ' ' + ({ F1: '成長', F2: '割安', F3: '収益・財務' })[g] + '</span>' + symItems(its) + '</div>';
    });
    if (p.T && p.T.items) h += '<div class="snap-row"><span class="snap-k">T 値動き・需給</span>' + symItems(p.T.items) + '</div>';

    // 答え
    var ans = c.answers || {};
    var flagLabel = {};
    (c.flags || []).forEach(function (fl) { flagLabel['R-' + fl.key] = fl.label; });
    var keys = Object.keys(ans).filter(function (k) { return k !== 'R-OUT'; });
    if (keys.length) {
      h += '<div class="snap-row"><span class="snap-k">チェックの答え</span><span class="snap-answers">' + keys.map(function (k) {
        var q = k.replace(/^ALL:/, '');
        return '<span>' + esc(ANSWER_LABEL[q] || flagLabel[q] || q) + ': ' + esc(ans[k]) + '</span>';
      }).join('') + '</span></div>';
    }
    h += '<div class="snap-note">⚠ にマウスを重ねると注意の中身が出ます。値は記録した時点のもので、その後の決算・株価では変わりません。</div>';
    return h + '</div>';
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
    f.elements.code.dispatchEvent(new Event('blur'));
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
    pendingQ.note = [];
    renderPendingQ('note');
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
    d.questions = pendingQ.note.slice();
    setStatus('noteStatus', '保存中…');
    try {
      if (editingNoteId) {
        var u = await api('PUT', '/api/journal/notes/' + editingNoteId, d);
        flash('メモ #' + editingNoteId + ' を更新しました' + (u.questionIds.length ? '(調べたいこと ' + u.questionIds.length + '件)' : ''));
      } else {
        var r = await api('POST', '/api/journal/notes', d);
        flash('メモ #' + r.noteId + ' を保存しました' + (r.questionIds.length ? '(調べたいこと ' + r.questionIds.length + '件)' : ''));
      }
      if (d.questions.length) refreshQuestionMeta();
      loaded.positions = false;
      pendingQ.note = [];
      renderPendingQ('note');
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
        qLinkHtml('note', n.noteId) +
        '<span class="spacer"></span><button class="link" type="button" data-q-add="note:' + n.noteId + ':' + esc(n.codes.join(',')) + '">調べたいことを追加</button>' +
        '<button class="link" type="button" data-edit-note="' + n.noteId + '">編集</button>' +
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

  //================================================================== 調べたいこと
  function qLinkHtml(kind, id) {
    var list = qLinks.filter(function (x) { return kind === 'decision' ? x.decisionId === id : x.noteId === id; });
    if (!list.length) return '';
    var open = list.filter(function (x) { return x.open; }).length;
    return '<button class="link" type="button" data-q-filter="' + kind + ':' + id + '">調べたいこと ' + list.length + '件' +
      (open ? '(未完了 ' + open + ')' : '') + '</button>';
  }

  async function refreshQuestionMeta() {
    try {
      var r = await Promise.all([api('GET', '/api/journal/questions/links'), api('GET', '/api/journal/questions?scope=open')]);
      qLinks = r[0].rows;
      var badge = $('qBadge');
      badge.textContent = r[1].count;
      badge.hidden = r[1].count === 0;
      if (decisionCache.length) renderDecisions(decisionCache);
      if (noteCache.length) renderNotes(noteCache);
    } catch (e) {
      // 表がまだ無い(ddl/27 未適用)ときも他の画面は動かす
      $('qBadge').hidden = true;
    }
  }

  function addPendingQ(kind) {
    var box = document.querySelector('[data-qinline="' + kind + '"]');
    var text = box.querySelector('.qinline-text');
    var v = text.value.trim();
    if (!v) {
      flash('調べたいことを入力してから「追加」を押してください', true);
      text.focus();
      return;
    }
    pendingQ[kind].push({ question: v, assignee: box.querySelector('.qinline-assignee').value });
    text.value = '';
    renderPendingQ(kind);
    text.focus();
  }

  function renderPendingQ(kind) {
    var el = document.querySelector('[data-qinline-list="' + kind + '"]');
    el.innerHTML = pendingQ[kind].map(function (q, i) {
      return '<div class="qpending"><span class="qwho ' + q.assignee + '">' + esc(LABELS.assignee[q.assignee]) + '</span>' +
        '<span>' + esc(q.question) + '</span><span class="spacer"></span>' +
        '<button class="link" type="button" data-qinline-del="' + kind + ':' + i + '">外す</button></div>';
    }).join('');
  }

  function initQuestions() {
    document.querySelectorAll('.qinline-text').forEach(function (inp) {
      inp.addEventListener('keydown', function (ev) {
        // 日本語変換の確定の Enter で送信しない
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          addPendingQ(inp.closest('[data-qinline]').dataset.qinline);
        }
      });
    });
    var f = $('questionForm');
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var d = formData(f);
      if (qLinkCtx) {
        if (qLinkCtx.decisionId) d.decisionId = qLinkCtx.decisionId;
        if (qLinkCtx.noteId) d.noteId = qLinkCtx.noteId;
      }
      setStatus('questionStatus', '保存中…');
      try {
        var r = await api('POST', '/api/journal/questions', d);
        setStatus('questionStatus', '');
        flash('調べたいこと #' + r.questionId + ' を書き留めました');
        f.reset();
        setQLinkCtx(null);
        loadQuestions();
        refreshQuestionMeta();
      } catch (e) {
        setStatus('questionStatus', e.message, true);
      }
    });
    $('qScope').onchange = loadQuestions;
    $('qAssignee').onchange = loadQuestions;
    $('importAnswersBtn').onclick = async function () {
      setStatus('answersStatus', '取込中…');
      try {
        var r = await api('POST', '/api/journal/questions/import-answers');
        setStatus('answersStatus', r.updated + '件に答えを入れました' +
          (r.skipped.length ? '(飛ばした問い: #' + r.skipped.join(', #') + '。既に答えがあるか、問いが無い)' : ''));
        loadQuestions();
        refreshQuestionMeta();
      } catch (e) { setStatus('answersStatus', e.message, true); }
    };
  }

  function setQLinkCtx(ctx) {
    qLinkCtx = ctx;
    var b = $('questionLinkBanner');
    if (!ctx) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = esc(ctx.label) + ' から出た問いとして書き留めます。 <button class="link" type="button" id="qLinkCancel">紐付けをやめる</button>';
    $('qLinkCancel').onclick = function () { setQLinkCtx(null); };
  }

  function setQFilter(ctx) {
    qFilterCtx = ctx;
    var b = $('qFilterBanner');
    if (!ctx) { b.hidden = true; } else {
      b.hidden = false;
      b.innerHTML = esc(ctx.label) + ' の問いだけ表示 <button class="link" type="button" id="qFilterClear">解除</button>';
      $('qFilterClear').onclick = function () { setQFilter(null); loadQuestions(); };
    }
  }

  var questionCache = [];
  async function loadQuestions() {
    var scope = qFilterCtx ? 'all' : $('qScope').value;
    var a = $('qAssignee').value;
    setStatus('questionListStatus', '読み込み中…');
    try {
      var r = await api('GET', '/api/journal/questions?scope=' + scope + (a ? '&assignee=' + a : ''));
      var rows = r.rows;
      if (qFilterCtx) {
        rows = rows.filter(function (q) {
          return qFilterCtx.decisionId ? q.decisionId === qFilterCtx.decisionId : q.noteId === qFilterCtx.noteId;
        });
      }
      questionCache = rows;
      setStatus('questionListStatus', rows.length + '件');
      renderQuestions(rows);
    } catch (e) {
      setStatus('questionListStatus', e.message, true);
      $('questionList').innerHTML = '';
    }
  }

  function renderQuestions(rows) {
    if (!rows.length) {
      $('questionList').innerHTML = '<p class="empty">該当する調べたいことはありません。</p>';
      return;
    }
    $('questionList').innerHTML = rows.map(function (q) {
      var closed = q.status === 'DONE' || q.status === 'DROPPED';
      var links = [];
      if (q.decisionId) links.push('判断 #' + q.decisionId);
      if (q.noteId) links.push('メモ #' + q.noteId);
      return '<div class="qcard' + (closed ? ' closed' : '') + '" data-qid="' + q.questionId + '">' +
        '<div class="qhead"><span class="id">#' + q.questionId + '</span><span>' + esc(q.askedDate) + '</span>' +
        '<span class="qstatus ' + q.status + '">' + esc(LABELS.qstatus[q.status]) + '</span>' +
        '<span class="qwho ' + q.assignee + '">' + esc(LABELS.assignee[q.assignee]) + '</span>' +
        '<span>優先度 ' + esc(LABELS.priority[q.priority]) + '</span>' +
        (q.codes.length ? '<span>' + q.codes.map(function (c) { return esc(short(c)); }).join(', ') + '</span>' : '') +
        (links.length ? '<span>' + links.join(' ・ ') + ' から</span>' : '') + '</div>' +
        '<div class="qtext">' + esc(q.question) + '</div>' +
        (q.background ? '<div class="qbg">' + esc(q.background) + '</div>' : '') +
        (q.answer ? '<div class="qanswer">' + esc(q.answer) +
          '<span class="qmeta">' + esc(LABELS.assignee[q.answeredBy] || '') + ' ・ ' +
          (q.answeredAt ? esc(new Date(q.answeredAt).toLocaleString('ja-JP')) : '') +
          (q.answerRef ? ' ・ 出典: ' + linkify(q.answerRef) : '') + '</span></div>' : '') +
        '<div class="qactions">' +
        '<label>状態 <select data-q-status="' + q.questionId + '">' + meta.questionStatuses.map(function (st) {
          return '<option value="' + st + '"' + (st === q.status ? ' selected' : '') + '>' + esc(LABELS.qstatus[st]) + '</option>';
        }).join('') + '</select></label>' +
        '<button class="link" type="button" data-q-assign="' + q.questionId + ':' + (q.assignee === 'SELF' ? 'CLAUDE' : 'SELF') + '">' +
        (q.assignee === 'SELF' ? 'Claude に頼む' : '自分で調べる') + '</button>' +
        '<button class="link" type="button" data-q-answer="' + q.questionId + '">' + (q.answer ? '答えを直す' : '答えを書く') + '</button>' +
        '</div><div class="q-answer-slot"></div></div>';
    }).join('');
  }

  function linkify(ref) {
    var s = String(ref);
    if (/^https?:\/\//.test(s)) return '<a href="' + esc(s) + '" target="_blank" rel="noopener">' + esc(s) + '</a>';
    return esc(s);
  }

  function openAnswerForm(card, id) {
    var slot = card.querySelector('.q-answer-slot');
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    var q = questionCache.filter(function (x) { return x.questionId === id; })[0] || {};
    slot.innerHTML = '<form class="review-form card"><label class="field-label">答え<textarea name="answer" rows="4">' + esc(q.answer || '') + '</textarea></label>' +
      '<label class="field-label">出典・詳細の置き場所<input type="text" name="answerRef" value="' + esc(q.answerRef || '') + '" placeholder="URL や資料名"></label>' +
      '<div class="submit-row"><button class="btn primary" type="submit">保存(状態を「答えあり」に)</button><span class="status"></span></div></form>';
    var form = slot.querySelector('form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var st = form.querySelector('.status');
      st.textContent = '保存中…';
      try {
        await api('PUT', '/api/journal/questions/' + id, formData(form));
        flash('#' + id + ' の答えを保存しました');
        loadQuestions();
        refreshQuestionMeta();
      } catch (e) { st.textContent = e.message; st.className = 'status error'; }
    });
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
        var ts = tagSyncText(r.tagSync);
        flash(r.inserted + '件を取り込みました(重複 ' + r.duplicate + '件は飛ばしました)' + (ts.text ? '。' + ts.text : ''), ts.isError);
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

  //================================================================== 口座(元手。src/capital.js)
  function initCapitalForm() {
    var f = $('capForm');
    f.elements.effectiveDate.value = meta.today;
    f.elements.effectiveDate.max = meta.today;
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      setStatus('capStatus', '保存中…');
      try {
        await api('POST', '/api/journal/capital', formData(f));
        setStatus('capStatus', '');
        flash('元手を記録しました');
        loadAccount();
        loaded.positions = false;
      } catch (e) {
        setStatus('capStatus', e.message, true);
      }
    });
  }

  async function loadAccount() {
    var cap;
    try {
      cap = await api('GET', '/api/journal/capital');
    } catch (e) {
      $('capCurrent').textContent = '元手を読み込めませんでした: ' + e.message +
        '(ddl/30_journal_capital.sql を実行していない可能性があります)';
      $('capNow').innerHTML = '';
      $('capTable').innerHTML = '';
      loadOldSnapshots();
      return;
    }
    var cur = cap.current;
    $('capCurrent').innerHTML = cur
      ? '元手 <b>' + yen(cur.amount) + '</b> 円(' + esc(cur.effectiveDate) + ' から)'
      : '<span class="pending">元手がまだ記録されていません。下の欄で記録してください</span>';

    // 株の時価は保有の計算と同じもの(参考)
    var stockValue = null;
    try {
      var r = lastPositions || await api('GET', '/api/journal/positions');
      lastPositions = r;
      stockValue = r.totals.cashStockValue;
    } catch (e) { /* 時価が出なくても他は出す */ }

    var fl = cap.flows;
    $('capNowNote').textContent = fl.firstTradeDate ? '約定 ' + fl.firstTradeDate + '〜' + fl.lastTradeDate + '(現物のみ)' : '約定がまだありません';
    $('capNow').innerHTML = '<div class="acc-now">' +
      '<span>取得額の累計</span><span class="v">' + yen(fl.buyTotal) + ' 円</span><span class="sub">買付 ' + fl.buyCount + '件の受渡金額</span>' +
      '<span>売却額の累計</span><span class="v">' + yen(fl.sellTotal) + ' 円</span><span class="sub">売付 ' + fl.sellCount + '件の受渡金額</span>' +
      '<span>株に入れた正味の額</span><span class="v">' + yen(cap.netInvested) + ' 円</span><span class="sub">取得額の累計 − 売却額の累計</span>' +
      '<span class="key">まだ使っていない元手</span><span class="v key">' + (cap.unused === null ? '—' : yen(cap.unused) + ' 円') + '</span>' +
      '<span class="sub key">元手 − 株に入れた正味の額' + (cap.unused === null ? '(元手が未記録)' : '') + '</span>' +
      '<span>参考: 株の時価</span><span class="v">' + (stockValue === null ? '—' : yen(stockValue) + ' 円') + '</span>' +
      '<span class="sub">今持っている現物 × 最新の終値(保有タブと同じ)</span>' +
      '<span>参考: トータルの差益</span><span class="v">' +
      (stockValue === null ? '—' : signed(stockValue - cap.netInvested, 0, ' 円')) + '</span>' +
      '<span class="sub">株の時価 − 株に入れた正味の額(= 実現損益 + 含み損益。配当は含まない)</span>' +
      '</div>';

    $('capTable').innerHTML = cap.history.length
      ? '<thead><tr><th>日付</th><th class="num-col">元手</th><th>メモ</th><th>更新</th><th></th></tr></thead><tbody>' +
        cap.history.map(function (h, i) {
          return '<tr' + (i === 0 ? ' class="active-row"' : '') + '><td>' + esc(h.effectiveDate) +
            (i === 0 ? '<span class="active-badge">今有効</span>' : '') + '</td><td class="num-col">' + yen(h.amount) +
            '</td><td class="wrap">' + esc(h.note || '') + '</td><td class="dim">' + esc(h.updatedAt || '') +
            '</td><td><button class="link" type="button" data-del-capital="' + h.capitalId + '" data-label="' + esc(h.effectiveDate) + '">削除</button></td></tr>';
        }).join('') + '</tbody>'
      : '<tbody><tr><td class="dim">まだ記録がありません</td></tr></tbody>';
    loadOldSnapshots();
  }

  /** 以前の週次記録(今は使っていない。参照と削除だけ) */
  async function loadOldSnapshots() {
    try {
      var r = await api('GET', '/api/journal/snapshots');
      $('snapTable').innerHTML = r.rows.length
        ? '<thead><tr><th>日付</th><th class="num-col">現金</th><th class="num-col">株式評価額</th>' +
          '<th class="num-col">入金</th><th class="num-col">出金</th><th>メモ</th><th></th></tr></thead><tbody>' +
          r.rows.map(function (s) {
            return '<tr><td>' + esc(s.snapDate) + '</td><td class="num-col">' + yen(s.cash) + '</td><td class="num-col">' + yen(s.stock) +
              '</td><td class="num-col">' + yen(s.deposit) + '</td><td class="num-col">' + yen(s.withdrawal) + '</td><td class="wrap">' + esc(s.note || '') +
              '</td><td><button class="link" type="button" data-del-snap="' + esc(s.snapDate) + '">削除</button></td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="dim">記録はありません</td></tr></tbody>';
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
    if ((el = t.closest('[data-goto-decisions]'))) {
      $('decisionFilter').value = short(el.dataset.gotoDecisions);
      var wasD = loaded.decisions;
      showTab('decisions');
      if (wasD) loadDecisions();
      $('decisionList').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if ((el = t.closest('[data-goto-notes]'))) {
      $('noteCode').value = short(el.dataset.gotoNotes);
      $('noteQ').value = '';
      var wasN = loaded.notes;
      showTab('notes');
      if (wasN) loadNotes();
      $('noteList').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if ((el = t.closest('[data-snap]'))) { toggleSnapshot(el.closest('.dcard'), Number(el.dataset.snap)); return; }
    if ((el = t.closest('[data-review]'))) { openReviewForm(el.closest('.dcard'), Number(el.dataset.review)); return; }
    if ((el = t.closest('[data-supersede]'))) { startSupersede(Number(el.dataset.supersede)); return; }
    if ((el = t.closest('[data-qinline-add]'))) { addPendingQ(el.dataset.qinlineAdd); return; }
    if ((el = t.closest('[data-qinline-del]'))) {
      var pp = el.dataset.qinlineDel.split(':');
      pendingQ[pp[0]].splice(Number(pp[1]), 1);
      renderPendingQ(pp[0]);
      return;
    }
    if ((el = t.closest('[data-q-add]'))) {
      var qa = el.dataset.qAdd.split(':');
      var ctx = qa[0] === 'decision'
        ? { decisionId: Number(qa[1]), label: '判断 #' + qa[1] }
        : { noteId: Number(qa[1]), label: 'メモ #' + qa[1] };
      showTab('questions');
      setQLinkCtx(ctx);
      $('questionForm').elements.codes.value = (qa[2] || '').split(',').filter(Boolean).map(short).join(', ');
      $('questionForm').elements.question.focus();
      $('questionForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if ((el = t.closest('[data-q-filter]'))) {
      var qf = el.dataset.qFilter.split(':');
      setQFilter(qf[0] === 'decision'
        ? { decisionId: Number(qf[1]), label: '判断 #' + qf[1] }
        : { noteId: Number(qf[1]), label: 'メモ #' + qf[1] });
      if (loaded.questions) loadQuestions();
      showTab('questions');
      return;
    }
    if ((el = t.closest('[data-q-assign]'))) {
      var qs = el.dataset.qAssign.split(':');
      try { await api('PUT', '/api/journal/questions/' + qs[0], { assignee: qs[1] }); loadQuestions(); } catch (e) { flash(e.message, true); }
      return;
    }
    if ((el = t.closest('[data-q-answer]'))) { openAnswerForm(el.closest('.qcard'), Number(el.dataset.qAnswer)); return; }
    if ((el = t.closest('[data-unpick]'))) { pendingImages.splice(Number(el.dataset.unpick), 1); renderThumbs(); return; }
    if ((el = t.closest('[data-edit-note]'))) { startEditNote(Number(el.dataset.editNote)); return; }
    if ((el = t.closest('[data-del-note]'))) {
      if (!window.confirm('メモ #' + el.dataset.delNote + ' を写真ごと削除します。よろしいですか?')) return;
      try { await api('DELETE', '/api/journal/notes/' + el.dataset.delNote); flash('削除しました'); loadNotes(); loaded.positions = false; } catch (e) { flash(e.message, true); }
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
    if ((el = t.closest('[data-del-capital]'))) {
      if (!window.confirm(el.dataset.label + ' の元手の記録を削除します。よろしいですか?')) return;
      try { await api('DELETE', '/api/journal/capital/' + el.dataset.delCapital); loadAccount(); loaded.positions = false; } catch (e) { flash(e.message, true); }
      return;
    }
    if ((el = t.closest('[data-del-snap]'))) {
      if (!window.confirm(el.dataset.delSnap + ' の記録を削除します。よろしいですか?')) return;
      try { await api('DELETE', '/api/journal/snapshots/' + el.dataset.delSnap); loadOldSnapshots(); } catch (e) { flash(e.message, true); }
      return;
    }
  });

  document.addEventListener('change', async function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-q-status]');
    if (!el) return;
    try {
      await api('PUT', '/api/journal/questions/' + el.dataset.qStatus, { status: el.value });
      flash('#' + el.dataset.qStatus + ' を「' + LABELS.qstatus[el.value] + '」にしました');
      loadQuestions();
      refreshQuestionMeta();
    } catch (e) { flash(e.message, true); }
  });

  //================================================================== 起動
  async function init() {
    try {
      meta = await api('GET', '/api/journal/meta');
    } catch (e) {
      flash('初期化に失敗しました: ' + e.message, true);
      return;
    }
    initDecisionForm();
    initNoteForm();
    initImport();
    initCapitalForm();
    initQuestions();
    $('syncTagsBtn').onclick = syncTags;
    refreshQuestionMeta();
    $('dataMeta').textContent = '';
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
    showTab(['positions', 'decisions', 'notes', 'questions', 'import', 'account'].indexOf(tab) >= 0 ? tab : 'positions');
    applyFromCheck();
  }

  init();
})();
