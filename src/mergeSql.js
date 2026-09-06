'use strict';

/**
 * ステージングテーブルから本番テーブルへのMERGE処理をまとめたモジュール。
 * loadInitial.js / loadDaily.js の両方から使用する。
 *
 * MERGEのUSING句では必ずROW_NUMBER()による重複排除を行っている。
 * 同一キーの行が複数あるとOracleは ORA-30926 を返すため、
 * 元データに万一重複があっても止まらないようにするための保険。
 */

/**
 * EQUITY_MASTER_STG から EQUITY_MASTER へMERGEする。
 *
 * ステージングには「1銘柄×複数日」のスナップショットが入っているため、
 * 銘柄ごとに最新のas_of_dateの行だけを対象とする。
 * さらに、既存レコードより古い基準日で上書きしないようUPDATE側に条件を付けている
 * (ファイルを時系列と異なる順序で再実行しても最新状態が壊れない)。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeMaster(connection) {
  const sql = `
    MERGE INTO equity_master t
    USING (
      SELECT code, as_of_date, co_name, co_name_en,
             sector17_code, sector17_name, sector33_code, sector33_name,
             scale_category, market_code, market_name,
             margin_code, margin_name, prod_category
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.code ORDER BY s.as_of_date DESC) AS rn
        FROM equity_master_stg s
        WHERE s.code IS NOT NULL AND s.as_of_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.code = s.code)
    WHEN MATCHED THEN
      UPDATE SET
        t.co_name        = s.co_name,
        t.co_name_en     = s.co_name_en,
        t.sector17_code  = s.sector17_code,
        t.sector17_name  = s.sector17_name,
        t.sector33_code  = s.sector33_code,
        t.sector33_name  = s.sector33_name,
        t.scale_category = s.scale_category,
        t.market_code    = s.market_code,
        t.market_name    = s.market_name,
        t.margin_code    = s.margin_code,
        t.margin_name    = s.margin_name,
        t.prod_category  = s.prod_category,
        t.as_of_date     = s.as_of_date,
        t.updated_at     = SYSTIMESTAMP
      WHERE s.as_of_date >= t.as_of_date
    WHEN NOT MATCHED THEN
      INSERT (code, co_name, co_name_en, sector17_code, sector17_name,
              sector33_code, sector33_name, scale_category, market_code, market_name,
              margin_code, margin_name, prod_category, as_of_date, delisted_flag, updated_at)
      VALUES (s.code, s.co_name, s.co_name_en, s.sector17_code, s.sector17_name,
              s.sector33_code, s.sector33_name, s.scale_category, s.market_code, s.market_name,
              s.margin_code, s.margin_name, s.prod_category, s.as_of_date, 'N', SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * EQUITY_MASTER_STG から EQUITY_MASTER_HIST へMERGEする。
 * こちらは日次スナップショットをそのまま蓄積する(キーは code + as_of_date)。
 *
 * 注意: EQUITY_MASTER_HIST は EQUITY_MASTER への外部キーを持つため、
 *       必ず mergeMaster() を先に実行しておくこと。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeMasterHist(connection) {
  const sql = `
    MERGE INTO equity_master_hist t
    USING (
      SELECT code, as_of_date, co_name, co_name_en,
             sector17_code, sector17_name, sector33_code, sector33_name,
             scale_category, market_code, market_name,
             margin_code, margin_name, prod_category
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.code, s.as_of_date ORDER BY s.loaded_at DESC) AS rn
        FROM equity_master_stg s
        WHERE s.code IS NOT NULL AND s.as_of_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.code = s.code AND t.as_of_date = s.as_of_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.co_name        = s.co_name,
        t.co_name_en     = s.co_name_en,
        t.sector17_code  = s.sector17_code,
        t.sector17_name  = s.sector17_name,
        t.sector33_code  = s.sector33_code,
        t.sector33_name  = s.sector33_name,
        t.scale_category = s.scale_category,
        t.market_code    = s.market_code,
        t.market_name    = s.market_name,
        t.margin_code    = s.margin_code,
        t.margin_name    = s.margin_name,
        t.prod_category  = s.prod_category,
        t.loaded_at      = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (code, as_of_date, co_name, co_name_en, sector17_code, sector17_name,
              sector33_code, sector33_name, scale_category, market_code, market_name,
              margin_code, margin_name, prod_category, loaded_at)
      VALUES (s.code, s.as_of_date, s.co_name, s.co_name_en, s.sector17_code, s.sector17_name,
              s.sector33_code, s.sector33_name, s.scale_category, s.market_code, s.market_name,
              s.margin_code, s.margin_name, s.prod_category, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * EQUITY_PRICE_DAILY_STG から EQUITY_PRICE_DAILY へMERGEする。
 *
 * 注意: EQUITY_PRICE_DAILY は EQUITY_MASTER への外部キーを持つため、
 *       マスタの取り込みを先に完了させておくこと。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergePriceDaily(connection) {
  const sql = `
    MERGE INTO equity_price_daily t
    USING (
      SELECT code, price_date, open_price, high_price, low_price, close_price,
             upper_limit, lower_limit, volume, turnover_value, adj_factor
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.code, s.price_date ORDER BY s.loaded_at DESC) AS rn
        FROM equity_price_daily_stg s
        WHERE s.code IS NOT NULL AND s.price_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.code = s.code AND t.price_date = s.price_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.open_price     = s.open_price,
        t.high_price     = s.high_price,
        t.low_price      = s.low_price,
        t.close_price    = s.close_price,
        t.upper_limit    = s.upper_limit,
        t.lower_limit    = s.lower_limit,
        t.volume         = s.volume,
        t.turnover_value = s.turnover_value,
        t.adj_factor     = s.adj_factor,
        t.loaded_at      = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (code, price_date, open_price, high_price, low_price, close_price,
              upper_limit, lower_limit, volume, turnover_value, adj_factor, loaded_at)
      VALUES (s.code, s.price_date, s.open_price, s.high_price, s.low_price, s.close_price,
              s.upper_limit, s.lower_limit, s.volume, s.turnover_value, s.adj_factor, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * ステージングに、EQUITY_MASTERに存在しない銘柄コードが含まれていないか確認する。
 * 株価のMERGE前に呼び、外部キー違反を事前に検出するためのもの。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<string[]>} マスタ未登録の銘柄コード一覧(空なら問題なし)
 */
