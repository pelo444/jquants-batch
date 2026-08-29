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
};

