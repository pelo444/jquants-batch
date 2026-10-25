'use strict';

/*
 * 材料(/events)。縦長の月間カレンダー: 1か月 = 1つの表、行 = 毎日(土日も)、列 = 数字、右端 = 備考。
 * 月も日も新しいものを上に。日付は米国の日付。データの意味は src/web/eventsQuery.js の冒頭。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fix = (v, n) => v.toLocaleString('ja-JP', { minimumFractionDigits: n, maximumFractionDigits: n });
  // 丸めると 0 になる値は符号を付けない(「-0」と出さない)
  function signed(v, n) {
    const r = Math.round(v * 10 ** n) / 10 ** n;
    if (r === 0) return fix(0, n);
    return (r > 0 ? '+' : '−') + fix(Math.abs(r), n);
  }

  function dayLabel(ymd) {
    const d = new Date(ymd + 'T00:00:00Z');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
  }

  function chgUnit(c) { return c.chg; } // bp / % / pt / 円
  function chgText(c, v) {
    if (v == null) return '';
    return c.chg === 'bp' ? signed(v, 0) : signed(v, 2);
  }

  function numCell(c, x) {
    if (!x) return '<td class="num-col"></td>';
    return `<td class="num-col"><div>${fix(x.v, c.dec)}</div><div class="chg">${chgText(c, x.chg)}</div></td>`;
  }

  function cpiCell(cpi) {
    if (!cpi) return '<td class="c-cpi"></td>';
    const y = cpi.yoy == null ? '—' : fix(cpi.yoy, 2) + '%';
    const m = cpi.mom == null ? '—' : signed(cpi.mom, 2) + '%';
    return `<td class="c-cpi">${cpi.refMonth}月分<div>前年比 ${y}</div><div>前月比 ${m}</div></td>`;
  }

  function notesCell(notes) {
    const html = notes.map((n) => {
      if (n.kind === 'filing') {
        return `<div class="note"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.label)}</a></div>`;
      }
      // recap(東京の日次概況)
      return `<div class="note"><span class="n-label">${esc(n.label)}</span>` +
        `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>` +
        `<span class="n-src">${esc(n.source || '')}</span></div>`;
    }).join('');
    return `<td class="c-notes">${html}</td>`;
  }

  function monthTable(cols, m) {
    const [y, mo] = m.ym.split('-').map(Number);
    const head = '<tr><th class="c-date">日付</th>' +
      cols.map((c) => `<th class="num-col">${esc(c.label)}<span class="unit">${esc(c.unit)} / 前日差 ${chgUnit(c)}</span></th>`).join('') +
      '<th class="c-cpi">CPI</th><th class="c-notes">備考</th></tr>';
    const body = m.days.map((d) =>
      `<tr${d.weekend ? ' class="wkend"' : ''}><td class="c-date">${dayLabel(d.date)}</td>` +
      d.values.map((x, i) => numCell(cols[i], x)).join('') +
      cpiCell(d.cpi) + notesCell(d.notes) + '</tr>').join('');
    return `<section class="panel events-month"><h2 class="panel-title">${y}年${mo}月</h2>` +
      `<div class="table-wrap events-wrap"><table class="events-table"><thead>${head}</thead><tbody>${body}</tbody></table></div></section>`;
  }

  // DB の時刻(協定世界時)を日本時間に直す
  function jst(s) {
    if (!s) return null;
    const d = new Date(s.replace(' ', 'T') + ':00Z');
    if (Number.isNaN(d.getTime())) return s;
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  }

  // 取得元と更新の時刻の表。日本時間の目安は、今日の夏時間・冬時間で計算したもの(src/eventSchedule.js)
  function sourcesTable(rows) {
    const head = '<thead><tr><th>No</th><th>データ</th><th>取得元</th><th>元のサイトの更新</th>' +
      '<th>日本時間の目安(対象日から)</th><th>DB の最新の日付</th><th>その日の分が初めて入った時刻</th><th>時刻の根拠</th></tr></thead>';
    const body = (rows || []).map((r) =>
      `<tr><td class="num-col">${r.no}</td><td>${esc(r.label)}</td><td>${esc(r.source)}</td><td>${esc(r.original)}</td>` +
      `<td>${esc(r.jst)}</td><td>${r.latestDate ? dayLabel(r.latestDate) : '—'}</td>` +
      `<td>${r.firstLoadedAt ? esc(jst(r.firstLoadedAt)) : '—'}</td><td class="basis">${esc(r.basis)}</td></tr>`).join('');
    return head + `<tbody>${body}</tbody>`;
  }

  function render(data) {
    $('sourcesTable').innerHTML = sourcesTable(data.schedule);
    $('months').innerHTML = data.months.map((m) => monthTable(data.columns, m)).join('');
    const parts = ['日付は米国の日付(日本の金利と東京の概況は日本の日付)'];
    if (data.loadedAt) parts.push(`数字の取込 ${jst(data.loadedAt)}`);
    $('dataMeta').textContent = parts.join(' / ');
    $('fromMonth').value = data.period.from;
    $('toMonth').value = data.period.to;
  }

  async function load(from, to) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    try {
      const res = await fetch('/api/events' + (qs.toString() ? '?' + qs : ''));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $('flash').hidden = true;
      render(await res.json());
    } catch (err) {
      $('flash').textContent = `読み込めませんでした: ${err.message}`;
      $('flash').hidden = false;
      $('dataMeta').textContent = '';
    }
  }

  $('periodForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = $('fromMonth').value;
    const to = $('toMonth').value;
    history.replaceState(null, '', `/events?from=${from}&to=${to}`);
    load(from, to);
  });

  const p = new URLSearchParams(location.search);
  load(p.get('from'), p.get('to'));
})();
