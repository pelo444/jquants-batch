'use strict';

/**
 * 需給3階層(マクロ / ウォッチリスト / シグナル)のデータ取得。
 *
 * 元になっているSQL:
 *   第一階層 queries/sql/demand_macro_dashboard.sql   の 1・7
 *   第二階層 queries/sql/demand_watchlist_sheet.sql   の 1・2・3・4・6・7
 *   第三階層 queries/sql/demand_signal_detection.sql  の 1・2・3・4
 *
 * ------------------------------------------------------------------
 * 【queries/sql/*.sql との関係(必ず読むこと)】
 *
 *   同じ判定ロジックが2箇所にある状態になる。これは
 *   「同じテーブルを同じ意味で読むのだから、読み方が食い違っていること自体がバグ」
 *   (docs/DEMAND_SIGNAL_RUNBOOK.md / project memory: demand_three_layer)
 *   に真っ向から反する。放っておくと必ずずれるので、次の2つで縛っている。
 *
 *     1. しきい値は下の PARAMS だけに書く。SQL文字列にも列ラベルにも数値を書かない。
 *     2. scripts/check-demand-params.js が queries/sql/*.sql の params CTE を読んで
 *        PARAMS と突き合わせる。ずれたら落ちる。しきい値を動かしたら両方直すこと。
 *
 *   役割分担:
 *     queries/sql/*.sql … 較正(05〜11)と ad hoc の調査。claude-query.js で流す。
 *     このファイル       … 日々の運用(Webアプリ)。
 *
 * ------------------------------------------------------------------
 * 【SQL本文の差分(意図的に変えたところ)】
 *
 *   (a) LISTAGG に ON OVERFLOW TRUNCATE ... WITH COUNT を付けた。
 *       .sql 側で付けていないのは scripts/claude-query.js が禁止キーワードを
 *       コメントも含めた単語一致で判定するためで、ここにはその制約が無い
 *       (project memory: cowork_device_bridge_limits)。
 *       SUBSTR と GRP_RANK <= 10 の長さ制限はそのまま残してあるので、
 *       この句が効くのは想定外に長い社名が来たときだけ。黙って切れずに
 *       件数が出る(silent truncation はしない、という既存方針)。
 *
 *   (b) 第二階層 7 の STATUS に「割合なし」を足した。
 *       元は CASE WHEN total_shs_ratio >= 0.05 THEN '保有中' ELSE '退出' END で、
 *       TOTAL_SHS_RATIO が NULL の書類(共同保有者2名以上・全体の約9%)が
 *       NULL 比較の偽で ELSE に落ち、**「退出」と表示されていた**。
 *       第二階層 2 の LVS_LAST_DIRECTION が IS NULL 分岐を明示しているのと
 *       同じ壊れ方で、これは直した(詳細は docs/DEMAND_WEB.md)。
 *
 *   (c) 第二階層 3(時系列)に SHORT_STATUS を足した。
 *       0.00 が「残高ゼロ」ではなく「0.5%を割ったことを知らせる最終報告」で
 *       あることを、グラフを描く側が判定できるようにするため。
 *
 *   (d) 対象銘柄・期間・銘柄コードはバインド変数にした(.sql は params CTE のリテラル)。
 *
 * ------------------------------------------------------------------
 * 【この階層の位置づけ】
 *   需給5指標の予測力は10年分で検証済みで、いずれも先行リターンの方向を
 *   予測できなかった(queries/sql/demand_signal_backtest.sql)。
 *   SIGNAL_SCORE は「買いシグナル」ではなく「先に中身を見る順番」。
 *   表示側でこれを煽らないこと。
 */

const oracledb = require('oracledb');

//------------------------------------------------------------------
// しきい値(唯一の定義場所)
//
// 2026-09-14 にウォッチ21銘柄の実データで較正して確定した値。
// 根拠は docs/DEMAND_SIGNAL_RUNBOOK.md 1章 / project memory:
// signal_threshold_calibration・signal_shrt_mult_design。
//
// **変えるときは queries/sql/demand_*.sql の params CTE も一緒に変える。**
// scripts/check-demand-params.js でずれを検出できる。
//------------------------------------------------------------------
const PARAMS = {
  // S1 出来高急増
  volMultTh: 2.0,        // 20日平均出来高の何倍で点灯させるか
  minAvgVolN: 20,        // 平均に使えた営業日数の下限。未満は判定対象外
  // S2 売残の増加
  shrtMultTh: 2.0,       // 信用売残 ÷ 過去13週平均売残
  minShrtN: 13,          // 過去13週のうち売残>0だった週数の下限
  // S3 大量保有の動き
  lvsDaysTh: 14,         // 「直近」と見なす日数
  lvsMinRatio: 0.05,     // 大量保有者として数える下限(報告義務の基準)
  lvsMinChg: 0.01,       // 実質的な変更と見なす変化幅(小数。0.01 = 1pt)
  lvsStaleDays: 365,     // 最終報告がこれより古いグループを「古い」扱い
  // S4 空売り残高の増加(2026-09-16 に水準→増加幅へ作り替え。理由は
  //   queries/sql/demand_signal_detection.sql 冒頭の 2026-09-16 の節)
  shortMinRatio: 0.005,  // 空売り残高報告の義務基準。これ未満の報告は終了報告
  shortChgTh: 0.015,     // 持ち越し合計の増加幅(小数。0.015 = 1.5pt)で点灯させる
  shortChgDays: 28,      // 増加幅を測る日数(この日数前の持ち越し合計と比べる)
  shortStaleDays: 180,   // 計算日からこれを過ぎた報告は合計に入れない(失効)
  // 第三階層 3(全銘柄版)の流動性フィルタ
  minTurnover20d: 50000000, // 20日平均売買代金の下限(円)
};

/** 最後に実データで較正した日。画面のフッターに出す。 */
const CALIBRATED_AT = '2026-09-16';

/**
 * 鮮度の「正常な範囲」の目安(日数)。
 *
 * measured: true  … 実測で確かめた範囲(docs/DEMAND_SIGNAL_RUNBOOK.md 4章)
 * measured: false … まだ測っていない。公表スケジュールからの推定でしかないので、
 *                   画面では判定を出さずに日付だけ見せる。
 *                   **推定を実測と同じ顔で出さないこと。**
 */
const FRESHNESS_LIMITS = {
  '株価(出来高)':        { maxDays: 3,  measured: true,  note: '日次' },
  '信用取引残高':        { maxDays: 11, measured: true,  note: '週次(申込日=金曜)・公表は翌週第2営業日ごろ。2026-09-25申込分から日次' },
  '空売り残高報告':      { maxDays: 3,  measured: true,  note: '随時(残高割合0.5%以上の報告のみ)' },
  '大量保有報告書':      { maxDays: 3,  measured: true,  note: '随時(EDINET)' },
  '投資部門別情報':      { maxDays: null, measured: false, note: '週次。正常範囲は未実測' },
  '業種別空売り比率':    { maxDays: null, measured: false, note: '日次。正常範囲は未実測' },
  '裁定取引残高(手動取込)': { maxDays: null, measured: false, note: 'JPX週間資料を手動取込。正常範囲は未実測' },
};

//------------------------------------------------------------------
// 空売り残高の読み方(3つの取得関数で共有する)
//
// 空売り残高は「報告者ごとの最新の報告」を持ち越して合計する(ddl/21)。
// V_EQUITY_SHORT_POSITION_SUM の最新計算日の行には、その日に報告した報告者の分しか
// 入らず、全銘柄で平均約37%過小だった(2026-09-16 実測)。
// **同じ読み方を複数の関数に書き写さないこと。** ここから組み立てる。
//------------------------------------------------------------------

/**
 * 今日(NOW)と :shortChgDays 前(PREV)の持ち越し合計を銘柄ごとに1行で返す CTE 群。
 * 生成する CTE: sp_asof, sp_live, sp
 * sp の列: code, calc_date(有効な報告のうち最新の計算日), shrt_ratio, shrt_shares,
 *          reporter_count, stale_count(失効扱いの0.5%以上の報告), shrt_ratio_prev
 * @param {string} targetFilter 'AND EXISTS (... i.code)' のような絞り込み(不要なら空文字)
 */
function spCarryCtes(targetFilter) {
  return `sp_asof AS (
    SELECT 'NOW' AS k, TRUNC(SYSDATE) AS d FROM dual
    UNION ALL
    SELECT 'PREV', TRUNC(SYSDATE) - :shortChgDays FROM dual
),
sp_live AS (
    -- 基準日時点で有効な報告(報告者ごとに次の報告が出るまで持ち越す)
    SELECT a.k, i.code, i.calc_date, i.shrt_pos_to_so, i.shrt_pos_shares,
           CASE WHEN i.shrt_pos_to_so >= :shortMinRatio
                 AND i.calc_date >= a.d - :shortStaleDays THEN 'Y' ELSE 'N' END AS carried,
           CASE WHEN i.shrt_pos_to_so >= :shortMinRatio
                 AND i.calc_date <  a.d - :shortStaleDays THEN 'Y' ELSE 'N' END AS stale
    FROM v_short_position_carry_iv i
    CROSS JOIN sp_asof a
    WHERE i.disc_date <= a.d
      AND a.d < NVL(i.next_disc_date, DATE '9999-12-31')
      ${targetFilter}
),
sp AS (
    SELECT code,
           MAX(CASE WHEN k = 'NOW' THEN calc_date END)                              AS calc_date,
           SUM(CASE WHEN k = 'NOW' AND carried = 'Y' THEN shrt_pos_to_so END)      AS shrt_ratio,
           SUM(CASE WHEN k = 'NOW' AND carried = 'Y' THEN shrt_pos_shares END)     AS shrt_shares,
           COUNT(CASE WHEN k = 'NOW' AND carried = 'Y' THEN 1 END)                 AS reporter_count,
           COUNT(CASE WHEN k = 'NOW' AND stale = 'Y' THEN 1 END)                   AS stale_count,
           NVL(SUM(CASE WHEN k = 'PREV' AND carried = 'Y' THEN shrt_pos_to_so END), 0) AS shrt_ratio_prev
    FROM sp_live
    GROUP BY code
)`;
}

