'use strict';

/*
 * 市場(/market)。1枚の表: 行 = 項目、列 = 前の週の月曜から今日まで。
 * 狭い幅(スマホ)では日付の列を隠し、最新・前回比・期間前比の3列にまとめる。行を押すと日ごとの値が開く。
 * データの意味と列の置き方は src/web/marketQuery.js の冒頭。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  const GROUPS = {
    idx: { title: '指数', note: '米国と日経先物は日本で見られる日の列(現地の前の取引日の終値)' },
    inv: { title: '投資部門別 差引(億円)', note: '東証・名証の合計。公表日の列' },
    mgn: { title: '信用残・裁定残', note: '信用残はプライム・スタンダード・グロースの合計で申込日の列。裁定残は週末時点の列' },
    sect: { title: '33業種の株価指数 前日比(%)', note: '東証業種別株価指数' },
    short: { title: '33業種の空売り比率(%)', note: '' },
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function dayLabel(ymd) {
    const d = new Date(ymd + 'T00:00:00Z');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
  }
  function shortDate(ymd) {
    const d = new Date(ymd + 'T00:00:00Z');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }

  const int = (v) => Math.round(v).toLocaleString('ja-JP');
  const fix = (v, n) => v.toLocaleString('ja-JP', { minimumFractionDigits: n, maximumFractionDigits: n });
  const sign = (v, s) => (v > 0 ? '+' + s : v < 0 ? '-' + s.replace(/^-/, '') : s);

  function signRounded(v, n) {
    const r = Math.round(v * 10 ** n) / 10 ** n;
    return r === 0 ? fix(0, n) : sign(r, fix(Math.abs(r), n));
  }

  /** 列の値の表示 */
  function fmt(v, f) {
    if (v == null) return '';
    switch (f) {
      // 価格は小数があるときだけ小数1桁
      case 'idx': return Number.isInteger(v) ? int(v) : fix(v, 1);
      case 'oku': return int(v);
      case 'signed': return sign(Math.round(v), int(Math.abs(v)));
      case 'ratio': return fix(v, 2);
      case 'pct': return fix(v, 2);
      // 丸めると 0 になる値は符号を付けない(「-0.0」と出さない)
      case 'chgpct': return signRounded(v, 2);
      case 'sigma': return signRounded(v, 1);
      case 'chgpt': return signRounded(v, 2);
      default: return String(v);
    }
  }

  /** 前回比・期間前比の表示。指数は%、空売り比率はpt、ほかは行の単位のまま */
  function fmtDiff(v, row) {
    if (v == null) return '—';
    if (row.fmt === 'idx' || row.fmt === 'chgpct') return sign(v, fix(Math.abs(v), 2)) + '%';
    if (row.fmt === 'pct') return sign(v, fix(Math.abs(v), 2)) + 'pt';
    if (row.fmt === 'ratio') return sign(v, fix(Math.abs(v), 2));
    return sign(Math.round(v), int(Math.abs(v)));
  }

  // 色は指数(33業種の株価指数を含む)の上げ下げにだけ使う(空売り比率などの増減は良し悪しが決まらないため)
  function dirClass(v, row) {
    if ((row.group !== 'idx' && row.group !== 'sect') || v == null) return '';
    return v > 0 ? ' pct up' : v < 0 ? ' pct down' : ' pct flat';
  }

  // 「Zスコア(標準偏差 1.31%)」の括弧の中は、狭い幅では次の行に回す
  function subHtml(sub) {
    // 「(%)」「(pt)」のような短い単位は回さない
    const m = /^(.+?)(\(.{5,}\))$/.exec(sub);
    return m ? `${esc(m[1])}<span class="sub-note">${esc(m[2])}</span>` : esc(sub);
  }

  // 上げ下げのうすい背景色を付ける行: 指数の前日比の行と、33業種の株価指数(前日比)の行
  const isChgRow = (r) => (r.group === 'idx' && r.kind === 'change') || (r.group === 'sect' && r.kind === 'level');
  function wash(v, strong) {
    if (v == null || v === 0) return '';
    return (v > 0 ? ' wash-up' : ' wash-down') + (strong ? ' strong' : '');
  }

  let data = null;

  function render() {
    const cols = data.columns;
    const baseLabel = data.baseDate ? shortDate(data.baseDate) + '比' : '期間前比';
    const nCols = 2 + cols.length + 3; // 項目名は「名前 | 中身」の2列

    let h = '<thead><tr><th class="c-label" colspan="2">項目</th>';
    for (const c of cols) h += `<th class="num-col c-day">${esc(dayLabel(c.date))}</th>`;
    h += '<th class="num-col c-sum">最新</th><th class="num-col c-sum">前回比</th>' +
      `<th class="num-col c-sum" title="${esc(data.baseDate || '')} の値と比べた変化">${esc(baseLabel)}</th>`;
    h += '</tr></thead><tbody>';

    let group = null;
    data.rows.forEach((r, i) => {
      if (r.group !== group) {
        group = r.group;
        const g = GROUPS[group];
        h += `<tr class="grp"><th colspan="${nCols}">${esc(g.title)}` +
          (g.note ? `<span class="grp-note">${esc(g.note)}</span>` : '') + '</th></tr>';
      }
      const cls = r.kind === 'change' ? 'chg-row' : r.kind === 'sigma' ? 'sg-row' : 'lv-row';
      if (r.sub != null) {
        // 名前は1行目だけ。次の行が同じまとまり(名前が空)なら、名前の列の横線を消して1つに見せる
        const nx = data.rows[i + 1];
        const cont = nx && nx.group === r.group && nx.sub != null && nx.name === '';
        h += `<tr class="${cls}" data-i="${i}"><td class="c-name${cont ? ' nb' : ''}">${esc(r.name)}</td>` +
          `<td class="c-sub">${subHtml(r.sub)}</td>`;
      } else {
        h += `<tr class="${cls}" data-i="${i}"><td class="c-label" colspan="2">${esc(r.label)}</td>`;
      }
      for (const c of r.cells) {
        if (c.v == null) {
          h += c.na
            ? `<td class="num-col c-day na" title="${esc(c.na)}">—</td>`
            : '<td class="num-col c-day"></td>';
        } else {
          const dc = r.kind === 'change' || r.kind === 'sigma' || r.group === 'sect' ? dirClass(c.v, r) : '';
          const t = c.title ? ` title="${esc(c.title)}"` : '';
          // 指数・33業種の前日比は上げ下げにうすい背景色(Zスコアの絶対値が2以上なら濃く)。空売り比率の前日差は辛子色
          const bg = isChgRow(r) ? wash(c.v, c.hi) : (c.hi ? ' hi' : '');
          h += `<td class="num-col c-day${dc}${bg}"${t}>${esc(fmt(c.v, r.fmt))}</td>`;
        }
      }
      if (r.kind === 'level') {
        const latestTitle = r.latestDate ? ` title="${esc(dayLabel(r.latestDate))} の値"` : '';
        // Zスコアの絶対値が2以上の最新日は、前日比にあたるセル(業種は「最新」、指数と空売り比率は「前回比」)を背景色で強調
        //   指数と33業種は、前日比・期間前比にあたるセルに上げ下げのうすい背景色(2以上は濃く)
        const bgLatest = r.group === 'sect' ? wash(r.latest, r.latestHi) : '';
        const bgPrev = r.group === 'idx' ? wash(r.prevDiff, r.latestHi) : (r.group === 'short' && r.latestHi ? ' hi' : '');
        const bgBase = r.group === 'idx' || r.group === 'sect' ? wash(r.baseDiff, false) : '';
        h += `<td class="num-col c-sum${r.group === 'sect' ? dirClass(r.latest, r) : ''}${bgLatest}"${latestTitle}>${r.latest == null ? '—' : esc(fmt(r.latest, r.fmt))}</td>` +
          `<td class="num-col c-sum${dirClass(r.prevDiff, r)}${bgPrev}">${esc(fmtDiff(r.prevDiff, r))}</td>` +
          `<td class="num-col c-sum${dirClass(r.baseDiff, r)}${bgBase}">${esc(fmtDiff(r.baseDiff, r))}</td>`;
      } else if (r.kind === 'sigma') {
        const latestTitle = r.latestDate ? ` title="${esc(dayLabel(r.latestDate))} の値"` : '';
        h += `<td class="num-col c-sum${dirClass(r.latest, r)}"${latestTitle}>` +
          `${r.latest == null ? '—' : esc(fmt(r.latest, r.fmt))}</td><td class="c-sum"></td><td class="c-sum"></td>`;
      } else {
        h += '<td class="c-sum"></td><td class="c-sum"></td><td class="c-sum"></td>';
      }
      h += '</tr>';
    });
    h += '</tbody>';
    $('marketTable').innerHTML = h;
  }

  /** 狭い幅で行を押したときの、日ごとの値 */
  function detailHtml(r) {
    const chg = data.rows.find((x) => x.key === r.key + '_chg' || (r.key === 'arb' && x.key === 'arb_wow'));
    let h = '<div class="day-list">';
    data.columns.forEach((c, i) => {
      const cell = r.cells[i];
      if (cell.v == null && !cell.na) return; // 週次の公表の無い日・今日のまだ出ていない値
      let sub = '';
      if (chg && chg.cells[i].v != null) {
        sub = r.group === 'idx' ? fmt(chg.cells[i].v, 'chgpct') + '%'
          : r.group === 'short' ? '前日差 ' + fmt(chg.cells[i].v, 'chgpt') + 'pt'
          : '前週比 ' + fmt(chg.cells[i].v, 'signed');
      }
      if (cell.title) sub = (sub ? sub + ' ' : '') + cell.title;
      h += `<div><span class="dl-date">${esc(dayLabel(c.date))}</span>` +
        `<span class="dl-val">${cell.v == null ? '—' : esc(fmt(cell.v, r.fmt))}</span>` +
        (sub ? `<span class="dl-sub">${esc(sub)}</span>` : '') + '</div>';
    });
    return h + '</div>';
  }

  $('marketTable').addEventListener('click', (e) => {
    if (!window.matchMedia('(max-width: 1100px)').matches) return;
    const tr = e.target.closest('tr.lv-row');
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('detail')) {
      next.remove();
      tr.classList.remove('open');
      return;
    }
    const r = data.rows[Number(tr.dataset.i)];
    const d = document.createElement('tr');
    d.className = 'detail';
    d.innerHTML = `<td colspan="${2 + data.columns.length + 3}">${detailHtml(r)}</td>`;
    tr.after(d);
    tr.classList.add('open');
  });

  // 表の見出しを上部バーのすぐ下で止める(上部バーは幅によって2段になる)
  function syncTopbar() {
    const h = document.querySelector('.topbar').offsetHeight;
    document.documentElement.style.setProperty('--topbar-h', h + 'px');
  }
  window.addEventListener('resize', syncTopbar);
  syncTopbar();

  function hhmm(iso) {
    const d = new Date(iso);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  fetch('/api/market')
    .then((res) => res.json().then((body) => {
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    }))
    .then((body) => {
      data = body;
      $('periodTitle').textContent = `${shortDate(body.from)}〜${shortDate(body.today)}`;
      $('dataMeta').textContent = `米国・日経先物は ${hhmm(body.fetchedAt)} に取得`;
      if (body.errors && body.errors.length) {
        $('flash').textContent = body.errors.join(' / ');
        $('flash').hidden = false;
      }
      render();
      syncTopbar();
    })
    .catch((err) => {
      $('dataMeta').textContent = '';
      $('flash').textContent = '読み込めませんでした: ' + err.message;
      $('flash').hidden = false;
    });
})();
