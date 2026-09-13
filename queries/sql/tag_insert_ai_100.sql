--------------------------------------------------------------------------------
-- AI関連(100番台)タグの銘柄登録
--
-- 前提: ddl/05_tag_master.sql を実行済みであること。
--
-- 【必ずSTEP 2の突合結果を確認してからSTEP 3を実行すること】
--   候補リストの証券コードはWeb調査に基づくもので、DB上の実銘柄との突合は
--   未実施。STEP 2 で EQUITY_MASTER の社名と突き合わせ、
--   「コード未存在」「要確認」が無いことを確かめてから投入する。
--
-- 1銘柄に複数タグが付く(例: 富士通=110+120、三菱電機=120+140)。
-- AIバリューチェーンは1社が複数段にまたがるため、意図的な重複である。
--
-- 調査日: 2026-08-16 / 選定根拠は trend_analysis/ai_candidates_100.md を参照
--
-- 【改訂履歴】
--   2026-08-16 初版
--   2026-08-16 110から 43850 メルカリ・44430 Sansan を除外。
--              いずれもGENIAC採択だが、開発対象が自社ドメイン特化モデル
--              (メルカリ=出品データの検索・推薦、Sansan=自社プロダクト向けCello)で
--              汎用モデルを外部提供していないため、株価がAIモデル開発テーマで
--              動く企業とは言えないと判断。
--              → STEP 5 に投入済みデータからの取り消しSQLあり。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- STEP 1. 候補リスト(コード・タグ・想定社名)
--
-- 突合チェックと投入の両方から参照するため、ビューとして定義する。
-- 銘柄を追加・削除する場合はこのビューを修正して再実行すること。
-- 投入完了後に不要になったら DROP VIEW v_tag_candidate; で削除してよい。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tag_candidate (code, tag_name, expected_name) AS
    -- 110 AIモデル開発
    SELECT '44880', '110_ai_model', 'AI inside' FROM dual
    UNION ALL SELECT '55740', '110_ai_model', 'ABEJA' FROM dual
    UNION ALL SELECT '94340', '110_ai_model', 'ソフトバンク' FROM dual
    UNION ALL SELECT '94320', '110_ai_model', 'NTT' FROM dual   -- J-Quants上の社名は「ＮＴＴ」
    UNION ALL SELECT '67010', '110_ai_model', '日本電気' FROM dual
    UNION ALL SELECT '67020', '110_ai_model', '富士通' FROM dual
    UNION ALL SELECT '47550', '110_ai_model', '楽天グループ' FROM dual
    UNION ALL SELECT '77520', '110_ai_model', 'リコー' FROM dual
    UNION ALL SELECT '94330', '110_ai_model', 'KDDI' FROM dual
    UNION ALL SELECT '67520', '110_ai_model', 'パナソニック ホールディングス' FROM dual
    UNION ALL SELECT '43070', '110_ai_model', '野村総合研究所' FROM dual
    UNION ALL SELECT '39930', '110_ai_model', 'PKSHA Technology' FROM dual
    UNION ALL SELECT '99840', '110_ai_model', 'ソフトバンクグループ' FROM dual
    UNION ALL SELECT '67580', '110_ai_model', 'ソニーグループ' FROM dual
    UNION ALL SELECT '72670', '110_ai_model', '本田技研工業' FROM dual
    -- 120 半導体 設計・製造
    UNION ALL SELECT '285A0', '120_semi_design_mfg', 'キオクシアホールディングス' FROM dual
    UNION ALL SELECT '65260', '120_semi_design_mfg', 'ソシオネクスト' FROM dual
    UNION ALL SELECT '69630', '120_semi_design_mfg', 'ローム' FROM dual
    UNION ALL SELECT '67230', '120_semi_design_mfg', 'ルネサスエレクトロニクス' FROM dual
    UNION ALL SELECT '65030', '120_semi_design_mfg', '三菱電機' FROM dual
    UNION ALL SELECT '65040', '120_semi_design_mfg', '富士電機' FROM dual
    UNION ALL SELECT '58020', '120_semi_design_mfg', '住友電気工業' FROM dual
    UNION ALL SELECT '58010', '120_semi_design_mfg', '古河電気工業' FROM dual
    UNION ALL SELECT '67020', '120_semi_design_mfg', '富士通' FROM dual
    UNION ALL SELECT '99840', '120_semi_design_mfg', 'ソフトバンクグループ' FROM dual
    UNION ALL SELECT '67580', '120_semi_design_mfg', 'ソニーグループ' FROM dual
    UNION ALL SELECT '94320', '120_semi_design_mfg', 'NTT' FROM dual   -- J-Quants上の社名は「ＮＴＴ」
    UNION ALL SELECT '67010', '120_semi_design_mfg', '日本電気' FROM dual
    UNION ALL SELECT '67070', '120_semi_design_mfg', 'サンケン電気' FROM dual
    UNION ALL SELECT '68440', '120_semi_design_mfg', '新電元工業' FROM dual
    -- 130 半導体 製造装置・素材
    UNION ALL SELECT '80350', '130_semi_equip_material', '東京エレクトロン' FROM dual
    UNION ALL SELECT '68570', '130_semi_equip_material', 'アドバンテスト' FROM dual
    UNION ALL SELECT '61460', '130_semi_equip_material', 'ディスコ' FROM dual
    UNION ALL SELECT '77350', '130_semi_equip_material', 'SCREENホールディングス' FROM dual
    UNION ALL SELECT '69200', '130_semi_equip_material', 'レーザーテック' FROM dual
    UNION ALL SELECT '77290', '130_semi_equip_material', '東京精密' FROM dual
    UNION ALL SELECT '65250', '130_semi_equip_material', 'KOKUSAI ELECTRIC' FROM dual
    UNION ALL SELECT '63150', '130_semi_equip_material', 'TOWA' FROM dual
    UNION ALL SELECT '68710', '130_semi_equip_material', '日本マイクロニクス' FROM dual
    UNION ALL SELECT '68550', '130_semi_equip_material', '日本電子材料' FROM dual
    UNION ALL SELECT '67280', '130_semi_equip_material', 'アルバック' FROM dual
    UNION ALL SELECT '63230', '130_semi_equip_material', 'ローツェ' FROM dual
    UNION ALL SELECT '65900', '130_semi_equip_material', '芝浦メカトロニクス' FROM dual
    UNION ALL SELECT '63610', '130_semi_equip_material', '荏原製作所' FROM dual
    UNION ALL SELECT '268A0', '130_semi_equip_material', 'リガク・ホールディングス' FROM dual
    UNION ALL SELECT '40630', '130_semi_equip_material', '信越化学工業' FROM dual
    UNION ALL SELECT '34360', '130_semi_equip_material', 'SUMCO' FROM dual
    UNION ALL SELECT '41860', '130_semi_equip_material', '東京応化工業' FROM dual
    UNION ALL SELECT '40620', '130_semi_equip_material', 'イビデン' FROM dual
    UNION ALL SELECT '40040', '130_semi_equip_material', 'レゾナック・ホールディングス' FROM dual
    UNION ALL SELECT '50160', '130_semi_equip_material', 'JX金属' FROM dual
    UNION ALL SELECT '53840', '130_semi_equip_material', 'フジミインコーポレーテッド' FROM dual
    UNION ALL SELECT '43690', '130_semi_equip_material', 'トリケミカル研究所' FROM dual
    UNION ALL SELECT '41090', '130_semi_equip_material', 'ステラケミファ' FROM dual
    UNION ALL SELECT '40470', '130_semi_equip_material', '関東電化工業' FROM dual
    UNION ALL SELECT '77410', '130_semi_equip_material', 'HOYA' FROM dual
    UNION ALL SELECT '42030', '130_semi_equip_material', '住友ベークライト' FROM dual
    UNION ALL SELECT '28020', '130_semi_equip_material', '味の素' FROM dual
    UNION ALL SELECT '57060', '130_semi_equip_material', '三井金属鉱業' FROM dual
    UNION ALL SELECT '40210', '130_semi_equip_material', '日産化学' FROM dual
    UNION ALL SELECT '79660', '130_semi_equip_material', 'リンテック' FROM dual
    UNION ALL SELECT '69710', '130_semi_equip_material', '京セラ' FROM dual
    -- 140 電力・データセンターインフラ
    UNION ALL SELECT '95010', '140_power_datacenter', '東京電力ホールディングス' FROM dual
    UNION ALL SELECT '95030', '140_power_datacenter', '関西電力' FROM dual
    UNION ALL SELECT '95130', '140_power_datacenter', '電源開発' FROM dual
    UNION ALL SELECT '65010', '140_power_datacenter', '日立製作所' FROM dual
    UNION ALL SELECT '65030', '140_power_datacenter', '三菱電機' FROM dual
    UNION ALL SELECT '65040', '140_power_datacenter', '富士電機' FROM dual
    UNION ALL SELECT '65080', '140_power_datacenter', '明電舎' FROM dual
    UNION ALL SELECT '66170', '140_power_datacenter', '東光高岳' FROM dual
    UNION ALL SELECT '66220', '140_power_datacenter', 'ダイヘン' FROM dual
    UNION ALL SELECT '66510', '140_power_datacenter', '日東工業' FROM dual
    UNION ALL SELECT '65160', '140_power_datacenter', '山洋電気' FROM dual
    UNION ALL SELECT '99340', '140_power_datacenter', '因幡電機産業' FROM dual
    UNION ALL SELECT '58030', '140_power_datacenter', 'フジクラ' FROM dual
    UNION ALL SELECT '58010', '140_power_datacenter', '古河電気工業' FROM dual
    UNION ALL SELECT '58020', '140_power_datacenter', '住友電気工業' FROM dual
    UNION ALL SELECT '58050', '140_power_datacenter', 'SWCC' FROM dual
    UNION ALL SELECT '63670', '140_power_datacenter', 'ダイキン工業' FROM dual
    UNION ALL SELECT '64580', '140_power_datacenter', '新晃工業' FROM dual
    UNION ALL SELECT '65940', '140_power_datacenter', 'ニデック' FROM dual
    UNION ALL SELECT '70110', '140_power_datacenter', '三菱重工業' FROM dual
    UNION ALL SELECT '19690', '140_power_datacenter', '高砂熱学工業' FROM dual
    UNION ALL SELECT '19520', '140_power_datacenter', '新日本空調' FROM dual
    UNION ALL SELECT '19610', '140_power_datacenter', '三機工業' FROM dual
    UNION ALL SELECT '19420', '140_power_datacenter', '関電工' FROM dual
    UNION ALL SELECT '19440', '140_power_datacenter', 'きんでん' FROM dual
    UNION ALL SELECT '14170', '140_power_datacenter', 'ミライト・ワン' FROM dual
    UNION ALL SELECT '19510', '140_power_datacenter', 'エクシオグループ' FROM dual
    UNION ALL SELECT '18120', '140_power_datacenter', '鹿島建設' FROM dual
    UNION ALL SELECT '18020', '140_power_datacenter', '大林組' FROM dual
    UNION ALL SELECT '37780', '140_power_datacenter', 'さくらインターネット' FROM dual
    UNION ALL SELECT '94340', '140_power_datacenter', 'ソフトバンク' FROM dual
    UNION ALL SELECT '94330', '140_power_datacenter', 'KDDI' FROM dual
    UNION ALL SELECT '37740', '140_power_datacenter', 'インターネットイニシアティブ' FROM dual
    -- 150 AI応用サービス
    UNION ALL SELECT '40110', '150_ai_application', 'ヘッドウォータース' FROM dual
    UNION ALL SELECT '55860', '150_ai_application', 'Laboro.AI' FROM dual
    UNION ALL SELECT '55910', '150_ai_application', 'AVILEN' FROM dual
    UNION ALL SELECT '55720', '150_ai_application', 'Ridge-i' FROM dual
    UNION ALL SELECT '55740', '150_ai_application', 'ABEJA' FROM dual
    UNION ALL SELECT '42590', '150_ai_application', 'エクサウィザーズ' FROM dual
    UNION ALL SELECT '39930', '150_ai_application', 'PKSHA Technology' FROM dual
    UNION ALL SELECT '44880', '150_ai_application', 'AI inside' FROM dual
    UNION ALL SELECT '43820', '150_ai_application', 'HEROZ' FROM dual
    UNION ALL SELECT '55880', '150_ai_application', 'ファーストアカウンティング' FROM dual
    UNION ALL SELECT '478A0', '150_ai_application', 'フツパー' FROM dual
    UNION ALL SELECT '70460', '150_ai_application', 'TDSE' FROM dual
    UNION ALL SELECT '36550', '150_ai_application', 'ブレインパッド' FROM dual
    UNION ALL SELECT '21580', '150_ai_application', 'FRONTEO' FROM dual
    UNION ALL SELECT '37730', '150_ai_application', 'アドバンスト・メディア' FROM dual
    UNION ALL SELECT '43880', '150_ai_application', 'エーアイ' FROM dual
    UNION ALL SELECT '36530', '150_ai_application', 'モルフォ' FROM dual
    UNION ALL SELECT '40560', '150_ai_application', 'ニューラルグループ' FROM dual
    UNION ALL SELECT '52460', '150_ai_application', 'ELEMENTS' FROM dual
    UNION ALL SELECT '44250', '150_ai_application', 'Kudan' FROM dual
    UNION ALL SELECT '61820', '150_ai_application', 'メタリアル' FROM dual
    UNION ALL SELECT '39840', '150_ai_application', 'ユーザーローカル' FROM dual
    UNION ALL SELECT '41800', '150_ai_application', 'Appier Group' FROM dual
    UNION ALL SELECT '50340', '150_ai_application', 'unerry' FROM dual
    UNION ALL SELECT '40710', '150_ai_application', 'プラスアルファ・コンサルティング' FROM dual
    UNION ALL SELECT '36940', '150_ai_application', 'オプティム' FROM dual
    UNION ALL SELECT '44930', '150_ai_application', 'サイバーセキュリティクラウド' FROM dual
    UNION ALL SELECT '52540', '150_ai_application', 'Arent' FROM dual
    UNION ALL SELECT '43750', '150_ai_application', 'セーフィー' FROM dual
    UNION ALL SELECT '46670', '150_ai_application', 'アイサンテクノロジー' FROM dual
    UNION ALL SELECT '44180', '150_ai_application', 'JDSC' FROM dual
    UNION ALL SELECT '73830', '150_ai_application', 'ネットプロテクションズホールディングス' FROM dual
    UNION ALL SELECT '39960', '150_ai_application', 'サインポスト' FROM dual;