/**
 * sp CTE から表示用の列を作る SELECT 句の断片。
 *   short_status: 報告なし / 残高あり / 古い報告のみ(0.5%以上の報告は残るが全て失効扱い) / 報告終了
 */
const SP_CARRY_COLUMNS = `TO_CHAR(sp.calc_date, 'YYYY-MM-DD')                          AS short_calc_date,
            TRUNC(SYSDATE) - sp.calc_date                                AS short_days_since,
            CASE WHEN sp.calc_date IS NOT NULL
                 THEN ROUND(NVL(sp.shrt_ratio, 0) * 100, 2) END          AS short_ratio_pct,
            CASE WHEN sp.calc_date IS NOT NULL
                 THEN ROUND((NVL(sp.shrt_ratio, 0) - sp.shrt_ratio_prev) * 100, 2) END
                                                                         AS short_ratio_chg_pt,
            CASE WHEN sp.calc_date IS NULL   THEN '報告なし'
                 WHEN sp.reporter_count > 0  THEN '残高あり'
                 WHEN sp.stale_count > 0     THEN '古い報告のみ'
                 ELSE '報告終了' END                                      AS short_status,
            sp.reporter_count,
            NVL(sp.stale_count, 0)                                       AS short_stale_cnt`;

const SP_BINDS = () => ({
  shortMinRatio: PARAMS.shortMinRatio,
  shortChgDays: PARAMS.shortChgDays,
  shortStaleDays: PARAMS.shortStaleDays,
});

//------------------------------------------------------------------
// 共通ヘルパー
//------------------------------------------------------------------

/**
 * SELECT を実行し、列名を lowerCamelCase にしたオブジェクトの配列で返す。
 *
 * db.js は outFormat を既定(ARRAY)のままにしているので(executeMany のため)、
 * ここでは execute 単位で OBJECT を指定する。列名は Oracle から
 * 大文字スネークで返るため、SQL のエイリアスをそのまま JS の
 * プロパティ名に機械変換している(SHORT_RATIO_PCT -> shortRatioPct)。
 */
async function selectRows(connection, sql, binds = {}) {
  const r = await connection.execute(sql, pickBinds(sql, binds), {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
  return r.rows.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) {
      out[toCamel(key)] = row[key];
    }
    return out;
  });
}

/**
 * SQL に実際に現れるバインド変数だけを抜き出す。
 *
 * シグナル検出のSQLは scope によって使うしきい値が変わる(全銘柄版は
 * lvsStaleDays を使わない、ウォッチ版は minTurnover20d を使わない)。
 * 使っていないバインドを渡すと oracledb が ORA-01036 で落ちるので、
 * **しきい値は常に全部渡して、ここで絞る**。呼び出し側に分岐を作らないための措置。
 */
function pickBinds(sql, binds) {
  const out = {};
  for (const name of Object.keys(binds)) {
    if (new RegExp(':' + name + '\\b').test(sql)) out[name] = binds[name];
  }
  return out;
}

function toCamel(upperSnake) {
  return upperSnake
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase());
}

/** 5桁の証券コードか */
function isCode(v) {
  return typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v);
}

//==================================================================
// 鮮度(第三階層 1 + 第一階層 1)
//==================================================================

/**
 * 7データの最新日と遅れ日数。
 *
 * **シグナルは最新値で判定するので、どれか1つでも取込が止まっていると
 * 静かに誤判定する。** 画面ではシグナルより先に、常に見える位置に置くこと。
 *
 * DAYS_BEHIND が小さいことは「そのデータが新しい」ことしか言わない。
 * 銘柄ごとの最終報告が古いこと(空売り・大量保有に固有)は
 * SHORT_DAYS_SINCE / LVS_GRP_CNT_STALE で別に見る。
 */
async function fetchFreshness(connection) {
  const rows = await selectRows(
    connection,
    `SELECT '株価(出来高)' AS data_name, 'signal' AS grp,
            TO_CHAR(MAX(price_date), 'YYYY-MM-DD') AS latest,
            TRUNC(SYSDATE) - MAX(price_date)       AS days_behind
     FROM equity_price_daily
     UNION ALL
     SELECT '信用取引残高', 'both',
            TO_CHAR(MAX(app_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(app_date)
     FROM equity_margin_interest
     UNION ALL
     SELECT '空売り残高報告', 'signal',
            TO_CHAR(MAX(calc_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(calc_date)
     FROM equity_short_position
     UNION ALL
     SELECT '大量保有報告書', 'signal',
            TO_CHAR(MAX(sub_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(sub_date)
     FROM large_volume_shareholder
     UNION ALL
     SELECT '投資部門別情報', 'macro',
            TO_CHAR(MAX(en_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(en_date)
     FROM investor_type_trading
     UNION ALL
     SELECT '業種別空売り比率', 'macro',
            TO_CHAR(MAX(ratio_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(ratio_date)
     FROM sector_short_ratio
     UNION ALL
     SELECT '裁定取引残高(手動取込)', 'macro',
            TO_CHAR(MAX(pos_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(pos_date)
     FROM arbitrage_balance`
  );

  return rows.map((r) => {
    const limit = FRESHNESS_LIMITS[r.dataName] || { maxDays: null, measured: false, note: '' };
    return {
      ...r,
      maxDays: limit.maxDays,
      measured: limit.measured,
      note: limit.note,
      // 判定は実測の範囲があるものだけ。無いものは 'unknown'(画面で色を付けない)
      state:
        !limit.measured || limit.maxDays === null
          ? 'unknown'
          : r.daysBehind === null
            ? 'empty'
            : r.daysBehind <= limit.maxDays
              ? 'ok'
              : 'late',
    };
  });
}

//==================================================================
// 第一階層: マクロ需給ダッシュボード
//==================================================================

/**
 * INVESTOR_TYPE_TRADING の SECTION 一覧。
 *
 * **2022年4月の市場区分再編で系列が切れている。** TSE1st 等は 2022-04-01 で
 * 終わり、TSEPrime 等はそこから始まる。TSEPrime を選んで4年半より前まで
 * 遡ると、エラーにならずに黙って NULL が並ぶ。これが一番危ない失敗の仕方なので、
 * 各系列の from/to を返して、画面側で期間が系列をはみ出すときに警告を出せるようにする。
 */
async function fetchSections(connection) {
  return selectRows(
    connection,
    `SELECT section,
            COUNT(*)                              AS rows_cnt,
            TO_CHAR(MIN(en_date), 'YYYY-MM-DD')   AS from_date,
            TO_CHAR(MAX(en_date), 'YYYY-MM-DD')   AS to_date
     FROM investor_type_trading
     GROUP BY section
     ORDER BY COUNT(*) DESC`
  );
}

/**
 * マクロ需給ダッシュボード 一枚もの(週次)。
 *
 * 骨格(wk)は取引カレンダーの営業日から作るので、データが無い週も行として残る。
 * 「まだ公表されていない」のか「取込漏れ」なのかを見分けるため。
 * **値が NULL の週を 0 として描かないこと。**
 *
 * @param {object} opts
 * @param {string} opts.section    既定 'TokyoNagoya'(市場区分再編をまたいで連続する唯一の系列)
 * @param {number} opts.weeksBack
 */
