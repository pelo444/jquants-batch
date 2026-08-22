'use strict';

/**
 * 取得した株価の行データを、chartHtml.js が受け取る形のペイロードに変換する。
 *
 * CLI(chart.js)とWebサーバー(web/server.js)の両方から使うため独立させている。
 *
 * 日付は全銘柄で共通の配列(dates)にまとめ、各銘柄の値はその配列と同じ長さの
 * 配列(欠損はnull)にする。こうすることで
 *   ・出力HTMLのサイズが小さくなる(日付文字列を銘柄ごとに持たない)
 *   ・全グラフのクロスヘアを同じ日付で同期できる
 *
 * @param {{code:string,name:string,market:string,date:string,adjClose:number,isSplit:number}[]} rows
 * @param {string[]} orderedCodes 表示したい順の銘柄コード
 * @param {object} meta from / to / source など、そのままペイロードに載せる情報
 * @returns {{dates:string[], series:object[]}}
 */
function buildPayload(rows, orderedCodes, meta) {
  const dateSet = new Set();
  for (const r of rows) dateSet.add(r.date);
  const dates = Array.from(dateSet).sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  const byCode = new Map();
  for (const r of rows) {
    let s = byCode.get(r.code);
    if (!s) {
      s = {
        code: r.code,
        name: r.name,
        market: r.market,
        splits: 0,
        values: new Array(dates.length).fill(null),
      };
      byCode.set(r.code, s);
    }
    s.values[dateIndex.get(r.date)] = r.adjClose;
    if (r.isSplit === 1) s.splits++;
  }

  const series = [];
  orderedCodes.forEach((code, order) => {
    const s = byCode.get(code);
    if (s) {
      s.order = order;
      series.push(s);
    }
  });

  return { ...meta, dates, series };
}

module.exports = { buildPayload };
