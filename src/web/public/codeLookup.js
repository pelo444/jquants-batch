/*
 * 企業名の一部から銘柄コードを引いて、銘柄コードの欄に足す部品。
 * 騰落率一覧(index.html)の「銘柄コード」タブと、銘柄購入(purchase.html)の購入検討銘柄で使う。
 *
 * 使い方: <div class="lookup" data-target="入力欄のid"></div> を置いて、このファイルを読み込むだけ。
 *   候補を選ぶと、入力欄の末尾に4桁コードを「, 」区切りで足し、change イベントを出す
 *   (銘柄購入はその change でリストに反映する)。すでに入っているコードは足さない。
 * 検索はサーバー(/api/stock-lookup)。ひらがな・カタカナ・半角カナ・英語名・コードの先頭でも当たる。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** 欄の中のコードを4桁・大文字にそろえて返す(67520 → 6752) */
  function codesIn(el) {
    return el.value.split(/[,，、\s]+/).filter(Boolean).map(function (c) {
      c = c.trim().toUpperCase();
      return c.length === 5 && c[4] === '0' ? c.slice(0, 4) : c;
    });
  }

  function attach(box) {
    var target = document.getElementById(box.getAttribute('data-target'));
    if (!target) return;
    box.innerHTML =
      '<input type="search" class="lookup-input" placeholder="企業名の一部で探す(例: トヨタ、とよた、toyota)" autocomplete="off" spellcheck="false">' +
      '<div class="lookup-pop" hidden><ul class="lookup-list" role="listbox"></ul><div class="lookup-foot"></div></div>';
    var input = box.querySelector('.lookup-input');
    var pop = box.querySelector('.lookup-pop');
    var list = box.querySelector('.lookup-list');
    var foot = box.querySelector('.lookup-foot');
    var items = [];
    var active = -1;
    var timer = null;
    var seq = 0;
    var lastTotal = 0;

    function close() { pop.hidden = true; active = -1; }

    function render() {
      var total = lastTotal;
      var have = codesIn(target);
      list.innerHTML = items.map(function (it, i) {
        var added = have.indexOf(it.shortCode) >= 0;
        return '<li role="option" data-i="' + i + '" class="' + (added ? 'added' : '') + (i === active ? ' active' : '') + '">' +
          '<span class="lk-code">' + esc(it.shortCode) + '</span>' +
          '<span class="lk-name">' + esc(it.name) + '</span>' +
          '<span class="lk-mkt">' + esc(it.market) + '</span>' +
          '<span class="lk-state">' + (added ? '追加済み' : '') + '</span></li>';
      }).join('');
      if (items.length === 0) foot.textContent = '一致する銘柄はありません';
      else if (total > items.length) foot.textContent = total + '件のうち先頭' + items.length + '件';
      else foot.textContent = total + '件';
      pop.hidden = false;
    }

    function query() {
      var q = input.value.trim();
      var my = ++seq;
      if (!q) { items = []; close(); return; }
      fetch('/api/stock-lookup?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); })
        .then(function (j) {
          if (my !== seq) return; // 後から打った分の結果が先に来ていたら捨てる
          items = j.items || [];
          active = items.length ? 0 : -1;
          lastTotal = j.total || 0;
          render();
        })
        .catch(function (e) {
          if (my !== seq) return;
          items = [];
          list.innerHTML = '';
          foot.textContent = '検索できませんでした: ' + e.message;
          pop.hidden = false;
        });
    }

    function pick(i) {
      var it = items[i];
      if (!it) return;
      var have = codesIn(target);
      if (have.indexOf(it.shortCode) < 0) {
        var v = target.value.replace(/[,，、\s]+$/, '');
        target.value = v ? v + ', ' + it.shortCode : it.shortCode;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // 続けて別の銘柄も選べるよう、候補は開いたままにして「追加済み」を付け直す
      active = i;
      render();
      input.focus();
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(query, 150);
    });
    input.addEventListener('focus', function () { if (items.length && input.value.trim()) render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); return; }
      if (pop.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(active < 0 ? 0 : active); }
    });
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li');
      if (!li) return;
      e.preventDefault(); // 入力欄からフォーカスを外さない
      e.stopPropagation(); // pick() で一覧を描き直すと押した li が消え、下の「外側を押したら閉じる」が誤って働くため
      pick(Number(li.getAttribute('data-i')));
    });
    document.addEventListener('mousedown', function (e) { if (!box.contains(e.target)) close(); });
    // 選んだ後に欄を手で書き換えたら、「追加済み」を付け直す
    target.addEventListener('input', function () { if (!pop.hidden && items.length) render(); });
  }

  function init() { Array.prototype.forEach.call(document.querySelectorAll('.lookup[data-target]'), attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
