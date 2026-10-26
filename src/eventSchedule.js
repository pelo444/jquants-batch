'use strict';

/**
 * 材料(/events)の取得元ごとの「元のサイトでいつ頃更新されるか」の定義。
 * 取込(src/loadEventCalendar.js)の時刻(VM の cron、日本時間 7:30 と 14:00)はこの表から決めた。
 * 画面(/events の「取得元と更新の時刻」)にもこの表を出す。設計は Project の claude/event_calendar_design.md。
 *
 * 時刻は元の時刻帯(tz)で持ち、日本時間は表示する日の夏時間・冬時間に合わせてその都度計算する。
 *   day: 対象日から何営業日後に出るか(0 = 当日、1 = 翌営業日)
 *   time: 元の時刻帯での時刻 'HH:MM'。決まった時刻が無いものは null
 *   basis: その時刻の根拠(2026-10-25 に確かめたもの)
 *
 * 実際に入った時刻は EXT_SERIES_DAILY.FIRST_LOADED_AT(ddl/35)に残る。取込は1日2回なので、
 * 分かるのは「どの回で初めて入ったか」まで。
 */

const SCHEDULE = [
  { key: 'DGS2', codes: ['DGS2', 'DGS10'], label: '米2年・10年金利', source: 'FRED(元は FRB の H.15)',
    tz: 'America/Chicago', day: 1, time: '15:16',
    basis: 'FRED の更新時刻が 2026-10-23 15:16(米中部)の時点で、最新が 10/22 の分' },
  { key: 'T10YIE', codes: ['T10YIE'], label: '期待インフレ率(10年)', source: 'FRED',
    tz: 'America/Chicago', day: 0, time: '16:03',
    basis: 'FRED の更新時刻が 2026-10-23 16:03(米中部)の時点で、最新が 10/23 の分' },
  { key: 'JGB', codes: ['JGB10', 'JGB20'], label: '日本10年・20年金利', source: '財務省(国債金利情報)',
    tz: 'Asia/Tokyo', day: 1, time: '09:30',
    basis: '財務省の FAQ「翌営業日午前9時30分頃」。別のページ(p220226)には「翌営業日午前11時頃」とある' },
  { key: 'FUT', codes: ['CL=F', 'BZ=F'], label: 'WTI・ブレント先物', source: 'Yahoo(CME の先物)',
    tz: 'America/New_York', day: 0, time: '17:00', reopen: '18:00',
    basis: '先物の1日の取引が終わる時刻。18:00 に次の取引が始まる。Yahoo に載るまでの遅れは未確認' },
  { key: 'FX', codes: ['JPY=X'], label: 'ドル円', source: 'Yahoo',
    tz: null, day: 0, time: null,
    basis: '24時間動く。Yahoo の日付の区切りは未確認' },
  { key: 'IDX', codes: ['^SOX', '^BKX'], label: 'SOX・KBW銀行株指数', source: 'Yahoo',
    tz: 'America/New_York', day: 0, time: '16:00',
    basis: '米国の株の取引が終わる時刻。Yahoo に載るまでの遅れは未確認' },
  { key: 'CBOE', codes: ['^VIX', '^SKEW'], label: 'VIX・SKEW', source: 'Yahoo(元は Cboe)',
    tz: 'America/New_York', day: 0, time: '16:15',
    basis: 'S&P500 のオプションの取引が終わる時刻。Yahoo に載るまでの遅れは未確認' },
  { key: 'HY', codes: ['BAMLH0A0HYM2'], label: 'ハイイールド債の上乗せ金利', source: 'FRED(元は ICE)',
    tz: 'America/Chicago', day: 1, time: '08:34',
    basis: 'FRED の更新時刻が 2026-10-23 8:34(米中部)の時点で、最新が 10/22 の分' },
  { key: 'CRWV', codes: ['CRWV_975_2031'], label: 'コアウィーブ社債利回り', source: 'FINRA(TRACE)',
    tz: 'America/New_York', day: 1, time: '00:00', originalText: 'その日(米東部)が終わったあと',
    basis: '約定は15分以内に公表される。取込はその日(米国の日付)が終わってから入れる' },
  { key: 'CPI', codes: ['CPIAUCSL'], label: 'CPI', source: 'BLS(取得は FRED・ALFRED)',
    tz: 'America/New_York', day: 0, time: '08:30', release: true,
    basis: 'BLS の 2026年の予定表(発表日は 10/14・11/10・12/10)。発表日に出る' },
  { key: 'SEC', codes: [], label: '決算の提出書類', source: 'SEC EDGAR',
    tz: null, day: 0, time: null, filing: true,
    basis: '提出は随時。受付時刻は EDGAR の受付日時(EARNINGS_FILING.ACCEPTANCE_AT)に残る' },
  { key: 'RECAP', codes: [], label: '東京の概況リンク', source: '取りに行かない(リンクを作るだけ)',
    tz: 'Asia/Tokyo', day: 0, time: '18:30', recap: true,
    basis: 'DB に TOPIX の終値がある日に出る。TOPIX は VM の J-Quants の取込(平日 18:30)で入る' },
];

/** tz の時刻帯の時差(分)。instant はその時点のミリ秒 */
function tzOffsetMin(instant, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - Math.floor(instant / 60000) * 60000) / 60000);
}

/** tz の ymd hh:mm が指す時点(ミリ秒) */
function wallToInstant(ymd, hhmm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMin(guess, tz) * 60000;
  t = guess - tzOffsetMin(t, tz) * 60000; // 夏時間の切り替わりの近くで1回直す
  return t;
}

const DAY_WORD = ['当日', '翌日', '翌々日', '3日後'];
const SRC_DAY_WORD = ['当日', '翌営業日'];
const TZ_WORD = { 'America/Chicago': '米中部', 'America/New_York': '米東部', 'Asia/Tokyo': '日本' };

/**
 * 1行の表示用の文。refYmd(対象日にあたる日。既定は今日)の夏時間・冬時間で日本時間を出す。
 * 週末や祝日をはさむと、その分遅れる(ここでは数えない)。
 */
function describe(s, refYmd) {
  if (!s.time) return { original: s.key === 'SEC' ? '随時' : '24時間', jst: '—' };
  const original = s.originalText || `${SRC_DAY_WORD[s.day] || s.day + '営業日後'} ${s.time}(${TZ_WORD[s.tz] || s.tz})`;
  if (s.tz === 'Asia/Tokyo') return { original, jst: `${DAY_WORD[s.day]} ${Number(s.time.slice(0, 2))}:${s.time.slice(3)}頃` };
  const [y, m, d] = refYmd.split('-').map(Number);
  const pub = new Date(Date.UTC(y, m - 1, d + s.day)).toISOString().slice(0, 10);
  const t = wallToInstant(pub, s.time, s.tz);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const jstYmd = `${p.year}-${p.month}-${p.day}`;
  const diff = Math.round((Date.parse(jstYmd) - Date.parse(refYmd)) / 86400000);
  return { original, jst: `${DAY_WORD[diff] || diff + '日後'} ${Number(p.hour)}:${p.minute}頃` };
}

/** 系列の1日の取引が終わる時刻 {tz, time}。当日に出る(day 0)もので、時刻があるものだけ */
function closeOf(code) {
  const s = SCHEDULE.find((x) => x.codes.includes(code));
  if (!(s && s.day === 0 && s.time && s.tz)) return null;
  return s.reopen ? { tz: s.tz, time: s.time, reopen: s.reopen } : { tz: s.tz, time: s.time };
}

module.exports = { SCHEDULE, describe, closeOf, wallToInstant, tzOffsetMin };
