--------------------------------------------------------------------------------
-- TAG_MASTER(タグマスタ)の追加と FAVORITE_TAG への外部キー付与
-- 実行ユーザー: GD_JQUANTS
--
-- 背景:
--   FAVORITE_TAG.TAG_NAME は自由入力の文字列のため、表記ゆれやタイポがあっても
--   検知できず、集計時に銘柄が静かに漏れる。
--   タグの正式名称を TAG_MASTER で一元管理し、FAVORITE_TAG から外部キーで
--   参照させることで、登録できるタグをマスタ定義済みのものだけに限定する。
--
-- タグ体系:
--   TAG_TYPE='CLASS' … 番号付き。業種・バリューチェーンの分類体系。
--                       3桁固定・10刻み。上位1桁が大分類(1=AI, 2=資源, 3=金融)。
--   TAG_TYPE='THEME' … 番号なし。個別テーマの自由タグ(例: 光電融合)。
--
--   3桁固定にするのは文字列ソートと数値順を一致させるため
--   (桁数が混ざると '90' が '110' より後ろに並ぶ)。
--   10刻みにするのは、後から中分類を割るときに 131/132 を追加でき、
--   既存タグの振り直しが不要になるため。
--
--   番号の有無で分類体系とテーマタグを機械的に分離できる:
--     WHERE tag_type = 'CLASS'  (または REGEXP_LIKE(tag_name, '^[0-9]'))
--
-- 1銘柄に複数タグを付与できる(FAVORITE_TAG の UNIQUE(code, tag_name))。
-- AIバリューチェーンは1社が複数段にまたがることが多いため、
-- 単一カテゴリに強制的に割り振らず、該当するタグをすべて付ける運用とする。
--
-- 実行順序:
--   01〜04 の実行後、任意のタイミングで実行可能。
--   FAVORITE_TAG に既存データがある場合は、STEP 3 の確認クエリで
--   未登録タグが0件であることを確かめてから STEP 4 を実行すること。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- STEP 0. FAVORITE_TAG.TAG_NAME を文字数セマンティクスに揃える
--
-- 既存の FAVORITE_TAG.TAG_NAME は VARCHAR2(100)(バイト指定)のため、
-- UTF-8の日本語では実質33文字しか入らない。TAG_MASTER 側を (100 CHAR) で作ると
-- 「マスタには登録できるが FAVORITE_TAG には入らないタグ名」が生まれうる。
-- 04_alter_column_sizes.sql と同じ方針で CHAR セマンティクスに統一しておく。
--------------------------------------------------------------------------------
ALTER TABLE favorite_tag MODIFY (tag_name VARCHAR2(100 CHAR));


--------------------------------------------------------------------------------
-- STEP 1. TAG_MASTER 作成
--------------------------------------------------------------------------------
CREATE TABLE tag_master (
    tag_name        VARCHAR2(100 CHAR)  NOT NULL,
    tag_type        VARCHAR2(10 CHAR)   DEFAULT 'CLASS' NOT NULL,
    tag_code        VARCHAR2(3 CHAR),
    major_code      VARCHAR2(3 CHAR),
    major_label_ja  VARCHAR2(100 CHAR),
    tag_label_ja    VARCHAR2(100 CHAR)  NOT NULL,
    description     VARCHAR2(1000 CHAR),
    is_active       NUMBER(1)           DEFAULT 1 NOT NULL,
    created_at      TIMESTAMP           DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at      TIMESTAMP           DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_tag_master PRIMARY KEY (tag_name),
    CONSTRAINT uq_tag_master_code UNIQUE (tag_code),
    CONSTRAINT ck_tag_master_type CHECK (tag_type IN ('CLASS','THEME')),
    CONSTRAINT ck_tag_master_active CHECK (is_active IN (0,1)),
    -- CLASSは番号必須、THEMEは番号を持たない
    CONSTRAINT ck_tag_master_code_rule CHECK (
        (tag_type = 'CLASS' AND tag_code IS NOT NULL AND major_code IS NOT NULL)
     OR (tag_type = 'THEME' AND tag_code IS NULL     AND major_code IS NULL)
    )
);

COMMENT ON TABLE  tag_master                IS 'タグマスタ(FAVORITE_TAGで使用できるタグの定義)';
COMMENT ON COLUMN tag_master.tag_name       IS 'タグ名(FAVORITE_TAG.TAG_NAMEから参照。例:110_ai_model)';
COMMENT ON COLUMN tag_master.tag_type       IS 'CLASS=番号付きの分類体系 / THEME=番号なしの自由テーマ';
COMMENT ON COLUMN tag_master.tag_code       IS '分類番号(3桁固定・10刻み。THEMEはNULL)';
COMMENT ON COLUMN tag_master.major_code     IS '大分類番号(100/200/300。THEMEはNULL)';
COMMENT ON COLUMN tag_master.major_label_ja IS '大分類名(日本語)';
COMMENT ON COLUMN tag_master.tag_label_ja   IS 'タグ名(日本語表示用)';
COMMENT ON COLUMN tag_master.description    IS 'このタグに含める範囲の定義。判断に迷ったときの基準';
COMMENT ON COLUMN tag_master.is_active      IS '1=使用中 / 0=廃止(過去データ保持のため物理削除しない)';
COMMENT ON COLUMN tag_master.created_at     IS '登録日時';
COMMENT ON COLUMN tag_master.updated_at     IS '更新日時';


