'use strict';

/**
 * 売買記録から騰落率一覧用のタグ(FAVORITE_TAG)を付け直す。定義は ddl/28_journal_tags.sql。
 *
 *   jnl_held           保有中: 約定から計算した保有(現物・信用買)が残っている銘柄
 *   jnl_held_past      過去に保有: 約定(現物・信用買)はあるが、今は保有していない銘柄
 *   jnl_passed         見送った銘柄: 判断で「見送り」にした銘柄(訂正済みの判断は除く)
 *
 * 【方針】
 *   保有は「保有」タブと同じ計算(journalPositions.js)で決める。SQL で数量を足し引きすると
 *   分割の入庫や信用の扱いが保有タブとずれるため。
 *   付け直しは差分だけ: 足りない行を INSERT、余分な行を DELETE(タグの行を全消しして入れ直すと、
 *   CREATED_AT が毎回変わり「いつからそのタグか」が分からなくなる)。
 *   TAG_MASTER に未登録(ddl/28 未適用)のタグは飛ばして、結果に理由を返す。
 */

const jq = require('./journalQuery');
const { computePositions } = require('./journalPositions');

const TAGS = {
  held: 'jnl_held',
  formerlyHeld: 'jnl_held_past',
  passed: 'jnl_passed',
};

/** 3つのタグに入るべき銘柄の集合 */
async function computeTagSets(conn) {
  const trades = await jq.fetchTrades(conn);
  const codes = Array.from(new Set(trades.map((t) => t.code)));
  const splits = codes.length ? await jq.fetchSplits(conn, codes, trades[0].tradeDate) : new Map();
  const { positions } = computePositions(trades, splits);

  const held = new Set(positions.filter((p) => p.kind !== 'MSHORT').map((p) => p.code));
  const everLong = new Set(trades.filter((t) => t.positionKind !== 'MSHORT').map((t) => t.code));
  const formerlyHeld = new Set(Array.from(everLong).filter((c) => !held.has(c)));

  const r = await conn.execute(
    `SELECT DISTINCT d.code FROM jnl_decision d
     WHERE d.action = 'PASS'
       AND NOT EXISTS (SELECT 1 FROM jnl_decision s WHERE s.supersedes_id = d.decision_id)`
  );
  const passed = new Set(r.rows.map((x) => x[0]));

  return { [TAGS.held]: held, [TAGS.formerlyHeld]: formerlyHeld, [TAGS.passed]: passed };
}

/**
 * 付け直す。1つのトランザクションで3タグ分を揃えてから commit する。
 * @returns {Promise<{tags: object[], skipped: string[]}>}
 */
async function syncJournalTags(conn) {
  const sets = await computeTagSets(conn);
  const names = Object.keys(sets);

  const reg = await conn.execute(
    `SELECT tag_name FROM tag_master WHERE tag_name IN (:a, :b, :c)`,
    { a: names[0], b: names[1], c: names[2] }
  );
  const registered = new Set(reg.rows.map((x) => x[0]));

  const result = [];
  const skipped = [];
  for (const tag of names) {
    if (!registered.has(tag)) {
      skipped.push(tag);
      continue;
    }
    const want = sets[tag];
    const cur = await conn.execute(`SELECT code FROM favorite_tag WHERE tag_name = :tag`, { tag });
    const have = new Set(cur.rows.map((x) => x[0]));

    const toDelete = Array.from(have).filter((c) => !want.has(c));
    const toInsert = Array.from(want).filter((c) => !have.has(c));

    for (const code of toDelete) {
      await conn.execute(`DELETE FROM favorite_tag WHERE tag_name = :tag AND code = :code`, { tag, code });
    }
    let inserted = 0;
    const missing = [];
    for (const code of toInsert) {
      // 銘柄マスタに無いコード(FK違反になる)は飛ばして報告する
      const ins = await conn.execute(
        `INSERT INTO favorite_tag (code, tag_name)
         SELECT :code, :tag FROM equity_master WHERE code = :code`,
        { code, tag }
      );
      if (ins.rowsAffected) inserted += 1;
      else missing.push(code);
    }
    result.push({ tag, count: want.size - missing.length, added: inserted, removed: toDelete.length, missing });
  }
  await conn.commit();
  return { tags: result, skipped };
}

module.exports = { TAGS, computeTagSets, syncJournalTags };
