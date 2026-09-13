--------------------------------------------------------------------------------
-- 資源・素材(200番台)タグの銘柄登録
--
-- 前提: ddl/05_tag_master.sql と ddl/06_tag_master_add_230.sql を実行済みであること。
--       (230_renewable_energy タグは 06 で追加する)
--
-- 【必ずSTEP 2の突合結果を確認してからSTEP 3を実行すること】
--   候補リストの証券コードはWeb調査に基づくもので、DB上の実銘柄との突合は未実施。
--
-- 1銘柄に複数タグが付く。総合商社(三井物産・三菱商事・住友商事・丸紅・双日・岩谷産業)は
-- 非鉄金属と資源エネルギーの両方の権益を持つため 210 と 220 の両方を付与している。
-- また 100番台とも重なる銘柄がある(JX金属・三井金属鉱業・信越化学=130、電源開発=140)。
--
-- 選定基準: 「株価がそのテーマで動く企業」に絞っている。
--   ・一部の製品にレアメタルを使っているだけのメーカーは 210 に含めない
--   ・エネルギーを消費するだけの企業は 220 に含めない
--   ・再エネ開発企業は値動きの要因(FIT/FIP制度・電力卸価格・金利)が資源市況と異なるため
--     220 に混ぜず 230 として分離した
--
-- 調査日: 2026-08-16 / 選定根拠は trend_analysis/resource_candidates_200.md を参照
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- STEP 1. 候補リスト(コード・タグ・想定社名)
--
-- 突合チェックと投入の両方から参照するため、ビューとして定義する。
-- 銘柄を追加・削除する場合はこのビューを修正して再実行すること。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tag_candidate_200 (code, tag_name, expected_name) AS
    -- 210 レアメタル・非鉄金属
    SELECT '57130', '210_rare_metal', '住友金属鉱山' FROM dual
    UNION ALL SELECT '57110', '210_rare_metal', '三菱マテリアル' FROM dual
    UNION ALL SELECT '57060', '210_rare_metal', '三井金属鉱業' FROM dual
    UNION ALL SELECT '50160', '210_rare_metal', 'JX金属' FROM dual
    UNION ALL SELECT '57140', '210_rare_metal', 'DOWAホールディングス' FROM dual
    UNION ALL SELECT '57070', '210_rare_metal', '東邦亜鉛' FROM dual
    UNION ALL SELECT '30360', '210_rare_metal', 'アルコニックス' FROM dual
    UNION ALL SELECT '57260', '210_rare_metal', '大阪チタニウムテクノロジーズ' FROM dual
    UNION ALL SELECT '57270', '210_rare_metal', '東邦チタニウム' FROM dual
    UNION ALL SELECT '57290', '210_rare_metal', '日本精鉱' FROM dual
    UNION ALL SELECT '57810', '210_rare_metal', '東邦金属' FROM dual
    UNION ALL SELECT '55410', '210_rare_metal', '大平洋金属' FROM dual
    UNION ALL SELECT '55630', '210_rare_metal', '新日本電工' FROM dual
    UNION ALL SELECT '57030', '210_rare_metal', '日本軽金属ホールディングス' FROM dual
    UNION ALL SELECT '57410', '210_rare_metal', 'UACJ' FROM dual
    UNION ALL SELECT '57020', '210_rare_metal', '大紀アルミニウム工業所' FROM dual
    UNION ALL SELECT '58570', '210_rare_metal', 'AREホールディングス' FROM dual
    UNION ALL SELECT '74560', '210_rare_metal', '松田産業' FROM dual
    UNION ALL SELECT '57240', '210_rare_metal', 'アサカ理研' FROM dual
    UNION ALL SELECT '57150', '210_rare_metal', '古河機械金属' FROM dual
    UNION ALL SELECT '15150', '210_rare_metal', '日鉄鉱業' FROM dual
    UNION ALL SELECT '56980', '210_rare_metal', 'エンビプロ・ホールディングス' FROM dual
    UNION ALL SELECT '40630', '210_rare_metal', '信越化学工業' FROM dual
    UNION ALL SELECT '54710', '210_rare_metal', '大同特殊鋼' FROM dual
    UNION ALL SELECT '27680', '210_rare_metal', '双日' FROM dual
    UNION ALL SELECT '80880', '210_rare_metal', '岩谷産業' FROM dual
    UNION ALL SELECT '80150', '210_rare_metal', '豊田通商' FROM dual
    UNION ALL SELECT '80580', '210_rare_metal', '三菱商事' FROM dual
    UNION ALL SELECT '80310', '210_rare_metal', '三井物産' FROM dual
    UNION ALL SELECT '80530', '210_rare_metal', '住友商事' FROM dual
    UNION ALL SELECT '80020', '210_rare_metal', '丸紅' FROM dual
    -- 220 エネルギー・資源
    UNION ALL SELECT '16050', '220_energy_resource', 'INPEX' FROM dual
    UNION ALL SELECT '16620', '220_energy_resource', '石油資源開発' FROM dual
    UNION ALL SELECT '50200', '220_energy_resource', 'ENEOSホールディングス' FROM dual
    UNION ALL SELECT '50190', '220_energy_resource', '出光興産' FROM dual
    UNION ALL SELECT '50210', '220_energy_resource', 'コスモエネルギーホールディングス' FROM dual
    UNION ALL SELECT '80310', '220_energy_resource', '三井物産' FROM dual
    UNION ALL SELECT '80580', '220_energy_resource', '三菱商事' FROM dual
    UNION ALL SELECT '95310', '220_energy_resource', '東京瓦斯' FROM dual   -- 通称は東京ガス
    UNION ALL SELECT '95320', '220_energy_resource', '大阪瓦斯' FROM dual   -- 通称は大阪ガス
    UNION ALL SELECT '16630', '220_energy_resource', 'K&Oエナジーグループ' FROM dual
    UNION ALL SELECT '15140', '220_energy_resource', '住石ホールディングス' FROM dual
    UNION ALL SELECT '33150', '220_energy_resource', '日本コークス工業' FROM dual
    UNION ALL SELECT '80880', '220_energy_resource', '岩谷産業' FROM dual
    UNION ALL SELECT '95330', '220_energy_resource', '東邦瓦斯' FROM dual   -- 通称は東邦ガス
    UNION ALL SELECT '95360', '220_energy_resource', '西部ガスホールディングス' FROM dual
    UNION ALL SELECT '95430', '220_energy_resource', '静岡ガス' FROM dual
    UNION ALL SELECT '81740', '220_energy_resource', '日本瓦斯' FROM dual
    UNION ALL SELECT '80970', '220_energy_resource', '三愛オブリ' FROM dual
    UNION ALL SELECT '81330', '220_energy_resource', '伊藤忠エネクス' FROM dual
    UNION ALL SELECT '81320', '220_energy_resource', 'シナネンホールディングス' FROM dual
    UNION ALL SELECT '50090', '220_energy_resource', '富士興産' FROM dual
    UNION ALL SELECT '80020', '220_energy_resource', '丸紅' FROM dual
    UNION ALL SELECT '80530', '220_energy_resource', '住友商事' FROM dual
    UNION ALL SELECT '80010', '220_energy_resource', '伊藤忠商事' FROM dual
    UNION ALL SELECT '27680', '220_energy_resource', '双日' FROM dual
    UNION ALL SELECT '95130', '220_energy_resource', '電源開発' FROM dual
    -- 230 再生可能エネルギー
    UNION ALL SELECT '95190', '230_renewable_energy', 'レノバ' FROM dual
    UNION ALL SELECT '95170', '230_renewable_energy', 'イーレックス' FROM dual
    UNION ALL SELECT '14070', '230_renewable_energy', 'ウエストホールディングス' FROM dual
    UNION ALL SELECT '95140', '230_renewable_energy', 'エフオン' FROM dual
    UNION ALL SELECT '50740', '230_renewable_energy', 'テスホールディングス' FROM dual;