async function fetchMacro(connection, opts) {
  const section = opts.section || 'TokyoNagoya';
  const weeksBack = opts.weeksBack || 52;

  return selectRows(
    connection,
    `WITH wk AS (
        SELECT DISTINCT TRUNC(c.calendar_date, 'IW') AS week_start
        FROM trading_calendar c
        WHERE c.hol_div IN ('1', '2')
          AND c.calendar_date <= TRUNC(SYSDATE)
          AND c.calendar_date >  TRUNC(SYSDATE) - :weeksBack * 7
     ),
     inv AS (
        SELECT TRUNC(v.en_date, 'IW')  AS week_start,
               SUM(v.frgn_bal)         AS frgn_bal,
               SUM(v.ind_bal)          AS ind_bal,
               SUM(v.trst_bnk_bal)     AS trst_bnk_bal,
               SUM(v.bus_co_bal)       AS bus_co_bal
        FROM v_investor_type_trading_latest v
        WHERE v.section = :section
          AND v.en_date > TRUNC(SYSDATE) - :weeksBack * 7
        GROUP BY TRUNC(v.en_date, 'IW')
     ),
     mgn AS (
        -- 市場全体の信用倍率は株数の単純合計ではなく、申込日終値を掛けた金額で集計する。
        -- 株数合計だと低位株の残高に引きずられる。
        SELECT TRUNC(m.app_date, 'IW')              AS week_start,
               MAX(m.app_date)                      AS app_date,
               SUM(m.long_vol * p.close_price)      AS long_val,
               SUM(m.shrt_vol * p.close_price)      AS shrt_val,
               COUNT(*)                             AS codes_cnt
        FROM equity_margin_interest m
        JOIN equity_master em
          ON em.code = m.code
         AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
        JOIN equity_price_daily p
          ON p.code = m.code
         AND p.price_date = m.app_date
        WHERE m.app_date > TRUNC(SYSDATE) - :weeksBack * 7
          AND p.close_price IS NOT NULL
        GROUP BY TRUNC(m.app_date, 'IW')
     ),
     ssr AS (
        SELECT TRUNC(r.ratio_date, 'IW')                        AS week_start,
               SUM(r.shrt_with_res_va + r.shrt_no_res_va)       AS short_va,
               SUM(r.sell_ex_short_va + r.shrt_with_res_va
                   + r.shrt_no_res_va)                          AS sell_total_va
        FROM sector_short_ratio r
        WHERE r.ratio_date > TRUNC(SYSDATE) - :weeksBack * 7
        GROUP BY TRUNC(r.ratio_date, 'IW')
     ),
     arb AS (
        SELECT TRUNC(a.pos_date, 'IW')                 AS week_start,
               MAX(a.buy_tot_val  - a.sell_tot_val)    AS net_val,
               MAX(a.buy_tot_val)                      AS buy_val
        FROM arbitrage_balance a
        WHERE a.pos_date > TRUNC(SYSDATE) - :weeksBack * 7
        GROUP BY TRUNC(a.pos_date, 'IW')
     ),
     idx AS (
        SELECT week_start,
               MAX(CASE WHEN index_code = '8200' THEN close_price END) AS growth_close,
               MAX(CASE WHEN index_code = '8100' THEN close_price END) AS value_close,
               MAX(CASE WHEN index_code = '0088' THEN close_price END) AS elec_close
        FROM (
            SELECT TRUNC(i.price_date, 'IW') AS week_start,
                   i.index_code, i.close_price,
                   ROW_NUMBER() OVER (PARTITION BY i.index_code, TRUNC(i.price_date, 'IW')
                                      ORDER BY i.price_date DESC) AS rn
            FROM index_price_daily i
            WHERE i.index_code IN ('8100', '8200', '0088')
              AND i.price_date > TRUNC(SYSDATE) - :weeksBack * 7
        )
        WHERE rn = 1
        GROUP BY week_start
     ),
     tpx AS (
        SELECT week_start, close_price
        FROM (
            SELECT TRUNC(t.price_date, 'IW') AS week_start, t.close_price,
                   ROW_NUMBER() OVER (PARTITION BY TRUNC(t.price_date, 'IW')
                                      ORDER BY t.price_date DESC) AS rn
            FROM topix_price_daily t
            WHERE t.price_date > TRUNC(SYSDATE) - :weeksBack * 7
        )
        WHERE rn = 1
     ),
     joined AS (
        SELECT wk.week_start,
               tpx.close_price                                   AS topix_close,
               idx.growth_close / NULLIF(idx.value_close, 0)     AS gv_ratio,
               idx.elec_close,
               inv.frgn_bal, inv.ind_bal, inv.trst_bnk_bal, inv.bus_co_bal,
               arb.net_val                                       AS arb_net_val,
               mgn.long_val / NULLIF(mgn.shrt_val, 0)            AS margin_ratio,
               mgn.long_val                                      AS margin_long_val,
               mgn.shrt_val                                      AS margin_shrt_val,
               mgn.codes_cnt                                     AS margin_codes_cnt,
               ssr.short_va / NULLIF(ssr.sell_total_va, 0) * 100 AS short_ratio_pct
        FROM wk
        LEFT JOIN inv ON inv.week_start = wk.week_start
        LEFT JOIN mgn ON mgn.week_start = wk.week_start
        LEFT JOIN ssr ON ssr.week_start = wk.week_start
        LEFT JOIN arb ON arb.week_start = wk.week_start
        LEFT JOIN tpx ON tpx.week_start = wk.week_start
        LEFT JOIN idx ON idx.week_start = wk.week_start
     )
     SELECT TO_CHAR(week_start, 'YYYY-MM-DD')                        AS week_start,
            ROUND(topix_close, 2)                                    AS topix_close,
            ROUND((topix_close / NULLIF(LAG(topix_close)
                   OVER (ORDER BY week_start), 0) - 1) * 100, 2)      AS topix_wow_pct,
            ROUND(gv_ratio, 4)                                       AS gv_ratio,
            ROUND((gv_ratio / NULLIF(LAG(gv_ratio)
                   OVER (ORDER BY week_start), 0) - 1) * 100, 2)      AS gv_ratio_wow,
            ROUND((elec_close / NULLIF(LAG(elec_close)
                   OVER (ORDER BY week_start), 0) - 1) * 100, 2)      AS elec_wow_pct,
            ROUND(frgn_bal     / 100000, 0)                          AS frgn_oku,
            ROUND(ind_bal      / 100000, 0)                          AS ind_oku,
            ROUND(trst_bnk_bal / 100000, 0)                          AS trst_bnk_oku,
            ROUND(bus_co_bal   / 100000, 0)                          AS bus_co_oku,
            ROUND((frgn_bal - LAG(frgn_bal) OVER (ORDER BY week_start))
                  / 100000, 0)                                       AS frgn_wow_oku,
            ROUND(arb_net_val / 100000000, 0)                        AS arb_net_oku,
            ROUND((arb_net_val - LAG(arb_net_val) OVER (ORDER BY week_start))
                  / 100000000, 0)                                    AS arb_net_wow_oku,
            ROUND(margin_ratio, 2)                                   AS margin_ratio,
            ROUND(margin_ratio - LAG(margin_ratio) OVER (ORDER BY week_start), 2)
                                                                     AS margin_ratio_wow,
            ROUND(margin_long_val / 100000000, 0)                    AS margin_long_oku,
            ROUND(margin_shrt_val / 100000000, 0)                    AS margin_shrt_oku,
            margin_codes_cnt,
            ROUND(short_ratio_pct, 2)                                AS short_ratio_pct,
            ROUND(short_ratio_pct - LAG(short_ratio_pct) OVER (ORDER BY week_start), 2)
                                                                     AS short_ratio_wow
     FROM joined
     ORDER BY week_start DESC`,
    { section, weeksBack }
  );
}

//==================================================================
// 第二階層: ウォッチリスト需給シート
//==================================================================

/**
 * ウォッチリストの確認(第二階層 1)。
 * 何も返らなければ FAVORITE_MASTER が空。
 * 大量保有報告書の件数も併せて返す(0件なら詳細の履歴は空振りする)。
 */
async function fetchWatchlist(connection) {
  const [codes, docs] = await Promise.all([
    selectRows(
      connection,
      `SELECT f.code, em.co_name, em.market_name, em.sector33_name,
              f.is_buy_candidate, f.ref_note1
       FROM favorite_master f
       JOIN equity_master em ON em.code = f.code
       WHERE f.is_watching = 1
       ORDER BY f.code`
    ),
    selectRows(
      connection,
      `SELECT COUNT(DISTINCT l.code)                 AS codes_with_doc,
              COUNT(*)                               AS docs_cnt,
              TO_CHAR(MIN(l.sub_date), 'YYYY-MM-DD') AS from_date,
              TO_CHAR(MAX(l.sub_date), 'YYYY-MM-DD') AS to_date
       FROM large_volume_shareholder l
       WHERE EXISTS (SELECT 1 FROM favorite_master f
                     WHERE f.code = l.code AND f.is_watching = 1)`
    ),
  ]);
  return { codes, lvsDocs: docs[0] || null };
}

/**
 * 需給シート 一枚もの(ウォッチ銘柄 × 最新断面)。第二階層 2。
 *
 * 【この結果を表示するときの約束】
 *   ・LVS_GRP_CNT = 0 は「大量保有者がいない」ではない。取込開始が 2021-07-01 で、
 *     それ以前から保有し続けて以降1度も変更報告書を出していない大量保有者は
 *     DBに存在しない。**「この5年で動きが無かった」。**
 *   ・SHORT_RATIO_PCT は報告者ごとの最新を持ち越した合計(個人を除く。ddl/21)。
 *     NULL は「空売りゼロ」ではなく「個人以外の報告が一度も無い」。
 *     0.00 は SHORT_STATUS が '報告終了'(全員0.5%割れ)か '古い報告のみ'(全て失効扱い)。
 *   ・SHORT_RATIO_CHG_PT は PARAMS.shortChgDays 前の持ち越し合計との差。
 *   ・SHORT_STALE_CNT > 0 は失効扱いで合計から落ちた報告がある(実在する残高かもしれない)。
 *   ・MARGIN_* が NULL の週は「残高ゼロ」ではなく JPX が公表していない
 *     (営業日2日以下の週)。
 *   ・LVS_TOTAL_PCT が高いこと自体は異常ではない(オーナー系は普通に50%超)。
 *     効くのは水準ではなく **鮮度**(LVS_GRP_CNT_STALE)と **グループ数**。
 *   ・LVS_OUT_STKS_AT_DOC は「その書類時点」の発行済株式数。分割前の書類は旧株数。
 */
