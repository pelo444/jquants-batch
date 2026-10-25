'use strict';

/*
 * 日々の確認(/daily)。保有・ウォッチ・検討中の銘柄の出来事と値動き、これからの予定。
 * 期間は前回「確認した」日時から今まで(日付を選んでその日からにもできる)。
 * データの意味は src/web/dailyQuery.js の冒頭、設計は claude/daily_page_design.md。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const shortJst = (jst) => jst.replace(/^\d{4}-(\d{2})-(\d{2})/, (m, a, b) => `${Number(a)}/${Number(b)}`);
  const code4 = (c) => (c && c.length === 5 && c.endsWith('0') ? c.slice(0, 4) : c);
  function md(ymd) {
    if (!ymd) return '—';
    const d = new Date(ymd + 'T00:00:00Z');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
  }
  const fix = (v, n) => Number(v).toLocaleString('ja-JP', { minimumFractionDigits: n, maximumFractionDigits: n });
  function signed(v, n) {
    if (v == null) return '—';
    const r = Math.round(v * 10 ** n) / 10 ** n;
    if (r === 0) return fix(0, n);
    return (r > 0 ? '+' : '-') + fix(Math.abs(r), n);
  }
  // 会社の規模を表す金額は億円(小数1桁)
  const oku = (v) => (v == null ? '—' : fix(v, 1) + '億円');
  // 価格は小数があるときだけ小数1桁
  const price = (v) => (v == null ? '—' : Number.isInteger(Number(v)) ? Number(v).toLocaleString('ja-JP') : fix(v, 1));
  const pct2 = (v) => (v == null ? '—' : fix(v, 2) + '%');
  const dir = (v) => (v == null ? '' : v > 0 ? ' pct up' : v < 0 ? ' pct down' : '');

  /** 区分の札(保有・ウォッチ・検討) */
  function tags(r) {
    const t = [];
    if (r.held) t.push('<span class="no-tag">保有</span>');
    if (r.watch) t.push('<span class="no-tag">ウォッチ</span>');
    if (r.lists && r.lists.length) t.push(`<span class="no-tag" title="${esc(r.lists.join('、'))}">検討</span>`);
    return t.join('');
  }
  // 銘柄コードは 株予報Pro(IFIS)のその銘柄のアナリスト予想のページへのリンク(数字は取り込まず、開いて見るだけ)
  const ifisUrl = (c) => 'https://kabuyoho.jp/reportAnalyst?bcode=' + encodeURIComponent(code4(c));
  function stock(r) {
    return `<a class="code4 ifis" href="${esc(ifisUrl(r.code))}" target="_blank" rel="noopener noreferrer" title="株予報Proのアナリスト予想を開く">${esc(code4(r.code))}</a>${esc(r.name || '')}`;
  }

  //---------------------------------------------------------------- 出来事の中身
  const CHG = { up: '上方', down: '下方', same: '据え置き' };
  function forecastText(e) {
    if (e.forecast == null) return `${e.forecastLabel} —`;
    let s = `${e.forecastLabel} ${oku(e.forecast)}`;
    if (e.forecastPrev != null) s += `(前回 ${oku(e.forecastPrev)}から${CHG[e.forecastChg]})`;
    return s;
  }
  function eventLines(e) {
    switch (e.kind) {
      case 'fin':
        return [
          `営業利益 ${oku(e.op)}` + (e.opGrowth != null ? `(前年同期比 ${signed(e.opGrowth, 1)}%)` : ''),
          forecastText(e),
        ];
      case 'rev':
        return [e.forecastPrev != null
          ? `営業利益予想 ${oku(e.forecastPrev)} → ${oku(e.forecast)}(${CHG[e.forecastChg]})`
          : `営業利益予想 ${oku(e.forecast)}`];
      case 'div': {
        const yen = (v) => (v == null ? '—' : fix(v, Number.isInteger(Number(v)) ? 0 : 2) + '円');
        const word = { up: '増配', down: '減配', same: '据え置き' }[e.divChg];
        return [e.divPrev != null ? `年間配当予想 ${yen(e.divPrev)} → ${yen(e.div)}(${word})` : `年間配当予想 ${yen(e.div)}`];
      }
      case 'lvs': {
        const D = {
          new: '新規',
          up: `前回 ${pct2(e.last)}から増えた`,
          down: `前回 ${pct2(e.last)}から減った`,
          same: '前回と同じ',
          below5: e.last != null ? `5%未満に(前回 ${pct2(e.last)})` : '5%未満に',
          noratio: '割合の記載なし',
        };
        return [`提出者 ${e.filer || '—'}`, `保有割合 ${pct2(e.ratio)}` + (e.dir && e.dir !== 'noratio' ? `(${D[e.dir]})` : e.dir === 'noratio' ? `(${D.noratio})` : '')];
      }
      case 'short':
        return e.items.map((x) => `${x.reporter || '—'}${x.fund ? '(' + x.fund + ')' : ''} ${pct2(x.ratio)}`
          + (x.last != null ? `(前回 ${pct2(x.last)})` : '(前回なし)'));
      case 'alert':
        return [`理由: ${e.reasons.length ? e.reasons.join('、') : '—'}`];
      default:
        return [];
    }
  }

  //---------------------------------------------------------------- 描画
  function renderEvents(d) {
    let h = '<thead><tr><th>公表日</th><th>銘柄</th><th>区分</th><th>種類</th><th>内容</th></tr></thead><tbody>';
    if (!d.events.length) {
      h += '<tr class="empty-row"><td colspan="5">この期間に入った出来事はありません</td></tr>';
    }
    for (const e of d.events) {
      h += `<tr><td data-label="公表日">${esc(md(e.date))}</td>` +
        `<td class="stock" data-label="銘柄">${stock(e)}</td>` +
        `<td class="tags-cell" data-label="区分">${tags(e)}</td>` +
        `<td data-label="種類">${esc(e.type)}</td>` +
        `<td class="content" data-label="内容"><div>${eventLines(e).map((l) => `<div class="line">${esc(l)}</div>`).join('')}</div></td></tr>`;
    }
    $('evTable').innerHTML = h + '</tbody>';
    $('evTitle').textContent = `出来事(${d.events.length}件)`;
  }

  /** 信用残の要確認の印(marginCheck.js。文言は title に入れる) */
  function warnMark(w) {
    return w ? '<span class="sym-warn" aria-label="要確認">⚠</span>' : '';
  }

  /** 信用残の前日比のセルの説明: 何日と何日の比較か + 要確認の文言 */
  function marginTitle(m) {
    if (!m.marginDate) return '';
    const base = m.marginPrevDate ? `${md(m.marginPrevDate)} → ${md(m.marginDate)} 申込分` : md(m.marginDate) + ' 申込分';
    return m.marginWarn ? base + '。' + m.marginWarn : base;
  }

  function renderMoves(d) {
    const cols = [
      ['銘柄'], ['区分'], ['出来事(件)', 'num-col'], ['終値', 'num-col'], ['騰落率(%)', 'num-col'],
      ['TOPIXとの差(pt)', 'num-col'], ['出来高(倍)', 'num-col'],
      ['信用買残 前日比(%)', 'num-col'], ['信用売残 前日比(%)', 'num-col'], ['信用倍率(倍)', 'num-col'],
    ];
    let h = '<thead><tr>' + cols.map(([l, c]) => `<th${c ? ` class="${c}"` : ''}>${esc(l)}</th>`).join('') + '</tr></thead><tbody>';
    for (const m of d.moves) {
      const cell = (label, v, cls = 'num-col', title = '') =>
        `<td class="${cls}" data-label="${esc(label)}"${title ? ` title="${esc(title)}"` : ''}>${v}</td>`;
      h += '<tr>' +
        `<td class="stock" data-label="銘柄">${stock(m)}</td>` +
        `<td class="tags-cell" data-label="区分">${tags(m)}</td>` +
        cell('出来事(件)', m.events) +
        cell('終値', esc(price(m.close)), 'num-col', m.closeDate ? md(m.closeDate) + ' の終値' : '') +
        cell('騰落率(%)', esc(signed(m.ret, 2)), 'num-col' + dir(m.ret)) +
        cell('TOPIXとの差(pt)', esc(signed(m.vsTopix, 2)), 'num-col' + dir(m.vsTopix)) +
        cell('出来高(倍)', m.volRatio == null ? '—' : esc(fix(m.volRatio, 2)), 'num-col', '最新日の出来高 ÷ 直前25営業日の平均') +
        cell('信用買残 前日比(%)', warnMark(m.marginWarn) + esc(signed(m.longChg, 1)), 'num-col' + (m.marginWarn ? ' mwarn' : ''), marginTitle(m)) +
        cell('信用売残 前日比(%)', warnMark(m.marginWarn) + esc(signed(m.shortChg, 1)), 'num-col' + (m.marginWarn ? ' mwarn' : ''), marginTitle(m)) +
        cell('信用倍率(倍)', warnMark(m.marginWarn) + (m.marginRatio == null ? '—' : esc(fix(m.marginRatio, 2))), 'num-col' + (m.marginWarn ? ' mwarn' : ''), m.marginWarn || '') +
        '</tr>';
    }
    if (!d.moves.length) h += '<tr class="empty-row"><td colspan="10">対象の銘柄がありません</td></tr>';
    $('mvTable').innerHTML = h + '</tbody>';
    $('mvTitle').textContent = `値動き ${md(d.baseDate)} → ${md(d.latestDate)} の終値`;
  }

  function renderUpcoming(d) {
    const u = d.upcoming;
    let h = '<thead><tr><th>日付</th><th>銘柄</th><th>区分</th><th>予定</th><th>内容</th></tr></thead><tbody>';
    if (!u.items.length) h += '<tr class="empty-row"><td colspan="5">この期間の予定はありません</td></tr>';
    for (const x of u.items) {
      h += `<tr><td data-label="日付">${esc(md(x.date))}</td>` +
        `<td class="stock" data-label="銘柄">${stock(x)}</td>` +
        `<td class="tags-cell" data-label="区分">${tags(x)}</td>` +
        `<td data-label="予定">${esc(x.type)}</td>` +
        `<td data-label="内容">${esc(x.detail || '')}</td></tr>`;
    }
    $('upTable').innerHTML = h + '</tbody>';
    $('upTitle').textContent = `これからの予定(${md(d.today)}〜${md(u.until)})`;
  }

  /** @param {string} [untilJst] 過去の確認を開いているとき、その確認の日時(「今」の代わりに出す) */
  function renderPeriod(d, untilJst) {
    const until = untilJst ? shortJst(untilJst) : '今';
    let t;
    if (d.mode === 'seen') t = `前回確認 ${shortJst(d.seen.jst)} → ${until}`;
    else if (d.mode === 'date') t = `${md(d.fromDate)} から${untilJst ? ' ' + until + ' まで' : '今まで'}`;
    else t = `直近の営業日 ${md(d.fromDate)} の分` + (untilJst ? '' : '(まだ「確認した」を押したことがありません)');
    $('periodText').textContent = t;
    const dd = d.dataDates;
    $('dataDates').textContent = `データの最新日: 株価 ${md(dd.price)}・決算 ${md(dd.fin)}・大量保有 ${md(dd.lvs)}・` +
      `空売り報告 ${md(dd.short)}・日々公表 ${md(dd.alert)}・信用残 ${md(dd.margin)}`;
    $('sinceBtn').hidden = d.mode !== 'date';
    // 信用残の要確認(最新の申込日が marginCheck.js の jump のとき)
    $('notice').textContent = d.marginNotice ? '⚠ ' + d.marginNotice : '';
    $('notice').hidden = !d.marginNotice;
    if (d.seenTableMissing) flash('確認した日時の表がありません。ddl/32_daily_seen.sql を GD_JQUANTS で流してください', true);
    $('dataMeta').textContent = `対象 ${d.targets.length}銘柄`;
  }

  function flash(msg, isError) {
    const f = $('flash');
    f.textContent = msg;
    f.classList.toggle('error', Boolean(isError));
    f.hidden = false;
  }

  // 今の画面の内容(GET /api/daily の結果)。「確認した」を押すとこれをそのまま残す
  let current = null;

  function renderAll(d, untilJst) {
    renderPeriod(d, untilJst);
    renderEvents(d);
    renderMoves(d);
    renderUpcoming(d);
  }

  /** 過去の確認を開いているかどうかで、帯・ボタンを切り替える */
  function setHistoryView(jst) {
    $('histBanner').hidden = !jst;
    $('histText').textContent = jst ? `${shortJst(jst)} に確認した内容です` : '';
    $('seenBtn').disabled = Boolean(jst);
    $('fromBtn').disabled = Boolean(jst);
    if (!jst) $('histSel').value = '';
  }

  async function load(date) {
    $('flash').hidden = true;
    try {
      const res = await fetch('/api/daily' + (date ? '?date=' + encodeURIComponent(date) : ''));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      current = body;
      setHistoryView(null);
      renderAll(body);
    } catch (err) {
      flash('読み込めませんでした: ' + err.message, true);
    }
  }

  async function loadHistoryList() {
    try {
      const res = await fetch('/api/daily/history');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      const sel = $('histSel');
      const keep = sel.value;
      sel.innerHTML = '<option value="">—</option>' + body.rows.map((r) =>
        `<option value="${r.id}"${r.hasPayload ? '' : ' disabled'}>${esc(shortJst(r.jst))}${r.hasPayload ? '' : '(内容なし)'}</option>`).join('');
      sel.value = keep;
    } catch (err) {
      // 一覧が取れなくても今の画面は使えるので、知らせるだけにする
      flash('過去の確認の一覧を読み込めませんでした: ' + err.message, true);
    }
  }

  async function openHistory(id) {
    $('flash').hidden = true;
    try {
      const res = await fetch('/api/daily/history/' + encodeURIComponent(id));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      renderAll(body.payload, body.jst);
      setHistoryView(body.jst);
      window.scrollTo(0, 0);
    } catch (err) {
      flash('開けませんでした: ' + err.message, true);
    }
  }

  $('histSel').addEventListener('change', () => {
    const v = $('histSel').value;
    if (v) openHistory(v);
    else if (current) { setHistoryView(null); renderAll(current); }
  });
  $('histBack').addEventListener('click', () => {
    setHistoryView(null);
    if (current) renderAll(current);
  });

  $('fromBtn').addEventListener('click', () => {
    const v = $('fromDate').value;
    if (v) load(v);
  });
  $('sinceBtn').addEventListener('click', () => { $('fromDate').value = ''; load(null); });

  $('seenBtn').addEventListener('click', async () => {
    $('seenBtn').disabled = true;
    try {
      if (!current) throw new Error('画面の内容がまだ読み込まれていません');
      const res = await fetch('/api/daily/seen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: current }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      // 画面はそのまま残し、次に開いたときの始まりだけ変わる
      const when = body.seen ? shortJst(body.seen.jst) : '';
      flash(body.payloadSaved
        ? `確認した日時と画面の内容を残しました(${when})。次はここからの分を出します`
        : `確認した日時を残しました(${when})。画面の内容は残せませんでした。ddl/33_daily_seen_payload.sql を GD_JQUANTS で流してください`,
      !body.payloadSaved);
      loadHistoryList();
    } catch (err) {
      flash('残せませんでした: ' + err.message, true);
    } finally {
      $('seenBtn').disabled = false;
    }
  });

  load(null);
  loadHistoryList();
})();
