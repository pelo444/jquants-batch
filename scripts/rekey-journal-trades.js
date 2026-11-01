'use strict';

/**
 * JNL_TRADE の dedup_key を、今の規則(src/web/journalCsv.js の stableContent / dedupKey)で
 * 付け直す。キーの規則を変えたら(RK1 → RK2 など)、次の約定CSVを取り込む前に1回流す。
 * 付け直さないと、既に入っている約定も新しいキーでは「未登録」に見えて二重に入る。
 *
 * 使い方(GD_JQUANTS で接続する .env のある Mac のターミナルで):
 *   node scripts/rekey-journal-trades.js          # 確認だけ(何も書かない)
 *   node scripts/rekey-journal-trades.js --apply  # 書き込む
 *
 * 「何件目か」の数え方:
 *   取込時はファイルの中で数えるが、ここでは表全体を trade_id 順に数える。
 *   表には同じ約定が1回ずつしか入っていない前提なので、表全体で数えれば
 *   「その日にその内容の約定が何件あるか」になり、取込時の数え方と一致する。
 *
 * 止まる条件:
 *   同じ内容の行が「別々の取込」から入っているときは、二重取込の疑いがあるので
 *   --apply でも書き込まずに止まる。疑いの行を消してから流し直す。
 *   (同じ日に同じ内容の約定が本当に2件あるなら、普通は同じCSVに一緒に入っている)
 */

const db = require('../src/db');
const oracledb = require('oracledb');
const { SOURCE, stableContent, dedupKey } = require('../src/web/journalCsv');

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const apply = process.argv.includes('--apply');

  await db.withConnection(async (conn) => {
    const r = await conn.execute(
      `SELECT trade_id, batch_id, dedup_key, trade_date, code, name, account_type, trade_type,
              side_raw, margin_type, qty, price
         FROM jnl_trade
        WHERE source = :source
        ORDER BY trade_id`,
      { source: SOURCE },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const groups = new Map(); // content → 行の配列
    const rows = r.rows.map((x) => {
      const t = {
        tradeDate: iso(x.TRADE_DATE),
        code: x.CODE,
        accountType: x.ACCOUNT_TYPE,
        tradeType: x.TRADE_TYPE,
        sideRaw: x.SIDE_RAW,
        marginType: x.MARGIN_TYPE,
        qty: x.QTY,
        price: x.PRICE,
      };
      const content = stableContent(t);
      const g = groups.get(content) || [];
      g.push(x);
      groups.set(content, g);
      return { id: x.TRADE_ID, oldKey: x.DEDUP_KEY, newKey: dedupKey(content, g.length) };
    });

    const multi = [...groups.values()].filter((g) => g.length > 1);
    const suspect = multi.filter((g) => new Set(g.map((x) => x.BATCH_ID)).size > 1);
    const changes = rows.filter((x) => x.oldKey !== x.newKey);

    console.log(`対象 ${rows.length} 行 / キーが変わる行 ${changes.length} 行`);

    const show = (g) =>
      g.map((x) => `    trade_id=${x.TRADE_ID} batch=${x.BATCH_ID} ${iso(x.TRADE_DATE)} ${x.CODE} ${x.NAME || ''} ` +
        `${x.SIDE_RAW} ${x.QTY}株 @${x.PRICE} ${x.ACCOUNT_TYPE || ''}`).join('\n');

    if (multi.length) {
      console.log(`\n同じ内容の約定が複数ある組: ${multi.length} 組`);
      multi.forEach((g, i) => {
        const tag = suspect.includes(g) ? '【二重取込の疑い: 別々の取込から入っている】' : '(同じ取込の中。同じ日に同じ約定が複数)';
        console.log(`  ${i + 1}. ${tag}\n${show(g)}`);
      });
    }

    if (suspect.length) {
      console.log('\n二重取込の疑いがある組があるので、書き込まずに終了します。');
      console.log('残さない方の行を DELETE してから、もう一度流してください。');
      process.exitCode = 1;
      return;
    }

    if (!apply) {
      console.log('\n確認だけです(何も書いていません)。書き込むときは --apply を付けてください。');
      return;
    }
    if (!changes.length) {
      console.log('\n付け直す行はありません。');
      return;
    }

    // 新しいキーは RK2: で始まり古いキーと重ならず、新しいキー同士も重ならないので、
    // 1文ずつ更新しても一意制約(jnl_trade_dedup_uk)にはかからない。
    await conn.executeMany(
      `UPDATE jnl_trade SET dedup_key = :newKey WHERE trade_id = :id`,
      changes.map((x) => ({ id: x.id, newKey: x.newKey }))
    );
    await conn.commit();
    console.log(`\n${changes.length} 行の dedup_key を付け直しました。`);
  });
  await db.closePool();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  try { await db.closePool(); } catch (_) { /* ignore */ }
});