--------------------------------------------------------------------------------
-- STEP 2. 【必須】証券コードの突合チェック
--
-- 候補リストの想定社名と EQUITY_MASTER の実際の社名を突き合わせる。
-- 証券コードの取り違えはここで必ず検出できる。
--
--   コード未存在 … EQUITY_MASTERに無いコード。上場廃止・新規上場・コード誤りのいずれか。
--   要確認       … コードは在るが社名が想定と一致しない。コード取り違えの可能性が高い。
--
-- J-Quantsの CO_NAME は英数字が全角で格納されているため、TO_SINGLE_BYTE で
-- 半角に揃え、空白(半角/全角)・中黒「・」・ハイフン類(-、−、－)を除去して比較する。
--
-- 【このチェックの限界】
--   包含関係で判定しているため、一方が他方を含む社名同士の取り違えは検出できない。
--   200番台では以下の紛らわしいペアを個別に目視すること:
--     57060 三井金属鉱業 / 80310 三井物産
--     57130 住友金属鉱山 / 80530 住友商事
--     57260 大阪チタニウムテクノロジーズ / 57270 東邦チタニウム
--     57070 東邦亜鉛 / 57810 東邦金属 / 95330 東邦ガス
--     15140 住石ホールディングス / 33150 日本コークス工業(いずれも石炭)
--
-- 【社名表記の注意】
--   J-Quantsは登記上の正式社名を使うため、都市ガス大手は「瓦斯」表記になっている。
--   通称の「ガス」で書くと不一致になるので候補リスト側を正式名に合わせること。
--     95310 東京瓦斯 / 95320 大阪瓦斯 / 95330 東邦瓦斯
--   一方、西部ガスホールディングス(95360)・静岡ガス(95430)は正式名がカタカナ表記。
--------------------------------------------------------------------------------
WITH chk AS (
    SELECT c.tag_name,
           c.code,
           c.expected_name,
           em.co_name AS actual_name,
           -- TO_SINGLE_BYTE は中黒「・」(U+30FB)を半角中黒「･」(U+FF65)に変換するため、
           -- 半角側も除去しないと中黒が残ってしまう(例: エンビプロ・ホールディングス)
           UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               TO_SINGLE_BYTE(c.expected_name),
               ' ',''), '　',''), '・',''), '･',''), '-',''), '−',''), '－','')) AS exp_norm,
           UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               TO_SINGLE_BYTE(em.co_name),
               ' ',''), '　',''), '・',''), '･',''), '-',''), '−',''), '－','')) AS act_norm
    FROM v_tag_candidate_200 c
    LEFT JOIN equity_master em ON em.code = c.code
)
SELECT tag_name,
       code,
       expected_name,
       actual_name,
       CASE
         WHEN actual_name IS NULL THEN 'コード未存在'
         WHEN act_norm LIKE '%' || exp_norm || '%'
           OR exp_norm LIKE '%' || act_norm || '%' THEN 'OK'
         ELSE '要確認'
       END AS judge
