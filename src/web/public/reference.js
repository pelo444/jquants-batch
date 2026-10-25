'use strict';

/*
 * 参考情報(/reference)。テーマをプルダウンで選び、「表示」で1枚の表を出す。
 * テーマの中身と決めごとは src/web/referenceQuery.js の冒頭。条件は URL に残す(開き直すと同じ表が出る)。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  let meta = null;
  let dateTouched = false; // 日付を自分で変えたか(変えていなければ、テーマに合わせて初期値を入れ替える)

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fix = (v, n) => Number(v).toLocaleString('ja-JP', { minimumFractionDigits: n, maximumFractionDigits: n });
  function pct(v) {
    if (v == null) return '—';
    const r = Math.round(v * 100) / 100;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + fix(Math.abs(r), 2) + '%';
  }
  const pctCls = (v) => (v > 0 ? 'pct up' : v < 0 ? 'pct down' : 'pct flat');
  function dayLabel(ymd) {
    const d = new Date(ymd + 'T00:00:00Z');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
  }
  // 銘柄コードは4桁で出し、株予報Proのアナリスト予想へのリンクにする(騰落率一覧と同じ)
  function short(code) { return code && code.length === 5 && code[4] === '0' ? code.slice(0, 4) : code; }
  function codeCell(code) {
    const c = short(code);
    return `<td class="code"><a class="ifis" href="https://kabuyoho.jp/reportAnalyst?bcode=${encodeURIComponent(c)}"` +
      ` target="_blank" rel="noopener noreferrer" title="株予報Proのアナリスト予想を開く">${esc(c)}</a></td>`;
  }
  const tv = (v) => (v == null ? '—' : fix(v, 1));
  const close = (v) => (v == null ? '—' : fix(v, v % 1 ? 1 : 0));

  function todayJst() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function themeKind() {
    const t = meta.themes.find((x) => x.key === $('theme').value);
    return t ? t.kind : 'sector';
  }

  // テーマに合わせて、使うオプションだけを出す
  function syncOptions() {
    const kind = themeKind();
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(kind); });
    // 決算発表の予定は「今日以降」、ほかは最新の営業日が初期値
    if (!dateTouched) $('date').value = kind === 'schedule' ? todayJst() : (meta.latestDate || '');
    renderRecent();
  }

  // 業種のテーマ: 直近で TOPIX が下げた(上げた)日を押すと、その日を日付に入れる
  function renderRecent() {
    if (!meta || themeKind() !== 'sector') return;
    const down = $('theme').value === 'down_up_sectors';
    const days = meta.recentTopix.filter((d) => (down ? d.chg < 0 : d.chg > 0)).slice(0, 8);
    $('recentLabel').textContent = `直近で TOPIX が${down ? '下げた' : '上げた'}日:`;
    $('recentChips').innerHTML = days.length
      ? days.map((d) => `<button class="chip" type="button" data-date="${d.date}">${dayLabel(d.date)} ${pct(d.chg)}</button>`).join('')
      : '<span class="unit">直近20営業日にありません</span>';
  }

  function selectedSectors() {
    return Array.from(document.querySelectorAll('.seccb:checked')).map((c) => c.value);
  }
  function updateSectorSummary() {
    const s = selectedSectors();
    const names = new Map(meta.sectors.map((x) => [x.code, x.name]));
    $('sectorSummary').textContent = s.length === 0 ? 'すべて'
      : s.slice(0, 4).map((c) => names.get(c) || c).join('・') + (s.length > 4 ? ` ほか${s.length - 4}` : '');
  }

  //---------------------------------------------------------------- 表
  function sectorTable(d) {
    const nCols = 7;
    let h = '<thead><tr><th class="num-col">順位</th><th>コード</th><th>企業名</th>' +
      '<th class="num-col">前日比</th><th class="num-col">終値</th><th class="num-col">売買代金(億円)</th><th></th></tr></thead><tbody>';
    if (!d.groups.length) {
      h += `<tr class="none"><td colspan="${nCols}">該当する業種がありません</td></tr>`;
    }
    for (const g of d.groups) {
      h += `<tr class="grp"><th colspan="${nCols}">${esc(g.name)} <span class="${pctCls(g.chg)}">${pct(g.chg)}</span>` +
        `<span class="grp-note">業種内 上昇 ${g.up} / 下落 ${g.down}${g.flat ? ' / 変わらず ' + g.flat : ''} 銘柄</span></th></tr>`;
      if (!g.stocks.length) {
        h += `<tr class="none"><td colspan="${nCols}">売買代金の下限を満たす銘柄がありません</td></tr>`;
      }
      g.stocks.forEach((s, i) => {
        h += `<tr><td class="num-col rank">${i + 1}</td>${codeCell(s.code)}<td class="name">${esc(s.name)}</td>` +
          `<td class="num-col ${pctCls(s.chg)}">${pct(s.chg)}</td><td class="num-col">${close(s.close)}</td>` +
          `<td class="num-col">${tv(s.tvOku)}</td><td></td></tr>`;
      });
    }
    return h + '</tbody>';
  }

  function streakTable(d) {
    let h = '<thead><tr><th class="num-col">順位</th><th>コード</th><th>企業名</th><th>33業種</th>' +
      '<th class="num-col">連続日数</th><th>始まり</th><th class="num-col">その間の騰落率</th>' +
      '<th class="num-col">終値</th><th class="num-col">売買代金(億円)</th></tr></thead><tbody>';
    if (!d.rows.length) h += '<tr class="none"><td colspan="9">該当する銘柄がありません</td></tr>';
    d.rows.forEach((r, i) => {
      h += `<tr><td class="num-col rank">${i + 1}</td>${codeCell(r.code)}<td class="name">${esc(r.name)}</td>` +
        `<td class="dim">${esc(r.sector33)}</td><td class="num-col">${r.streak}${r.capped ? '以上' : ''}</td>` +
        `<td>${r.startDate ? dayLabel(r.startDate) : ''}</td><td class="num-col ${pctCls(r.chg)}">${pct(r.chg)}</td>` +
        `<td class="num-col">${close(r.close)}</td><td class="num-col">${tv(r.tvOku)}</td></tr>`;
    });
    return h + '</tbody>';
  }

  function scheduleTable(d) {
    const nCols = 9;
    let h = '<thead><tr><th>コード</th><th>企業名</th><th>決算</th><th>決算期</th><th>33業種</th><th>市場</th>' +
      '<th class="num-col" title="最新の営業日の売買代金">売買代金(億円)</th><th>予定の公表日</th><th>予定の変更</th></tr></thead><tbody>';
    if (!d.rows.length) h += `<tr class="none"><td colspan="${nCols}">該当する予定がありません</td></tr>`;
    let cur;
    const count = new Map();
    d.rows.forEach((r) => count.set(r.date, (count.get(r.date) || 0) + 1));
    for (const r of d.rows) {
      if (r.date !== cur) {
        cur = r.date;
        h += `<tr class="grp"><th colspan="${nCols}">${r.date ? dayLabel(r.date) : '日付未定'}` +
          `<span class="grp-note">${count.get(r.date)}社</span></th></tr>`;
      }
      const chg = r.changed ? `<td class="changed">${r.prevDate ? dayLabel(r.prevDate) : '未定'} から変更</td>` : '<td></td>';
      h += `<tr>${codeCell(r.code)}<td class="name">${esc(r.name)}</td><td>${esc(r.fqLabel)}</td>` +
        `<td class="dim">${r.fyeMonth ? r.fyeMonth + '月期' : ''}</td><td class="dim">${esc(r.sector33)}</td>` +
        `<td class="dim">${esc(r.market || '')}</td><td class="num-col">${tv(r.tvOku)}</td>` +
        `<td class="dim">${r.pubDate ? dayLabel(r.pubDate) : ''}</td>${chg}</tr>`;
    }
    return h + '</tbody>';
  }

  function render(d) {
    $('empty').hidden = true;
    $('resultPane').hidden = false;
    const t = meta.themes.find((x) => x.key === d.theme);
    let title = `${t ? t.label : ''}` + (d.kind !== 'schedule' && d.day ? `　${dayLabel(d.day)}` : '');
    if (d.kind === 'sector' && d.topixChg != null) title += `　TOPIX ${pct(d.topixChg)}`;
    $('resultTitle').innerHTML = esc(title) + `<span class="h2-note">${esc(conditionText(d))}</span>`;
    $('notice').hidden = !(d.notice && d.notice.length);
    $('notice').textContent = (d.notice || []).join(' / ');
    if (d.empty) { $('refTable').innerHTML = ''; $('resultNote').textContent = ''; return; }
    $('refTable').innerHTML = d.kind === 'sector' ? sectorTable(d) : d.kind === 'streak' ? streakTable(d) : scheduleTable(d);
    $('resultNote').textContent = d.kind === 'schedule'
      ? `J-Quants の決算発表予定日(銘柄×決算区分で最新の公表)。日付の中は売買代金の大きい順。${d.rows.length}件。` +
        '「予定の変更」は、前の公表(120日以内)から予定日が変わったもの'
      : d.kind === 'sector'
      ? `業種の前日比は東証業種別指数(${dayLabel(d.prev)}→${dayLabel(d.day)})。銘柄の前日比は分割を調整済み。ETF・REIT等・上場廃止は除外`
      : `毎日の終値が前日(分割調整後)より${d.theme === 'up_streak' ? '高い' : '低い'}日が、指定日まで続いている銘柄。変わらずは途切れ扱い。` +
        `遡るのは${d.window}営業日まで。「その間の騰落率」は始まりの前日の終値からの変化。${d.rows.length}銘柄`;
  }

  function conditionText(d) {
    const p = d.params;
    const parts = [];
    if (d.kind === 'sector') parts.push(`業種ごと上位${p.n}`);
    else if (d.kind === 'streak') parts.push(`${p.minStreak}日以上`);
    else parts.push(`${dayLabel(p.date)} 以降` + (p.includeTbd ? '・日付未定を含む' : ''));
    if (d.kind !== 'schedule') parts.push(`売買代金 ${p.minTv}億円以上`);
    if (p.sectors.length) {
      const names = new Map(meta.sectors.map((x) => [x.code, x.name]));
      parts.push('業種: ' + p.sectors.map((c) => names.get(c) || c).join('・'));
    }
    return parts.join(' ・ ');
  }

  //---------------------------------------------------------------- 取得
  function params() {
    const q = new URLSearchParams();
    q.set('theme', $('theme').value);
    if ($('date').value) q.set('date', $('date').value);
    const kind = themeKind();
    if (kind === 'sector') q.set('n', $('n').value || '5');
    else if (kind === 'streak') q.set('minStreak', $('minStreak').value || '5');
    if (kind !== 'schedule') q.set('minTv', $('minTv').value === '' ? '0' : $('minTv').value);
    else if ($('includeTbd').checked) q.set('includeTbd', '1');
    const s = selectedSectors();
    if (s.length) q.set('sectors', s.join(','));
    return q;
  }

  async function run() {
    const q = params();
    history.replaceState(null, '', '/reference?' + q);
    $('runBtn').disabled = true;
    $('status').textContent = '取得中…';
    $('flash').hidden = true;
    try {
      const res = await fetch('/api/reference?' + q);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      render(j);
      $('status').textContent = '';
    } catch (err) {
      $('status').textContent = '';
      $('flash').textContent = `読み込めませんでした: ${err.message}`;
      $('flash').hidden = false;
    } finally {
      $('runBtn').disabled = false;
    }
  }

  //---------------------------------------------------------------- 初期化
  async function init() {
    try {
      const res = await fetch('/api/reference/meta');
      meta = await res.json();
      if (!res.ok) throw new Error(meta.error || `HTTP ${res.status}`);
    } catch (err) {
      $('dataMeta').textContent = '接続エラー';
      $('flash').textContent = `読み込めませんでした: ${err.message}`;
      $('flash').hidden = false;
      return;
    }
    $('dataMeta').textContent = `最新の営業日: ${meta.latestDate ? dayLabel(meta.latestDate) : '—'}`;
    $('theme').innerHTML = meta.themes.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('');
    $('sectorBox').innerHTML = meta.sectors.map((s) =>
      `<label class="sector-item"><input type="checkbox" class="seccb" value="${esc(s.code)}"><span>${esc(s.name)}</span></label>`).join('');
    $('date').value = meta.latestDate || '';

    // URL の条件を戻す。テーマがあればそのまま表示する
    const u = new URLSearchParams(location.search);
    if (u.get('theme') && meta.themes.some((t) => t.key === u.get('theme'))) $('theme').value = u.get('theme');
    if (u.get('includeTbd') === '1') $('includeTbd').checked = true;
    if (u.get('n')) $('n').value = u.get('n');
    if (u.get('minStreak')) $('minStreak').value = u.get('minStreak');
    if (u.get('minTv') !== null) $('minTv').value = u.get('minTv');
    if (u.get('sectors')) {
      const set = new Set(u.get('sectors').split(','));
      document.querySelectorAll('.seccb').forEach((c) => { c.checked = set.has(c.value); });
    }
    updateSectorSummary();
    syncOptions();
    if (u.get('date')) { $('date').value = u.get('date'); dateTouched = true; }
    if (u.get('theme')) run();
  }

  $('refForm').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  $('theme').addEventListener('change', syncOptions);
  $('date').addEventListener('change', () => { dateTouched = true; });
  $('recentChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (b) { $('date').value = b.dataset.date; dateTouched = true; }
  });
  $('sectorBox').addEventListener('change', updateSectorSummary);
  $('sectorAll').addEventListener('click', () => {
    document.querySelectorAll('.seccb').forEach((c) => { c.checked = false; });
    updateSectorSummary();
  });

  init();
})();
