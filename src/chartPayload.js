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
 * 材料(原油・金利など)を重ねるときは ext を渡す。値は株価と同じ dates の並びに合わせ、
 * 国内の営業日に無い日の値は落とす(グラフは指数表示でだけ重ねるので、水準は揃えなくてよい)。
 *
 * @param {{code:string,name:string,market:string,date:string,adjClose:number,isSplit:number}[]} rows
 * @param {string[]} orderedCodes 表示したい順の銘柄コード
 * @param {object} meta from / to / source など、そのままペイロードに載せる情報
 * @param {{defs:{code:string,label:string,unit:string,dec:number}[], rows:{code:string,date:string,value:number}[]}} [ext]
 * @returns {{dates:string[], series:object[], ext:object[]}}
 */
function buildPayload(rows, orderedCodes, meta, ext) {
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

  const extOut = [];
  if (ext && ext.defs && ext.defs.length) {
    const byExt = new Map();
    for (const r of ext.rows || []) {
      const i = dateIndex.get(r.date);
      if (i === undefined) continue;          // 国内の営業日に無い日
      if (!byExt.has(r.code)) byExt.set(r.code, new Array(dates.length).fill(null));
      byExt.get(r.code)[i] = r.value;
    }
    for (const def of ext.defs) {
      const values = byExt.get(def.code);
      if (values) extOut.push({ ...def, values });
    }
  }

  return { ...meta, dates, series, ext: extOut };
}

module.exports = { buildPayload };
