'use strict';

// config.jsを経由して、実際にoracledbへ渡る値がどうなっているかを検査する。
// パスワードの中身は出力せず、長さと「余計な文字が混ざっていないか」だけを見る。

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

function inspect(label, value) {
  if (value === undefined || value === null) {
    console.log(`${label}: (未設定)`);
    return;
  }
  const s = String(value);
  const issues = [];
  if (s !== s.trim()) issues.push('前後に空白または改行あり');
  if (/^["'].*["']$/.test(s)) issues.push('クォートで囲まれている(値の一部になっている可能性)');
  if (/\r/.test(s)) issues.push('CR(\\r)が含まれる → .envがCRLF改行の可能性');
  if (/\s$/.test(s)) issues.push('末尾に空白あり');

  console.log(
    `${label}: 長さ=${s.length}` +
      (issues.length ? `  ⚠️ ${issues.join(' / ')}` : '  (異常なし)')
  );
}

console.log('=== config.js経由で読み込まれた値の検査 ===\n');

// ユーザー名と接続文字列は秘密情報ではないので、そのまま表示して確認する
console.log(`JQB_DB_USER の値          : "${config.db.user}"`);
console.log(`JQB_DB_CONNECT_STRING の値: "${config.db.connectString}"`);
console.log(`JQB_DB_WALLET_LOCATION: "${config.db.walletLocation}"`);
console.log('');

inspect('JQB_DB_USER          ', config.db.user);
inspect('JQB_DB_PASSWORD      ', config.db.password);
inspect('JQB_DB_CONNECT_STRING', config.db.connectString);
inspect('JQB_DB_WALLET_PASSWORD', config.db.walletPassword);

console.log('\n=== .envファイル自体の検査 ===\n');

const envPath = path.resolve(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.log(`⚠️ .env が見つかりません: ${envPath}`);
} else {
  const raw = fs.readFileSync(envPath, 'utf-8');
  console.log(`.envのパス: ${envPath}`);
  console.log(`改行コード: ${raw.includes('\r\n') ? 'CRLF ⚠️ (LFに変換を推奨)' : 'LF (正常)'}`);
  console.log('\n各行のキー名と値の長さ(値の中身は表示しません):');
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) {
      console.log(`  ${i + 1}行目: ⚠️ '='が無い行: "${line}"`);
      return;
    }
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);
    const flags = [];
    if (key !== key.trim()) flags.push('キー名に空白');
    if (val !== val.trim()) flags.push('値の前後に空白');
    if (/^["'].*["']$/.test(val.trim())) flags.push('値がクォート囲み');
    console.log(
      `  ${i + 1}行目: ${key.trim()} = (長さ ${val.length})` +
        (flags.length ? `  ⚠️ ${flags.join(' / ')}` : '')
    );
  });
}

console.log('\n=== シェル環境変数との衝突チェック ===\n');
// dotenvは既存のprocess.envを上書きしないため、シェル側に同名の変数があると
// .envの値が無視される。JQB_プレフィックスはこれを避けるためのもの。
const envPathForDup = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPathForDup)) {
  const rawDup = fs.readFileSync(envPathForDup, 'utf-8');
  const keysInFile = rawDup
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());

  // .env読み込み前のシェル環境変数と比較したいが、この時点では既に読み込み済みのため、
  // 「.envの値」と「実際のprocess.envの値」が食い違うキーを検出する
  const mismatches = [];
  keysInFile.forEach((key) => {
    const line = rawDup.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (!line) return;
    const fileValue = line.slice(key.length + 1);
    const actualValue = process.env[key];
    if (actualValue !== undefined && actualValue !== fileValue) {
      mismatches.push(key);
    }
  });

  if (mismatches.length > 0) {
    console.log('⚠️ .envの値とprocess.envの値が食い違うキーがあります:');
    mismatches.forEach((k) => {
      console.log(`  - ${k} : シェル環境変数が優先されています(.envの値は無視されます)`);
    });
    console.log('  → シェル側の設定をunsetするか、変数名を変更してください');
  } else {
    console.log('衝突は検出されませんでした (正常)');
  }
}

console.log('\n=== ウォレットディレクトリの検査 ===\n');
const wl = config.db.walletLocation;
if (!fs.existsSync(wl)) {
  console.log(`⚠️ ディレクトリが存在しません: ${wl}`);
} else {
  const files = fs.readdirSync(wl);
  console.log(`${wl} の中身:`, files);
  if (!files.includes('ewallet.pem')) {
    console.log('⚠️ ewallet.pem がありません(Thinモードでは必須)');
  }
  if (!files.includes('tnsnames.ora')) {
    console.log('⚠️ tnsnames.ora がありません');
  } else {
    // tnsnames.oraの中にDB_CONNECT_STRINGのエイリアスが存在するか確認
    const tns = fs.readFileSync(path.join(wl, 'tnsnames.ora'), 'utf-8');
    const alias = config.db.connectString;
    const found = new RegExp(`^\\s*${alias}\\s*=`, 'im').test(tns);
    console.log(
      `tnsnames.ora内に "${alias}" のエントリ: ${found ? '存在する (正常)' : '⚠️ 見つかりません'}`
    );
    if (!found) {
      const aliases = tns
        .split(/\r?\n/)
        .map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=/))
        .filter(Boolean)
        .map((m) => m[1]);
      console.log('  tnsnames.oraに定義されているエイリアス一覧:', aliases);
    }
  }
}
