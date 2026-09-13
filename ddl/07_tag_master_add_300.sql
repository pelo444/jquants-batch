--------------------------------------------------------------------------------
-- TAG_MASTER へのタグ追加: 300番台(金融)の細分タグ
--   311_bank_major / 312_bank_regional / 313_bank_digital / 330_insurance_agency
-- 実行ユーザー: GD_JQUANTS
--
-- 背景:
--   (1) 銀行(sector33=7050)は上場80社超あり、1タグではチャート一覧の実用上限を超える。
--       また値動きの要因が明確に異なる:
--         大手  … 海外金利・為替・海外与信コスト・政策保有株売却
--         地銀  … 国内利上げの預貸金利ざや、地域景気、再編思惑、PBR1倍割れ是正
--         ネット… 口座数/決済件数の成長率(金利感応度は低い)
--       310_bank は全銀行に付けたまま、311/312/313 を併せて付与する。
--       これにより「銀行全体」と「地銀だけ」の両方で抽出できる。
--
--   (2) 保険(sector33=7150)には保険引受会社と保険代理店・保険ショップが混在する。
--       代理店は募集手数料ビジネスで、引受会社とは値動きの要因が別物のため
--       330_insurance_agency として分離する(230を分離したのと同じ考え方)。
--
-- 311の区分は金融庁の「主要行等」の考え方に合わせている
-- (メガ3行・りそな・信託・SBI新生・あおぞら・ゆうちょ)。
--
-- 前提: 05_tag_master.sql を実行済みであること。
-- 注意: 05_tag_master.sql の MERGE にも同じ定義を追記してあるため、新規構築時は05だけでよい。
--       重複実行しても MERGE なので問題ない。
--------------------------------------------------------------------------------

MERGE INTO tag_master t
USING (
    SELECT '311_bank_major'       AS tag_name, 'CLASS' AS tag_type,
           '311' AS tag_code, '300' AS major_code, '金融' AS major_label_ja,
           '大手銀行・信託'        AS tag_label_ja,
           'メガバンク・信託銀行・ゆうちょ銀行など全国規模の大手銀行(金融庁の「主要行等」に相当)。海外金利・為替・政策保有株の売却が主な値動きの要因。310_bank と併せて付与する。'
                                  AS description FROM dual
    UNION ALL
    SELECT '312_bank_regional', 'CLASS',
           '312', '300', '金融',
           '地方銀行',
           '地方銀行・第二地銀とその持株会社。311・313に該当しない銀行として導出するため、新規上場や再編があっても自動的に追従する。国内利上げによる預貸金利ざや改善と再編思惑が主な値動きの要因。310_bank と併せて付与する。'
           FROM dual
    UNION ALL
    SELECT '313_bank_digital', 'CLASS',
           '313', '300', '金融',
           'ネット・決済系銀行',
           'ネット専業銀行・決済プラットフォーム型銀行。金利より口座数や決済件数の成長率で動くため、他の銀行とは値動きの要因が異なる。310_bank と併せて付与する。'
           FROM dual
    UNION ALL
    SELECT '330_insurance_agency', 'CLASS',
           '330', '300', '金融',
           '保険代理店・保険ショップ',
           '保険の募集・仲介を行う代理店、来店型保険ショップ、乗合代理店。JPX33業種では「保険業」に分類されるが、収益は募集手数料であり保険引受会社(320)とは値動きの要因が別物のため分離する。'
           FROM dual
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

--------------------------------------------------------------------------------
-- 既存の 310 / 320 の説明文も、細分タグができたことに合わせて更新する
--------------------------------------------------------------------------------
UPDATE tag_master
SET description = 'メガバンク・地方銀行・ネット銀行等。上場する全ての銀行に付与し、細分は311(大手)/312(地銀)/313(ネット・決済系)で併用する。JPX33業種の「銀行業」(sector33_code=7050)で機械的に抽出できるが、タグ体系の一貫性のため明示的に付与する。日本銀行(83010)は出資証券であり普通株ではないため除外する。',
    updated_at = SYSTIMESTAMP
WHERE tag_name = '310_bank';

UPDATE tag_master
SET description = '生命保険・損害保険の引受会社とその持株会社。JPX33業種の「保険業」(sector33_code=7150)には保険代理店も含まれるが、それらは330_insurance_agencyへ分離している。',
    updated_at = SYSTIMESTAMP
WHERE tag_name = '320_insurance';

COMMIT;

--------------------------------------------------------------------------------
-- 【重要】前提の確認
--
-- このファイルは 311/312/313/330 しか登録しない。310_bank と 320_insurance が
-- 未登録のまま先に進むと、tag_insert_finance_300.sql の MERGE が TAG_MASTER に
-- INNER JOIN しているため、310/320 の付与が「エラーも出さずに」全件スキップされる。
-- 下のクエリで1行でも返ったら 05_tag_master.sql を先に実行すること。
--------------------------------------------------------------------------------
SELECT 'ERROR: 310_bank / 320_insurance が TAG_MASTER に存在しません。05_tag_master.sql を先に実行してください。' AS check_result
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM tag_master WHERE tag_name = '310_bank')
   OR NOT EXISTS (SELECT 1 FROM tag_master WHERE tag_name = '320_insurance');

--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT tag_code, tag_name, tag_label_ja, description
-- FROM tag_master
-- WHERE major_code = '300'
-- ORDER BY tag_code;