async function findUnknownCodesInPriceStg(connection) {
  const result = await connection.execute(
    `SELECT DISTINCT s.code
     FROM equity_price_daily_stg s
     WHERE s.code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM equity_master m WHERE m.code = s.code)`
  );
  return result.rows.map((r) => r[0]);
}

/**
 * EQUITY_MASTER_HIST の最新基準日に存在しない銘柄を上場廃止(DELISTED_FLAG='Y')にする。
 * 全マスタファイルの取り込み完了後に一度だけ実行する。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 更新件数
 */
async function refreshDelistedFlag(connection) {
  const sql = `
    UPDATE equity_master m
    SET m.delisted_flag = CASE
          WHEN EXISTS (
            SELECT 1 FROM equity_master_hist h
            WHERE h.code = m.code
              AND h.as_of_date = (SELECT MAX(as_of_date) FROM equity_master_hist)
          ) THEN 'N' ELSE 'Y'
        END,
        m.updated_at = SYSTIMESTAMP
    WHERE m.delisted_flag <> CASE
          WHEN EXISTS (
            SELECT 1 FROM equity_master_hist h
            WHERE h.code = m.code
              AND h.as_of_date = (SELECT MAX(as_of_date) FROM equity_master_hist)
          ) THEN 'N' ELSE 'Y'
        END
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

//==================================================================
// 空売り・信用取引関連
//==================================================================

/**
 * ステージングに、EQUITY_MASTERに存在しない銘柄コードが含まれていないか確認する。
 * MERGE前に呼び、外部キー違反(ORA-02291)を「どの銘柄が原因か分かる」形にするためのもの。
 *
 * @param {import('oracledb').Connection} connection
 * @param {string} stagingTable ステージングテーブル名(例: 'EQUITY_MARGIN_INTEREST_STG')
 * @returns {Promise<string[]>} マスタ未登録の銘柄コード一覧(空なら問題なし)
 */
async function findUnknownCodesInStg(connection, stagingTable) {
  // テーブル名は呼び出し側の定数のみを渡す前提(外部入力を通さない)
  if (!/^[A-Z_]+$/.test(stagingTable)) {
    throw new Error(`不正なステージングテーブル名です: ${stagingTable}`);
  }
  const result = await connection.execute(
    `SELECT DISTINCT s.code
     FROM ${stagingTable} s
     WHERE s.code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM equity_master m WHERE m.code = s.code)`
  );
  return result.rows.map((r) => r[0]);
}

/**
 * ステージングから、EQUITY_MASTERに存在しない銘柄コードの行を削除する。
 *
 * 【なぜ必要か】
 *   空売り残高報告や信用取引残高には、東証以外の取引所に単独上場している銘柄が
 *   含まれることがある(例: 3808 オーケーウェブ = 名証単独上場)。
 *   J-Quantsの銘柄マスタは東証データのため、これらはEQUITY_MASTERに存在せず、
 *   そのままMERGEすると外部キー違反(ORA-02291)でファイル全体が失敗する。
 *
 *   これらは「取り込めない銘柄」であって「データの異常」ではないので、
 *   該当行だけを取り除いて残りを取り込む。落とした銘柄は呼び出し側で警告する。
 *
 * @param {import('oracledb').Connection} connection
 * @param {string} stagingTable ステージングテーブル名
 * @returns {Promise<number>} 削除した行数
 */
async function deleteUnknownCodesFromStg(connection, stagingTable) {
  if (!/^[A-Z_]+$/.test(stagingTable)) {
    throw new Error(`不正なステージングテーブル名です: ${stagingTable}`);
  }
  const result = await connection.execute(
    `DELETE FROM ${stagingTable} s
     WHERE s.code IS NULL
        OR NOT EXISTS (SELECT 1 FROM equity_master m WHERE m.code = s.code)`,
    {},
    { autoCommit: false }
  );
  return result.rowsAffected || 0;
}

/**
 * SECTOR_SHORT_RATIO_STG から SECTOR_SHORT_RATIO へMERGEする。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeShortRatio(connection) {
  const sql = `
    MERGE INTO sector_short_ratio t
    USING (
      SELECT s33_code, ratio_date, sell_ex_short_va, shrt_with_res_va, shrt_no_res_va
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.s33_code, s.ratio_date
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM sector_short_ratio_stg s
        WHERE s.s33_code IS NOT NULL AND s.ratio_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.s33_code = s.s33_code AND t.ratio_date = s.ratio_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.sell_ex_short_va = s.sell_ex_short_va,
        t.shrt_with_res_va = s.shrt_with_res_va,
        t.shrt_no_res_va   = s.shrt_no_res_va,
        t.loaded_at        = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (s33_code, ratio_date, sell_ex_short_va, shrt_with_res_va, shrt_no_res_va, loaded_at)
      VALUES (s.s33_code, s.ratio_date, s.sell_ex_short_va, s.shrt_with_res_va,
              s.shrt_no_res_va, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * EQUITY_MARGIN_INTEREST_STG から EQUITY_MARGIN_INTEREST へMERGEする。
 *
 * 金額項目(*_VAL)は2026年9月25日申込分以降のみ提供されるため、それ以前の
 * データではNULLのまま更新される(既存値を消さないための特別扱いは不要。
 * 同じ申込日のデータで金額だけ後から付与されることは無いため)。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeMarginInterest(connection) {
  const sql = `
    MERGE INTO equity_margin_interest t
    USING (
      SELECT code, app_date, iss_type,
             shrt_vol, long_vol, shrt_neg_vol, long_neg_vol, shrt_std_vol, long_std_vol,
             shrt_val, long_val, shrt_neg_val, long_neg_val, shrt_std_val, long_std_val
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.code, s.app_date
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM equity_margin_interest_stg s
        WHERE s.code IS NOT NULL AND s.app_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.code = s.code AND t.app_date = s.app_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.iss_type     = s.iss_type,
        t.shrt_vol     = s.shrt_vol,
        t.long_vol     = s.long_vol,
        t.shrt_neg_vol = s.shrt_neg_vol,
        t.long_neg_vol = s.long_neg_vol,
        t.shrt_std_vol = s.shrt_std_vol,
        t.long_std_vol = s.long_std_vol,
        t.shrt_val     = s.shrt_val,
        t.long_val     = s.long_val,
        t.shrt_neg_val = s.shrt_neg_val,
        t.long_neg_val = s.long_neg_val,
        t.shrt_std_val = s.shrt_std_val,
        t.long_std_val = s.long_std_val,
        t.loaded_at    = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (code, app_date, iss_type,
              shrt_vol, long_vol, shrt_neg_vol, long_neg_vol, shrt_std_vol, long_std_vol,
              shrt_val, long_val, shrt_neg_val, long_neg_val, shrt_std_val, long_std_val,
              loaded_at)
      VALUES (s.code, s.app_date, s.iss_type,
              s.shrt_vol, s.long_vol, s.shrt_neg_vol, s.long_neg_vol,
              s.shrt_std_vol, s.long_std_vol,
              s.shrt_val, s.long_val, s.shrt_neg_val, s.long_neg_val,
              s.shrt_std_val, s.long_std_val,
              SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * EQUITY_MARGIN_ALERT_STG から EQUITY_MARGIN_ALERT へMERGEする。
 *
 * 過誤訂正時は「申込日が同一で公表日が異なるレコード」が追加される仕様のため、
 * 結合キーに公表日を含める。訂正前の行は上書きせず両方を保持する。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeMarginAlert(connection) {
  const sql = `
    MERGE INTO equity_margin_alert t
    USING (
      SELECT code, app_date, pub_date,
             reason_restricted, reason_daily_publication, reason_monitoring,
             reason_restricted_by_jsf, reason_precaution_by_jsf, reason_unclear_or_sec_alert,
             shrt_out, shrt_out_chg, shrt_out_ratio,
             long_out, long_out_chg, long_out_ratio,
             sl_ratio,
             shrt_neg_out, shrt_neg_out_chg, shrt_std_out, shrt_std_out_chg,
             long_neg_out, long_neg_out_chg, long_std_out, long_std_out_chg,
             tse_mrgn_reg_cls
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.code, s.app_date, s.pub_date
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM equity_margin_alert_stg s
        WHERE s.code IS NOT NULL AND s.app_date IS NOT NULL AND s.pub_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.code = s.code AND t.app_date = s.app_date AND t.pub_date = s.pub_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.reason_restricted           = s.reason_restricted,
        t.reason_daily_publication    = s.reason_daily_publication,
        t.reason_monitoring           = s.reason_monitoring,
        t.reason_restricted_by_jsf    = s.reason_restricted_by_jsf,
        t.reason_precaution_by_jsf    = s.reason_precaution_by_jsf,
        t.reason_unclear_or_sec_alert = s.reason_unclear_or_sec_alert,
        t.shrt_out          = s.shrt_out,
        t.shrt_out_chg      = s.shrt_out_chg,
        t.shrt_out_ratio    = s.shrt_out_ratio,
        t.long_out          = s.long_out,
        t.long_out_chg      = s.long_out_chg,
        t.long_out_ratio    = s.long_out_ratio,
        t.sl_ratio          = s.sl_ratio,
        t.shrt_neg_out      = s.shrt_neg_out,
        t.shrt_neg_out_chg  = s.shrt_neg_out_chg,
        t.shrt_std_out      = s.shrt_std_out,
        t.shrt_std_out_chg  = s.shrt_std_out_chg,
        t.long_neg_out      = s.long_neg_out,
        t.long_neg_out_chg  = s.long_neg_out_chg,
        t.long_std_out      = s.long_std_out,
        t.long_std_out_chg  = s.long_std_out_chg,
        t.tse_mrgn_reg_cls  = s.tse_mrgn_reg_cls,
        t.loaded_at         = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (code, app_date, pub_date,
              reason_restricted, reason_daily_publication, reason_monitoring,
              reason_restricted_by_jsf, reason_precaution_by_jsf, reason_unclear_or_sec_alert,
              shrt_out, shrt_out_chg, shrt_out_ratio,
              long_out, long_out_chg, long_out_ratio,
              sl_ratio,
              shrt_neg_out, shrt_neg_out_chg, shrt_std_out, shrt_std_out_chg,
              long_neg_out, long_neg_out_chg, long_std_out, long_std_out_chg,
              tse_mrgn_reg_cls, loaded_at)
      VALUES (s.code, s.app_date, s.pub_date,
              s.reason_restricted, s.reason_daily_publication, s.reason_monitoring,
              s.reason_restricted_by_jsf, s.reason_precaution_by_jsf,
              s.reason_unclear_or_sec_alert,
              s.shrt_out, s.shrt_out_chg, s.shrt_out_ratio,
              s.long_out, s.long_out_chg, s.long_out_ratio,
              s.sl_ratio,
              s.shrt_neg_out, s.shrt_neg_out_chg, s.shrt_std_out, s.shrt_std_out_chg,
              s.long_neg_out, s.long_neg_out_chg, s.long_std_out, s.long_std_out_chg,
              s.tse_mrgn_reg_cls, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * EQUITY_SHORT_POSITION_STG の内容で EQUITY_SHORT_POSITION を「公表日単位で洗い替え」する。
 *
 * 【MERGEではなくDELETE→INSERTにしている理由】
 *   同一の (公表日, 計算日, 銘柄) に複数の報告者の行が入る。報告者を識別する
 *   SSName / DICName / FundName は空になることがあり、OracleではNULL同士が
 *   等しいと判定されないため、これらを結合キーにしたMERGEは
 *     ・同じ行を毎回INSERTしてしまう(重複)
 *     ・一意制約も効かない
 *   という二重の問題を起こす。
 *   一方、Bulk APIのファイルは「その公表日のデータ一式」なので、公表日単位で
 *   削除してから入れ直せば、何度実行しても同じ結果になる(冪等)。
 *
 * 【前提】
 *   1つの公表日のデータが複数ファイルに分割されていないこと。
 *   分割されている場合、後のファイルが前のファイルの分を消してしまう。
 *   ステージングに存在する公表日だけを対象にしているため、
 *   historical(月次)ファイルのように複数日を含む場合も正しく動作する。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<{deleted: number, inserted: number}>}
 */
async function replaceShortPosition(connection) {
  const deleteResult = await connection.execute(
    `DELETE FROM equity_short_position t
     WHERE EXISTS (
       SELECT 1 FROM equity_short_position_stg s
       WHERE s.disc_date = t.disc_date
     )`,
    {},
    { autoCommit: false }
  );

  const insertResult = await connection.execute(
    `INSERT INTO equity_short_position (
       disc_date, calc_date, code, ss_name, ss_addr, dic_name, dic_addr, fund_name,
       shrt_pos_to_so, shrt_pos_shares, shrt_pos_units,
       prev_rpt_date, prev_rpt_ratio, notes, loaded_at
     )
     SELECT s.disc_date, s.calc_date, s.code, s.ss_name, s.ss_addr,
            s.dic_name, s.dic_addr, s.fund_name,
            s.shrt_pos_to_so, s.shrt_pos_shares, s.shrt_pos_units,
            s.prev_rpt_date, s.prev_rpt_ratio, s.notes, SYSTIMESTAMP
     FROM equity_short_position_stg s
     WHERE s.disc_date IS NOT NULL
       AND s.calc_date IS NOT NULL
       AND s.code      IS NOT NULL`,
    {},
    { autoCommit: false }
  );

  return {
    deleted: deleteResult.rowsAffected || 0,
    inserted: insertResult.rowsAffected || 0,
  };
}


//==================================================================
// 取引カレンダー・指数四本値関連 (Tier 1)
// いずれもEQUITY_MASTERへの外部キーを持たない(銘柄単位のデータではないため)。
//==================================================================

/**
 * TRADING_CALENDAR_STG から TRADING_CALENDAR へMERGEする。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeTradingCalendar(connection) {
  const sql = `
    MERGE INTO trading_calendar t
    USING (
      SELECT calendar_date, hol_div
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.calendar_date ORDER BY s.loaded_at DESC) AS rn
        FROM trading_calendar_stg s
        WHERE s.calendar_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.calendar_date = s.calendar_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.hol_div   = s.hol_div,
        t.loaded_at = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (calendar_date, hol_div, loaded_at)
      VALUES (s.calendar_date, s.hol_div, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * TOPIX_PRICE_DAILY_STG から TOPIX_PRICE_DAILY へMERGEする。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeTopixPriceDaily(connection) {
  const sql = `
    MERGE INTO topix_price_daily t
    USING (
      SELECT price_date, open_price, high_price, low_price, close_price
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.price_date ORDER BY s.loaded_at DESC) AS rn
        FROM topix_price_daily_stg s
        WHERE s.price_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.price_date = s.price_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.open_price  = s.open_price,
        t.high_price  = s.high_price,
        t.low_price   = s.low_price,
        t.close_price = s.close_price,
        t.loaded_at   = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (price_date, open_price, high_price, low_price, close_price, loaded_at)
      VALUES (s.price_date, s.open_price, s.high_price, s.low_price, s.close_price, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * INDEX_PRICE_DAILY_STG から INDEX_PRICE_DAILY へMERGEする。
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeIndexPriceDaily(connection) {
  const sql = `
    MERGE INTO index_price_daily t
    USING (
      SELECT index_code, price_date, open_price, high_price, low_price, close_price
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.index_code, s.price_date
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM index_price_daily_stg s
        WHERE s.index_code IS NOT NULL AND s.price_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.index_code = s.index_code AND t.price_date = s.price_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.open_price  = s.open_price,
        t.high_price  = s.high_price,
        t.low_price   = s.low_price,
        t.close_price = s.close_price,
        t.loaded_at   = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (index_code, price_date, open_price, high_price, low_price, close_price, loaded_at)
      VALUES (s.index_code, s.price_date, s.open_price, s.high_price, s.low_price, s.close_price, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}


//==================================================================
// 投資部門別情報・決算発表予定日関連 (Tier 2)
//==================================================================

/**
 * INVESTOR_TYPE_TRADING_STG から INVESTOR_TYPE_TRADING へMERGEする。
 *
 * 過誤訂正時は「市場名・開始日・終了日が同一で公表日が異なるレコード」が
 * 追加される仕様(2023/4/3以降)のため、結合キーに公表日を含める。
 * 訂正前の行は上書きせず両方を保持する(EQUITY_MARGIN_ALERTと同じパターン)。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeInvestorTypeTrading(connection) {
  const sql = `
    MERGE INTO investor_type_trading t
    USING (
      SELECT section, st_date, en_date, pub_date,
             prop_sell, prop_buy, prop_tot, prop_bal, brk_sell, brk_buy, brk_tot, brk_bal, tot_sell, tot_buy, tot_tot, tot_bal, ind_sell, ind_buy, ind_tot, ind_bal, frgn_sell, frgn_buy, frgn_tot, frgn_bal, sec_co_sell, sec_co_buy, sec_co_tot, sec_co_bal, inv_tr_sell, inv_tr_buy, inv_tr_tot, inv_tr_bal, bus_co_sell, bus_co_buy, bus_co_tot, bus_co_bal, oth_co_sell, oth_co_buy, oth_co_tot, oth_co_bal, ins_co_sell, ins_co_buy, ins_co_tot, ins_co_bal, bank_sell, bank_buy, bank_tot, bank_bal, trst_bnk_sell, trst_bnk_buy, trst_bnk_tot, trst_bnk_bal, oth_fin_sell, oth_fin_buy, oth_fin_tot, oth_fin_bal
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.section, s.st_date, s.en_date, s.pub_date
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM investor_type_trading_stg s
        WHERE s.section IS NOT NULL AND s.st_date IS NOT NULL
          AND s.en_date IS NOT NULL AND s.pub_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.section = s.section AND t.st_date = s.st_date
        AND t.en_date = s.en_date AND t.pub_date = s.pub_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.prop_sell = s.prop_sell,
        t.prop_buy = s.prop_buy,
        t.prop_tot = s.prop_tot,
        t.prop_bal = s.prop_bal,
        t.brk_sell = s.brk_sell,
        t.brk_buy = s.brk_buy,
        t.brk_tot = s.brk_tot,
        t.brk_bal = s.brk_bal,
        t.tot_sell = s.tot_sell,
        t.tot_buy = s.tot_buy,
        t.tot_tot = s.tot_tot,
        t.tot_bal = s.tot_bal,
        t.ind_sell = s.ind_sell,
        t.ind_buy = s.ind_buy,
        t.ind_tot = s.ind_tot,
        t.ind_bal = s.ind_bal,
        t.frgn_sell = s.frgn_sell,
        t.frgn_buy = s.frgn_buy,
        t.frgn_tot = s.frgn_tot,
        t.frgn_bal = s.frgn_bal,
        t.sec_co_sell = s.sec_co_sell,
        t.sec_co_buy = s.sec_co_buy,
        t.sec_co_tot = s.sec_co_tot,
        t.sec_co_bal = s.sec_co_bal,
        t.inv_tr_sell = s.inv_tr_sell,
        t.inv_tr_buy = s.inv_tr_buy,
        t.inv_tr_tot = s.inv_tr_tot,
        t.inv_tr_bal = s.inv_tr_bal,
        t.bus_co_sell = s.bus_co_sell,
        t.bus_co_buy = s.bus_co_buy,
        t.bus_co_tot = s.bus_co_tot,
        t.bus_co_bal = s.bus_co_bal,
        t.oth_co_sell = s.oth_co_sell,
        t.oth_co_buy = s.oth_co_buy,
        t.oth_co_tot = s.oth_co_tot,
        t.oth_co_bal = s.oth_co_bal,
        t.ins_co_sell = s.ins_co_sell,
        t.ins_co_buy = s.ins_co_buy,
        t.ins_co_tot = s.ins_co_tot,
        t.ins_co_bal = s.ins_co_bal,
        t.bank_sell = s.bank_sell,
        t.bank_buy = s.bank_buy,
        t.bank_tot = s.bank_tot,
        t.bank_bal = s.bank_bal,
        t.trst_bnk_sell = s.trst_bnk_sell,
        t.trst_bnk_buy = s.trst_bnk_buy,
        t.trst_bnk_tot = s.trst_bnk_tot,
        t.trst_bnk_bal = s.trst_bnk_bal,
        t.oth_fin_sell = s.oth_fin_sell,
        t.oth_fin_buy = s.oth_fin_buy,
        t.oth_fin_tot = s.oth_fin_tot,
        t.oth_fin_bal = s.oth_fin_bal,
        t.loaded_at = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (section, st_date, en_date, pub_date,
              prop_sell, prop_buy, prop_tot, prop_bal, brk_sell, brk_buy, brk_tot, brk_bal, tot_sell, tot_buy, tot_tot, tot_bal, ind_sell, ind_buy, ind_tot, ind_bal, frgn_sell, frgn_buy, frgn_tot, frgn_bal, sec_co_sell, sec_co_buy, sec_co_tot, sec_co_bal, inv_tr_sell, inv_tr_buy, inv_tr_tot, inv_tr_bal, bus_co_sell, bus_co_buy, bus_co_tot, bus_co_bal, oth_co_sell, oth_co_buy, oth_co_tot, oth_co_bal, ins_co_sell, ins_co_buy, ins_co_tot, ins_co_bal, bank_sell, bank_buy, bank_tot, bank_bal, trst_bnk_sell, trst_bnk_buy, trst_bnk_tot, trst_bnk_bal, oth_fin_sell, oth_fin_buy, oth_fin_tot, oth_fin_bal,
              loaded_at)
      VALUES (s.section, s.st_date, s.en_date, s.pub_date,
              s.prop_sell, s.prop_buy, s.prop_tot, s.prop_bal, s.brk_sell, s.brk_buy, s.brk_tot, s.brk_bal, s.tot_sell, s.tot_buy, s.tot_tot, s.tot_bal, s.ind_sell, s.ind_buy, s.ind_tot, s.ind_bal, s.frgn_sell, s.frgn_buy, s.frgn_tot, s.frgn_bal, s.sec_co_sell, s.sec_co_buy, s.sec_co_tot, s.sec_co_bal, s.inv_tr_sell, s.inv_tr_buy, s.inv_tr_tot, s.inv_tr_bal, s.bus_co_sell, s.bus_co_buy, s.bus_co_tot, s.bus_co_bal, s.oth_co_sell, s.oth_co_buy, s.oth_co_tot, s.oth_co_bal, s.ins_co_sell, s.ins_co_buy, s.ins_co_tot, s.ins_co_bal, s.bank_sell, s.bank_buy, s.bank_tot, s.bank_bal, s.trst_bnk_sell, s.trst_bnk_buy, s.trst_bnk_tot, s.trst_bnk_bal, s.oth_fin_sell, s.oth_fin_buy, s.oth_fin_tot, s.oth_fin_bal,
              SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

/**
 * EARNINGS_SCHEDULE_STG から EARNINGS_SCHEDULE へMERGEする。
 *
 * 予定日の変更・未定への変更履歴を含めて公表日単位でそのまま保持する
 * (過去の値は消さない)。「現在有効な予定」は V_EARNINGS_SCHEDULE_LATEST を使う。
 *
 * @param {import('oracledb').Connection} connection
 * @returns {Promise<number>} 反映件数
 */
async function mergeEarningsSchedule(connection) {
  const sql = `
    MERGE INTO earnings_schedule t
    USING (
      SELECT code, fye, fq_name, pub_date, sch_date, co_name, co_name_en
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.code, s.fye, s.fq_name, s.pub_date
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM earnings_schedule_stg s
        WHERE s.code IS NOT NULL AND s.fye IS NOT NULL
          AND s.fq_name IS NOT NULL AND s.pub_date IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.code = s.code AND t.fye = s.fye AND t.fq_name = s.fq_name AND t.pub_date = s.pub_date)
    WHEN MATCHED THEN
      UPDATE SET
        t.sch_date    = s.sch_date,
        t.co_name     = s.co_name,
        t.co_name_en  = s.co_name_en,
        t.loaded_at   = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (code, fye, fq_name, pub_date, sch_date, co_name, co_name_en, loaded_at)
      VALUES (s.code, s.fye, s.fq_name, s.pub_date, s.sch_date, s.co_name, s.co_name_en, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}


async function mergeFinancialSummary(connection) {
  const sql = `
    MERGE INTO financial_summary t
    USING (
      SELECT disc_date, disc_time, code, disc_no, doc_type, cur_per_type, cur_per_st, cur_per_en, cur_fy_st, cur_fy_en, nxt_fy_st, nxt_fy_en, sales, op, odp, np, eps, deps, ta, eq, eq_ar, bps, cfo, cfi, cff, cash_eq, div_1q, div_2q, div_3q, div_fy, div_ann, div_unit, div_total_ann, payout_ratio_ann, f_div_1q, f_div_2q, f_div_3q, f_div_fy, f_div_ann, f_div_unit, f_div_total_ann, f_payout_ratio_ann, nxf_div_1q, nxf_div_2q, nxf_div_3q, nxf_div_fy, nxf_div_ann, nxf_div_unit, nxf_payout_ratio_ann, f_sales_2q, f_op_2q, f_odp_2q, f_np_2q, f_eps_2q, nxf_sales_2q, nxf_op_2q, nxf_odp_2q, nxf_np_2q, nxf_eps_2q, f_sales, f_op, f_odp, f_np, f_eps, nxf_sales, nxf_op, nxf_odp, nxf_np, nxf_eps, mat_chg_sub, sig_chg_in_c, chg_by_as_rev, chg_no_as_rev, chg_ac_est, retro_rst, sh_out_fy, tr_sh_fy, avg_sh, nc_sales, nc_op, nc_odp, nc_np, nc_eps, nc_ta, nc_eq, nc_eq_ar, nc_bps, fnc_sales_2q, fnc_op_2q, fnc_odp_2q, fnc_np_2q, fnc_eps_2q, nxfnc_sales_2q, nxfnc_op_2q, nxfnc_odp_2q, nxfnc_np_2q, nxfnc_eps_2q, fnc_sales, fnc_op, fnc_odp, fnc_np, fnc_eps, nxfnc_sales, nxfnc_op, nxfnc_odp, nxfnc_np, nxfnc_eps, sh_eq, nc_sh_eq, roe, nc_roe
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.disc_no
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM financial_summary_stg s
        WHERE s.disc_no IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.disc_no = s.disc_no)
    WHEN MATCHED THEN
      UPDATE SET
        t.disc_date = s.disc_date,
        t.disc_time = s.disc_time,
        t.code = s.code,
        t.doc_type = s.doc_type,
        t.cur_per_type = s.cur_per_type,
        t.cur_per_st = s.cur_per_st,
        t.cur_per_en = s.cur_per_en,
        t.cur_fy_st = s.cur_fy_st,
        t.cur_fy_en = s.cur_fy_en,
        t.nxt_fy_st = s.nxt_fy_st,
        t.nxt_fy_en = s.nxt_fy_en,
        t.sales = s.sales,
        t.op = s.op,
        t.odp = s.odp,
        t.np = s.np,
        t.eps = s.eps,
        t.deps = s.deps,
        t.ta = s.ta,
        t.eq = s.eq,
        t.eq_ar = s.eq_ar,
        t.bps = s.bps,
        t.cfo = s.cfo,
        t.cfi = s.cfi,
        t.cff = s.cff,
        t.cash_eq = s.cash_eq,
        t.div_1q = s.div_1q,
        t.div_2q = s.div_2q,
        t.div_3q = s.div_3q,
        t.div_fy = s.div_fy,
        t.div_ann = s.div_ann,
        t.div_unit = s.div_unit,
        t.div_total_ann = s.div_total_ann,
        t.payout_ratio_ann = s.payout_ratio_ann,
        t.f_div_1q = s.f_div_1q,
        t.f_div_2q = s.f_div_2q,
        t.f_div_3q = s.f_div_3q,
        t.f_div_fy = s.f_div_fy,
        t.f_div_ann = s.f_div_ann,
        t.f_div_unit = s.f_div_unit,
        t.f_div_total_ann = s.f_div_total_ann,
        t.f_payout_ratio_ann = s.f_payout_ratio_ann,
        t.nxf_div_1q = s.nxf_div_1q,
        t.nxf_div_2q = s.nxf_div_2q,
        t.nxf_div_3q = s.nxf_div_3q,
        t.nxf_div_fy = s.nxf_div_fy,
        t.nxf_div_ann = s.nxf_div_ann,
        t.nxf_div_unit = s.nxf_div_unit,
        t.nxf_payout_ratio_ann = s.nxf_payout_ratio_ann,
        t.f_sales_2q = s.f_sales_2q,
        t.f_op_2q = s.f_op_2q,
        t.f_odp_2q = s.f_odp_2q,
        t.f_np_2q = s.f_np_2q,
        t.f_eps_2q = s.f_eps_2q,
        t.nxf_sales_2q = s.nxf_sales_2q,
        t.nxf_op_2q = s.nxf_op_2q,
        t.nxf_odp_2q = s.nxf_odp_2q,
        t.nxf_np_2q = s.nxf_np_2q,
        t.nxf_eps_2q = s.nxf_eps_2q,
        t.f_sales = s.f_sales,
        t.f_op = s.f_op,
        t.f_odp = s.f_odp,
        t.f_np = s.f_np,
        t.f_eps = s.f_eps,
        t.nxf_sales = s.nxf_sales,
        t.nxf_op = s.nxf_op,
        t.nxf_odp = s.nxf_odp,
        t.nxf_np = s.nxf_np,
        t.nxf_eps = s.nxf_eps,
        t.mat_chg_sub = s.mat_chg_sub,
        t.sig_chg_in_c = s.sig_chg_in_c,
        t.chg_by_as_rev = s.chg_by_as_rev,
        t.chg_no_as_rev = s.chg_no_as_rev,
        t.chg_ac_est = s.chg_ac_est,
        t.retro_rst = s.retro_rst,
        t.sh_out_fy = s.sh_out_fy,
        t.tr_sh_fy = s.tr_sh_fy,
        t.avg_sh = s.avg_sh,
        t.nc_sales = s.nc_sales,
        t.nc_op = s.nc_op,
        t.nc_odp = s.nc_odp,
        t.nc_np = s.nc_np,
        t.nc_eps = s.nc_eps,
        t.nc_ta = s.nc_ta,
        t.nc_eq = s.nc_eq,
        t.nc_eq_ar = s.nc_eq_ar,
        t.nc_bps = s.nc_bps,
        t.fnc_sales_2q = s.fnc_sales_2q,
        t.fnc_op_2q = s.fnc_op_2q,
        t.fnc_odp_2q = s.fnc_odp_2q,
        t.fnc_np_2q = s.fnc_np_2q,
        t.fnc_eps_2q = s.fnc_eps_2q,
        t.nxfnc_sales_2q = s.nxfnc_sales_2q,
        t.nxfnc_op_2q = s.nxfnc_op_2q,
        t.nxfnc_odp_2q = s.nxfnc_odp_2q,
        t.nxfnc_np_2q = s.nxfnc_np_2q,
        t.nxfnc_eps_2q = s.nxfnc_eps_2q,
        t.fnc_sales = s.fnc_sales,
        t.fnc_op = s.fnc_op,
        t.fnc_odp = s.fnc_odp,
        t.fnc_np = s.fnc_np,
        t.fnc_eps = s.fnc_eps,
        t.nxfnc_sales = s.nxfnc_sales,
        t.nxfnc_op = s.nxfnc_op,
        t.nxfnc_odp = s.nxfnc_odp,
        t.nxfnc_np = s.nxfnc_np,
        t.nxfnc_eps = s.nxfnc_eps,
        t.sh_eq = s.sh_eq,
        t.nc_sh_eq = s.nc_sh_eq,
        t.roe = s.roe,
        t.nc_roe = s.nc_roe
        , t.loaded_at = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (disc_date, disc_time, code, disc_no, doc_type, cur_per_type, cur_per_st, cur_per_en, cur_fy_st, cur_fy_en, nxt_fy_st, nxt_fy_en, sales, op, odp, np, eps, deps, ta, eq, eq_ar, bps, cfo, cfi, cff, cash_eq, div_1q, div_2q, div_3q, div_fy, div_ann, div_unit, div_total_ann, payout_ratio_ann, f_div_1q, f_div_2q, f_div_3q, f_div_fy, f_div_ann, f_div_unit, f_div_total_ann, f_payout_ratio_ann, nxf_div_1q, nxf_div_2q, nxf_div_3q, nxf_div_fy, nxf_div_ann, nxf_div_unit, nxf_payout_ratio_ann, f_sales_2q, f_op_2q, f_odp_2q, f_np_2q, f_eps_2q, nxf_sales_2q, nxf_op_2q, nxf_odp_2q, nxf_np_2q, nxf_eps_2q, f_sales, f_op, f_odp, f_np, f_eps, nxf_sales, nxf_op, nxf_odp, nxf_np, nxf_eps, mat_chg_sub, sig_chg_in_c, chg_by_as_rev, chg_no_as_rev, chg_ac_est, retro_rst, sh_out_fy, tr_sh_fy, avg_sh, nc_sales, nc_op, nc_odp, nc_np, nc_eps, nc_ta, nc_eq, nc_eq_ar, nc_bps, fnc_sales_2q, fnc_op_2q, fnc_odp_2q, fnc_np_2q, fnc_eps_2q, nxfnc_sales_2q, nxfnc_op_2q, nxfnc_odp_2q, nxfnc_np_2q, nxfnc_eps_2q, fnc_sales, fnc_op, fnc_odp, fnc_np, fnc_eps, nxfnc_sales, nxfnc_op, nxfnc_odp, nxfnc_np, nxfnc_eps, sh_eq, nc_sh_eq, roe, nc_roe, loaded_at)
      VALUES (s.disc_date, s.disc_time, s.code, s.disc_no, s.doc_type, s.cur_per_type, s.cur_per_st, s.cur_per_en, s.cur_fy_st, s.cur_fy_en, s.nxt_fy_st, s.nxt_fy_en, s.sales, s.op, s.odp, s.np, s.eps, s.deps, s.ta, s.eq, s.eq_ar, s.bps, s.cfo, s.cfi, s.cff, s.cash_eq, s.div_1q, s.div_2q, s.div_3q, s.div_fy, s.div_ann, s.div_unit, s.div_total_ann, s.payout_ratio_ann, s.f_div_1q, s.f_div_2q, s.f_div_3q, s.f_div_fy, s.f_div_ann, s.f_div_unit, s.f_div_total_ann, s.f_payout_ratio_ann, s.nxf_div_1q, s.nxf_div_2q, s.nxf_div_3q, s.nxf_div_fy, s.nxf_div_ann, s.nxf_div_unit, s.nxf_payout_ratio_ann, s.f_sales_2q, s.f_op_2q, s.f_odp_2q, s.f_np_2q, s.f_eps_2q, s.nxf_sales_2q, s.nxf_op_2q, s.nxf_odp_2q, s.nxf_np_2q, s.nxf_eps_2q, s.f_sales, s.f_op, s.f_odp, s.f_np, s.f_eps, s.nxf_sales, s.nxf_op, s.nxf_odp, s.nxf_np, s.nxf_eps, s.mat_chg_sub, s.sig_chg_in_c, s.chg_by_as_rev, s.chg_no_as_rev, s.chg_ac_est, s.retro_rst, s.sh_out_fy, s.tr_sh_fy, s.avg_sh, s.nc_sales, s.nc_op, s.nc_odp, s.nc_np, s.nc_eps, s.nc_ta, s.nc_eq, s.nc_eq_ar, s.nc_bps, s.fnc_sales_2q, s.fnc_op_2q, s.fnc_odp_2q, s.fnc_np_2q, s.fnc_eps_2q, s.nxfnc_sales_2q, s.nxfnc_op_2q, s.nxfnc_odp_2q, s.nxfnc_np_2q, s.nxfnc_eps_2q, s.fnc_sales, s.fnc_op, s.fnc_odp, s.fnc_np, s.fnc_eps, s.nxfnc_sales, s.nxfnc_op, s.nxfnc_odp, s.nxfnc_np, s.nxfnc_eps, s.sh_eq, s.nc_sh_eq, s.roe, s.nc_roe, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}

async function mergeOptionPriceDaily(connection) {
  const sql = `
    MERGE INTO index_option_price_daily t
    USING (
      SELECT trade_date, code, o, h, l, c, eo, eh, el, ec, ao, ah, al, ac, vo, oi, va, contract_month, strike_price, vo_oa, em_mrgn_trg_div, pc_div, last_trading_date, sq_date, settle_price, theoretical_price, base_volatility, underlying_price, implied_volatility, interest_rate
      FROM (
        SELECT s.*,
               ROW_NUMBER() OVER (PARTITION BY s.trade_date, s.code, s.em_mrgn_trg_div
                                  ORDER BY s.loaded_at DESC) AS rn
        FROM index_option_price_daily_stg s
        WHERE s.trade_date IS NOT NULL AND s.code IS NOT NULL AND s.em_mrgn_trg_div IS NOT NULL
      )
      WHERE rn = 1
    ) s
    ON (t.trade_date = s.trade_date AND t.code = s.code AND t.em_mrgn_trg_div = s.em_mrgn_trg_div)
    WHEN MATCHED THEN
      UPDATE SET
        t.o = s.o,
        t.h = s.h,
        t.l = s.l,
        t.c = s.c,
        t.eo = s.eo,
        t.eh = s.eh,
        t.el = s.el,
        t.ec = s.ec,
        t.ao = s.ao,
        t.ah = s.ah,
        t.al = s.al,
        t.ac = s.ac,
        t.vo = s.vo,
        t.oi = s.oi,
        t.va = s.va,
        t.contract_month = s.contract_month,
        t.strike_price = s.strike_price,
        t.vo_oa = s.vo_oa,
        t.pc_div = s.pc_div,
        t.last_trading_date = s.last_trading_date,
        t.sq_date = s.sq_date,
        t.settle_price = s.settle_price,
        t.theoretical_price = s.theoretical_price,
        t.base_volatility = s.base_volatility,
        t.underlying_price = s.underlying_price,
        t.implied_volatility = s.implied_volatility,
        t.interest_rate = s.interest_rate
        , t.loaded_at = SYSTIMESTAMP
    WHEN NOT MATCHED THEN
      INSERT (trade_date, code, o, h, l, c, eo, eh, el, ec, ao, ah, al, ac, vo, oi, va, contract_month, strike_price, vo_oa, em_mrgn_trg_div, pc_div, last_trading_date, sq_date, settle_price, theoretical_price, base_volatility, underlying_price, implied_volatility, interest_rate, loaded_at)
      VALUES (s.trade_date, s.code, s.o, s.h, s.l, s.c, s.eo, s.eh, s.el, s.ec, s.ao, s.ah, s.al, s.ac, s.vo, s.oi, s.va, s.contract_month, s.strike_price, s.vo_oa, s.em_mrgn_trg_div, s.pc_div, s.last_trading_date, s.sq_date, s.settle_price, s.theoretical_price, s.base_volatility, s.underlying_price, s.implied_volatility, s.interest_rate, SYSTIMESTAMP)
  `;
  const result = await connection.execute(sql, {}, { autoCommit: false });
  return result.rowsAffected || 0;
}


module.exports = {
  mergeMaster,
  mergeMasterHist,
  mergePriceDaily,
  findUnknownCodesInPriceStg,
  refreshDelistedFlag,

  // 空売り・信用取引関連
  findUnknownCodesInStg,
  deleteUnknownCodesFromStg,
  mergeShortRatio,
  mergeMarginInterest,
  mergeMarginAlert,
  replaceShortPosition,

  // 取引カレンダー・指数四本値関連
  mergeTradingCalendar,
  mergeTopixPriceDaily,
  mergeIndexPriceDaily,

  // 投資部門別情報・決算発表予定日関連 (Tier 2)
  mergeInvestorTypeTrading,
  mergeEarningsSchedule,

  // 財務情報・日経225オプション四本値関連 (Tier 3)
  mergeFinancialSummary,
  mergeOptionPriceDaily,
};

