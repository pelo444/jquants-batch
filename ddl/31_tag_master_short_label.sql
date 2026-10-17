--------------------------------------------------------------------------------
-- TAG_MASTER に短縮表記の列を追加する
-- 実行ユーザー: GD_JQUANTS
--
-- 用途: 騰落率一覧(/)の表のタグ列と CSV に出す短い名前。
--       空のタグは画面側で TAG_LABEL_JA を出す。
-- 前提: 05_tag_master.sql を実行済みであること。
-- CLAUDE_RO は表単位の SELECT 権限なので、列を足しても GRANT のやり直しは不要。
--------------------------------------------------------------------------------

ALTER TABLE tag_master ADD (tag_short_ja VARCHAR2(30 CHAR));

COMMENT ON COLUMN tag_master.tag_short_ja IS 'タグの短縮表記(一覧の表・CSV用)。NULLなら TAG_LABEL_JA を使う';

MERGE INTO tag_master t
USING (
    SELECT '110_ai_model'            AS tag_name, 'AIモデル'   AS tag_short_ja FROM dual UNION ALL
    SELECT '120_semi_design_mfg',                 '半導体'                      FROM dual UNION ALL
    SELECT '130_semi_equip_material',             '半導体装置'                  FROM dual UNION ALL
    SELECT '140_power_datacenter',                '電力DC'                      FROM dual UNION ALL
    SELECT '150_ai_application',                  'AI応用'                      FROM dual UNION ALL
    SELECT '210_rare_metal',                      '非鉄'                        FROM dual UNION ALL
    SELECT '220_energy_resource',                 '資源'                        FROM dual UNION ALL
    SELECT '230_renewable_energy',                '再エネ'                      FROM dual UNION ALL
    SELECT '310_bank',                            '銀行'                        FROM dual UNION ALL
    SELECT '320_insurance',                       '保険'                        FROM dual UNION ALL
    SELECT 'high_dividend_yield',                 '高配当'                      FROM dual UNION ALL
    SELECT 'jnl_held',                            '保有中'                      FROM dual UNION ALL
    SELECT 'jnl_held_past',                       '過去保有'                    FROM dual UNION ALL
    SELECT 'jnl_passed',                          '見送り'                      FROM dual UNION ALL
    SELECT 'photoelectric_fusion',                '光電融合'                    FROM dual UNION ALL
    SELECT 'sheres_held',                         '保有株'                      FROM dual
) s
ON (t.tag_name = s.tag_name)
WHEN MATCHED THEN UPDATE SET t.tag_short_ja = s.tag_short_ja, t.updated_at = SYSTIMESTAMP;

COMMIT;

-- 確認
SELECT tag_code, tag_name, tag_label_ja, tag_short_ja FROM tag_master ORDER BY tag_code NULLS LAST, tag_name;