async function fetchWatchlistSheet(connection) {
  return selectRows(
    connection,
    `WITH target AS (
        SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
     ),
     px AS (
        SELECT p.code, p.price_date, p.close_price, p.volume,
               AVG(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                                   ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
               COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                                   ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
               MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
                   OVER (PARTITION BY p.code ORDER BY p.price_date
                         ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)           AS split_flag,
               ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
        FROM equity_price_daily p
        WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
     ),
     px_latest AS (
        SELECT code, price_date, close_price, volume, avg_vol_20d, avg_vol_n, split_flag
        FROM px WHERE rn = 1
     ),
     mgn AS (
        SELECT code,
               MAX(CASE WHEN rn = 1 THEN app_date END)  AS app_date,
               MAX(CASE WHEN rn = 1 THEN long_vol END)  AS long_vol,
               MAX(CASE WHEN rn = 1 THEN shrt_vol END)  AS shrt_vol,
               MAX(CASE WHEN rn = 2 THEN app_date END)  AS app_date_prev,
               MAX(CASE WHEN rn = 2 THEN long_vol END)  AS long_vol_prev,
               MAX(CASE WHEN rn = 2 THEN shrt_vol END)  AS shrt_vol_prev
        FROM (
            SELECT m.code, m.app_date, m.long_vol, m.shrt_vol,
                   ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
            FROM equity_margin_interest m
            WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
              AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -6)
        )
        WHERE rn <= 2
        GROUP BY code
     ),
     ${spCarryCtes('AND EXISTS (SELECT 1 FROM target t WHERE t.code = i.code)')},
     lvs_grp AS (
        -- 提出者は子テーブルの HLDR_SEQ = 1。親の EDINET_CODE / ISR_NAME は発行者。
        -- 親側でグルーピングすると全書類が1グループに潰れ、エラーにならず
        -- 「それらしい数字」が出る。
        --
        -- TOTAL_SHS_RATIO の補完は保有者1名の書類に限る。2名以上は共同保有者の
        -- 重複計上があり、子の合計では親を再現できない(426件中62件が不一致・最大13.72pt)。
        -- 1名に限れば合計＝本人の割合で算術的に曖昧さが無い。
        -- **検証したのではなく構造から言えるだけ**(「親あり かつ 保有者1名」は0件で、
        -- 検算の標本が存在しない)。
        SELECT code, grp_key, grp_name, sub_date, doc_id, ratio_imputed,
               total_shs_ratio, total_shs_ratio_last, total_out_stks, large_hldg_type_code
        FROM (
            SELECT l.code,
                   NVL(h.hldr_edinet_code, h.hldr_name)  AS grp_key,
                   h.hldr_name                           AS grp_name,
                   l.sub_date, l.doc_id,
                   l.total_out_stks, l.large_hldg_type_code,
                   COALESCE(l.total_shs_ratio,
                            (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                             FROM large_volume_shareholder_holder hh
                             WHERE hh.doc_id = l.doc_id))              AS total_shs_ratio,
                   COALESCE(l.total_shs_ratio_last,
                            (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                             FROM large_volume_shareholder_holder hh
                             WHERE hh.doc_id = l.doc_id))              AS total_shs_ratio_last,
                   CASE WHEN l.total_shs_ratio IS NULL
                         AND (SELECT COUNT(*) FROM large_volume_shareholder_holder hh
                              WHERE hh.doc_id = l.doc_id) = 1
                        THEN 'Y' END                                   AS ratio_imputed,
                   ROW_NUMBER() OVER (
                       PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                       ORDER BY l.sub_date DESC, l.doc_id DESC)        AS rn
            FROM large_volume_shareholder l
            JOIN large_volume_shareholder_holder h
              ON h.doc_id = l.doc_id
             AND h.hldr_seq = 1
            WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)
        )
        WHERE rn = 1
     ),
     lvs AS (
        SELECT g.code,
               COUNT(CASE WHEN g.total_shs_ratio >= :lvsMinRatio THEN 1 END) AS grp_cnt,
               SUM(CASE WHEN g.total_shs_ratio >= :lvsMinRatio
                        THEN g.total_shs_ratio END)                          AS total_ratio,
               COUNT(*)                                                      AS grp_cnt_all,
               MAX(g.sub_date)                                               AS last_sub_date,
               MAX(g.grp_name) KEEP (DENSE_RANK LAST
                                     ORDER BY g.sub_date, g.doc_id)          AS last_grp_name,
               MAX(g.total_shs_ratio) KEEP (DENSE_RANK LAST
                                     ORDER BY g.sub_date, g.doc_id)          AS last_ratio,
               MAX(g.total_shs_ratio_last) KEEP (DENSE_RANK LAST
                                     ORDER BY g.sub_date, g.doc_id)          AS last_ratio_prev,
               MAX(g.total_out_stks) KEEP (DENSE_RANK LAST
                                     ORDER BY g.sub_date, g.doc_id)          AS total_out_stks,
               MAX(g.ratio_imputed)                                          AS ratio_imputed,
               COUNT(CASE WHEN g.total_shs_ratio IS NULL THEN 1 END)         AS grp_cnt_noratio,
               COUNT(CASE WHEN g.total_shs_ratio >= :lvsMinRatio
                           AND g.sub_date < TRUNC(SYSDATE) - :lvsStaleDays
                          THEN 1 END)                                        AS grp_cnt_stale
        FROM lvs_grp g
        GROUP BY g.code
     )
     SELECT em.code, em.co_name, em.market_name, em.sector33_name,
            TO_CHAR(px_latest.price_date, 'YYYY-MM-DD')                  AS price_date,
            px_latest.close_price,
            px_latest.volume,
            ROUND(px_latest.avg_vol_20d)                                 AS avg_vol_20d,
            px_latest.avg_vol_n                                          AS avg_vol_n,
            ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
            NVL(px_latest.split_flag, 'N')                               AS split_flag,
            TO_CHAR(mgn.app_date, 'YYYY-MM-DD')                          AS margin_date,
            mgn.long_vol                                                 AS margin_long_vol,
            mgn.shrt_vol                                                 AS margin_shrt_vol,
            ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)             AS margin_ratio,
            mgn.long_vol - mgn.long_vol_prev                             AS margin_long_chg,
            mgn.shrt_vol - mgn.shrt_vol_prev                             AS margin_shrt_chg,
            ROUND(mgn.shrt_vol / NULLIF(px_latest.avg_vol_20d, 0), 2)    AS margin_shrt_dtc,
            CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
                  AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
                 THEN 'CROSS' END                                        AS margin_season_warn,
            ${SP_CARRY_COLUMNS},
            ROUND(sp.shrt_shares / NULLIF(px_latest.avg_vol_20d, 0), 2)  AS short_dtc,
            NVL(lvs.grp_cnt, 0)                                          AS lvs_grp_cnt,
            NVL(lvs.grp_cnt_all, 0)                                      AS lvs_grp_cnt_all,
            NVL(lvs.grp_cnt_noratio, 0)                                  AS lvs_grp_cnt_noratio,
            NVL(lvs.grp_cnt_stale, 0)                                    AS lvs_grp_cnt_stale,
            NVL(lvs.ratio_imputed, 'N')                                  AS lvs_ratio_imputed,
            ROUND(lvs.total_ratio * 100, 2)                              AS lvs_total_pct,
            TO_CHAR(lvs.last_sub_date, 'YYYY-MM-DD')                     AS lvs_last_sub_date,
            lvs.last_grp_name                                            AS lvs_last_holder,
            ROUND(lvs.last_ratio * 100, 2)                               AS lvs_last_ratio_pct,
            ROUND((lvs.last_ratio - lvs.last_ratio_prev) * 100, 2)       AS lvs_last_chg_pt,
            -- NULL を ELSE で飲み込まないこと。TOTAL_SHS_RATIO が NULL の書類は実在し、
            -- 素直に書くと NULL 同士の比較が全て偽になって '変化なし' と嘘をつく。
            CASE
              WHEN lvs.last_sub_date IS NULL              THEN NULL
              WHEN lvs.last_ratio IS NULL                 THEN '割合なし'
              WHEN lvs.last_ratio_prev IS NULL            THEN '新規'
              WHEN lvs.last_ratio > lvs.last_ratio_prev   THEN '買い増し'
              WHEN lvs.last_ratio < lvs.last_ratio_prev   THEN '売り減らし'
              ELSE '変化なし'
            END                                                          AS lvs_last_direction,
            lvs.total_out_stks                                           AS lvs_out_stks_at_doc
     FROM equity_master em
     JOIN target                ON target.code    = em.code
     LEFT JOIN px_latest        ON px_latest.code = em.code
     LEFT JOIN mgn              ON mgn.code       = em.code
     LEFT JOIN sp               ON sp.code        = em.code
     LEFT JOIN lvs              ON lvs.code       = em.code
     ORDER BY vol_vs_20d DESC NULLS LAST`,
    {
      lvsMinRatio: PARAMS.lvsMinRatio,
      lvsStaleDays: PARAMS.lvsStaleDays,
      ...SP_BINDS(),
    }
  );
}

/**
 * 個別銘柄の需給時系列(週次)。第二階層 3。銘柄詳細のグラフ元データ。
 *
 * **欠測の意味が系列ごとに違う。** 描画側はここを潰さないこと。
 *   margin_*      … 行が無い週 = JPX が公表していない(営業日2日以下の週)。線を切る。
 *   short_ratio_* … 報告者ごとの最新を持ち越した合計(個人を除く。ddl/21)なので週ごとに連続する。
 *                   NULL はまだ報告が1件も無い週。
 *   short_status  … '報告終了'(全員0.5%割れ)/'古い報告のみ'(全て失効扱い)の 0.00 は残高ゼロではない。
 */
