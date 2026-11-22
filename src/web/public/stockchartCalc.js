/*
 * 個別チャート(/stockchart)の計算だけを置く(描画はしない)。ブラウザと node(tests/stockChart.test.js)の両方で使う。
 *
 *   aggregate   日足を週足・月足にまとめる
 *   sma         単純移動平均
 *   bollinger   ボリンジャーバンド(中心線と標準偏差)
 *   pivots      高安値表示(山と谷)の位置を決める
 *   niceTicks   軸の目盛り
 *   attachMargin / attachEarnings  信用残・決算発表日を足の位置に当てる
 *   volumeProfile  価格帯別出来高(どの価格帯でどれだけ売買が成立したか)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StockChartCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function utc(ymd) { return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)); }
  function dayDiff(a, b) { return Math.round((utc(b) - utc(a)) / 86400000); }

  /** その日を含む週の月曜日(YYYY-MM-DD)。週足の区切りに使う */
  function weekKey(ymd) {
    var t = new Date(utc(ymd));
    var wd = (t.getUTCDay() + 6) % 7; // 月=0 … 日=6
    t.setUTCDate(t.getUTCDate() - wd);
    return t.toISOString().slice(0, 10);
  }

  /**
   * 日足をまとめる。
   * @param {{d:string[],o:number[],h:number[],l:number[],c:number[],v:number[]}} day 昇順
   * @param {'d'|'w'|'m'} tf 日足・週足・月足
   * @returns {{d:string[],d0:string[],o:number[],h:number[],l:number[],c:number[],v:number[],hd:string[],ld:string[]}}
   *   d = その足の最後の営業日、d0 = 最初の営業日、hd / ld = 高値・安値を付けた日
   */
  function aggregate(day, tf) {
    var out = { d: [], d0: [], o: [], h: [], l: [], c: [], v: [], hd: [], ld: [] };
    var n = day.d.length;
    var prevKey = null;
    var j = -1;
    for (var i = 0; i < n; i++) {
      var date = day.d[i];
      var key = tf === 'w' ? weekKey(date) : tf === 'm' ? date.slice(0, 7) : date;
      if (key !== prevKey) {
        prevKey = key;
        j++;
        out.d0[j] = date; out.o[j] = day.o[i];
        out.h[j] = day.h[i]; out.hd[j] = date;
        out.l[j] = day.l[i]; out.ld[j] = date;
        out.v[j] = 0;
      }
      if (day.h[i] > out.h[j]) { out.h[j] = day.h[i]; out.hd[j] = date; }
      if (day.l[i] < out.l[j]) { out.l[j] = day.l[i]; out.ld[j] = date; }
      out.d[j] = date; out.c[j] = day.c[i];
      out.v[j] += day.v[i] || 0;
    }
    return out;
  }

  /** 単純移動平均。本数が足りない位置は null */
  function sma(values, len) {
    var n = values.length;
    var out = new Array(n);
    var s = 0;
    for (var i = 0; i < n; i++) {
      s += values[i];
      if (i >= len) s -= values[i - len];
      out[i] = i >= len - 1 ? s / len : null;
    }
    return out;
  }

  /**
   * 高安値表示の位置。表示している範囲 [i0, i1) の中で決める。
   *   1. 前後 k 本の中でいちばん高い高値を「山」、いちばん低い安値を「谷」とする(範囲の端では、ある分だけで比べる)
   *   2. 山と山が続くところには、その間のいちばん低い安値を谷として入れる(谷と谷の間も同じ)
   * こうすると山と谷が交互に並ぶ。株探の「高安値表示」と同じ位置になることを 6613 の 2026/5〜11 で確認した(k = 9)。
   * @returns {Array<{i:number,type:'H'|'L'}>} 位置の昇順
   */
  function pivots(h, l, i0, i1, k) {
    var out = [];
    if (i1 - i0 < 2) return out;
    var i, j, a, b, isH, isL;
    for (i = i0; i < i1; i++) {
      a = Math.max(i0, i - k); b = Math.min(i1 - 1, i + k);
      isH = true; isL = true;
      for (j = a; j <= b && (isH || isL); j++) {
        if (j === i) continue;
        // 同じ値が並ぶときは最初の1本だけを採る
        if (h[j] > h[i] || (h[j] === h[i] && j < i)) isH = false;
        if (l[j] < l[i] || (l[j] === l[i] && j < i)) isL = false;
      }
      // 1本が山と谷の両方になったら(値幅の大きい1本)、直前と交互になる方を採る
      if (isH && isL) {
        var prev = out.length ? out[out.length - 1].type : 'L';
        out.push({ i: i, type: prev === 'H' ? 'L' : 'H' });
      } else if (isH) out.push({ i: i, type: 'H' });
      else if (isL) out.push({ i: i, type: 'L' });
    }

    function extreme(from, to, type) { // [from, to] の中の、いちばん高い高値 / 低い安値
      var best = -1;
      for (var x = from; x <= to; x++) {
        if (best < 0 || (type === 'H' ? h[x] > h[best] : l[x] < l[best])) best = x;
      }
      return best;
    }
    function other(t) { return t === 'H' ? 'L' : 'H'; }

    // 2. 同じ種類が続くところに、反対の種類を入れる
    var merged = [];
    for (i = 0; i < out.length; i++) {
      var cur = out[i];
      var last = merged[merged.length - 1];
      if (last && last.type === cur.type) {
        if (cur.i - last.i >= 2) {
          merged.push({ i: extreme(last.i + 1, cur.i - 1, other(cur.type)), type: other(cur.type) });
        } else {
          // 隣り合う2本が同じ種類: 値の大きい(小さい)方だけ残す
          var keepCur = cur.type === 'H' ? h[cur.i] > h[last.i] : l[cur.i] < l[last.i];
          if (keepCur) merged[merged.length - 1] = cur;
          continue;
        }
      }
      merged.push(cur);
    }
    return merged;
  }

  /**
   * ボリンジャーバンド。中心線は単純移動平均、幅は母標準偏差(len 個の値そのもののばらつき = N で割る)。
   * 返すのは中心線と標準偏差だけ。±1σ・±2σ の線は画面側で mid ± k * sd として作る。
   * @returns {{mid:Array<number|null>, sd:Array<number|null>}}
   */
  function bollinger(values, len) {
    var n = values.length;
    var mid = new Array(n), sd = new Array(n);
    for (var i = 0; i < n; i++) {
      if (i < len - 1) { mid[i] = null; sd[i] = null; continue; }
      var s = 0, j;
      for (j = i - len + 1; j <= i; j++) s += values[j];
      var m = s / len;
      var q = 0;
      for (j = i - len + 1; j <= i; j++) q += (values[j] - m) * (values[j] - m);
      mid[i] = m;
      sd[i] = Math.sqrt(q / len);
    }
    return { mid: mid, sd: sd };
  }

  /** raw 以上でいちばん近い、1・2・2.5・5 × 10^n の刻み */
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  /** 軸の目盛り(1・2・2.5・5 × 10^n の刻み)。min〜max の中に入るものだけ返す */
  function niceTicks(min, max, target) {
    if (!(max > min)) return { step: 1, ticks: [min] };
    var step = niceStep((max - min) / Math.max(1, target));
    var ticks = [];
    var start = Math.ceil(min / step - 1e-9) * step;
    for (var v = start; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step + 0); // + 0 は -0 を 0 にするため
    return { step: step, ticks: ticks };
  }

  /** date 以上の d を持つ最初の足の位置(無ければ -1)。bars.d は昇順 */
  function barIndexOnOrAfter(dates, date) {
    var lo = 0, hi = dates.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (dates[mid] < date) lo = mid + 1; else hi = mid; }
    return lo < dates.length ? lo : -1;
  }

  /**
   * 信用残を足の位置に当てる。1本の足に複数の申込日が入るとき(週足・月足)は、その足の最後の申込日の値。
   * @returns {Array<{i:number,d:string,long:number,short:number}>} 位置の昇順(値がある足だけ)
   */
  function attachMargin(bars, margin) {
    var out = [];
    if (!margin || !margin.d) return out;
    for (var k = 0; k < margin.d.length; k++) {
      var date = margin.d[k];
      if (bars.d0.length === 0 || date < bars.d0[0]) continue;
      // 申込日を含む足(足の最後の日が申込日以降になる最初の足)。株価が無い日の申込分は次の足に寄せない
      var i = barIndexOnOrAfter(bars.d, date);
      if (i < 0 || bars.d0[i] > date) {
        // その日に足が無い(値が付かなかった日など): 直前の足に当てる
        i = (i < 0 ? bars.d.length : i) - 1;
        if (i < 0) continue;
      }
      var p = { i: i, d: date, long: margin.long[k], short: margin.short[k] };
      if (out.length && out[out.length - 1].i === i) out[out.length - 1] = p;
      else out.push(p);
    }
    return out;
  }

  /**
   * 決算発表日を足の位置に当てる。発表日が営業日でないときは次の足。1本の足に複数入るときはまとめる。
   * @returns {Array<{i:number,items:Array<{d:string,time:string,label:string}>}>}
   */
  function attachEarnings(bars, earnings) {
    var out = [];
    (earnings || []).forEach(function (e) {
      if (bars.d0.length === 0 || e.d < bars.d0[0]) return;
      var i = barIndexOnOrAfter(bars.d, e.d);
      if (i < 0) return;
      if (out.length && out[out.length - 1].i === i) out[out.length - 1].items.push(e);
      else out.push({ i: i, items: [e] });
    });
    return out;
  }

  /**
   * 価格帯別出来高。日足のうち from〜to の日について、1日の出来高を その日の安値〜高値 に均等に配り、価格帯ごとに足し上げる。
   *   手元には日足しかない(1件ごとの約定や分足が無い)ので、1日の中でどの値段で売買されたかは分からない。
   *   安値〜高値に均等に配るのは、日足から描くチャートソフトの多くと同じ近似。
   *   安値 = 高値 の日(値幅が0)は、その値段を含む帯に全部入れる。
   * 帯の幅は (期間の高値 − 安値) ÷ targetBins を 1・2・2.5・5 × 10^n に丸めたもの。帯の境目はその幅の倍数にそろえる。
   * 帯は下から上へ [p0, p1)。いちばん上の帯だけ p1 を含む。
   * @param {{d:string[],h:number[],l:number[],v:number[]}} day 日足(昇順)
   * @returns {null|{from:string,to:string,days:number,step:number,total:number,bins:Array<{p0:number,p1:number,v:number}>}}
   */
  function volumeProfile(day, from, to, targetBins) {
    var a = barIndexOnOrAfter(day.d, from);
    if (a < 0 || day.d[a] > to) return null;
    var e = a, lo = Infinity, hi = -Infinity, i;
    for (; e < day.d.length && day.d[e] <= to; e++) {
      if (day.l[e] < lo) lo = day.l[e];
      if (day.h[e] > hi) hi = day.h[e];
    }
    var step = hi > lo ? niceStep((hi - lo) / Math.max(1, targetBins)) : niceStep(Math.max(hi, 1) * 0.01);
    var base = Math.floor(lo / step + 1e-9) * step;
    var count = Math.max(1, Math.ceil((hi - base) / step - 1e-9));
    var vol = new Array(count);
    for (i = 0; i < count; i++) vol[i] = 0;
    function binOf(price, upper) { // upper: 帯の上端ちょうどの値段は下の帯に入れる(値幅の上端)
      var k = Math.floor((price - base) / step + (upper ? -1e-9 : 1e-9));
      return Math.max(0, Math.min(count - 1, k));
    }
    var total = 0;
    for (i = a; i < e; i++) {
      var v = day.v[i];
      if (!v) continue;
      var l = day.l[i], h = day.h[i];
      total += v;
      if (!(h > l)) { vol[binOf(l, false)] += v; continue; }
      var k0 = binOf(l, false), k1 = Math.max(k0, binOf(h, true));
      for (var k = k0; k <= k1; k++) {
        var over = Math.min(h, base + (k + 1) * step) - Math.max(l, base + k * step);
        if (over > 0) vol[k] += v * over / (h - l);
      }
    }
    var dec = step >= 1 ? 0 : 6;
    function r(x) { return dec ? Math.round(x * 1e6) / 1e6 : Math.round(x); }
    var bins = [];
    for (i = 0; i < count; i++) bins.push({ p0: r(base + i * step), p1: r(base + (i + 1) * step), v: vol[i] });
    return { from: day.d[a], to: day.d[e - 1], days: e - a, step: step, total: total, bins: bins };
  }

  return {
    volumeProfile: volumeProfile, niceStep: niceStep,
    aggregate: aggregate, sma: sma, bollinger: bollinger, pivots: pivots, niceTicks: niceTicks,
    attachMargin: attachMargin, attachEarnings: attachEarnings,
    weekKey: weekKey, dayDiff: dayDiff, barIndexOnOrAfter: barIndexOnOrAfter,
  };
});
