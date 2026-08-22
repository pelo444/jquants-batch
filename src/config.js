'use strict';

require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません。.envを確認してください。`);
  }
  return value;
}

/**
 * 設定はセクション単位で遅延評価する。
 *
 * 以前は module 読み込み時に全ての requireEnv を実行していたため、
 * DBしか使わないツール(chart.js など)でも JQB_JQUANTS_API_KEY が
 * 未設定だと起動できなかった。getter にして、実際に参照された
 * セクションだけを検証する。
 */
let jquantsCache = null;
let dbCache = null;

const config = {
  get jquants() {
    if (!jquantsCache) {
      jquantsCache = {
        apiKey: requireEnv('JQB_JQUANTS_API_KEY'),
        baseUrl: process.env.JQB_JQUANTS_BASE_URL || 'https://api.jquants.com/v2',
        // bulk/getで返るダウンロードURLの有効期限(秒)。仕様上300秒だが、
        // 実測で余裕を持たせるため内部的な安全マージンとして使う。
        bulkUrlExpirySeconds: 300,
        // Bulk APIの呼び出し間隔(ミリ秒)。リクエスト数自体は少ない(数百回)ので
        // 大きな値にする必要はないが、行儀よく間隔を空ける。
        requestIntervalMs: 300,
      };
    }
    return jquantsCache;
  },

  get db() {
    if (!dbCache) {
      dbCache = {
        user: requireEnv('JQB_DB_USER'), // GD_JQUANTS
        password: requireEnv('JQB_DB_PASSWORD'),
        connectString: requireEnv('JQB_DB_CONNECT_STRING'), // tnsnames.ora内のTNSエイリアス(例: adb23aiyy1_tp)
        // ウォレットZIPを解凍したディレクトリ(tnsnames.ora, ewallet.pemが入っている場所)
        // Thinモードでは cwallet.sso ではなく ewallet.pem を使用する
        walletLocation: requireEnv('JQB_DB_WALLET_LOCATION'),
        walletPassword: requireEnv('JQB_DB_WALLET_PASSWORD'),
        poolMin: Number(process.env.JQB_DB_POOL_MIN || 1),
        poolMax: Number(process.env.JQB_DB_POOL_MAX || 4),
        poolIncrement: Number(process.env.JQB_DB_POOL_INCREMENT || 1),
      };
    }
    return dbCache;
  },
};

module.exports = config;
