'use strict';

/**
 * 需給3階層 (/demand) のフロントエンド。依存ライブラリなし。
 *
 * ============================================================
 * 【この画面の設計方針 — 表示層でここを潰すと3階層の意味が無くなる】
 *
 *  1. **NULL と 0 を区別する。** 値が無いセルは 0 でも空白でもなく — で出し、
 *     title に「なぜ無いのか」を持たせる。列ごとに理由が違う(NA_NOTE)。
 *  2. **「疑う列」を点灯より目立たせる。** 点灯した行を上から読む前に、
 *     その点灯が信用できるかを先に確かめるための列。枠付きのチップにして左に置く。
 *  3. **大量保有は向きを必ず見せる。** 退出報告でも点灯するので、
 *     LVS_RECENT_SUMMARY を折りたたまず全文を出す。省略しない。
 *  4. **確認順(SIGNAL_SCORE)を煽らない。** 大きいほど良い、という色付けをしない。
 *     列名も「スコア」ではなく「確認順」にしてある。
 *  5. **しきい値を文言に書かない。** params を変えた瞬間に嘘になるため、
 *     ラベルは閾値非依存にし、実際の値はフッターに1箇所だけ出す。
 *
 *  詳細は docs/DEMAND_SIGNAL_RUNBOOK.md の 3章・4章。
 * ============================================================
 */
