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

module.exports = {
  mergeMaster,
  mergeMasterHist,
  mergePriceDaily,
  findUnknownCodesInPriceStg,
  refreshDelistedFlag,
};