--------------------------------------------------------------------------------
-- STEP 2. 【必須】証券コードの突合チェック
--
-- 候補リストの想定社名と EQUITY_MASTER の実際の社名を突き合わせる。
-- 証券コードの取り違えはここで必ず検出できる。
--
--   コード未存在 … EQUITY_MASTERに無いコード。上場廃止・新規上場・コード誤りのいずれか。
--   要確認       … コードは在るが社名が想定と一致しない。コード取り違えの可能性が高い。
--   OK           … 想定社名と実社名が包含関係にある。
--
-- 「要確認」は社名表記の揺れ(ホールディングス/HD、旧社名など)でも出るため、
-- ACTUAL_NAME を見て人が判断すること。
--
-- 【表記ゆれの正規化】
--   J-Quantsの CO_NAME は英数字が全角で格納されている(例:「ＫＤＤＩ」)ため、
--   そのまま比較すると全件が「要確認」になる。TO_SINGLE_BYTE で半角に揃え、
--   さらに以下を除去してから比較する:
--     空白(半角/全角)、中黒「・」、ハイフン類(-、−、－)
--   これで「ＡＩ　ｉｎｓｉｄｅ」=「AI inside」、「Ｒｉｄｇｅ−ｉ」=「Ridge-i」が一致する。
--
-- 【このチェックの限界】
--   包含関係で判定しているため、「ソフトバンク」と「ソフトバンクグループ」、
--   「三井金属鉱業」と「三井金属」のように一方が他方を含む社名同士の取り違えは
--   検出できない。以下の紛らわしいペアだけは個別に目視すること:
--     94340 ソフトバンク(通信) / 99840 ソフトバンクグループ(投資)
--     67010 日本電気(NEC)     / 67020 富士通
--     58010 古河電気工業       / 58020 住友電気工業 / 58030 フジクラ / 58050 SWCC
--------------------------------------------------------------------------------
WITH chk AS (
    SELECT c.tag_name,
           c.code,
           c.expected_name,
           em.co_name AS actual_name,
           -- 比較用に正規化した文字列(全角→半角、空白・中黒・ハイフンを除去)
           -- TO_SINGLE_BYTE は中黒「・」(U+30FB)を半角中黒「･」(U+FF65)に変換するため、
           -- 半角側も除去しないと中黒が残ってしまう(例: エンビプロ・ホールディングス)
           UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               TO_SINGLE_BYTE(c.expected_name),
               ' ',''), '　',''), '・',''), '･',''), '-',''), '−',''), '－','')) AS exp_norm,
           UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               TO_SINGLE_BYTE(em.co_name),
               ' ',''), '　',''), '・',''), '･',''), '-',''), '−',''), '－','')) AS act_norm
    FROM v_tag_candidate c
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
-- STEP 2 で「コード未存在」だった銘柄は、ここでは黙って除外される。
--------------------------------------------------------------------------------
MERGE INTO favorite_tag t
USING (
    SELECT c.code, c.tag_name
    FROM v_tag_candidate c
    JOIN equity_master em ON em.code = c.code
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
WHERE tm.major_code = '100'
GROUP BY tm.tag_code, tm.tag_label_ja
ORDER BY tm.tag_code;

-- 投入されなかった候補(コード未存在)
SELECT c.tag_name, c.code, c.expected_name
FROM v_tag_candidate c
WHERE NOT EXISTS (SELECT 1 FROM equity_master em WHERE em.code = c.code)
ORDER BY c.tag_name, c.code;


--------------------------------------------------------------------------------
-- STEP 5. 候補リストから外した銘柄の取り消し
--
-- STEP 1のビューから銘柄を削除しても、既にFAVORITE_TAGへ投入済みの行は
-- MERGEでは消えない(WHEN NOT MATCHED THEN INSERT のみのため)。
-- ビューから外した銘柄は、この文で明示的に削除する必要がある。
--
-- 下は 2026-08-16 の改訂(メルカリ・Sansanを110から除外)に対応する削除文。
-- まだSTEP 3を実行していない場合は、実行しなくても影響はない(0行削除)。
--------------------------------------------------------------------------------
DELETE FROM favorite_tag
WHERE tag_name = '110_ai_model'
  AND code IN ('43850', '44430');   -- メルカリ、Sansan

COMMIT;

-- 汎用版: ビューに存在しない100番台タグの行をすべて削除する。
-- 今後ビューから銘柄を外したときは、個別の削除文を書く代わりにこれを実行してもよい。
-- ただしビュー経由以外で手動登録したタグも消えるため、実行前に対象を確認すること。
--
-- SELECT ft.code, ft.tag_name FROM favorite_tag ft
-- JOIN tag_master tm ON tm.tag_name = ft.tag_name
-- WHERE tm.major_code = '100'
--   AND NOT EXISTS (SELECT 1 FROM v_tag_candidate c
--                   WHERE c.code = ft.code AND c.tag_name = ft.tag_name);