(function () {
  var meta = null;            // /api/demand/meta
  var P = {};                 // しきい値
  var cache = {};             // タブごとの取得結果
  var state = { tab: 'signal', detailCode: null };

  var $ = function (id) { return document.getElementById(id); };

  //================================================================ 整形
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmt(v, d) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return n.toLocaleString('ja-JP', {
      minimumFractionDigits: d === undefined ? 0 : d,
      maximumFractionDigits: d === undefined ? 0 : d,
    });
  }

  /**
   * 「値が無い」の表示。**0 にしない。空欄にもしない。**
   * どうして無いのかを必ず title に持たせる(列ごとに意味が違う)。
   */
  function na(reason) {
    return '<span class="na" title="' + esc(reason) + '">—</span>';
  }

  /** 列ごとの「無い」の意味。docs/DEMAND_SIGNAL_RUNBOOK.md 4章の表と対応する */
  var NA_NOTE = {
    price: '直近4か月にこの銘柄の株価の行がありません(上場前・売買停止・取込漏れのいずれか)',
    margin: '信用取引残高が公表されていません。営業日が2日以下の週(GW・年末年始)はJPXが集計・公表しません。残高ゼロではありません',
    marginRatio: '買残または売残が無いため計算できません。残高ゼロとは限りません',
    short: '残高割合0.5%以上の空売り残高報告がありません。空売りがゼロという意味ではなく、時価総額が大きい銘柄ほど普通に起きます',
    shortChg: '比べる時点に報告が無いため差が取れません',
    lvsRatio: '保有割合の記載が無い書類です。0%ではありません(共同保有者が2名以上の書類では親の合計欄が空になります)',
    lvsNone: 'この5年でこの銘柄の大量保有報告書の提出がありません。取込開始が2021-07-01なので、それ以前から保有し続けて以降1度も変更報告書を出していない大量保有者は現れません。「大量保有者がいない」という意味ではありません',
    lvsPrev: '前回割合が無いため差が取れません(新規の大量保有報告書、または割合の記載が無い書類)',
    inv: 'この週の投資部門別情報がありません。市場区分再編で終了した系列を選んでいないか確認してください',
    arb: 'この週の裁定取引残高がありません(JPXの週間資料を手動で取り込んでいます。バックナンバーは直近4年分のみ)',
    generic: 'この週・この銘柄のデータがありません。0という意味ではありません',
    fin: '財務情報または大株主状況の書類が取り込まれていません',
  };

  function numCell(v, digits, reasonKey, suffix) {
    var s = fmt(v, digits);
    if (s === null) return na(NA_NOTE[reasonKey] || NA_NOTE.generic);
    return esc(s + (suffix || ''));
  }

  function dateCell(v, reasonKey) {
    if (!v) return na(NA_NOTE[reasonKey] || NA_NOTE.generic);
    return esc(v);
  }

  /** 前週比などの符号付き。色だけに頼らないよう符号を必ず数値に併記する */
  function signedCell(v, digits, reasonKey, suffix) {
    var s = fmt(v, digits);
    if (s === null) return na(NA_NOTE[reasonKey] || NA_NOTE.generic);
    var cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
    return '<span class="pct ' + cls + '">' + (v > 0 ? '+' : '') + esc(s + (suffix || '')) + '</span>';
  }

  /** 倍率。2桁を超えたら「水準を見ろ」の注記を添える(上場直後は基準が小さく発散する) */
  function multCell(v, reasonKey) {
    var s = fmt(v, 2);
    if (s === null) return na(NA_NOTE[reasonKey] || NA_NOTE.generic);
    var big = v >= 10;
    return '<span class="strong-num"' +
      (big ? ' title="倍率が2桁です。上場直後などで基準(過去平均)そのものが小さい可能性があります。水準そのものを必ず見てください"' : '') +
      '>' + esc(s) + '×' + (big ? ' ⚠' : '') + '</span>';
  }

  /**
   * 空売り残高割合(報告者ごとの最新を持ち越した合計。個人を除く。ddl/21)。
   *   NULL         → 「個人以外の報告が一度も無い」。ゼロではない
   *   報告終了     → 全報告者の最新が0.5%未満。ゼロではない
   *   古い報告のみ → 0.5%以上の報告は残っているが全て失効扱い。実在するかもしれない
   */
  function shortRatioCell(r) {
    var s = fmt(r.shortRatioPct, 2);
    if (s === null || r.shortStatus === '報告なし') return na(NA_NOTE.short);
    if (r.shortStatus === '報告終了') {
      return '<span class="zero-report" title="全ての報告者の最新の報告が0.5%を割っています。残高がゼロという意味ではありません">' +
        esc(s) + '% <span class="badge">報告終了</span></span>';
    }
    if (r.shortStatus === '古い報告のみ') {
      return '<span class="zero-report" title="0.5%以上の報告は残っていますが、計算日から' + P.shortStaleDays +
        '日を過ぎていて合計に入れていません。報告は残高が0.1pt以上動かないと出ないので、実在する残高かもしれません">' +
        esc(s) + '% <span class="badge">古い報告のみ</span></span>';
    }
    return esc(s) + '%';
  }

  //================================================================ 疑う列
  /**
   * 点灯を読む前に見る列。**点灯より目立たせる。**
   * docs/DEMAND_SIGNAL_RUNBOOK.md 3章 Step1 の表がそのまま入っている。
   */
  function doubtChips(r) {
    var out = [];
    function add(label, why) { out.push({ label: label, why: why }); }

    if (!r.priceDate) {
      add('株価の行が無い', NA_NOTE.price);
    }
    if (r.splitFlag === 'Y') {
      add('分割あり', '直近20営業日以内に株式分割・併合があります。出来高の株数基準が途中で変わっているので、出来高倍率をそのまま信じないでください');
    }
    if (r.marginSeasonWarn === 'CROSS') {
      add('つなぎ売り期', '3月・9月の権利付最終日前の申込日です。優待・配当のつなぎ売り(クロス取引)で信用売残が一時的に膨らみ、権利落ち後に反対売買で消えます。前週比ではなく前年同期と比べてください');
    }
    if (r.avgVolN !== null && r.avgVolN !== undefined && r.avgVolN < P.minAvgVolN) {
      add('20日平均が不成立 n=' + r.avgVolN,
        '20日平均出来高に使えた営業日が足りません(上場直後・売買停止明け)。出来高急増は判定対象外になっています');
    }
    if (r.marginShrtN13w !== null && r.marginShrtN13w !== undefined && r.marginShrtN13w < P.minShrtN) {
      add('売残の基準が不揃い n=' + r.marginShrtN13w,
        '過去13週のうち売残>0だった週が足りません。売り方がいない銘柄に増加率は定義できないため、売残の増加は判定対象外になっています');
    }
    if (r.shortStaleCnt > 0) {
      add('失効扱いの空売り報告 ' + r.shortStaleCnt + '件',
        '計算日から' + P.shortStaleDays + '日を過ぎた0.5%以上の報告が' + r.shortStaleCnt +
        '件あり、残高割合の合計に入れていません。報告は残高が0.1pt以上動かないと出ないため、実在する残高かもしれません(合計は過小の可能性)');
    }
    if (r.lvsGrpCntStale > 0) {
      add('大量保有が古い ' + r.lvsGrpCntStale + '/' + r.lvsGrpCnt + 'グループ',
        '最終報告が1年以上前の保有グループがこれだけあります。5%を割ると報告義務が切れて更新されないため、合計%は過去の姿です');
    }
    if (r.lvsGrpCntNoratio > 0) {
      add('割合不明 ' + r.lvsGrpCntNoratio + 'グループ',
        '保有割合の記載が無い書類のグループです(共同保有者2名以上)。合計%はその分だけ過小に出ています。0%とみなしていません');
    }
    if (r.marginShrtVs13w !== null && r.marginShrtVs13w !== undefined && r.marginShrtVs13w >= 10) {
      add('売残倍率が2桁',
        '過去13週平均そのものが小さい可能性があります(上場直後など)。倍率ではなく売残の水準を見てください');
    }
    if (r.lvsRecentDocs > 0 && r.lvsRecentMaterial === 0) {
      add('報告は出たが動きなし',
        '直近に大量保有報告書は提出されましたが、実質的な変化(新規・退出・1pt以上の増減・割合不明)ではありませんでした');
    }
    return out;
  }

  function doubtCell(r) {
    var chips = doubtChips(r);
    if (chips.length === 0) return '<span class="doubt-none">—</span>';
    return '<span class="doubt">' + chips.map(function (c) {
      return '<span class="doubt-chip" title="' + esc(c.why) + '">⚠ ' + esc(c.label) + '</span>';
    }).join('') + '</span>';
  }

  function signalsCell(r) {
    if (!r.signals) return '<span class="doubt-none">—</span>';
    return '<span class="sigs">' + r.signals.split(/\s+/).filter(Boolean).map(function (s) {
      return '<span class="sig-chip">' + esc(s) + '</span>';
    }).join('') + '</span>';
  }

  /**
   * 大量保有の直近サマリー。**折りたたまない・省略しない。**
   * 「NAME:方向 12.34%(+1.09pt)[形式的]」を ' / ' で連ねた文字列を、方向だけ色分けする。
   */
  var DIR_CLASS = {
    '買い増し': 'dir-buy', '売り減らし': 'dir-sell', '新規': 'dir-new',
    '退出': 'dir-exit', '変化なし': 'dir-none', '割合なし': 'dir-noratio',
  };
  function summaryHtml(text) {
    return text.split(' / ').map(function (part) {
      var m = /^([\s\S]*):(割合なし|退出|新規|買い増し|売り減らし|変化なし)([\s\S]*)$/.exec(part);
      if (!m) return esc(part);
      var dirCls = DIR_CLASS[m[2]] || '';
      var title = m[2] === '割合なし'
        ? ' title="保有割合の記載が無い書類です。0%でも変化なしでもありません"' : '';
      var rest = esc(m[3]).replace(/\[形式的\]/g, '<span class="formal">[形式的]</span>');
      return esc(m[1]) + ' <span class="dir ' + dirCls + '"' + title + '>' + esc(m[2]) + '</span>' + rest;
    }).join('　/　');
  }

  //================================================================ 汎用テーブル
  /**
   * cols: [{ key, label, grp, num:boolean, title, html(row), csv(row), sortVal(row) }]
   * opts: { pick:boolean, subRow(row)->html|null, order:[key,asc] }
   */
  function renderTable(tableEl, cols, rows, opts) {
    opts = opts || {};
    var sortKey = opts.sortKey || null;
    var sortAsc = !!opts.sortAsc;

    function headHtml() {
      var groups = [];
      cols.forEach(function (c) {
        var g = c.grp || '';
        if (groups.length && groups[groups.length - 1].name === g) groups[groups.length - 1].n++;
        else groups.push({ name: g, n: 1 });
      });
      var h1 = '<tr class="grp">' + groups.map(function (g, i) {
        return '<th colspan="' + g.n + '"' + (i > 0 ? ' class="grp-start"' : '') + '>' +
          esc(g.name) + '</th>';
      }).join('') + '</tr>';

      var gi = 0, left = groups[0] ? groups[0].n : 0;
      var h2 = '<tr class="col">' + cols.map(function (c) {
        var first = left === (groups[gi] ? groups[gi].n : 0);
        left--;
        if (left === 0) { gi++; left = groups[gi] ? groups[gi].n : 0; }
        var cls = [];
        if (c.num) cls.push('num-col');
        if (gi > 0 && first && groups[0]) cls.push('');
        if (c.sortable !== false) cls.push('sortable');
        var aria = sortKey === c.key ? ' aria-sort="' + (sortAsc ? 'ascending' : 'descending') + '"' : '';
        return '<th class="' + cls.join(' ') + '" data-key="' + esc(c.key) + '"' + aria +
          (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label) + '</th>';
      }).join('') + '</tr>';
      return h1 + h2;
    }

    function bodyHtml(list) {
      if (list.length === 0) {
        return '<tr><td colspan="' + cols.length + '" class="dim">該当する行がありません。</td></tr>';
      }
      return list.map(function (r) {
        var tds = cols.map(function (c) {
          return '<td class="' + (c.num ? 'num-col ' : '') + (c.cls || '') + '">' +
            (c.html ? c.html(r) : esc(r[c.key] === null || r[c.key] === undefined ? '' : r[c.key])) +
            '</td>';
        }).join('');
        var attrs = opts.pick ? ' class="pick' + (state.detailCode === r.code ? ' active' : '') +
          '" data-code="' + esc(r.code) + '"' : '';
        var main = '<tr' + attrs + '>' + tds + '</tr>';
        var sub = opts.subRow ? opts.subRow(r) : null;
        if (sub) {
          main += '<tr class="summary-row"><td colspan="' + cols.length + '">' + sub + '</td></tr>';
        }
        return main;
      }).join('');
    }

    function sorted() {
      if (!sortKey) return rows;
      var col = cols.filter(function (c) { return c.key === sortKey; })[0];
      if (!col) return rows;
      var val = col.sortVal || function (r) { return r[sortKey]; };
      return rows.slice().sort(function (a, b) {
        var x = val(a), y = val(b);
        if (x === null || x === undefined) return 1;   // 「無い」は常に末尾
        if (y === null || y === undefined) return -1;
        if (typeof x === 'string' || typeof y === 'string') {
          x = String(x); y = String(y);
          return sortAsc ? (x < y ? -1 : x > y ? 1 : 0) : (x > y ? -1 : x < y ? 1 : 0);
        }
        return sortAsc ? x - y : y - x;
      });
    }

    function paint() {
      tableEl.querySelector('thead').innerHTML = headHtml();
      tableEl.querySelector('tbody').innerHTML = bodyHtml(sorted());
    }

    tableEl.onclick = function (ev) {
      var th = ev.target.closest ? ev.target.closest('th.sortable') : null;
      if (th) {
        var k = th.getAttribute('data-key');
        if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
        paint();
        return;
      }
      if (opts.pick) {
        var tr = ev.target.closest ? ev.target.closest('tr.pick') : null;
        if (tr && opts.onPick) opts.onPick(tr.getAttribute('data-code'));
      }
    };
    paint();
  }

  //================================================================ CSV
  function toCsv(cols, rows) {
    function q(v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var head = cols.map(function (c) {
      return q((c.grp ? c.grp + '_' : '') + c.label);
    }).join(',');
    var body = rows.map(function (r) {
      return cols.map(function (c) {
        return q(c.csv ? c.csv(r) : r[c.key]);
      }).join(',');
    }).join('\n');
    return '﻿' + head + '\n' + body + '\n';
  }

  function downloadCsv(name, cols, rows) {
    var blob = new Blob([toCsv(cols, rows)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  //================================================================ 通信
  function api(path) {
    return fetch(path).then(function (r) {
      if (r.ok) return r.json();
      return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); },
        function () { throw new Error('HTTP ' + r.status); });
    });
  }

  function setStatus(el, msg, isError) {
    el.textContent = msg || '';
    el.className = 'status' + (isError ? ' error' : '');
  }

  //================================================================ 鮮度
  function renderFreshness(rows) {
    var late = rows.filter(function (r) { return r.state === 'late'; });
    $('freshnessList').innerHTML = rows.map(function (r) {
      var cls = 'fresh-item ' + (r.state === 'late' ? 'late' : r.state === 'unknown' ? 'unknown' : '');
      var title = r.note +
        (r.measured && r.maxDays !== null
          ? '(実測にもとづく正常範囲: 0〜' + r.maxDays + '日)'
          : '(正常範囲は未実測。日付だけを見てください)');
      return '<span class="' + cls + '" title="' + esc(title) + '">' +
        '<span class="fi-name">' + esc(r.dataName) + '</span>' +
        '<span class="fi-date">' + (r.latest ? esc(r.latest) : na('このテーブルに1件もデータがありません')) + '</span>' +
        '<span class="fi-days">' + (r.daysBehind === null || r.daysBehind === undefined
          ? '' : esc(r.daysBehind) + '日前') + '</span>' +
        (r.measured ? '' : '<span class="badge" title="公表スケジュールからの推定です。実測で確かめた範囲ではありません">目安未実測</span>') +
        '</span>';
    }).join('');

    var head = $('freshness').querySelector('.freshness-head span');
    if (late.length > 0) {
      head.innerHTML = '<strong class="pct down">' + late.length +
        '件が実測の正常範囲より遅れています(' +
        esc(late.map(function (r) { return r.dataName; }).join('・')) +
        ')。シグナルを読む前に取込を確認してください。</strong>';
    } else {
      head.textContent = 'シグナルは最新値で判定します。取込が止まっていると静かに誤判定します。';
    }
  }

  //================================================================ フッター
  function renderCalib() {
    var items = [
      ['出来高倍率', P.volMultTh + '倍', '20日平均出来高の何倍で点灯させるか'],
      ['20日平均の最低営業日数', P.minAvgVolN + '日', 'これ未満は出来高急増を判定しない'],
      ['売残倍率', P.shrtMultTh + '倍', '信用売残 ÷ 自分の過去13週平均売残'],
      ['売残の基準週数', P.minShrtN + '週', '過去13週のうち売残>0だった週数の下限'],
      ['大量保有の直近', P.lvsDaysTh + '日', 'これ以内の提出を「直近」とする'],
      ['実質的な変化幅', (P.lvsMinChg * 100).toFixed(0) + 'pt', 'これ未満の変更報告は形式的とみなす'],
      ['大量保有の鮮度', P.lvsStaleDays + '日', 'これより古い報告を「古い」扱いにする'],
      ['空売り残高の増加幅', (P.shortChgTh * 100).toFixed(1) + 'pt', P.shortChgDays + '日前の持ち越し合計からこれ以上増えたら点灯'],
      ['空売り報告の失効', P.shortStaleDays + '日', '計算日からこれを過ぎた報告は残高の合計に入れない'],
      ['全銘柄版の流動性', (P.minTurnover20d / 100000000).toFixed(1) + '億円',
        '20日平均売買代金の下限(全銘柄から探すときのみ)'],
    ];
    $('calib').innerHTML =
      '<div>いま使っているしきい値(最後に実データで較正したのは <strong>' +
      esc(meta.calibratedAt) + '</strong>)。' +
      '較正クエリ(05〜11)はこの画面に出していません。全期間の分位を使っていて' +
      'その時点では知り得ない情報を含むため、日々の判断には混ぜません。' +
      'ウォッチリストの顔ぶれを入れ替えたら較正し直してください' +
      '(<code>queries/sql/demand_signal_detection.sql</code> の 05〜11)。</div>' +
      '<div class="calib-grid">' + items.map(function (it) {
        return '<span title="' + esc(it[2]) + '">' + esc(it[0]) + ' <code>' + esc(it[1]) + '</code></span>';
      }).join('') + '</div>';
  }

  //================================================================ タブ
  var LOADERS = {};
  function showTab(name) {
    state.tab = name;
    Array.prototype.forEach.call($('tabs').querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === name));
    });
    $('paneSignal').hidden = name !== 'signal';
    $('paneWatchlist').hidden = name !== 'watchlist';
    $('paneMacro').hidden = name !== 'macro';
    if (LOADERS[name]) LOADERS[name]();
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* 無視 */ }
  }

  //================================================================ 列の組み立て
  function fail(el, err) {
    el.innerHTML = '<span class="status error">' + esc(err.message || String(err)) + '</span>';
  }

  /** 銘柄の2列。市場区分と業種は title に逃がす(横幅を食うだけで毎回は見ない) */
  function codeCols(grp) {
    return [
      { key: 'code', label: 'コード', grp: grp, cls: 'code' },
      {
        key: 'coName', label: '銘柄名', grp: grp, cls: 'name',
        html: function (r) {
          var sub = [r.marketName, r.sector33Name].filter(Boolean).join(' / ');
          return '<span' + (sub ? ' title="' + esc(sub) + '"' : '') + '>' + esc(r.coName) + '</span>';
        },
      },
    ];
  }

  /**
   * 大量保有の保有グループ数。
   * **0 を「大量保有者がいない」と読ませない。** 取込開始が 2021-07-01 なので、
   * それ以前から保有し続けて以降1度も変更報告書を出していない株主は現れない。
   */
  function grpCntCell(r) {
    var n = r.lvsGrpCnt;
    if (n === null || n === undefined) return na(NA_NOTE.lvsNone);
    if (Number(n) !== 0) return esc(String(n));
    // 0 には2通りある。どちらなのかを言わずに 0 とだけ出さない。
    //   書類そのものが無い      … この5年で動きが無かった(取込開始は2021-07-01)
    //   書類はあるが5%以上が0件 … 全員が退出した後(売り抜けが終わっている)
    var all = r.lvsGrpCntAll;
    if (all !== null && all !== undefined && Number(all) > 0) {
      return '<span class="zero-report" title="大量保有報告書はありますが、5%以上を保有しているグループが0件です。全員が5%未満へ退出した後の姿で、「大量保有者がいない」とは別の状態です">0 ' +
        '<span class="badge">全員退出(全' + esc(String(all)) + 'G)</span></span>';
    }
    return '<span class="zero-report" title="' + esc(NA_NOTE.lvsNone) + '">0 ' +
      '<span class="badge">この5年で動きなし</span></span>';
  }

  /** 合計%。グループが0件のときは「0%」ではなく「この5年で動きが無かった」 */
  function lvsTotalCell(r) {
    if (Number(r.lvsGrpCnt) === 0) return na(NA_NOTE.lvsNone);
    return numCell(r.lvsTotalPct, 2, 'lvsRatio', '%');
  }

  //================================================================ 第三階層
  /**
   * 列の並びは docs/DEMAND_SIGNAL_RUNBOOK.md 3章の読む順番そのもの。
   *   ① 疑う列 → ② 点灯 → ③〜⑥ 点灯の材料
   * **疑う列を点灯の左に置く。** 並び順で読む順番を強制する。
   */
  function signalCols(scope) {
    var watch = scope === 'watchlist';
    var cols = codeCols('銘柄').concat([
      {
        key: 'doubt', label: 'この点灯を疑う理由', grp: '① 疑う', sortable: false,
        html: doubtCell,
        csv: function (r) {
          return doubtChips(r).map(function (c) { return c.label; }).join(' / ');
        },
      },
      {
        key: 'signalScore', label: '確認順', grp: '② 点灯', num: true, cls: 'rank',
        title: '点灯した数。買いシグナルの強さではありません。先に中身を見る順番です',
        html: function (r) { return esc(String(r.signalScore)); },
      },
      {
        key: 'signals', label: '点灯したシグナル', grp: '② 点灯', sortable: false,
        html: signalsCell, csv: function (r) { return r.signals || ''; },
      },

      {
        key: 'volVs20d', label: '倍率', grp: '③ 出来高', num: true,
        title: '直近の出来高 ÷ 20日平均出来高(直近日を含まない平均)',
        html: function (r) { return multCell(r.volVs20d, 'price'); },
      },
      {
        key: 'volume', label: '出来高', grp: '③ 出来高', num: true,
        html: function (r) { return numCell(r.volume, 0, 'price'); },
      },
      {
        key: 'avgVol20d', label: '20日平均', grp: '③ 出来高', num: true,
        html: function (r) { return numCell(r.avgVol20d, 0, 'price'); },
      },
      {
        key: 'avgVolN', label: 'n', grp: '③ 出来高', num: true,
        title: '20日平均に使えた営業日数。少ないと「20日平均」ではありません',
        html: function (r) { return numCell(r.avgVolN, 0, 'price'); },
      },
      {
        key: 'priceDate', label: '株価日', grp: '③ 出来高',
        html: function (r) { return dateCell(r.priceDate, 'price'); },
      },

      {
        key: 'marginShrtVs13w', label: '13週比', grp: '④ 信用売残', num: true,
        title: '信用売残 ÷ 自分の過去13週平均売残。直近比と長期比の両方が高いかを見ます(片方だけなら弱い)',
        html: function (r) { return multCell(r.marginShrtVs13w, 'margin'); },
      },
      {
        key: 'marginShrtVsMed52', label: '52週中央比', grp: '④ 信用売残', num: true,
        title: '信用売残 ÷ 自分の過去52週中央値。基準窓そのものが凹んでいないかの確認',
        html: function (r) { return multCell(r.marginShrtVsMed52, 'margin'); },
      },
      {
        key: 'marginShrtVol', label: '売残', grp: '④ 信用売残', num: true,
        title: '倍率が大きいときは必ずこの水準を見ること(基準が小さいと倍率は発散します)',
        html: function (r) { return numCell(r.marginShrtVol, 0, 'margin'); },
      },
      {
        key: 'marginShrtN13w', label: 'n', grp: '④ 信用売残', num: true,
        title: '過去13週のうち売残>0だった週数。少ないと増加率が定義できません',
        html: function (r) { return numCell(r.marginShrtN13w, 0, 'margin'); },
      },
      {
        key: 'marginShrtDtc', label: 'DTC', grp: '④ 信用売残', num: true,
        title: '売残 ÷ 20日平均出来高(日数)。踏み上げの燃料の目安であって、売残の水準が平常かの物差しには使えません(分子と分母が同率で動くと水準変化が打ち消されます)',
        html: function (r) { return numCell(r.marginShrtDtc, 2, 'margin'); },
      },
      {
        key: 'marginRatio', label: '信用倍率', grp: '④ 信用売残', num: true,
        title: '買残 ÷ 売残。3月・9月はつなぎ売りで必ず下がります',
        html: function (r) { return numCell(r.marginRatio, 2, 'marginRatio'); },
      },
      {
        key: 'marginDate', label: '申込日', grp: '④ 信用売残',
        html: function (r) { return dateCell(r.marginDate, 'margin'); },
      },

      {
        key: 'shortRatioPct', label: '残高割合', grp: '⑤ 空売り', num: true,
        title: '報告者ごとの最新の報告を持ち越した合計(個人を除く)。空欄は「空売りゼロ」ではなく「0.5%以上の報告が無い」。大型株ほど普通に起きます',
        html: shortRatioCell, csv: function (r) { return r.shortRatioPct; },
      },
      {
        key: 'shortRatioChgPt', label: '4週差', grp: '⑤ 空売り', num: true,
        title: '残高割合の' + P.shortChgDays + '日前との差。空売り残高の増加はこれで点灯します',
        html: function (r) { return signedCell(r.shortRatioChgPt, 2, 'shortChg', 'pt'); },
      },
      {
        key: 'reporterCount', label: '報告者数', grp: '⑤ 空売り', num: true,
        title: '増えているほど売り方の関心が強い',
        html: function (r) { return numCell(r.reporterCount, 0, 'short'); },
      },
      {
        key: 'shortDaysSince', label: '経過日数', grp: '⑤ 空売り', num: true,
        title: '合計に使った報告のうち一番新しい計算日からの日数',
        html: function (r) { return numCell(r.shortDaysSince, 0, 'short', '日'); },
      },
      {
        key: 'shortCalcDate', label: '計算日', grp: '⑤ 空売り',
        html: function (r) { return dateCell(r.shortCalcDate, 'short'); },
      },

      {
        key: 'lvsRecentGrps', label: '直近の提出G', grp: '⑥ 大量保有', num: true,
        title: '直近に報告した提出者グループ数(書類数ではありません)',
        html: function (r) { return numCell(r.lvsRecentGrps, 0, 'generic'); },
      },
      {
        key: 'lvsRecentMaterial', label: 'うち実質', grp: '⑥ 大量保有', num: true,
        title: '形式的な変更報告を除いた数。提出があるのにここが0なら「報告は出たが動きは無い」',
        html: function (r) { return numCell(r.lvsRecentMaterial, 0, 'generic'); },
      },
      {
        key: 'lvsLastSubDate', label: '最終提出', grp: '⑥ 大量保有',
        html: function (r) { return dateCell(r.lvsLastSubDate, 'lvsNone'); },
      },
    ]);

    // 全銘柄版は全期間スナップショットを作らないので、この4列がそもそも返ってこない
    if (watch) {
      cols = cols.concat([
        {
          key: 'lvsGrpCnt', label: '保有G', grp: '⑥ 大量保有', num: true,
          title: '5%以上を保有している提出者グループ数(全期間の最新断面)',
          html: grpCntCell, csv: function (r) { return r.lvsGrpCnt; },
        },
        {
          key: 'lvsTotalPct', label: '合計%', grp: '⑥ 大量保有', num: true,
          title: '高いこと自体は異常ではありません(オーナー系は普通に50%超)。効くのは水準ではなく鮮度とグループ数',
          html: lvsTotalCell, csv: function (r) { return r.lvsTotalPct; },
        },
        {
          key: 'lvsGrpCntStale', label: '古G', grp: '⑥ 大量保有', num: true,
          title: '最終報告が1年以上前のグループ数。合計%はその分だけ過去の姿です',
          html: function (r) { return numCell(r.lvsGrpCntStale, 0, 'generic'); },
        },
        {
          key: 'lvsGrpCntNoratio', label: '割合不明G', grp: '⑥ 大量保有', num: true,
          title: '保有割合の記載が無い書類のグループ数。合計%はその分だけ過小です(0%ではありません)',
          html: function (r) { return numCell(r.lvsGrpCntNoratio, 0, 'generic'); },
        },
      ]);
    }
    return cols;
  }

  /**
   * 大量保有の直近サマリーを本文行の下に必ず1行出す。
   * **折りたたまない・省略しない。** 退出報告でも点灯するので、
   * これを読まずに確認順だけで判断すると向きを取り違える。
   */
  function signalSubRow(r) {
    if (r.lvsRecentSummary) {
      return '<span class="summary-label">直近の大量保有</span>' + summaryHtml(r.lvsRecentSummary);
    }
    if (r.sigLvs === 1) {
      return '<span class="summary-label">直近の大量保有</span>' + na(NA_NOTE.lvsNone);
    }
    return null;
  }

  var signalState = { cols: null, rows: [] };

  function renderSignals(d) {
    var cols = signalCols('watchlist');
    signalState = { cols: cols, rows: d.rows };
    var n = meta && meta.watchlist ? meta.watchlist.length : null;
    $('signalMeta').textContent =
      (n ? 'ウォッチ' + n + '銘柄のうち' : '') + '1つ以上点灯した行だけを出しています';
    $('signalCount').textContent =
      d.count + '件が点灯' + (n ? '(ウォッチ' + n + '銘柄中)' : '');
    renderTable($('signalTable'), cols, d.rows, { subRow: signalSubRow });

    // 点灯0件を「何も起きていない」と読ませない(手引き1章: 期待値と独立観測数を先に数える)
    $('signalNote').innerHTML = d.count === 0
      ? '点灯0件は「何も起きていない」ではありません。' +
        (n ? n + '銘柄' : 'ウォッチ銘柄') +
        '・到達率5%なら0件になる確率は3割強あります。1日の結果から構造を語らないでください。'
      : '⚠ の列を先に読んでから、点灯の材料(③〜⑥)を見てください。' +
        '大量保有は行の下のサマリーで向きを必ず確認します(退出でも点灯します)。';
  }

  function loadSignals(force) {
    if (cache.signals && !force) { renderSignals(cache.signals); return; }
    $('signalCount').textContent = '読み込み中…';
    api('/api/demand/signals').then(function (d) {
      cache.signals = d;
      renderSignals(d);
    }).catch(function (e) { fail($('signalCount'), e); });
  }

  //---------------------------------------------------------------- 補助シグナル
  function suppCols() {
    return codeCols('銘柄').concat([
      {
        key: 'doubt', label: '疑う理由', grp: '① 疑う', sortable: false,
        html: doubtCell,
        csv: function (r) {
          return doubtChips(r).map(function (c) { return c.label; }).join(' / ');
        },
      },
      {
        key: 'daysToCover', label: 'DTC', grp: '踏み上げの燃料', num: true,
        title: '信用売残 ÷ 20日平均出来高(日数)。つなぎ売りの週は売残と一緒に跳ねます。燃料が溜まったわけではありません',
        html: function (r) { return numCell(r.daysToCover, 1, 'margin', '日'); },
      },
      {
        key: 'marginShrtVol', label: '売残', grp: '踏み上げの燃料', num: true,
        html: function (r) { return numCell(r.marginShrtVol, 0, 'margin'); },
      },
      {
        key: 'avgVol20d', label: '20日平均出来高', grp: '踏み上げの燃料', num: true,
        html: function (r) { return numCell(r.avgVol20d, 0, 'price'); },
      },
      {
        key: 'avgVolN', label: 'n', grp: '踏み上げの燃料', num: true,
        title: '20日平均に使えた営業日数',
        html: function (r) { return numCell(r.avgVolN, 0, 'price'); },
      },
      {
        key: 'marginDate', label: '申込日', grp: '踏み上げの燃料',
        html: function (r) { return dateCell(r.marginDate, 'margin'); },
      },
      {
        key: 'dailyPublication', label: '日々公表', grp: '規制', 
        title: '30日窓で見ています。指定が外れた後もしばらく Y のまま残るので、申込日を必ず見てください',
        html: function (r) {
          if (r.dailyPublication !== 'Y') return '<span class="doubt-none">—</span>';
          return '<span class="badge" title="日々公表銘柄です">Y</span>';
        },
      },
      {
        key: 'alertSlRatio', label: '貸借倍率', grp: '規制', num: true,
        html: function (r) { return numCell(r.alertSlRatio, 2, 'generic'); },
      },
      {
        key: 'tseMrgnRegCls', label: '規制区分', grp: '規制',
        html: function (r) {
          return r.tseMrgnRegCls ? esc(r.tseMrgnRegCls) : '<span class="doubt-none">—</span>';
        },
      },
      {
        key: 'alertAppDate', label: '申込日', grp: '規制',
        html: function (r) { return dateCell(r.alertAppDate, 'generic'); },
      },
      {
        key: 'reporterCount', label: '報告者数', grp: '空売り報告', num: true,
        html: function (r) { return numCell(r.reporterCount, 0, 'short'); },
      },
      {
        key: 'reporterChg', label: '4週差', grp: '空売り報告', num: true,
        title: '0.5%以上の報告者数の' + P.shortChgDays + '日前との差。増えているほど売り方の関心が強い',
        html: function (r) { return signedCell(r.reporterChg, 0, 'shortChg'); },
      },
      {
        key: 'shortDaysSince', label: '経過日数', grp: '空売り報告', num: true,
        html: function (r) { return numCell(r.shortDaysSince, 0, 'short', '日'); },
      },
      {
        key: 'shortCalcDate', label: '計算日', grp: '空売り報告',
        html: function (r) { return dateCell(r.shortCalcDate, 'short'); },
      },
    ]);
  }

  function loadSupplementary() {
    if (cache.supp) return;
    api('/api/demand/supplementary').then(function (d) {
      cache.supp = d;
      renderTable($('suppTable'), suppCols(), d.rows, {});
    }).catch(function (e) {
      $('suppTable').querySelector('tbody').innerHTML =
        '<tr><td class="dim">' + esc(e.message) + '</td></tr>';
    });
  }

  //---------------------------------------------------------------- 全銘柄版
  var allState = { cols: null, rows: [] };

  function loadSignalsAll() {
    setStatus($('allStatus'), '実行中… 全銘柄 × 15か月を走査します');
    $('allRunBtn').disabled = true;
    api('/api/demand/signals/all').then(function (d) {
      allState = { cols: signalCols('all'), rows: d.rows };
      cache.signalsAll = d;
      setStatus($('allStatus'), d.count + '件(2つ以上の同時点灯・上位100件)');
      renderTable($('allTable'), allState.cols, d.rows, { subRow: signalSubRow });
    }).catch(function (e) {
      setStatus($('allStatus'), e.message, true);
    }).then(function () {
      $('allRunBtn').disabled = false;
    });
  }

  //================================================================ 第二階層
  /** 方向を色と文言の両方で出す。色だけに意味を運ばせない */
  function directionCell(v) {
    if (!v) return na(NA_NOTE.lvsNone);
    var title = v === '割合なし'
      ? ' title="保有割合の記載が無い書類です。0%でも変化なしでもありません"'
      : (v === '退出' ? ' title="5%未満に落ちた報告です。報告義務が切れるので以後は更新されません"' : '');
    return '<span class="dir ' + (DIR_CLASS[v] || '') + '"' + title + '>' + esc(v) + '</span>';
  }

  function sheetCols() {
    return codeCols('銘柄').concat([
      {
        key: 'doubt', label: 'この数字を疑う理由', grp: '① 疑う', sortable: false,
        html: doubtCell,
        csv: function (r) {
          return doubtChips(r).map(function (c) { return c.label; }).join(' / ');
        },
      },
      {
        key: 'volVs20d', label: '出来高倍率', grp: '株価・出来高', num: true,
        title: '直近の出来高 ÷ 20日平均出来高(直近日を含まない平均)',
        html: function (r) { return multCell(r.volVs20d, 'price'); },
      },
      {
        key: 'closePrice', label: '終値', grp: '株価・出来高', num: true,
        html: function (r) { return numCell(r.closePrice, 1, 'price'); },
      },
      {
        key: 'volume', label: '出来高', grp: '株価・出来高', num: true,
        html: function (r) { return numCell(r.volume, 0, 'price'); },
      },
      {
        key: 'avgVol20d', label: '20日平均', grp: '株価・出来高', num: true,
        html: function (r) { return numCell(r.avgVol20d, 0, 'price'); },
      },
      {
        key: 'priceDate', label: '日付', grp: '株価・出来高',
        html: function (r) { return dateCell(r.priceDate, 'price'); },
      },
      {
        key: 'marginRatio', label: '信用倍率', grp: '信用取引残高', num: true,
        title: '買残 ÷ 売残。3月・9月はつなぎ売りで必ず下がります。前週比ではなく前年同期と比べてください',
        html: function (r) { return numCell(r.marginRatio, 2, 'marginRatio'); },
      },
      {
        key: 'marginLongVol', label: '買残', grp: '信用取引残高', num: true,
        html: function (r) { return numCell(r.marginLongVol, 0, 'margin'); },
      },
      {
        key: 'marginLongChg', label: '前週差', grp: '信用取引残高', num: true,
        html: function (r) { return signedCell(r.marginLongChg, 0, 'margin'); },
      },
      {
        key: 'marginShrtVol', label: '売残', grp: '信用取引残高', num: true,
        html: function (r) { return numCell(r.marginShrtVol, 0, 'margin'); },
      },
      {
        key: 'marginShrtChg', label: '前週差', grp: '信用取引残高', num: true,
        html: function (r) { return signedCell(r.marginShrtChg, 0, 'margin'); },
      },
      {
        key: 'marginShrtDtc', label: 'DTC', grp: '信用取引残高', num: true,
        title: '売残 ÷ 20日平均出来高(日数)。踏み上げの燃料の目安です',
        html: function (r) { return numCell(r.marginShrtDtc, 2, 'margin'); },
      },
      {
        key: 'marginDate', label: '申込日', grp: '信用取引残高',
        html: function (r) { return dateCell(r.marginDate, 'margin'); },
      },
      {
        key: 'shortRatioPct', label: '残高割合', grp: '空売り残高', num: true,
        title: '報告者ごとの最新の報告を持ち越した合計(個人を除く)。空欄は「空売りゼロ」ではなく「0.5%以上の報告が無い」',
        html: shortRatioCell, csv: function (r) { return r.shortRatioPct; },
      },
      {
        key: 'shortRatioChgPt', label: '4週差', grp: '空売り残高', num: true,
        title: '残高割合の' + P.shortChgDays + '日前との差',
        html: function (r) { return signedCell(r.shortRatioChgPt, 2, 'shortChg', 'pt'); },
      },
      {
        key: 'reporterCount', label: '報告者数', grp: '空売り残高', num: true,
        html: function (r) { return numCell(r.reporterCount, 0, 'short'); },
      },
      {
        key: 'shortDtc', label: 'DTC', grp: '空売り残高', num: true,
        title: '空売り残高株数 ÷ 20日平均出来高(日数)',
        html: function (r) { return numCell(r.shortDtc, 2, 'short', '日'); },
      },
      {
        key: 'shortDaysSince', label: '経過日数', grp: '空売り残高', num: true,
        title: '合計に使った報告のうち一番新しい計算日からの日数',
        html: function (r) { return numCell(r.shortDaysSince, 0, 'short', '日'); },
      },
      {
        key: 'shortCalcDate', label: '計算日', grp: '空売り残高',
        html: function (r) { return dateCell(r.shortCalcDate, 'short'); },
      },
      {
        key: 'lvsGrpCnt', label: '保有G', grp: '大量保有', num: true,
        title: '5%以上を保有している提出者グループ数',
        html: grpCntCell, csv: function (r) { return r.lvsGrpCnt; },
      },
      {
        key: 'lvsGrpCntAll', label: '全G', grp: '大量保有', num: true,
        title: '退出したグループも含めた提出者グループ数。保有Gが0でもここが0でなければ「大量保有者がいない」ではなく「全員が退出した後」です',
        html: function (r) { return numCell(r.lvsGrpCntAll, 0, 'lvsNone'); },
      },
      {
        key: 'lvsTotalPct', label: '合計%', grp: '大量保有', num: true,
        title: '高いこと自体は異常ではありません(オーナー系は普通に50%超)。効くのは水準ではなく鮮度とグループ数',
        html: lvsTotalCell, csv: function (r) { return r.lvsTotalPct; },
      },
      {
        key: 'lvsGrpCntStale', label: '古G', grp: '大量保有', num: true,
        title: '最終報告が1年以上前のグループ数。全Gが0の銘柄ではここも0になりますが、それは「古い報告が無い」であって「新しい」ではありません',
        html: function (r) { return numCell(r.lvsGrpCntStale, 0, 'generic'); },
      },
      {
        key: 'lvsGrpCntNoratio', label: '割合不明G', grp: '大量保有', num: true,
        title: '保有割合の記載が無い書類のグループ数。合計%はその分だけ過小です。全Gが0の銘柄ではここも0になります',
        html: function (r) { return numCell(r.lvsGrpCntNoratio, 0, 'generic'); },
      },
      {
        key: 'lvsLastDirection', label: '最新の向き', grp: '大量保有', sortable: false,
        title: '直近に報告したグループの向き。退出も売り抜けの開始として残しています',
        html: function (r) { return directionCell(r.lvsLastDirection); },
        csv: function (r) { return r.lvsLastDirection || ''; },
      },
      {
        key: 'lvsLastHolder', label: '提出者', grp: '大量保有', cls: 'name',
        html: function (r) {
          return r.lvsLastHolder ? esc(r.lvsLastHolder) : na(NA_NOTE.lvsNone);
        },
      },
      {
        key: 'lvsLastRatioPct', label: '割合', grp: '大量保有', num: true,
        html: function (r) { return numCell(r.lvsLastRatioPct, 2, 'lvsRatio', '%'); },
      },
      {
        key: 'lvsLastChgPt', label: '前回差', grp: '大量保有', num: true,
        html: function (r) { return signedCell(r.lvsLastChgPt, 2, 'lvsPrev', 'pt'); },
      },
      {
        key: 'lvsLastSubDate', label: '最終提出', grp: '大量保有',
        html: function (r) { return dateCell(r.lvsLastSubDate, 'lvsNone'); },
      },
    ]);
  }

  var sheetState = { cols: null, rows: [] };

  function renderSheet(d) {
    var cols = sheetCols();
    sheetState = { cols: cols, rows: d.rows };
    $('sheetCount').textContent = d.count + '銘柄';
    if (d.lvsDocs && d.lvsDocs.docsCnt) {
      $('sheetMeta').textContent =
        '大量保有報告書の取込は ' + d.lvsDocs.codesWithDoc + '銘柄 / ' +
        d.lvsDocs.docsCnt + '件(' + d.lvsDocs.fromDate + '〜' + d.lvsDocs.toDate + ')';
    }
    renderTable($('sheetTable'), cols, d.rows, {
      pick: true,
      onPick: function (code) { openDetail(code); },
    });
  }

  function loadWatchlist(force) {
    if (cache.sheet && !force) { renderSheet(cache.sheet); return; }
    $('sheetCount').textContent = '読み込み中…';
    api('/api/demand/watchlist').then(function (d) {
      cache.sheet = d;
      renderSheet(d);
    }).catch(function (e) { fail($('sheetCount'), e); });
  }

  //---------------------------------------------------------------- 銘柄詳細
  function holderCols() {
    var grp = '提出者グループごとの最新1件';
    return [
      { key: 'holderName', label: '提出者', cls: 'name', grp: grp },
      {
        key: 'status', label: '状態', grp: grp, sortable: false,
        html: function (r) { return directionCell(r.status); },
        csv: function (r) { return r.status; },
      },
      {
        key: 'ratioPct', label: '割合', grp: grp, num: true,
        html: function (r) {
          var s = numCell(r.ratioPct, 2, 'lvsRatio', '%');
          if (r.ratioImputed === 'Y' && r.ratioPct !== null && r.ratioPct !== undefined) {
            s += ' <span class="badge" title="親の合計欄が空だったため、保有者1名の書類に限り子の割合で補完しています">補完</span>';
          }
          return s;
        },
        csv: function (r) { return r.ratioPct; },
      },
      {
        key: 'ratioChgPt', label: '前回差', grp: grp, num: true,
        html: function (r) { return signedCell(r.ratioChgPt, 2, 'lvsPrev', 'pt'); },
      },
      {
        key: 'daysSince', label: '経過', grp: grp, num: true,
        title: '最後に報告した時点の値です。経過日数が大きいグループほど実態と乖離します',
        html: function (r) {
          if (r.daysSince === null || r.daysSince === undefined) return na(NA_NOTE.lvsNone);
          if (r.daysSince >= P.lvsStaleDays) {
            return '<span class="doubt-chip" title="最終報告が古いグループです。5%を割ると報告義務が切れて更新されません">⚠ ' +
              esc(fmt(r.daysSince, 0)) + '日</span>';
          }
          return esc(fmt(r.daysSince, 0) + '日');
        },
        csv: function (r) { return r.daysSince; },
      },
      {
        key: 'lastSubDate', label: '最終提出', grp: grp,
        html: function (r) { return dateCell(r.lastSubDate, 'lvsNone'); },
      },
      {
        key: 'docsCnt', label: '書類数', grp: grp, num: true,
        title: 'このグループが提出した書類の総数(ほとんどが変更報告書)',
      },
      {
        key: 'sharesHeld', label: '保有株数', grp: grp, num: true,
        title: '書類ごとに発行済株式数が違うので株数どうしを直接比べないこと(分割前の書類は旧株数)',
        html: function (r) { return numCell(r.sharesHeld, 0, 'lvsRatio'); },
      },
    ];
  }

  function historyCols() {
    var grp = '提出履歴';
    return [
      { key: 'subDate', label: '提出日', grp: grp },
      { key: 'hldrName', label: '保有者', cls: 'name', grp: grp },
      { key: 'hldrSeq', label: '#', num: true, grp: grp, title: '共同保有者の連番。1が提出者' },
      {
        key: 'holderRatioPct', label: '保有者%', num: true, grp: grp,
        html: function (r) { return numCell(r.holderRatioPct, 2, 'lvsRatio', '%'); },
      },
      {
        key: 'holderRatioLastPct', label: '前回%', num: true, grp: grp,
        title: '変更報告書にしか入りません。新規の大量保有報告書では空欄です(欠損ではありません)',
        html: function (r) { return numCell(r.holderRatioLastPct, 2, 'lvsPrev', '%'); },
      },
      {
        key: 'holderRatioChgPt', label: '差', num: true, grp: grp,
        html: function (r) { return signedCell(r.holderRatioChgPt, 2, 'lvsPrev', 'pt'); },
      },
      {
        key: 'totalRatioPct', label: '合計%', num: true, grp: grp,
        title: '共同保有者が2名以上の書類だけ埋まります',
        html: function (r) { return numCell(r.totalRatioPct, 2, 'lvsRatio', '%'); },
      },
      {
        key: 'shsHeld', label: '保有株数', num: true, grp: grp,
        html: function (r) { return numCell(r.shsHeld, 0, 'lvsRatio'); },
      },
      {
        key: 'totalOutStks', label: '発行済', num: true, grp: grp,
        title: 'その書類時点の発行済株式数です。分割前の書類には旧株数が入っています',
        html: function (r) { return numCell(r.totalOutStks, 0, 'lvsRatio'); },
      },
      {
        key: 'hldgPurpHead', label: '保有目的', grp: grp, sortable: false,
        html: function (r) {
          if (!r.hldgPurpHead) return '<span class="doubt-none">—</span>';
          return '<span title="' + esc(r.hldgPurpHead) + '">' +
            esc(String(r.hldgPurpHead).slice(0, 28)) + '</span>';
        },
      },
    ];
  }

  /** 詳細のグラフ。**欠測を0で描かない。** 系列ごとに欠測の意味が違う */
  function renderDetailCharts(ts) {
    var host = $('detailCharts');
    host.innerHTML = '';
    DemandChart.resetGroup('detail');
    if (ts.length === 0) {
      host.innerHTML = '<p class="chart-note">この期間にこの銘柄の株価の行がありません。</p>';
      return;
    }
    var dates = ts.map(function (r) { return r.weekStart; });
    function col(key) {
      return ts.map(function (r) {
        var v = r[key];
        return (v === null || v === undefined) ? null : Number(v);
      });
    }
    function card(spec) {
      var d = document.createElement('div');
      host.appendChild(d);
      spec.group = 'detail';
      spec.dates = dates;
      DemandChart.draw(d, spec);
    }

    // 終値は分割調整していない。水準が飛ぶ場所を黙って見せない
    var splitWeeks = ts.filter(function (r) { return r.splitFlag === 'Y'; })
      .map(function (r) { return r.weekStart; });

    card({
      title: '終値(週の最終営業日)',
      note: '分割調整をしていない生の値です' +
        (splitWeeks.length
          ? '。分割・併合のあった週(' + splitWeeks.join('・') + ')で水準が飛びます'
          : ''),
      series: [{
        name: '終値', values: col('weekClose'), mode: 'line',
        colorVar: '--series-1', digits: 1, unit: '円',
      }],
    });

    card({
      title: '週間出来高',
      note: '分割のあった週は株数の基準が変わっています',
      zeroBase: true,
      series: [{
        name: '出来高', values: col('weekVolume'), mode: 'line',
        colorVar: '--series-1', digits: 0, unit: '株',
      }],
    });

    card({
      title: '信用取引残高',
      note: '線が切れている週は残高ゼロではなく、JPXが公表していない週です(営業日2日以下のGW・年末年始)',
      zeroBase: true,
      series: [
        { name: '買残', values: col('marginLongVol'), mode: 'line', colorVar: '--series-1', digits: 0, unit: '株' },
        { name: '売残', values: col('marginShrtVol'), mode: 'line', colorVar: '--series-2', digits: 0, unit: '株' },
      ],
    });

    card({
      title: '信用倍率',
      note: '3月・9月はつなぎ売りで必ず下がります。倍率の低下をそのまま転換と読まないでください',
      series: [{
        name: '信用倍率', values: col('marginRatio'), mode: 'line',
        colorVar: '--series-1', digits: 2, unit: '倍',
      }],
    });

    // 空売り残高は報告者ごとの最新を持ち越した合計(ddl/21)なので、週ごとに連続した値になる。
    // 以前は「その週に報告した人の分」しか無く点で打っていたが、今は線で結んでよい
    var zeroNotEmpty = ts.some(function (r) {
      return r.shortStatus === '報告終了' || r.shortStatus === '古い報告のみ';
    });
    card({
      title: '空売り残高割合',
      note: '報告者ごとの最新の報告を持ち越した合計です(個人を除く)。線が無い週はまだ報告が1件も無い週です' +
        (zeroNotEmpty ? '。0の週は「全員が0.5%を割った」か「報告が' + P.shortStaleDays + '日以上前で失効扱い」で、残高ゼロとは限りません' : ''),
      zeroBase: true,
      series: [{
        name: '残高割合', values: col('shortRatioPct'), mode: 'line',
        colorVar: '--series-1', digits: 2, unit: '%',
      }],
    });
  }

  function openDetail(code) {
    state.detailCode = code;
    var weeks = $('detailWeeks').value;
    var row = (cache.sheet ? cache.sheet.rows : []).filter(function (r) {
      return r.code === code;
    })[0];
    $('detail').hidden = false;
    $('detailTitle').textContent = row ? row.code + ' ' + row.coName : code;
    $('detailSub').textContent = '読み込み中…';
    if (cache.sheet) renderSheet(cache.sheet);   // 選択行のハイライトを更新する
    $('detail').scrollIntoView({ block: 'nearest' });

    api('/api/demand/detail?code=' + encodeURIComponent(code) +
        '&weeks=' + encodeURIComponent(weeks))
      .then(function (d) {
        if (state.detailCode !== code) return;   // 連打されたときは後勝ち
        $('detailSub').textContent =
          d.timeseries.length + '週 / 保有グループ ' + d.holders.length +
          '件 / 提出履歴 ' + d.history.length + '行';
        renderDetailCharts(d.timeseries);
        renderTable($('holderTable'), holderCols(), d.holders, {});
        renderTable($('historyTable'), historyCols(), d.history, {});
      })
      .catch(function (e) { fail($('detailSub'), e); });
  }

  //---------------------------------------------------------------- 疑似浮動株比率
  function floatCols() {
    return [
      { key: 'code', label: 'コード', cls: 'code', grp: '疑似浮動株比率(近似)' },
      { key: 'coName', label: '銘柄名', cls: 'name', grp: '疑似浮動株比率(近似)' },
      {
        key: 'pseudoFloatPct', label: '疑似浮動株%', num: true, grp: '疑似浮動株比率(近似)',
        title: '(1 − 自己株式比率) × (1 − 上位株主の保有割合合計)。絶対値は信用せず、銘柄間の相対比較と経年の変化方向にだけ使ってください',
        html: function (r) { return numCell(r.pseudoFloatPct, 2, 'fin', '%'); },
      },
      {
        key: 'treasuryPct', label: '自己株式%', num: true, grp: '内訳',
        html: function (r) { return numCell(r.treasuryPct, 2, 'fin', '%'); },
      },
      {
        key: 'topHolderPct', label: '上位株主%', num: true, grp: '内訳',
        title: '大株主状況の書類に載っている株主の保有割合合計。信託口が含まれるぶん過小評価へ振れます',
        html: function (r) { return numCell(r.topHolderPct, 2, 'fin', '%'); },
      },
      {
        key: 'holderCnt', label: '株主数', num: true, grp: '内訳',
        html: function (r) { return numCell(r.holderCnt, 0, 'fin'); },
      },
      {
        key: 'sharesOutstanding', label: '発行済', num: true, grp: '内訳',
        html: function (r) { return numCell(r.sharesOutstanding, 0, 'fin'); },
      },
      {
        key: 'treasuryShares', label: '自己株式', num: true, grp: '内訳',
        html: function (r) { return numCell(r.treasuryShares, 0, 'fin'); },
      },
      {
        key: 'finPeriodEnd', label: '決算期末', grp: '出典',
        html: function (r) { return dateCell(r.finPeriodEnd, 'fin'); },
      },
      {
        key: 'msSubDate', label: '大株主状況', grp: '出典',
        title: '有価証券報告書ベースなので更新は年1回です',
        html: function (r) { return dateCell(r.msSubDate, 'fin'); },
      },
    ];
  }

  function loadPseudoFloat() {
    if (cache.float) return;
    api('/api/demand/pseudo-float').then(function (d) {
      cache.float = d;
      renderTable($('floatTable'), floatCols(), d.rows, {});
    }).catch(function (e) {
      $('floatTable').querySelector('tbody').innerHTML =
        '<tr><td class="dim">' + esc(e.message) + '</td></tr>';
    });
  }

  //================================================================ 第一階層
  function macroCols() {
    return [
      { key: 'weekStart', label: '週(月曜)', grp: '週' },
      {
        key: 'topixClose', label: 'TOPIX', grp: '指数', num: true,
        html: function (r) { return numCell(r.topixClose, 2, 'generic'); },
      },
      {
        key: 'topixWowPct', label: '前週比', grp: '指数', num: true,
        html: function (r) { return signedCell(r.topixWowPct, 2, 'generic', '%'); },
      },
      {
        key: 'gvRatio', label: 'G/V', grp: '指数', num: true,
        title: 'グロース指数 ÷ バリュー指数。上昇はグロース優位',
        html: function (r) { return numCell(r.gvRatio, 4, 'generic'); },
      },
      {
        key: 'gvRatioWow', label: '前週比', grp: '指数', num: true,
        html: function (r) { return signedCell(r.gvRatioWow, 2, 'generic', '%'); },
      },
      {
        key: 'elecWowPct', label: '電機', grp: '指数', num: true,
        title: '電気機器指数の前週比',
        html: function (r) { return signedCell(r.elecWowPct, 2, 'generic', '%'); },
      },
      {
        key: 'frgnOku', label: '海外', grp: '投資部門別ネット(億円)', num: true,
        title: 'プラスが買い越し。空欄はこの区分のその週のデータがありません(0ではありません)',
        html: function (r) { return signedCell(r.frgnOku, 0, 'inv'); },
      },
      {
        key: 'frgnWowOku', label: '海外前週差', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.frgnWowOku, 0, 'inv'); },
      },
      {
        key: 'indOku', label: '個人', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.indOku, 0, 'inv'); },
      },
      {
        key: 'trstBnkOku', label: '信託銀行', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.trstBnkOku, 0, 'inv'); },
      },
      {
        key: 'busCoOku', label: '事業法人', grp: '投資部門別ネット(億円)', num: true,
        html: function (r) { return signedCell(r.busCoOku, 0, 'inv'); },
      },
      {
        key: 'arbNetOku', label: '裁定ネット', grp: '裁定取引残高(億円)', num: true,
        title: '買残 − 売残。増加は将来の解消売り圧力の蓄積で、強気とは限りません',
        html: function (r) { return signedCell(r.arbNetOku, 0, 'arb'); },
      },
      {
        key: 'arbNetWowOku', label: '前週差', grp: '裁定取引残高(億円)', num: true,
        html: function (r) { return signedCell(r.arbNetWowOku, 0, 'arb'); },
      },
      {
        key: 'marginRatio', label: '信用倍率', grp: '信用取引残高(金額)', num: true,
        title: '申込日終値で金額換算してから合計した倍率。低いほど売り長。3月・9月はつなぎ売りで必ず下がります',
        html: function (r) { return numCell(r.marginRatio, 2, 'margin'); },
      },
      {
        key: 'marginRatioWow', label: '前週差', grp: '信用取引残高(金額)', num: true,
        html: function (r) { return signedCell(r.marginRatioWow, 2, 'margin'); },
      },
      {
        key: 'marginLongOku', label: '買残(億円)', grp: '信用取引残高(金額)', num: true,
        html: function (r) { return numCell(r.marginLongOku, 0, 'margin'); },
      },
      {
        key: 'marginShrtOku', label: '売残(億円)', grp: '信用取引残高(金額)', num: true,
        html: function (r) { return numCell(r.marginShrtOku, 0, 'margin'); },
      },
      {
        key: 'marginCodesCnt', label: '銘柄数', grp: '信用取引残高(金額)', num: true,
        title: '集計に入った銘柄数。急に減った週は取込を疑ってください',
        html: function (r) { return numCell(r.marginCodesCnt, 0, 'margin'); },
      },
      {
        key: 'shortRatioPct', label: '空売り比率', grp: '空売り', num: true,
        title: '高いほど売り圧力が強い一方で、極端な高水準は反転の目印にもなります',
        html: function (r) { return numCell(r.shortRatioPct, 2, 'generic', '%'); },
      },
      {
        key: 'shortRatioWow', label: '前週差', grp: '空売り', num: true,
        html: function (r) { return signedCell(r.shortRatioWow, 2, 'generic', 'pt'); },
      },
    ];
  }

  var macroState = { cols: null, rows: [] };

  function renderMacroCharts(rows) {
    var host = $('macroCharts');
    host.innerHTML = '';
    DemandChart.resetGroup('macro');
    if (rows.length === 0) return;
    var dates = rows.map(function (r) { return r.weekStart; });
    function col(key) {
      return rows.map(function (r) {
        var v = r[key];
        return (v === null || v === undefined) ? null : Number(v);
      });
    }
    function card(spec) {
      var d = document.createElement('div');
      host.appendChild(d);
      spec.group = 'macro';
      spec.dates = dates;
      DemandChart.draw(d, spec);
    }

    card({
      title: 'TOPIX(週の最終営業日)',
      note: '地合いの物差し。手元のデータは上昇相場10年分しかありません',
      series: [{ name: 'TOPIX', values: col('topixClose'), mode: 'line', colorVar: '--series-1', digits: 2 }],
    });

    card({
      title: '投資部門別ネット(億円)',
      note: 'プラスが買い越し。線が切れている週はこの区分のデータがありません(0ではありません)。' +
        '2022年4月の市場区分再編で系列が断絶しているので、長期は TokyoNagoya で見ます',
      zeroBase: true,
      height: 150,
      series: [
        { name: '海外', values: col('frgnOku'), mode: 'line', colorVar: '--series-1', digits: 0, unit: '億円' },
        { name: '個人', values: col('indOku'), mode: 'line', colorVar: '--series-2', digits: 0, unit: '億円' },
        { name: '信託銀行', values: col('trstBnkOku'), mode: 'line', colorVar: '--series-3', digits: 0, unit: '億円' },
        { name: '事業法人', values: col('busCoOku'), mode: 'line', colorVar: '--series-4', digits: 0, unit: '億円' },
      ],
    });

    card({
      title: '裁定取引残高ネット(億円)',
      note: '増加は将来の解消売り圧力の蓄積で、両義的に読みます。' +
        'JPXの週間資料を手動取込しており、バックナンバーが直近4年分しかないためそれ以前は空です',
      zeroBase: true,
      series: [{ name: '裁定ネット', values: col('arbNetOku'), mode: 'line', colorVar: '--series-1', digits: 0, unit: '億円' }],
    });

    card({
      title: '信用倍率(金額ベース)',
      note: '低いほど売り長で踏み上げ余地が大きい。ただし3月・9月はつなぎ売りで必ず下がります',
      series: [{ name: '信用倍率', values: col('marginRatio'), mode: 'line', colorVar: '--series-1', digits: 2, unit: '倍' }],
    });

    card({
      title: '空売り比率(%)',
      note: '高いほど売り圧力が強い一方で、極端な高水準は反転の目印にもなります',
      series: [{ name: '空売り比率', values: col('shortRatioPct'), mode: 'line', colorVar: '--series-1', digits: 2, unit: '%' }],
    });
  }

  function loadMacro(force) {
    var section = $('macroSection').value || 'TokyoNagoya';
    var weeks = $('macroWeeks').value || '52';
    var key = 'macro:' + section + ':' + weeks;
    if (cache[key] && !force) { renderMacro(cache[key]); return; }
    setStatus($('macroStatus'), '読み込み中…');
    api('/api/demand/macro?section=' + encodeURIComponent(section) +
        '&weeks=' + encodeURIComponent(weeks))
      .then(function (d) {
        cache[key] = d;
        renderMacro(d);
      })
      .catch(function (e) { setStatus($('macroStatus'), e.message, true); });
  }

  function renderMacro(d) {
    var cols = macroCols();
    macroState = { cols: cols, rows: d.rows };
    setStatus($('macroStatus'), d.count + '週');

    // 系列をはみ出した期間・終了した系列の警告。黙ってNULLが並ぶのを防ぐ
    var notice = $('macroNotice');
    if (d.notice && d.notice.length) {
      notice.hidden = false;
      notice.innerHTML = '<span class="pct down">⚠</span> ' +
        d.notice.map(function (s) { return esc(s); }).join('<br>');
    } else {
      notice.hidden = true;
      notice.innerHTML = '';
    }

    // 表は新しい週が上、グラフは古い週が左
    renderMacroCharts(d.rows.slice().reverse());
    renderTable($('macroTable'), cols, d.rows, {});
  }

  //================================================================ 鮮度の読み込み
  function loadFreshness() {
    api('/api/demand/freshness').then(function (d) {
      renderFreshness(d.rows);
    }).catch(function (e) {
      $('freshnessList').innerHTML = '<span class="status error">' + esc(e.message) + '</span>';
    });
  }

  //================================================================ 起動
  function renderDataMeta() {
    var parts = [];
    if (meta.watchlist) parts.push('ウォッチ ' + meta.watchlist.length + '銘柄');
    if (meta.lvsDocs && meta.lvsDocs.docsCnt) {
      parts.push('大量保有 ' + meta.lvsDocs.codesWithDoc + '銘柄 / ' + meta.lvsDocs.docsCnt + '件');
    }
    $('dataMeta').textContent = parts.join(' ・ ');
  }

  function fillSections() {
    var sel = $('macroSection');
    sel.innerHTML = (meta.sections || []).map(function (s) {
      return '<option value="' + esc(s.section) + '">' + esc(s.section) +
        '(' + esc(s.fromDate) + '〜' + esc(s.toDate) + ')</option>';
    }).join('');
    // 市場区分再編をまたいで連続している唯一の系列を既定にする
    var has = (meta.sections || []).some(function (s) { return s.section === 'TokyoNagoya'; });
    if (has) sel.value = 'TokyoNagoya';
  }

  function init() {
    LOADERS.signal = loadSignals;
    LOADERS.watchlist = loadWatchlist;
    LOADERS.macro = loadMacro;

    $('tabs').addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('.tab') : null;
      if (t) showTab(t.getAttribute('data-tab'));
    });

    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      this.textContent = next === 'dark' ? 'ライト' : 'ダーク';
    });

    // 再読み込み。サーバ側に5分のキャッシュがあるので、押した直後も同じ値のことがある
    $('reloadBtn').addEventListener('click', function () {
      cache = {};
      loadFreshness();
      if (LOADERS[state.tab]) LOADERS[state.tab](true);
    });

    // 重いもの・日々見ないものは開いたときに初めて取りに行く
    $('suppDetails').addEventListener('toggle', function () {
      if (this.open) loadSupplementary();
    });
    $('floatDetails').addEventListener('toggle', function () {
      if (this.open) loadPseudoFloat();
    });
    $('allRunBtn').addEventListener('click', loadSignalsAll);

    $('signalCsvBtn').addEventListener('click', function () {
      if (signalState.cols) downloadCsv('demand_signals', signalState.cols, signalState.rows);
    });
    $('allCsvBtn').addEventListener('click', function () {
      if (allState.cols) downloadCsv('demand_signals_all', allState.cols, allState.rows);
    });
    $('sheetCsvBtn').addEventListener('click', function () {
      if (sheetState.cols) downloadCsv('demand_watchlist', sheetState.cols, sheetState.rows);
    });
    $('macroCsvBtn').addEventListener('click', function () {
      if (macroState.cols) downloadCsv('demand_macro', macroState.cols, macroState.rows);
    });

    $('macroSection').addEventListener('change', function () { loadMacro(); });
    $('macroWeeks').addEventListener('change', function () { loadMacro(); });

    $('detailWeeks').addEventListener('change', function () {
      if (state.detailCode) openDetail(state.detailCode);
    });
    $('detailClose').addEventListener('click', function () {
      state.detailCode = null;
      $('detail').hidden = true;
      if (cache.sheet) renderSheet(cache.sheet);
    });

    loadFreshness();

    api('/api/demand/meta').then(function (m) {
      meta = m;
      P = m.params || {};
      renderDataMeta();
      renderCalib();
      fillSections();
      var hash = (location.hash || '').replace('#', '');
      showTab(['signal', 'watchlist', 'macro'].indexOf(hash) >= 0 ? hash : 'signal');
    }).catch(function (e) {
      fail($('dataMeta'), e);
      // しきい値が取れないと「疑う列」の判定ができない。点灯だけ出すより黙って止める
      $('signalCount').innerHTML =
        '<span class="status error">しきい値を取得できなかったため表示していません。' +
        'この状態で点灯だけを出すと「疑う列」の判定ができません。</span>';
    });
  }

  init();
})();