async function fetchCodeTimeseries(connection, code, weeksBack) {
  if (!isCode(code)) throw new Error(`銘柄コードが不正です: ${code}`);
  return selectRows(
    connection,
    `WITH wk_price AS (
        SELECT TRUNC(p.price_date, 'IW')                          AS week_start,
               SUM(p.volume)                                      AS week_volume,
               MAX(p.close_price) KEEP (DENSE_RANK LAST
                                        ORDER BY p.price_date)    AS week_close,
               MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)      AS split_flag
        FROM equity_price_daily p
        WHERE p.code = :code
          AND p.price_date > TRUNC(SYSDATE) - :weeksBack * 7
        GROUP BY TRUNC(p.price_date, 'IW')
     ),
     wk_margin AS (
        -- 信用残は週次(2026-09-25 申込分以降は日次)。日次になった後も週の最終申込日を採る
        SELECT week_start, app_date, long_vol, shrt_vol
        FROM (
            SELECT TRUNC(m.app_date, 'IW') AS week_start,
                   m.app_date, m.long_vol, m.shrt_vol,
                   ROW_NUMBER() OVER (PARTITION BY TRUNC(m.app_date, 'IW')
                                      ORDER BY m.app_date DESC) AS rn
            FROM equity_margin_interest m
            WHERE m.code = :code
              AND m.app_date > TRUNC(SYSDATE) - :weeksBack * 7
        )
        WHERE rn = 1
     ),
     wk_short AS (
        -- 各週の金曜(今週は今日)時点の持ち越し合計。第二階層 2 と同じ読み方(ddl/21)
        SELECT w.week_start,
               MAX(i.calc_date)                                             AS calc_date,
               SUM(CASE WHEN i.shrt_pos_to_so >= :shortMinRatio
                         AND i.calc_date >= LEAST(w.week_start + 4, TRUNC(SYSDATE)) - :shortStaleDays
                        THEN i.shrt_pos_to_so END)                          AS total_shrt_ratio,
               COUNT(CASE WHEN i.shrt_pos_to_so >= :shortMinRatio
                           AND i.calc_date >= LEAST(w.week_start + 4, TRUNC(SYSDATE)) - :shortStaleDays
                          THEN 1 END)                                       AS reporter_count,
               COUNT(CASE WHEN i.shrt_pos_to_so >= :shortMinRatio
                           AND i.calc_date <  LEAST(w.week_start + 4, TRUNC(SYSDATE)) - :shortStaleDays
                          THEN 1 END)                                       AS stale_count,
               SUM(CASE WHEN i.shrt_pos_to_so >= :shortMinRatio
                         AND i.calc_date >= LEAST(w.week_start + 4, TRUNC(SYSDATE)) - :shortStaleDays
                        THEN i.shrt_pos_shares END)                         AS total_shrt_shares
        FROM wk_price w
        JOIN v_short_position_carry_iv i
          ON i.code = :code
         AND i.disc_date <= LEAST(w.week_start + 4, TRUNC(SYSDATE))
         AND LEAST(w.week_start + 4, TRUNC(SYSDATE)) < NVL(i.next_disc_date, DATE '9999-12-31')
        GROUP BY w.week_start
     ),
     wk_lvs AS (
        SELECT TRUNC(l.sub_date, 'IW')                                     AS week_start,
               COUNT(*)                                                    AS lvs_docs,
               MAX(l.total_shs_ratio) KEEP (DENSE_RANK LAST
                                            ORDER BY l.sub_date, l.doc_id) AS lvs_ratio
        FROM large_volume_shareholder l
        WHERE l.code = :code
          AND l.sub_date > TRUNC(SYSDATE) - :weeksBack * 7
        GROUP BY TRUNC(l.sub_date, 'IW')
     )
     SELECT TO_CHAR(wp.week_start, 'YYYY-MM-DD')                     AS week_start,
            wp.week_close,
            wp.week_volume,
            NVL(wp.split_flag, 'N')                                  AS split_flag,
            TO_CHAR(wm.app_date, 'YYYY-MM-DD')                       AS margin_date,
            wm.long_vol                                              AS margin_long_vol,
            wm.shrt_vol                                              AS margin_shrt_vol,
            ROUND(wm.long_vol / NULLIF(wm.shrt_vol, 0), 2)           AS margin_ratio,
            TO_CHAR(ws.calc_date, 'YYYY-MM-DD')                      AS short_calc_date,
            CASE WHEN ws.calc_date IS NOT NULL
                 THEN ROUND(NVL(ws.total_shrt_ratio, 0) * 100, 2) END AS short_ratio_pct,
            -- 0.00 を「残高ゼロ」と読ませないための区別(描画側で終端マークにする)
            CASE WHEN ws.calc_date IS NULL   THEN NULL
                 WHEN ws.reporter_count > 0  THEN '残高あり'
                 WHEN ws.stale_count > 0     THEN '古い報告のみ'
                 ELSE '報告終了' END                                  AS short_status,
            ws.reporter_count,
            ws.total_shrt_shares                                     AS short_shares,
            NVL(wl.lvs_docs, 0)                                      AS lvs_docs,
            ROUND(wl.lvs_ratio * 100, 2)                             AS lvs_ratio_pct
     FROM wk_price wp
     LEFT JOIN wk_margin wm ON wm.week_start = wp.week_start
     LEFT JOIN wk_short  ws ON ws.week_start = wp.week_start
     LEFT JOIN wk_lvs    wl ON wl.week_start = wp.week_start
     ORDER BY wp.week_start`,
    { code, weeksBack, shortMinRatio: PARAMS.shortMinRatio, shortStaleDays: PARAMS.shortStaleDays }
  );
}

/**
 * 現在の大量保有者(提出者グループごとの最新断面)。第二階層 7。
 *
 * ・5%未満に落ちた提出者も '退出' として残す。消すと売り抜けが見えなくなる。
 * ・**保有割合が NULL の書類は '退出' ではなく '割合なし'。**
 *   元SQLは `WHEN total_shs_ratio >= 0.05 THEN '保有中' ELSE '退出'` で、
 *   NULL 比較が偽になって ELSE に落ち、共同保有者2名以上で親の合計欄が空の書類
 *   (ウォッチ21銘柄で52件)を全て「退出」と表示していた。IS NULL 分岐を先に置く。
 * ・DAYS_SINCE が大きいグループは「最後に報告した時点の値」であって現在値ではない。
 *   報告義務が切れた後は更新されない(1,514日前の5.05%が居座っていた実例がある)。
 * ・TOTAL_OUT_STKS は書類ごとに違う(分割前の書類は旧株数)。SHARES_HELD を
 *   比べるときはこの列で割ってから比べること。
 */
async function fetchCodeHolders(connection, code) {
  if (!isCode(code)) throw new Error(`銘柄コードが不正です: ${code}`);
  return selectRows(
    connection,
    `WITH grp AS (
        SELECT grp_name, sub_date, doc_id, large_hldg_type_code, docs_cnt, ratio_imputed,
               total_shs_ratio, total_shs_ratio_last, total_shs_held, total_out_stks
        FROM (
            SELECT h.hldr_name                                      AS grp_name,
                   l.sub_date, l.doc_id, l.large_hldg_type_code,
                   l.total_shs_held, l.total_out_stks,
                   COALESCE(l.total_shs_ratio,
                            (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                             FROM large_volume_shareholder_holder hh
                             WHERE hh.doc_id = l.doc_id))           AS total_shs_ratio,
                   COALESCE(l.total_shs_ratio_last,
                            (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                             FROM large_volume_shareholder_holder hh
                             WHERE hh.doc_id = l.doc_id))           AS total_shs_ratio_last,
                   CASE WHEN l.total_shs_ratio IS NULL
                         AND (SELECT COUNT(*) FROM large_volume_shareholder_holder hh
                              WHERE hh.doc_id = l.doc_id) = 1
                        THEN 'Y' END                                AS ratio_imputed,
                   COUNT(*) OVER (PARTITION BY NVL(h.hldr_edinet_code, h.hldr_name))
                                                                    AS docs_cnt,
                   ROW_NUMBER() OVER (
                       PARTITION BY NVL(h.hldr_edinet_code, h.hldr_name)
                       ORDER BY l.sub_date DESC, l.doc_id DESC)     AS rn
            FROM large_volume_shareholder l
            JOIN large_volume_shareholder_holder h
              ON h.doc_id = l.doc_id
             AND h.hldr_seq = 1
            WHERE l.code = :code
        )
        WHERE rn = 1
     )
     SELECT grp.grp_name                                            AS holder_name,
            CASE WHEN grp.total_shs_ratio IS NULL      THEN '割合なし'
                 WHEN grp.total_shs_ratio >= :lvsMinRatio THEN '保有中'
                 ELSE '退出' END                                     AS status,
            ROUND(grp.total_shs_ratio * 100, 2)                     AS ratio_pct,
            ROUND(grp.total_shs_ratio_last * 100, 2)                AS ratio_last_pct,
            ROUND((grp.total_shs_ratio - grp.total_shs_ratio_last) * 100, 2) AS ratio_chg_pt,
            grp.total_shs_held                                      AS shares_held,
            TO_CHAR(grp.sub_date, 'YYYY-MM-DD')                     AS last_sub_date,
            TRUNC(SYSDATE) - grp.sub_date                           AS days_since,
            grp.docs_cnt,
            NVL(grp.ratio_imputed, 'N')                             AS ratio_imputed,
            grp.large_hldg_type_code,
            grp.total_out_stks,
            grp.doc_id
     FROM grp
     ORDER BY CASE WHEN grp.total_shs_ratio IS NULL THEN 2
                   WHEN grp.total_shs_ratio >= :lvsMinRatio THEN 0 ELSE 1 END,
              grp.total_shs_ratio DESC NULLS LAST`,
    { code, lvsMinRatio: PARAMS.lvsMinRatio }
  );
}

/**
 * 大量保有報告書の提出履歴(提出者ごとの保有割合の推移)。第二階層 4。
 * TOTAL_SHS_RATIO_LAST は変更報告書にしか入らない。新規では NULL(欠損ではない)。
 */
