/*
 * 損失回避チェック(/purchase/check?list=3&codes=7203,6758)の画面。ライブラリ非依存。
 * API は src/web/purchaseRoutes.js(c) の節)、計算は src/web/purchaseCheck.js と src/lossChecks.js。
 * 読む順: 1 前提 → 2 赤信号で外すか決める → 3 残った銘柄の金額と損切り → 4 判断メモへ。
 *
 * 状態:
 *   result   最後に計算した結果
 *   answers  問いへの答え {"コード|R-DIP": "..."}。全体の問い(P-SEMI・S-SIZE)はコードの代わりに ALL。
 *            選ぶ形の問い(P-SEMI・S-SIZE・S-STOP)は選んだ文字列(例 "10%")をそのまま入れる。
 *            外す印は "コード|R-OUT": "外す"
 *   savedAnswers 最後に保存(または読み込み)した答え。answers と比べて「未保存」を出す
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ALL = 'ALL';
  var OUT = 'R-OUT';
  var DEFAULT_SHARES = 100;
  var listId = null;
  var codes = [];
  var result = null;
  var answers = {};
  var savedAnswers = {};
  var lastRunId = null;   // 一番新しい「答えを保存」の記録。判断メモへ渡す

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
  function man(v) { return v === null || v === undefined || isNaN(v) ? '—' : num(v / 10000, 1) + '万円'; }
  function yenP(v) { return v === null || v === undefined || isNaN(v) ? '—' : num(v, v < 1000 ? 1 : 0) + '円'; }
  function normCode(s) {
    var c = String(s).trim().toUpperCase();
    if (/^[0-9A-Z]{4}$/.test(c)) return c + '0';
    if (/^[0-9A-Z]{5}$/.test(c)) return c;
    return null;
  }
  function parseNum(s) {
    var t = String(s || '').replace(/[,，\s円]/g, '');
    if (!t) return null;
    var n = Number(t);
    return isFinite(n) && n > 0 ? n : NaN;
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

  function isDirty() {
    var keys = {};
    Object.keys(answers).forEach(function (k) { keys[k] = 1; });
    Object.keys(savedAnswers).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).some(function (k) { return (answers[k] || '').trim() !== (savedAnswers[k] || '').trim(); });
  }
  function renderDirty() { $('dirtyLabel').hidden = !isDirty(); }

  function isOut(code) { return (answers[code + '|' + OUT] || '').trim() !== ''; }
  function excludedCodes() { return codes.filter(isOut); }

  //------------------------------------------------------------------ 入力
  function readInputs() {
    var stops = $('stops').value.split(/[,，\s、]+/).filter(Boolean).map(Number);
    if (!stops.length || stops.some(function (x) { return !(x > 0 && x < 100); })) throw new Error('損切り幅は 1〜99 の数をカンマ区切りで入れてください');
    var buys = {};
    codes.forEach(function (c) {
      var el = $('buy_' + c);
      if (!el) return;
      var v = parseNum(el.value);
      if (isNaN(v)) throw new Error(short(c) + ' の買値は正の数で入れてください');
      if (v !== null) buys[c] = v;
    });
    var shares = {};
    codes.forEach(function (c) {
      var el = $('sh_' + c);
      if (!el) return;
      var t = String(el.value || '').replace(/[,，\s株]/g, '');
      if (!t) return;
      var n = Number(t);
      if (!(Number.isInteger(n) && n > 0)) throw new Error(short(c) + ' の株数は正の整数で入れてください');
      shares[c] = n;
    });
    return { stopPcts: stops, buys: buys, shares: shares };
  }

  /** 銘柄ごとの買値と株数の欄。外した銘柄の欄も値を保つため、隠すだけにする */
  function renderBuyInputs(prevBuys, prevShares) {
    $('buyRow').innerHTML = codes.map(function (c) {
      var s = result && result.stocks.find(function (x) { return x.code === c; });
      var name = s ? s.name : '';
      var sh = prevShares && prevShares[c] != null ? prevShares[c] : DEFAULT_SHARES;
      return '<div class="buy-item" data-buy="' + esc(c) + '"><span>' + esc(short(c)) + ' ' + esc(name || '') + '</span>' +
        '<label>買値<input type="text" class="in-num" id="buy_' + esc(c) + '" inputmode="decimal" placeholder="' +
        esc(s && s.lastClose ? '終値 ' + num(s.lastClose, s.lastClose < 1000 ? 1 : 0) : '直近終値') + '" value="' +
        esc(prevBuys && prevBuys[c] != null ? prevBuys[c] : '') + '"></label>' +
        '<label>株数<input type="text" class="in-num" id="sh_' + esc(c) + '" inputmode="numeric" value="' + esc(sh) + '"></label></div>';
    }).join('');
    Array.prototype.forEach.call($('buyRow').querySelectorAll('input'), function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') recalc(); });
    });
    syncBuyVisibility();
  }
  function syncBuyVisibility() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-buy]'), function (el) {
      el.hidden = isOut(el.getAttribute('data-buy'));
    });
  }

  /** 再読み込みで同じ画面に戻れるよう、入力を URL に書いておく */
  function writeUrl(p) {
    var q = new URLSearchParams();
    q.set('list', listId);
    q.set('codes', codes.map(short).join(','));
    q.set('stops', p.stopPcts.join(','));
    var b = Object.keys(p.buys).map(function (c) { return short(c) + ':' + p.buys[c]; }).join(',');
    if (b) q.set('buys', b);
    var sh = Object.keys(p.shares).map(function (c) { return short(c) + ':' + p.shares[c]; }).join(',');
    if (sh) q.set('shares', sh);
    history.replaceState(null, '', '/purchase/check?' + q.toString());
  }

  //------------------------------------------------------------------ 計算
  async function recalc() {
    var p;
    try { p = readInputs(); } catch (e) { flash(e.message, true); return; }
    var q = new URLSearchParams();
    q.set('list', listId);
    q.set('codes', codes.join(','));
    q.set('stops', p.stopPcts.join(','));
    q.set('buys', Object.keys(p.buys).map(function (c) { return c + ':' + p.buys[c]; }).join(','));
    q.set('shares', Object.keys(p.shares).map(function (c) { return c + ':' + p.shares[c]; }).join(','));
    q.set('exclude', excludedCodes().join(','));
    $('recalcBtn').disabled = true;
    $('recalcBtn').textContent = '計算中…';
    try {
      var open = openRows();
      result = await api('GET', '/api/purchase/check?' + q.toString());
      writeUrl(p);
      renderBuyInputs(p.buys, p.shares);
      render(open);
    } catch (e) {
      flash('計算できませんでした: ' + e.message, true);
    } finally {
      $('recalcBtn').disabled = false;
      $('recalcBtn').textContent = '再計算';
    }
  }

  //------------------------------------------------------------------ 表示
  function qHtml(code, q, label) {
    if (!q) return '';
    var k = code + '|' + q.id;
    var v = answers[k] || '';
    if (q.options) {
      // 選ぶ形。もう一度押すと選択を外す
      return '<div class="q"><span class="q-text">' + esc(label ? label + ': ' : '') + esc(q.text) + '</span><div class="choices">' +
        q.options.map(function (o) {
          return '<button type="button" class="choice' + (v === o ? ' on' : '') + '" data-ckey="' + esc(k) + '" data-val="' + esc(o) + '">' + esc(o) + '</button>';
        }).join('') + '</div></div>';
    }
    return '<div class="q"><span class="q-text">' + esc(label ? label + ': ' : '') + esc(q.text) + '</span>' +
      '<textarea rows="2" maxlength="2000" data-key="' + esc(k) + '" class="' + (v.trim() ? 'filled' : '') + '">' + esc(v) + '</textarea></div>';
  }
  function linesHtml(lines) {
    return lines && lines.length ? '<ul class="auto-lines">' + lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '';
  }

  // 1 前提
  function renderPremise() {
    var pr = result.premise;
    var h = '';
    if (pr.capitalMissing) h += '<p class="note">元手が記録されていません(売買記録の「口座」タブで入れます)。</p>';
    else {
      h += '<div class="cap-grid">' + pr.capital.map(function (c) {
        return '<div class="cap-row' + (c.key ? ' key' : '') + '"><span class="cap-label">' + esc(c.label) + '</span>' +
          '<span class="cap-value">' + esc(c.value) + '</span><span class="cap-note">' + esc(c.note) + '</span></div>';
      }).join('') + '</div>';
    }
    if (pr.semi) {
      var s = pr.semi;
      h += '<p class="semi-line">保有と今回の候補(外した銘柄を除く)を合わせた半導体(タグ120/130)の銘柄数: <span class="hl">' + s.total + '</span>' +
        '(保有 ' + s.held + '、今回の候補 ' + s.cand + (s.both ? '。うち ' + s.both + ' 銘柄は両方に入っている' : '') + ')</p>';
      if (s.total) h += '<p class="note">半導体は、群全体の13週の騰落の振れが他の約2倍だった(事後の観察)。同じ向きに動きやすく、銘柄数を増やしても振れが減りにくい。</p>';
      h += qHtml(ALL, pr.question);
    } else h += '<p class="note">保有の半導体の数を取得できませんでした。</p>';
    $('premiseBox').innerHTML = h;
  }

  // 2 赤信号
  function hitCount(s) { return s.flags.filter(function (f) { return f.hit; }).length; }
  function answeredFlags(s) {
    var qs = s.flags.filter(function (f) { return f.question; });
    var n = qs.filter(function (f) { return (answers[s.code + '|' + f.question.id] || '').trim(); }).length;
    return qs.length ? n + ' / ' + qs.length : '—';
  }

  function renderFlags(open) {
    var labels = result.stocks.length ? result.stocks[0].flags.map(function (f) { return f.label; }) : [];
    var head = '<thead><tr><th>外す</th><th>コード</th><th>銘柄名</th>' +
      labels.map(function (l) { return '<th>' + esc(l) + '</th>'; }).join('') + '<th>答え</th></tr></thead>';
    var body = result.stocks.map(function (s, idx) {
      var detail = s.flags.map(function (f) {
        return '<div class="ch-block"><div class="ch-head">' + esc(f.label) +
          (f.hit ? '<span class="st need">要確認</span>' : '') + '</div>' +
          linesHtml(f.lines) + qHtml(s.code, f.question) + '</div>';
      }).join('');
      var isOpen = open && open.indexOf(s.code) >= 0;
      return '<tr class="main' + (isOpen ? ' open' : '') + (s.excluded ? ' out' : '') + '" data-idx="' + idx + '">' +
        '<td class="out-cell"><input type="checkbox" data-out="' + esc(s.code) + '"' + (s.excluded ? ' checked' : '') + ' title="外す(3 の配分から除く)"></td>' +
        '<td class="code">' + esc(short(s.code)) + '</td>' +
        '<td class="name" title="' + esc(s.name) + '">' + esc(s.name) + '</td>' +
        s.flags.map(function (f) { return f.hit ? '<td class="st-check">要確認</td>' : '<td class="dim">-</td>'; }).join('') +
        '<td class="ans-count" data-ans="' + idx + '">' + answeredFlags(s) + '</td></tr>' +
        '<tr class="detail" data-idx="' + idx + '"' + (isOpen ? '' : ' hidden') + '><td colspan="' + (labels.length + 4) + '">' + detail + '</td></tr>';
    }).join('');
    $('flagTable').innerHTML = head + '<tbody>' + body + '</tbody>';
    Array.prototype.forEach.call($('flagTable').querySelectorAll('tr.main'), function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('.out-cell')) return;
        var d = $('flagTable').querySelector('tr.detail[data-idx="' + tr.getAttribute('data-idx') + '"]');
        d.hidden = !d.hidden;
        tr.classList.toggle('open', !d.hidden);
      });
    });
    Array.prototype.forEach.call($('flagTable').querySelectorAll('input[data-out]'), function (cb) {
      cb.addEventListener('change', function () {
        var k = cb.getAttribute('data-out') + '|' + OUT;
        if (cb.checked) answers[k] = '外す'; else delete answers[k];
        renderDirty();
        syncBuyVisibility();
        recalc();
      });
    });
  }

  function openRows() {
    if (!result) return [];
    return Array.prototype.map.call(document.querySelectorAll('#flagTable tr.main.open'), function (tr) {
      return result.stocks[Number(tr.getAttribute('data-idx'))].code;
    });
  }

  // 3 金額と損切り
  function renderSizing() {
    var sz = result.sizing;
    var pcts = result.stopPcts;
    var out = result.stocks.filter(function (s) { return s.excluded; });
    $('sizeNote').textContent = sz.rows.length + '銘柄' + (out.length ? '(外した ' + out.map(function (s) { return short(s.code); }).join('、') + ' を除く)' : '');
    if (!sz.rows.length) { $('sizeBox').innerHTML = '<p class="note">残っている銘柄がありません。</p>'; return; }
    var head = '<thead><tr><th rowspan="2">コード</th><th rowspan="2">銘柄名</th><th rowspan="2" class="num-col">買値</th>' +
      '<th rowspan="2" class="num-col">株数</th><th rowspan="2" class="num-col">買う額</th><th rowspan="2" class="num-col">割合</th>' +
      '<th rowspan="2" class="num-col">ふつうの<br>1週の動き</th><th rowspan="2" class="num-col">ふつうの<br>1週で動く額</th>' +
      '<th rowspan="2" class="num-col">参考: 値動きで<br>分けたら</th>' +
      pcts.map(function (p) { return '<th colspan="3" class="grp">損切り幅 ' + p + '%</th>'; }).join('') + '</tr><tr>' +
      pcts.map(function () { return '<th class="num-col grp">損切り価格</th><th class="num-col">1週の動きの</th><th class="num-col">売ると損失</th>'; }).join('') +
      '</tr></thead>';
    var body = sz.rows.map(function (r) {
      return '<tr><td class="code">' + esc(short(r.code)) + '</td><td class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</td>' +
        '<td class="num-col">' + yenP(r.buy) + (r.buyIsDefault ? '' : ' <span class="badge">指定</span>') + '</td>' +
        '<td class="num-col">' + num(r.shares) + '株</td>' +
        '<td class="num-col">' + man(r.yen) + '</td>' +
        '<td class="num-col">' + (r.share != null ? num(r.share * 100, 1) + '%' : '—') + '</td>' +
        '<td class="num-col">' + (r.vol13 != null ? num(r.vol13, 1) + '%' : '—') + '</td>' +
        '<td class="num-col">' + man(r.weekYen) + '</td>' +
        '<td class="num-col dim">' + (r.refShares != null ? num(r.refShares) + '株' : '—') + '</td>' +
        r.stops.map(function (x) {
          return '<td class="num-col grp">' + yenP(x.price) + '</td><td class="num-col">' + (x.timesWeek != null ? num(x.timesWeek, 1) + '倍' : '—') +
            '</td><td class="num-col">' + man(x.lossYen) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    var t = sz.totals;
    // 買う額の合計が、まだ使っていない元手を上回るか
    var unused = result.premise.unusedYen;
    var over = unused != null && t.yen != null && t.yen > unused;
    var foot = '<tfoot><tr class="total"><td colspan="4">合計(全銘柄を損切りしたときの損失は右端)</td>' +
      '<td class="num-col' + (over ? ' over' : '') + '">' + man(t.yen) + '</td><td></td><td></td><td class="num-col">' + man(t.weekYen) + '</td><td></td>' +
      t.stopLoss.map(function (x) { return '<td class="grp"></td><td></td><td class="num-col">' + man(x.lossYen) + '</td>'; }).join('') +
      '</tr></tfoot>';
    var h = '<div class="table-wrap short"><table id="sizeTable">' + head + '<tbody>' + body + '</tbody>' + foot + '</table></div>';
    if (over) {
      h += '<p class="over-warn">買う額の合計 ' + man(t.yen) + ' が、まだ使っていない元手 ' + man(unused) + ' を ' + man(t.yen - unused) + ' 上回っています。</p>';
    } else if (unused != null && t.yen != null) {
      h += '<p class="note">まだ使っていない元手 ' + man(unused) + ' のうち ' + man(t.yen) + ' を使います(残り ' + man(unused - t.yen) + ')。</p>';
    }
    h += '<ul class="auto-lines">' +
      '<li>買う額 = 買値 × 株数。株数は既定で100株。単元未満で買うときは、その株数を入れる</li>' +
      '<li>ふつうの1週の動き = 直近13週の、週ごとの騰落率のばらつき(標準偏差)。買う額 × これ = ふつうの1週で動く額</li>' +
      '<li>参考: 同じ合計額を、値動きの小さい銘柄ほど多くなるように分けたら(1 ÷ ふつうの1週の動き の比)何株になるか</li>' +
      '<li>「1週の動きの○倍」が1倍に近い損切り幅は、ふつうの値動きで当たりやすい</li>' +
      '<li>逆指値は、急落した日に損切り価格より下で売れることがある。損失はこの表より大きくなりうる</li>' +
      '<li>検証資料: 固定幅の損切りは、13週で一番悪かった5%の銘柄の損を浅くするが、平均の成績は週あたり 0.3〜0.7pt 下がる。成績を上げる手段ではなく、最悪を浅くする手段</li>' +
      '</ul>';
    h += qHtml(ALL, sz.sizeQuestion);
    h += sz.rows.map(function (r) { return qHtml(r.code, sz.stopQuestion, short(r.code) + ' ' + (r.name || '')); }).join('');
    $('sizeBox').innerHTML = h;
  }

  // 4 判断メモへ
  function renderMemo() {
    $('memoBox').innerHTML = '<table class="memo-table"><tbody>' + result.stocks.map(function (s) {
      return '<tr><td class="code">' + esc(short(s.code)) + '</td><td class="name">' + esc(s.name) + '</td>' +
        '<td>' + (s.excluded ? '<span class="dim">外した</span>' : '') + '</td><td class="memo-actions">' +
        '<button class="btn" type="button" data-memo="BUY" data-code="' + esc(s.code) + '"' +
        (s.excluded ? ' disabled title="2 で「外す」にしています"' : '') + '>判断メモへ</button>' +
        '<button class="btn" type="button" data-memo="PASS" data-code="' + esc(s.code) + '">見送りとして記録</button></td></tr>';
    }).join('') + '</tbody></table>' +
      '<p class="note">押すと、答えを保存してから売買記録の判断フォームを別タブで開きます。判断を記録すると、その時点のファンダメンタル・テクニカル・このチェックの値も一緒に残します。</p>';
    Array.prototype.forEach.call($('memoBox').querySelectorAll('button[data-memo]'), function (bt) {
      bt.addEventListener('click', function () { openMemo(bt.getAttribute('data-code'), bt.getAttribute('data-memo')); });
    });
  }

  /** 判断フォームに入れる値(/journal が URL から読む) */
  function memoParams(code, action) {
    var s = result.stocks.find(function (x) { return x.code === code; });
    var row = result.sizing.rows.find(function (x) { return x.code === code; });
    var p = new URLSearchParams();
    p.set('from', 'check');
    p.set('list', listId);
    p.set('listName', result.listName || '');
    if (lastRunId) p.set('run', lastRunId);
    p.set('code', short(code));
    p.set('action', action);

    // 赤信号への答え(理由の下書き)
    var flagLines = s.flags.filter(function (f) { return f.question && (answers[code + '|' + f.question.id] || '').trim(); })
      .map(function (f) { return '・' + f.label + ': ' + answers[code + '|' + f.question.id].trim(); });
    var hits = s.flags.filter(function (f) { return f.hit; }).map(function (f) { return f.label; });

    if (action === 'PASS') {
      var r = '損失回避チェックで見送り。' + (hits.length ? '赤信号: ' + hits.join('、') + '。' : '') + (s.excluded ? '「外す」にした。' : '');
      if (flagLines.length) r += '\n' + flagLines.join('\n');
      p.set('reason', r);
      return p;
    }
    if (flagLines.length) p.set('reason', '赤信号への答え\n' + flagLines.join('\n'));
    var stopAns = answers[code + '|S-STOP'] || '';
    var pct = /%$/.test(stopAns) ? Number(stopAns.replace('%', '')) : null;
    var stop = row && pct != null ? row.stops.find(function (x) { return x.pct === pct; }) : null;
    if (pct != null) p.set('stop', pct);
    if (row) {
      var total = result.sizing.totals.yen;
      p.set('size', num(row.shares) + '株 × ' + yenP(row.buy) + ' = ' + man(row.yen) +
        (total ? '(今回の合計 ' + man(total) + ' の ' + num(row.share * 100, 0) + '%)' : ''));
    }
    p.set('inv', (stop ? '株価: 買値 ' + yenP(row.buy) + ' から −' + pct + '%(' + yenP(stop.price) + ')で全部売る' :
      stopAns === '置かない' ? '株価: 損切りは置かない' : '株価: ') + '\n株価以外: \n時間: ');
    return p;
  }

  async function openMemo(code, action) {
    // 先にタブを開いておく(保存を待ってから開くと、ブラウザにポップアップとして止められることがある)
    var w = window.open('about:blank', '_blank');
    // 入れたまま再計算していない株数・買値があっても、表と同じ値を渡すよう先に計算し直す
    await recalc();
    // 株数・買値も判断時の値として残すので、答えに変更が無くても毎回保存する
    var ok = await save();
    if (!ok) { if (w) w.close(); return; }
    var url = '/journal?' + memoParams(code, action).toString() + '#decisions';
    if (w) w.location.href = url; else location.href = url;
  }

  function bindTextareas() {
    Array.prototype.forEach.call(document.querySelectorAll('textarea[data-key]'), function (ta) {
      ta.addEventListener('input', function () {
        answers[ta.getAttribute('data-key')] = ta.value;
        ta.classList.toggle('filled', !!ta.value.trim());
        renderDirty();
        result.stocks.forEach(function (s, idx) {
          var cell = document.querySelector('[data-ans="' + idx + '"]');
          if (cell) cell.textContent = answeredFlags(s);
        });
      });
    });
  }

  function bindChoices() {
    Array.prototype.forEach.call(document.querySelectorAll('button.choice'), function (bt) {
      bt.addEventListener('click', function () {
        var k = bt.getAttribute('data-ckey');
        var v = bt.getAttribute('data-val');
        if (answers[k] === v) delete answers[k]; else answers[k] = v;
        Array.prototype.forEach.call(document.querySelectorAll('button.choice'), function (o) {
          if (o.getAttribute('data-ckey') === k) o.classList.toggle('on', answers[k] === o.getAttribute('data-val'));
        });
        renderDirty();
      });
    });
  }

  function render(open) {
    $('dataMeta').textContent = 'リスト「' + result.listName + '」 / 株価 ' + (result.asOf || '—') + ' 時点 / ' + result.stocks.length + '銘柄';
    renderPremise();
    renderFlags(open);
    renderSizing();
    renderMemo();
    bindTextareas();
    bindChoices();
    renderDirty();
    $('body').hidden = false;
  }

  //------------------------------------------------------------------ 保存
  async function save() {
    var p;
    try { p = readInputs(); } catch (e) { flash(e.message, true); return false; }
    var list = Object.keys(answers).filter(function (k) { return (answers[k] || '').trim(); }).map(function (k) {
      var i = k.indexOf('|');
      return { code: k.slice(0, i), qid: k.slice(i + 1), answer: answers[k] };
    });
    $('saveBtn').disabled = true;
    try {
      var out = await api('POST', '/api/purchase/check/answers', {
        listId: listId, codes: codes, amount: result && result.sizing.totals.yen ? Math.round(result.sizing.totals.yen) : null,
        stopPcts: p.stopPcts, buys: p.buys, shares: p.shares, answers: list,
      });
      savedAnswers = {};
      Object.keys(answers).forEach(function (k) { if ((answers[k] || '').trim()) savedAnswers[k] = answers[k]; });
      renderDirty();
      lastRunId = out.runId;
      $('saveStatus').textContent = '保存しました(答え ' + out.saved + '件、記録 #' + out.runId + ')';
      return true;
    } catch (e) {
      flash('保存できませんでした: ' + e.message, true);
      return false;
    } finally {
      $('saveBtn').disabled = false;
    }
  }

  //------------------------------------------------------------------ 初期化
  async function init() {
    initTheme();
    var q = new URLSearchParams(location.search);
    listId = Number(q.get('list'));
    codes = (q.get('codes') || '').split(/[,\s]+/).map(normCode).filter(Boolean);
    codes = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
    if (!listId || !codes.length) {
      $('dataMeta').textContent = '';
      flash('リストと銘柄が指定されていません。銘柄購入の画面から開いてください', true);
      return;
    }
    if (codes.length > 5) { flash('損失回避チェックは5銘柄までです。先頭の5銘柄にしました', true); codes = codes.slice(0, 5); }

    // 前回保存した答えと入力を読む(URL に入力があれば URL を優先)
    var saved = null;
    try {
      saved = await api('GET', '/api/purchase/check/saved?list=' + listId + '&codes=' + encodeURIComponent(codes.join(',')));
    } catch (e) {
      flash('保存した答えを読めませんでした: ' + e.message, true);
    }
    answers = saved ? Object.assign({}, saved.answers) : {};
    savedAnswers = Object.assign({}, answers);
    var latest = saved && saved.latest;
    $('stops').value = q.get('stops') || (latest && latest.stopPcts ? latest.stopPcts : '10,15');
    var buys = {};
    if (q.get('buys')) {
      q.get('buys').split(',').forEach(function (x) {
        var kv = x.split(':');
        var c = normCode(kv[0]);
        if (c && kv[1]) buys[c] = kv[1];
      });
    } else if (latest && latest.buys) {
      Object.keys(latest.buys).forEach(function (c) { if (codes.indexOf(c) >= 0) buys[c] = latest.buys[c]; });
    }
    var shares = {};
    if (q.get('shares')) {
      q.get('shares').split(',').forEach(function (x) {
        var kv = x.split(':');
        var c = normCode(kv[0]);
        if (c && kv[1]) shares[c] = kv[1];
      });
    } else if (latest && latest.shares) {
      Object.keys(latest.shares).forEach(function (c) { if (codes.indexOf(c) >= 0) shares[c] = latest.shares[c]; });
    }
    renderBuyInputs(buys, shares);
    if (latest) lastRunId = latest.runId;
    if (latest) $('saveStatus').textContent = '前回の保存: ' + latest.runAt + '(記録 #' + latest.runId + ')';

    $('recalcBtn').addEventListener('click', recalc);
    $('saveBtn').addEventListener('click', save);
    window.addEventListener('beforeunload', function (e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    await recalc();
  }

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

  init();
})();
