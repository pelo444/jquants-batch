--------------------------------------------------------------------------------
-- TAG_MASTER へのタグ追加: 230_renewable_energy(再生可能エネルギー)
-- 実行ユーザー: GD_JQUANTS
--
-- 背景:
--   200番台(資源・素材)の銘柄調査で、レノバ・イーレックス等の再エネ開発企業が
--   220_energy_resource の候補として挙がった。しかしこれらの値動きの要因は
--   FIT/FIP制度・電力卸価格・金利であり、原油やガスの市況では動かない。
--   同じタグに混ぜると「220が上がった」の解釈が濁るため、別タグとして分離する。
--
--   タグ番号を10刻みにしてあるので、220 の隣に 230 を足すだけで済み、
--   既存タグの振り直しは発生しない。
--
-- 前提: 05_tag_master.sql を実行済みであること。
--
-- 注意: 05_tag_master.sql の MERGE にも同じ定義を追記してあるため、
--       新規に構築する場合は 05 だけで 230 まで登録される。
--       このファイルは「既に05を実行済みのDB」に後から追加するためのもの。
--       重複実行しても MERGE なので問題ない。
--------------------------------------------------------------------------------

MERGE INTO tag_master t
USING (
    SELECT '230_renewable_energy' AS tag_name, 'CLASS' AS tag_type,
           '230' AS tag_code, '200' AS major_code, '資源・素材' AS major_label_ja,
           '再生可能エネルギー'  AS tag_label_ja,
           '太陽光・風力・バイオマス・地熱等の再エネ発電所を自社で開発・保有・運営する企業、および再エネEPCを主業とする企業。値動きの要因はFIT/FIP制度・電力卸価格・金利であり、資源市況で動く220とは分けて扱う。'
                                 AS description FROM dual
) s
ON (t.tag_name = s.tag_name)
WHEN MATCHED THEN UPDATE SET
    t.tag_type       = s.tag_type,
    t.tag_code       = s.tag_code,
    t.major_code     = s.major_code,
    t.major_label_ja = s.major_label_ja,
    t.tag_label_ja   = s.tag_label_ja,
    t.description    = s.description,
    t.updated_at     = SYSTIMESTAMP
WHEN NOT MATCHED THEN INSERT (
    tag_name, tag_type, tag_code, major_code, major_label_ja, tag_label_ja, description
) VALUES (
    s.tag_name, s.tag_type, s.tag_code, s.major_code, s.major_label_ja, s.tag_label_ja, s.description
);

COMMIT;

--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT tag_code, tag_name, major_label_ja, tag_label_ja
-- FROM tag_master
-- WHERE major_code = '200'
-- ORDER BY tag_code;