async function fetchCodeLvsHistory(connection, code, limit) {
  if (!isCode(code)) throw new Error(`銘柄コードが不正です: ${code}`);
  return selectRows(
    connection,
    `SELECT TO_CHAR(l.sub_date, 'YYYY-MM-DD')                    AS sub_date,
            h.hldr_seq, h.hldr_name,
            l.doc_type_code, l.large_hldg_type_code,
            ROUND(h.shs_ratio * 100, 2)                          AS holder_ratio_pct,
            ROUND(h.shs_ratio_last * 100, 2)                     AS holder_ratio_last_pct,
            ROUND((h.shs_ratio - h.shs_ratio_last) * 100, 2)     AS holder_ratio_chg_pt,
            ROUND(l.total_shs_ratio * 100, 2)                    AS total_ratio_pct,
            ROUND(l.total_shs_ratio_last * 100, 2)               AS total_ratio_last_pct,
            h.shs_held, l.total_out_stks,
            SUBSTR(h.hldg_purp, 1, 120)                          AS hldg_purp_head,
            l.doc_id
     FROM large_volume_shareholder l
     JOIN large_volume_shareholder_holder h ON h.doc_id = l.doc_id
     WHERE l.code = :code
     ORDER BY l.sub_date DESC, l.doc_id DESC, h.hldr_seq
     FETCH FIRST :lim ROWS ONLY`,
    { code, lim: limit || 200 }
  );
}

/**
 * 疑似浮動株比率。第二階層 6。
 *
 * **JPX の公式な浮動株比率ではない。** J-Quants は浮動株比率も浮動株数も
 * 配信していないので、(1 - 自己株式比率) × (1 - 上位株主の保有割合合計) で代用している。
 *   ・上位10名に信託口(日本マスタートラスト等)が含まれる → 過小評価
 *   ・上位10名より下の持ち合いを拾えない               → 過大評価
 * 逆方向に振れるので絶対値の精度は期待できない。
 * **使い道は銘柄間の相対比較と経年の変化方向だけ。** 更新は有報ベースで年1回。
 */
async function fetchPseudoFloat(connection) {
  return selectRows(
    connection,
    `WITH target AS (
        SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
     ),
     fs AS (
        SELECT code, sh_out_fy, tr_sh_fy, cur_per_en
        FROM (
            SELECT f.code, f.sh_out_fy, f.tr_sh_fy, f.cur_per_en,
                   ROW_NUMBER() OVER (PARTITION BY f.code
                                      ORDER BY f.disc_date DESC, f.disc_no DESC) AS rn
            FROM financial_summary f
            WHERE f.sh_out_fy IS NOT NULL AND f.sh_out_fy > 0
              AND EXISTS (SELECT 1 FROM target t WHERE t.code = f.code)
        )
        WHERE rn = 1
     ),
     ms_doc AS (
        SELECT code, doc_id, sub_date, per_en
        FROM (
            SELECT d.code, d.doc_id, d.sub_date, d.per_en,
                   ROW_NUMBER() OVER (PARTITION BY d.code
                                      ORDER BY d.sub_date DESC, d.doc_id DESC) AS rn
            FROM edinet_major_shareholder d
            WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = d.code)
        )
        WHERE rn = 1
     ),
     ms AS (
        SELECT m.code, m.sub_date,
               COUNT(*)         AS holder_cnt,
               SUM(h.shs_ratio) AS top_holder_ratio
        FROM ms_doc m
        JOIN edinet_major_shareholder_holder h ON h.doc_id = m.doc_id
        GROUP BY m.code, m.sub_date
     )
     SELECT em.code, em.co_name,
            TO_CHAR(fs.cur_per_en, 'YYYY-MM-DD')                     AS fin_period_end,
            fs.sh_out_fy                                             AS shares_outstanding,
            fs.tr_sh_fy                                              AS treasury_shares,
            ROUND(fs.tr_sh_fy / NULLIF(fs.sh_out_fy, 0) * 100, 2)    AS treasury_pct,
            TO_CHAR(ms.sub_date, 'YYYY-MM-DD')                       AS ms_sub_date,
            ms.holder_cnt,
            ROUND(ms.top_holder_ratio * 100, 2)                      AS top_holder_pct,
            ROUND((1 - NVL(fs.tr_sh_fy, 0) / NULLIF(fs.sh_out_fy, 0))
                  * (1 - ms.top_holder_ratio) * 100, 2)              AS pseudo_float_pct
     FROM equity_master em
     JOIN target ON target.code = em.code
     LEFT JOIN fs ON fs.code = em.code
     LEFT JOIN ms ON ms.code = em.code
     ORDER BY pseudo_float_pct NULLS LAST`
  );
}

//==================================================================
// 第三階層: シグナル検出
//==================================================================

/**
 * シグナル検出のSQLを組み立てる。
 *
 * ウォッチリスト版(第三階層 2)と全銘柄版(第三階層 3)は判定ロジックが同一で、
 * 違うのは「対象をどう決めるか」と「大量保有の全期間スナップショットを作るか」
 * だけ。**同じ判定を2回書くと必ずずれる**ので、1つの組み立て関数から出す。
 *
 * scope = 'watchlist' … FAVORITE_MASTER.IS_WATCHING = 1。1つ以上点灯した行を返す。
 *                       大量保有の全期間スナップショット(LVS_GRP_CNT 等)も付ける。
 * scope = 'all'       … 東証プライム/スタンダード/グロース かつ 20日平均売買代金が
 *                       min_turnover_20d 以上。2つ以上の同時点灯だけを返す(上位100件)。
 *                       **全銘柄 × 15か月の信用残を走査するので重い。毎日流さない。**
 *                       全期間スナップショットは作らない(全4,215銘柄・65,311件を
 *                       提出者グループへ畳む必要があり、絞り込みの1本目としては重い)。
 *                       点灯した銘柄の「いま誰が何%持っているか」は銘柄詳細で見る。
 *
 * 流動性フィルタを入れる理由: 出来高が普段ほぼ0の銘柄は、数千株の売買で簡単に
 * 「20日平均の2倍」を超える。フィルタ無しだとその手の銘柄で埋まる。
 */