FROM chk
WHERE actual_name IS NULL
   OR NOT (act_norm LIKE '%' || exp_norm || '%'
        OR exp_norm LIKE '%' || act_norm || '%')
ORDER BY tag_name, code;

-- 全件を目視したい場合は上のWHERE句を外して実行する。


--------------------------------------------------------------------------------
-- STEP 3. FAVORITE_TAG へ投入
--
-- MERGEにしてあるので再実行しても重複エラーにならない。
-- EQUITY_MASTER に存在するコードのみを対象とする(外部キー制約を満たすため)。
--------------------------------------------------------------------------------
MERGE INTO favorite_tag t
USING (
    SELECT c.code, c.tag_name
    FROM v_tag_candidate_200 c
    JOIN equity_master em ON em.code = c.code
    -- tag_master 未登録のタグがあると外部キー違反で MERGE 全体がロールバックするため、
    -- こちらもJOINで守る(06_tag_master_add_230.sql の実行漏れ対策)
    JOIN tag_master   tm ON tm.tag_name = c.tag_name
) s
ON (t.code = s.code AND t.tag_name = s.tag_name)
WHEN NOT MATCHED THEN
    INSERT (code, tag_name) VALUES (s.code, s.tag_name);

COMMIT;


--------------------------------------------------------------------------------
-- STEP 4. 投入結果の確認
--------------------------------------------------------------------------------
-- タグ別の登録件数
SELECT tm.tag_code, tm.tag_label_ja, COUNT(ft.code) AS code_count
FROM tag_master tm
LEFT JOIN favorite_tag ft ON ft.tag_name = tm.tag_name
WHERE tm.major_code = '200'
GROUP BY tm.tag_code, tm.tag_label_ja
ORDER BY tm.tag_code;

-- 投入されなかった候補(コード未存在)
SELECT c.tag_name, c.code, c.expected_name
FROM v_tag_candidate_200 c
WHERE NOT EXISTS (SELECT 1 FROM equity_master em WHERE em.code = c.code)
ORDER BY c.tag_name, c.code;

-- 100番台と200番台の両方に付いている銘柄(意図した重複か確認する)
SELECT v.code, MAX(v.co_name) AS co_name,
       LISTAGG(v.tag_code, ', ') WITHIN GROUP (ORDER BY v.tag_code) AS tags
FROM v_equity_tag v
WHERE v.tag_code IS NOT NULL
GROUP BY v.code
HAVING MAX(CASE WHEN v.major_code = '100' THEN 1 ELSE 0 END) = 1
   AND MAX(CASE WHEN v.major_code = '200' THEN 1 ELSE 0 END) = 1
ORDER BY v.code;


--------------------------------------------------------------------------------
-- STEP 5. 候補リストから外した銘柄の取り消し(必要になったとき用)
--
-- STEP 1のビューから銘柄を削除しても、投入済みの行はMERGEでは消えない。
-- ビューから外した銘柄は下のクエリで検出し、DELETEすること。
--
-- SELECT ft.code, ft.tag_name FROM favorite_tag ft
-- JOIN tag_master tm ON tm.tag_name = ft.tag_name
-- WHERE tm.major_code = '200'
--   AND NOT EXISTS (SELECT 1 FROM v_tag_candidate_200 c
--                   WHERE c.code = ft.code AND c.tag_name = ft.tag_name);
--------------------------------------------------------------------------------