--------------------------------------------------------------------------------
-- STEP 2. タグ定義の投入
--
-- MERGE にしてあるので、定義を修正して再実行すれば内容が上書きされる。
-- タグを追加する場合は USING 句に SELECT 行を足して再実行すること。
--
-- 注意: 上書きできるのは TAG_LABEL_JA や DESCRIPTION などの属性のみ。
--       TAG_NAME はMERGEの結合キーなので、TAG_NAME自体を変更すると
--       「別タグの新規登録」になる。改名したい場合は次の順序で行うこと:
--         1) 新しいTAG_NAMEをTAG_MASTERに登録
--         2) UPDATE favorite_tag SET tag_name='新' WHERE tag_name='旧';
--         3) DELETE FROM tag_master WHERE tag_name='旧';
--       (STEP 4のFKがあるため、2を飛ばして3は実行できない)
--------------------------------------------------------------------------------
MERGE INTO tag_master t
USING (
    ----------------------------------------------------------------------------
    -- 100番台: AI・テクノロジー(AIバリューチェーンを川上から川下へ)
    ----------------------------------------------------------------------------
    SELECT '110_ai_model'           AS tag_name, 'CLASS' AS tag_type,
           '110' AS tag_code, '100' AS major_code, 'AI・テクノロジー' AS major_label_ja,
           'AIモデル開発'           AS tag_label_ja,
           '基盤モデル・LLM等のAIモデル自体を開発する企業、および主要開発企業へ出資しその損益を取り込む企業。国内上場では該当が少ない前提。'
                                    AS description FROM dual
    UNION ALL
    SELECT '120_semi_design_mfg', 'CLASS',
           '120', '100', 'AI・テクノロジー',
           '半導体 設計・製造',
           'AI向け半導体(GPU/ASIC/HBM/パワー半導体等)を設計または製造する企業。ファブレス・IDM・ファウンドリを含む。'
           FROM dual
    UNION ALL
    SELECT '130_semi_equip_material', 'CLASS',
           '130', '100', 'AI・テクノロジー',
           '半導体 製造装置・素材',
           '半導体の製造装置・検査装置、およびシリコンウエハ・フォトレジスト・特殊ガス等の材料を供給する企業。銘柄数が増えたら131=装置/132=素材に分割する。'
           FROM dual
    UNION ALL
    SELECT '140_power_datacenter', 'CLASS',
           '140', '100', 'AI・テクノロジー',
           '電力・データセンターインフラ',
           'AIの電力・設備需要を取り込む企業。発電・送配電、データセンターの建設・運営、冷却/電源/変圧器等の設備、通信インフラを含む。銘柄数が増えたら141=電力/142=DC設備・運営に分割する。'
           FROM dual
    UNION ALL
    SELECT '150_ai_application', 'CLASS',
           '150', '100', 'AI・テクノロジー',
           'AI応用サービス',
           'AIが主要な差別化要因・収益源になっている企業。社内業務でAIを使っているだけの企業は範囲が発散するため含めない。'
           FROM dual
    ----------------------------------------------------------------------------
    -- 200番台: 資源・素材
    ----------------------------------------------------------------------------
    UNION ALL
    SELECT '210_rare_metal', 'CLASS',
           '210', '200', '資源・素材',
           'レアメタル・非鉄金属',
           'レアメタル・レアアース・非鉄金属の採掘、製錬、加工、リサイクルを手掛ける企業。半導体材料と重なる場合は130も併せて付与する。'
           FROM dual
    UNION ALL
    SELECT '220_energy_resource', 'CLASS',
           '220', '200', '資源・素材',
           'エネルギー・資源',
           '石油・ガス・石炭・ウラン等のエネルギー資源の開発・調達・供給を行う企業、および資源権益を持つ商社。エネルギーを消費するだけの企業は含めない。電力会社そのものは140で扱う。'
           FROM dual
    UNION ALL
    SELECT '230_renewable_energy', 'CLASS',
           '230', '200', '資源・素材',
           '再生可能エネルギー',
           '太陽光・風力・バイオマス・地熱等の再エネ発電所を自社で開発・保有・運営する企業、および再エネEPCを主業とする企業。値動きの要因はFIT/FIP制度・電力卸価格・金利であり、資源市況で動く220とは分けて扱う。'
           FROM dual
    ----------------------------------------------------------------------------
    -- 300番台: 金融
    ----------------------------------------------------------------------------
    UNION ALL
    SELECT '310_bank', 'CLASS',
           '310', '300', '金融',
           '銀行',
           'メガバンク・地方銀行・ネット銀行等。上場する全ての銀行に付与し、細分は311(大手)/312(地銀)/313(ネット・決済系)で併用する。JPX33業種の「銀行業」(sector33_code=7050)で機械的に抽出できるが、タグ体系の一貫性のため明示的に付与する。日本銀行(83010)は出資証券であり普通株ではないため除外する。'
           FROM dual
    UNION ALL
    SELECT '311_bank_major', 'CLASS',
           '311', '300', '金融',
           '大手銀行・信託',
           'メガバンク・信託銀行・ゆうちょ銀行など全国規模の大手銀行(金融庁の「主要行等」に相当)。海外金利・為替・政策保有株の売却が主な値動きの要因。310_bank と併せて付与する。'
           FROM dual
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
    SELECT '320_insurance', 'CLASS',
           '320', '300', '金融',
           '保険',
           '生命保険・損害保険の引受会社とその持株会社。JPX33業種の「保険業」(sector33_code=7150)には保険代理店も含まれるが、それらは330_insurance_agencyへ分離している。'
           FROM dual
    UNION ALL
    SELECT '330_insurance_agency', 'CLASS',
           '330', '300', '金融',
           '保険代理店・保険ショップ',
           '保険の募集・仲介を行う代理店、来店型保険ショップ、乗合代理店。JPX33業種では「保険業」に分類されるが、収益は募集手数料であり保険引受会社(320)とは値動きの要因が別物のため分離する。'
           FROM dual
    ----------------------------------------------------------------------------
    -- 番号なし: 個別テーマ(既存タグの移行を含む)
    ----------------------------------------------------------------------------
    UNION ALL
    SELECT 'photoelectric_fusion', 'THEME',
           NULL, NULL, NULL,
           '光電融合',
           '光電融合(オプティカルI/O)関連。IOWN構想を含む個別テーマ。'
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

COMMIT;


--------------------------------------------------------------------------------
-- STEP 3. 【重要】外部キーを張る前の確認
--
-- FAVORITE_TAG に、TAG_MASTER へ未登録のタグが残っていないか確認する。
-- ここで行が返る場合は、STEP 2 の MERGE にそのタグを追加するか、
-- FAVORITE_TAG 側を正しいタグ名に UPDATE してから STEP 4 に進むこと。
-- 0件でなければ STEP 4 は ORA-02298 で失敗する。
--------------------------------------------------------------------------------
SELECT ft.tag_name, COUNT(*) AS cnt
FROM favorite_tag ft
WHERE NOT EXISTS (SELECT 1 FROM tag_master tm WHERE tm.tag_name = ft.tag_name)
GROUP BY ft.tag_name
ORDER BY ft.tag_name;

-- 参考: タグ名を一括で付け替える場合
-- UPDATE favorite_tag SET tag_name = '150_ai_application' WHERE tag_name = 'ai';
-- COMMIT;


--------------------------------------------------------------------------------
-- STEP 4. FAVORITE_TAG から TAG_MASTER への外部キー
--
-- 索引を先に作るのは、OracleがFK列に自動で索引を作らないため。
-- 索引が無いと親表(TAG_MASTER)の更新時に子表(FAVORITE_TAG)へ
-- 全表ロックがかかる。既存の UNIQUE(code, tag_name) は tag_name が
-- 第2列なので、FK用の索引としては使えない。
--------------------------------------------------------------------------------
CREATE INDEX ix_favorite_tag_name ON favorite_tag (tag_name);

ALTER TABLE favorite_tag
    ADD CONSTRAINT fk_favorite_tag_name
    FOREIGN KEY (tag_name) REFERENCES tag_master (tag_name);


--------------------------------------------------------------------------------
-- STEP 5. 参照用ビュー
--
-- 「タグ付き銘柄」を毎回3表JOINで書かずに済むようにする。
-- 分析SQLからは基本的にこのビューを使う。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_equity_tag AS
SELECT ft.code,
       em.co_name,
       em.market_name,
       em.sector17_code,
       em.sector33_name,
       tm.tag_name,
       tm.tag_type,
       tm.tag_code,
       tm.major_code,
       tm.major_label_ja,
       tm.tag_label_ja,
       tm.is_active,
       ft.created_at AS tagged_at
FROM favorite_tag ft
JOIN tag_master   tm ON tm.tag_name = ft.tag_name
JOIN equity_master em ON em.code    = ft.code;

COMMENT ON TABLE v_equity_tag IS 'タグ付き銘柄(FAVORITE_TAG × TAG_MASTER × EQUITY_MASTER)';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- タグ定義の一覧(番号順、テーマは末尾)
-- SELECT tag_code, tag_name, major_label_ja, tag_label_ja, is_active
-- FROM tag_master
-- ORDER BY tag_code NULLS LAST, tag_name;

-- タグ登録の例(1銘柄に複数タグを付与できる)
-- INSERT INTO favorite_tag (code, tag_name) VALUES ('68570', '130_semi_equip_material');
-- COMMIT;