function buildSignalSql(scope) {
  const watch = scope === 'watchlist';

  // 対象銘柄の絞り込みは必ず最初に効かせる(走査量を銘柄数に比例させる)。
  // 全銘柄版は絞り込む対象が「全上場銘柄」なので、この EXISTS が消える。
  const pxTargetFilter = watch
    ? `AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)`
    : '';
  const mgnTargetFilter = watch
    ? `AND EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)`
    : '';
  const spTargetFilter = watch
    ? `AND EXISTS (SELECT 1 FROM target t WHERE t.code = i.code)`
    : '';
  const lvsTargetFilter = watch
    ? `AND EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)`
    : '';

  return `
WITH ${watch ? `target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
` : ''}px AS (
    SELECT p.code, p.price_date, p.close_price, p.volume,
           -- 直近日を含めず、その前の20営業日の平均。直近日を含めると
           -- 急増した当日の出来高が平均を押し上げ、倍率が鈍る
           AVG(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           -- 平均に使えた営業日数。20未満なら「20日平均」ではない(上場直後・売買停止明け)
           COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
           AVG(p.turnover_value) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_turnover_20d,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
               OVER (PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)           AS split_flag,
           ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
    FROM equity_price_daily p
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
      ${pxTargetFilter}
),
px_latest AS (
    SELECT px.code, px.price_date, px.close_price, px.volume,
           px.avg_vol_20d, px.avg_vol_n, px.avg_turnover_20d, px.split_flag
    FROM px
    ${watch ? '' : `JOIN equity_master emf
      ON emf.code = px.code
     AND emf.delisted_flag = 'N'
     AND emf.market_name IN ('プライム', 'スタンダード', 'グロース')`}
    WHERE px.rn = 1
      ${watch ? '' : 'AND px.avg_turnover_20d >= :minTurnover20d'}
),
mgn_wk AS (
    -- 【必ず週次に畳んでから窓を取る】
    --   信用取引残高は 2026-09-25 申込分から週次(申込日=金曜)から日次に変わる。
    --   app_date の行そのものに ROWS 13 PRECEDING を当てると、その日を境に
    --   「13週前まで」が「13営業日前まで」に化ける。エラーにならず、
    --   窓の長さだけが静かに1/5になる。
    --   欠測週(営業日2日以下のGW・年末年始)は行が無いだけなので0で埋めない。
    SELECT code, week_start, app_date, long_vol, shrt_vol
    FROM (
        SELECT m.code,
               TRUNC(m.app_date, 'IW') AS week_start,
               m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -15)
          ${mgnTargetFilter}
    )
    WHERE rn = 1
),
mgn AS (
    -- 最新週の信用残と、その週を含めない過去13週の売残平均。
    -- 【長期の水準は平均ではなく中央値で取る】
    --   平均は裾に引っ張られる。1回のスパイクが1年間バーを上げ続け、
    --   落とすべきでない銘柄まで消す(実際に起きた)。
    --   MEDIAN は窓付きの分析関数にできないが、ここで要るのは最新1週だけなので
    --   rn = 1 に絞ってから相関副問合せで取れる。
    SELECT m.code, m.app_date, m.long_vol, m.shrt_vol, m.avg_shrt_13w, m.shrt_n_13w,
           (SELECT MEDIAN(x.shrt_vol)
            FROM mgn_wk x
            WHERE x.code = m.code
              AND x.week_start <  m.week_start
              AND x.week_start >= m.week_start - 364)                           AS med_shrt_52w
    FROM (
        SELECT w.code, w.week_start, w.app_date, w.long_vol, w.shrt_vol,
               AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                     ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)  AS avg_shrt_13w,
               -- 売残>0 だった週数。少ない銘柄は平均が0近辺になり倍率が発散する
               COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
                   OVER (PARTITION BY w.code ORDER BY w.week_start
                         ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)             AS shrt_n_13w,
               ROW_NUMBER() OVER (PARTITION BY w.code ORDER BY w.week_start DESC) AS rn
        FROM mgn_wk w
    ) m
    WHERE m.rn = 1
),
${spCarryCtes(spTargetFilter)},
${watch ? `lvs_grp AS (
    -- 提出者グループごとの最新1件(全期間)。LVS_GRP_CNT / LVS_TOTAL_PCT の土台。
    -- 補完は保有者1名の書類に限る(2名以上は共同保有者の重複計上があり、
    -- 子の合計では親を再現できない)。
    SELECT code, sub_date, doc_id, total_shs_ratio
    FROM (
        SELECT l.code, l.sub_date, l.doc_id,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio,
               ROW_NUMBER() OVER (
                   PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)                AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        WHERE 1 = 1
          ${lvsTargetFilter}
    )
    WHERE rn = 1
),
lvs_snap AS (
    SELECT g.code,
           COUNT(CASE WHEN g.total_shs_ratio >= :lvsMinRatio THEN 1 END)   AS grp_cnt,
           SUM(CASE WHEN g.total_shs_ratio >= :lvsMinRatio
                    THEN g.total_shs_ratio END)                            AS total_ratio,
           COUNT(CASE WHEN g.total_shs_ratio IS NULL THEN 1 END)           AS grp_cnt_noratio,
           COUNT(CASE WHEN g.total_shs_ratio >= :lvsMinRatio
                       AND g.sub_date < TRUNC(SYSDATE) - :lvsStaleDays
                      THEN 1 END)                                          AS grp_cnt_stale
    FROM lvs_grp g
    GROUP BY g.code
),
` : ''}lvs_recent_grp AS (
    -- 直近 :lvsDaysTh 日以内に報告したグループ。グループごとに最新1件へ畳む。
    -- 【方向の判定順に意味がある】
    --   割合が無い書類を最初に分けないと、NULL 比較が全て偽になって
    --   最後の ELSE '変化なし' に落ち、嘘をつく。
    --   退出(5%未満へ)を新規より先に見るのは、5%未満への変更報告も
    --   TOTAL_SHS_RATIO_LAST を持つとは限らないため。
    SELECT g.code, g.grp_name, g.sub_date, g.grp_docs,
           g.total_shs_ratio, g.total_shs_ratio_last,
           ROW_NUMBER() OVER (PARTITION BY g.code
                              ORDER BY g.sub_date DESC, g.grp_name) AS grp_rank,
           CASE WHEN g.total_shs_ratio IS NULL                      THEN '割合なし'
                WHEN g.total_shs_ratio <  :lvsMinRatio              THEN '退出'
                WHEN g.total_shs_ratio_last IS NULL                 THEN '新規'
                WHEN g.total_shs_ratio >  g.total_shs_ratio_last    THEN '買い増し'
                WHEN g.total_shs_ratio <  g.total_shs_ratio_last    THEN '売り減らし'
                ELSE '変化なし' END                                 AS direction,
           -- 【形式的な変更報告を落とすための印】
           --   変更報告書の提出義務は保有割合の1%以上の増減で生じる。
           --   落とさないものが3つある。いずれも「小さいから無視してよい」が成り立たない:
           --     ・割合なし … 判定できない。NULLを0扱いしない原則
           --     ・退出     … 5.2%→4.9% は -0.3pt でも報告義務が切れる節目
           --     ・新規     … 前回が無いので差が取れない
           CASE WHEN g.total_shs_ratio IS NULL                      THEN 'Y'
                WHEN g.total_shs_ratio <  :lvsMinRatio              THEN 'Y'
                WHEN g.total_shs_ratio_last IS NULL                 THEN 'Y'
                WHEN ABS(g.total_shs_ratio - g.total_shs_ratio_last)
                       >= :lvsMinChg                                THEN 'Y'
                ELSE 'N' END                                        AS is_material
    FROM (
        SELECT l.code,
               h.hldr_name                           AS grp_name,
               l.sub_date, l.doc_id,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio,
               COALESCE(l.total_shs_ratio_last,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio_last,
               COUNT(*) OVER (PARTITION BY l.code,
                                           NVL(h.hldr_edinet_code, h.hldr_name)) AS grp_docs,
               ROW_NUMBER() OVER (
                   PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)                AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        WHERE l.sub_date >= TRUNC(SYSDATE) - :lvsDaysTh
          ${lvsTargetFilter}
    ) g
    WHERE g.rn = 1
),
lvs_recent AS (
    SELECT code,
           SUM(grp_docs)                                            AS recent_docs,
           COUNT(*)                                                 AS recent_grps,
           COUNT(CASE WHEN is_material = 'Y' THEN 1 END)            AS recent_material,
           MAX(sub_date)                                            AS last_sub_date,
           -- 長さは SUBSTR と GRP_RANK <= 10 で決定的に抑えてある。
           -- ON OVERFLOW ... WITH COUNT は想定外に長い社名が来たときの保険で、
           -- 黙って切らずに「あと何件あるか」を出すため(silent truncation はしない)。
           LISTAGG(CASE WHEN grp_rank <= 10 THEN
                   SUBSTR(grp_name, 1, 60) || ':' || direction ||
                   CASE WHEN total_shs_ratio IS NOT NULL
                        THEN ' ' || TO_CHAR(ROUND(total_shs_ratio * 100, 2), 'FM9990.00') || '%'
                   END ||
                   CASE WHEN total_shs_ratio IS NOT NULL
                         AND total_shs_ratio_last IS NOT NULL
                        THEN '(' ||
                             TO_CHAR(ROUND((total_shs_ratio - total_shs_ratio_last) * 100, 2),
                                     'FMS9990.00') || 'pt)'
                   END ||
                   CASE WHEN is_material = 'N' THEN '[形式的]' END
                   END,
                   ' / ' ON OVERFLOW TRUNCATE '…' WITH COUNT)
                   WITHIN GROUP (ORDER BY sub_date DESC, grp_name)  AS recent_summary
    FROM lvs_recent_grp
    GROUP BY code
),
flags AS (
    SELECT em.code, em.co_name, em.market_name, em.sector33_name,
           px_latest.price_date,
           px_latest.close_price,
           px_latest.volume,
           ROUND(px_latest.avg_vol_20d)                                  AS avg_vol_20d,
           px_latest.avg_vol_n,
           ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
           ROUND(px_latest.avg_turnover_20d / 1000000)                   AS avg_turnover_20d_mil,
           NVL(px_latest.split_flag, 'N')                                AS split_flag,
           mgn.app_date                                                  AS margin_date,
           ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)              AS margin_ratio,
           ROUND(mgn.shrt_vol / NULLIF(px_latest.avg_vol_20d, 0), 2)     AS margin_shrt_dtc,
           ROUND(mgn.shrt_vol / NULLIF(mgn.avg_shrt_13w, 0), 2)          AS margin_shrt_vs_13w,
           ROUND(mgn.shrt_vol / NULLIF(mgn.med_shrt_52w, 0), 2)          AS margin_shrt_vs_med52,
           mgn.shrt_n_13w                                                AS margin_shrt_n_13w,
           mgn.shrt_vol                                                  AS margin_shrt_vol,
           CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
                 AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
                THEN 'CROSS' END                                         AS margin_season_warn,
           ${SP_CARRY_COLUMNS},
           NVL(lvs_recent.recent_docs, 0)                                AS lvs_recent_docs,
           NVL(lvs_recent.recent_grps, 0)                                AS lvs_recent_grps,
           NVL(lvs_recent.recent_material, 0)                            AS lvs_recent_material,
           lvs_recent.last_sub_date                                      AS lvs_last_sub_date,
           lvs_recent.recent_summary                                     AS lvs_recent_summary,
${watch ? `           NVL(lvs_snap.grp_cnt, 0)                                      AS lvs_grp_cnt,
           ROUND(lvs_snap.total_ratio * 100, 2)                          AS lvs_total_pct,
           NVL(lvs_snap.grp_cnt_noratio, 0)                              AS lvs_grp_cnt_noratio,
           NVL(lvs_snap.grp_cnt_stale, 0)                                AS lvs_grp_cnt_stale,
` : ''}           -- S1: 出来高急増。20日分の平均が取れていない銘柄は判定対象外
           CASE WHEN px_latest.avg_vol_20d > 0
                 AND px_latest.avg_vol_n >= :minAvgVolN
                 AND px_latest.volume >= px_latest.avg_vol_20d * :volMultTh
                THEN 1 ELSE 0 END                                        AS sig_volume,
           -- S2: 信用売残の増加(売残 ÷ 自分の過去13週平均売残)。
           --   自己正規化した倍率で「変化」を測り、52週中央値で「水準が落ちていない」
           --   ことを確かめる2段構え。ただし後者は弱い(汚染14件のうち取れるのは3件)。
           --   残りは当時の情報では原理的に検出できない。
           --   倍率が2桁を超えている行は水準(MARGIN_SHRT_VOL)を必ず見ること
           --   (上場直後は過去13週平均そのものが小さく、倍率が発散する)。
           CASE WHEN mgn.shrt_vol > 0
                 AND mgn.avg_shrt_13w > 0
                 AND mgn.shrt_n_13w >= :minShrtN
                 AND mgn.shrt_vol / mgn.avg_shrt_13w >= :shrtMultTh
                 AND mgn.shrt_vol >= mgn.med_shrt_52w
                THEN 1 ELSE 0 END                                        AS sig_margin,
           -- S3: 直近に「実質的な」大量保有報告書が提出された。
           --   向きは問わない(退出でも点灯させる)が、形式的な変更報告は数えない。
           --   LVS_RECENT_DOCS > 0 なのに LVS_RECENT_MATERIAL = 0 の行は
           --   「報告は出たが動きは無い」。向きは LVS_RECENT_SUMMARY で必ず確認する。
           CASE WHEN lvs_recent.recent_material > 0 THEN 1 ELSE 0 END    AS sig_lvs,
           -- S4: 空売り残高(持ち越し合計)が :shortChgDays 前より :shortChgTh 以上増えた。
           --   水準で測ると銘柄が固定される(Appier は2%超が104週中102週)ので増加幅で測る
           CASE WHEN NVL(sp.shrt_ratio, 0) - NVL(sp.shrt_ratio_prev, 0) >= :shortChgTh
                THEN 1 ELSE 0 END                                        AS sig_short
    FROM ${watch ? `equity_master em
    JOIN target ON target.code = em.code
    LEFT JOIN px_latest   ON px_latest.code   = em.code` : `px_latest
    JOIN equity_master em ON em.code = px_latest.code`}
    LEFT JOIN mgn         ON mgn.code         = ${watch ? 'em.code' : 'px_latest.code'}
    LEFT JOIN sp          ON sp.code          = ${watch ? 'em.code' : 'px_latest.code'}
    LEFT JOIN lvs_recent  ON lvs_recent.code  = ${watch ? 'em.code' : 'px_latest.code'}
${watch ? `    LEFT JOIN lvs_snap    ON lvs_snap.code    = em.code
    WHERE em.delisted_flag = 'N'` : ''}
)
SELECT code, co_name, market_name, sector33_name,
       sig_volume + sig_margin + sig_lvs + sig_short                 AS signal_score,
       -- 点灯したシグナルを1列にまとめる。
       -- 【文言にしきい値を書かないこと】params を変えた瞬間に嘘になる
       RTRIM(
         CASE WHEN sig_volume = 1 THEN '出来高急増 '     END ||
         CASE WHEN sig_margin = 1 THEN '売残の増加 '     END ||
         CASE WHEN sig_lvs    = 1 THEN '大量保有提出 '   END ||
         CASE WHEN sig_short  = 1 THEN '空売り残高の増加 ' END
       )                                                             AS signals,
       sig_volume, sig_margin, sig_lvs, sig_short,
       TO_CHAR(price_date, 'YYYY-MM-DD')                             AS price_date,
       close_price, volume, avg_vol_20d, avg_vol_n, vol_vs_20d,
       avg_turnover_20d_mil, split_flag,
       TO_CHAR(margin_date, 'YYYY-MM-DD')                            AS margin_date,
       margin_ratio, margin_shrt_dtc, margin_shrt_vs_13w, margin_shrt_vs_med52,
       margin_shrt_n_13w, margin_shrt_vol, margin_season_warn,
       TO_CHAR(lvs_last_sub_date, 'YYYY-MM-DD')                      AS lvs_last_sub_date,
       lvs_recent_docs, lvs_recent_grps, lvs_recent_material, lvs_recent_summary,
${watch ? `       lvs_grp_cnt, lvs_total_pct, lvs_grp_cnt_noratio, lvs_grp_cnt_stale,
` : ''}       short_calc_date,
       short_days_since, short_status, short_ratio_pct, short_ratio_chg_pt,
       reporter_count, short_stale_cnt
FROM flags
WHERE sig_volume + sig_margin + sig_lvs + sig_short ${watch ? '> 0' : '>= 2'}
ORDER BY signal_score DESC, vol_vs_20d DESC NULLS LAST
${watch ? '' : 'FETCH FIRST 100 ROWS ONLY'}`;
}

const SIGNAL_BINDS = {
  minAvgVolN: PARAMS.minAvgVolN,
  volMultTh: PARAMS.volMultTh,
  minShrtN: PARAMS.minShrtN,
  shrtMultTh: PARAMS.shrtMultTh,
  lvsDaysTh: PARAMS.lvsDaysTh,
  lvsMinRatio: PARAMS.lvsMinRatio,
  lvsMinChg: PARAMS.lvsMinChg,
  shortChgTh: PARAMS.shortChgTh,
  ...SP_BINDS(),
};

const SQL_SIGNALS_WATCHLIST = buildSignalSql('watchlist');
const SQL_SIGNALS_ALL = buildSignalSql('all');

/** シグナル検出(ウォッチリスト銘柄)。第三階層 2。 */
async function fetchSignals(connection) {
  return selectRows(connection, SQL_SIGNALS_WATCHLIST, {
    ...SIGNAL_BINDS,
    lvsStaleDays: PARAMS.lvsStaleDays,
  });
}

/**
 * シグナル検出(全銘柄・流動性フィルタ付き)。第三階層 3。
 * **重い。画面から明示的に押されたときだけ実行する。**
 */
async function fetchSignalsAll(connection) {
  return selectRows(connection, SQL_SIGNALS_ALL, {
    ...SIGNAL_BINDS,
    minTurnover20d: PARAMS.minTurnover20d,
  });
}

/**
 * 補助シグナル。第三階層 4。
 * 踏み上げの燃料がどれだけ溜まっているかを見る。週1回で足りる。
 *
 * 20日平均出来高の定義は 2・3 と揃えてある(直近日を含まない移動平均)。
 * MARGIN_SEASON_WARN は DAYS_TO_COVER にも効く(つなぎ売りで売残が膨らむ週は
 * DAYS_TO_COVER も一緒に跳ねる。燃料が溜まったわけではない)。
 */
async function fetchSupplementary(connection) {
  return selectRows(
    connection,
    `WITH target AS (
        SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
     ),
     avg_vol AS (
        SELECT code, avg_vol_20d, avg_vol_n
        FROM (
            SELECT p.code,
                   AVG(p.volume)   OVER (PARTITION BY p.code ORDER BY p.price_date
                                         ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
                   COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                                         ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
                   ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
            FROM equity_price_daily p
            WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
              AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
        )
        WHERE rn = 1
     ),
     mgn AS (
        SELECT code, app_date, shrt_vol, long_vol
        FROM (
            SELECT m.code, m.app_date, m.shrt_vol, m.long_vol,
                   ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
            FROM equity_margin_interest m
            WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
              AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -6)
        )
        WHERE rn = 1
     ),
     alert AS (
        -- 日々公表銘柄。30日窓なので、指定が外れた後もしばらく 'Y' のまま残る
        -- (ALERT_APP_DATE を見ること)。
        SELECT code, app_date, sl_ratio, shrt_out_ratio, tse_mrgn_reg_cls
        FROM (
            SELECT a.code, a.app_date, a.sl_ratio, a.shrt_out_ratio, a.tse_mrgn_reg_cls,
                   ROW_NUMBER() OVER (PARTITION BY a.code ORDER BY a.app_date DESC) AS rn
            FROM v_equity_margin_alert_latest a
            WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = a.code)
              AND a.app_date >= TRUNC(SYSDATE) - 30
        )
        WHERE rn = 1
     ),
     ${spCarryCtes('AND EXISTS (SELECT 1 FROM target t WHERE t.code = i.code)')},
     sp_prev_cnt AS (
        -- 報告者数の :shortChgDays 前(持ち越しで数える。以前は最新計算日の行の人数だった)
        SELECT code, COUNT(CASE WHEN k = 'PREV' AND carried = 'Y' THEN 1 END) AS reporter_count_prev
        FROM sp_live
        GROUP BY code
     )
     SELECT em.code, em.co_name,
            TO_CHAR(mgn.app_date, 'YYYY-MM-DD')                          AS margin_date,
            CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
                  AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
                 THEN 'CROSS' END                                        AS margin_season_warn,
            mgn.shrt_vol                                                 AS margin_shrt_vol,
            ROUND(avg_vol.avg_vol_20d)                                   AS avg_vol_20d,
            avg_vol.avg_vol_n,
            ROUND(mgn.shrt_vol / NULLIF(avg_vol.avg_vol_20d, 0), 1)      AS days_to_cover,
            CASE WHEN alert.code IS NOT NULL THEN 'Y' ELSE 'N' END       AS daily_publication,
            TO_CHAR(alert.app_date, 'YYYY-MM-DD')                        AS alert_app_date,
            alert.sl_ratio                                               AS alert_sl_ratio,
            alert.tse_mrgn_reg_cls,
            TO_CHAR(sp.calc_date, 'YYYY-MM-DD')                          AS short_calc_date,
            TRUNC(SYSDATE) - sp.calc_date                                AS short_days_since,
            sp.reporter_count,
            sp.reporter_count - sp_prev_cnt.reporter_count_prev          AS reporter_chg
     FROM equity_master em
     JOIN target ON target.code = em.code
     LEFT JOIN mgn     ON mgn.code     = em.code
     LEFT JOIN avg_vol ON avg_vol.code = em.code
     LEFT JOIN alert   ON alert.code   = em.code
     LEFT JOIN sp      ON sp.code      = em.code
     LEFT JOIN sp_prev_cnt ON sp_prev_cnt.code = em.code
     WHERE em.delisted_flag = 'N'
     ORDER BY days_to_cover DESC NULLS LAST`,
    SP_BINDS()
  );
}

module.exports = {
  PARAMS,
  CALIBRATED_AT,
  FRESHNESS_LIMITS,
  fetchFreshness,
  fetchSections,
  fetchMacro,
  fetchWatchlist,
  fetchWatchlistSheet,
  fetchCodeTimeseries,
  fetchCodeHolders,
  fetchCodeLvsHistory,
  fetchPseudoFloat,
  fetchSignals,
  fetchSignalsAll,
  fetchSupplementary,
  // テスト用(SQLの中身を検査できるように)
  _buildSignalSql: buildSignalSql,
};
