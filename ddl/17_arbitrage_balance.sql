--------------------------------------------------------------------------------
-- 裁定取引残高(週末の裁定取引に係る現物ポジション)
-- 実行ユーザー: GD_JQUANTS
--
-- 【なぜ手動取込なのか】
--   このデータは J-Quants が配信していない。API仕様書の「契約ごとに利用可能な
--   APIとデータ格納期間」の一覧に該当エンドポイントが存在せず、Premiumに
--   上げても取得できない(先物四本値はPremiumで取れるが、そこから裁定残は復元できない)。
--   一方でマクロ需給ダッシュボードの構成要素として必要なため、
--   JPXが公表するファイルを人手で取り込む唯一の例外テーブルとして用意する。
--
-- 【取込元】(2026-09-08 に実ページで確認)
--   日本取引所グループ 統計情報(株式関連) > プログラム売買・裁定取引
--   公表資料はページが2つに分かれている。取り違えやすいので注意:
--
--     ・日次版 … ページ「裁定取引」  .../statistics-equities/program/index.html
--                2営業日前の状況。株数のみ。毎営業日16:00頃。
--                ファイル名は 260904.xls のように YYMMDD 6桁。
--
--     ・週間版 … ページ「プログラム売買」.../statistics-equities/program/01.html
--                前週末時点。株数と金額の両方。毎週第3営業日の午後。
--                ファイル名は 20260828.xls のように YYYYMMDD 8桁。
--                ページ名は「プログラム売買」だが、ファイルの中に
--                「裁定取引に係る現物ポジション」の表が同梱されている。
--                ページ名で探すと見つからないので注意。
--
--   本テーブルは【週間版】(01.html 側)を対象とする。理由は2つ:
--     (1) 金額が付くので、他の需給指標(空売り比率=円、信用残の金額換算=円)と
--         同じ土俵で並べられる
--     (2) 第一階層のダッシュボードが週次のため、日次まで持つ必要がない
--
--   バックナンバー: .../statistics-equities/program/01-archives-NN.html
--   (NN は 00=最新、01=前年 … の連番。掲載は概ね直近3〜4年分しかない。
--    株価・信用残が10年あるのに対しここだけ短いため、
--    ダッシュボードを長期に遡ると裁定残の列だけ空く期間ができる)
--
--   【CSVは提供されていない】
--   配布形式は .xls(旧形式バイナリ) と .pdf のみ。CSVは無い。
--   .xls から下記レイアウトのCSVに変換する工程が必ず1つ挟まる。
--
-- 【対象範囲】
--   東証上場内国株式(海外取引所に上場している分も含む)。全取引参加者の報告合計。
--   金額は各社が週末営業日の終値で換算した数値の合計であり、
--   「株数は増えたが株価が下がったので金額は減った」ということが起こり得る。
--
-- 【当限 / 翌限以降】
--   裁定ポジションが対応する先物の限月。SQ(特別清算指数算出日)が近づくと
--   当限が翌限以降へロールオーバーされるため、当限だけを見て「解消された」と
--   判断すると読み違える。合計(TOT)で見るのが基本で、内訳は補助的に使う。
--
-- 【単位】(2026-09-08、2026年8月28日分の実ファイルで確認)
--   JPXの掲載単位は【株数=千株、金額=百万円】。
--   本テーブルは他テーブルと基準を揃えるため【株数=株、金額=円】で格納する。
--     株数: 千株 × 1000
--     金額: 百万円 × 1000000
--   変換はCSVを作る側で行い、本表には正規化済みの値だけを入れること。
--
-- 【ファイル内の表の並び】(2026年8月28日分の実ファイルで確認済み)
--   シートは1枚(「週間公表資料」)。その中に複数の表が縦に並んでいる:
--     表1 プログラム売買に係る現物株式の売買   (千株・百万円)
--     表2 裁定取引に係る現物ポジション         (千株・百万円) ← 本テーブルの対象
--     表3 (注)書き
--     表4 取引参加者別裁定取引の状況           (千株・%)
--   表2の構成は 売りポジション(左) / 買いポジション(右) の2ブロックで、
--   各ブロックが 当限 / 翌限以降 / 合計 の3列、行が「株　数」「金　額」。
--   株数・金額それぞれの直下に「前週末比」の行がある(取り込まない。DB側でLAGで出せる)。
--
--   【左が売り、右が買い】。PDFから機械抽出すると左右が入れ替わって見えることが
--   あったため、変換スクリプトは見出しセル(「売りポジション」「買いポジション」)の
--   列位置から毎回マッピングを作り直している。行・列の決め打ちはしていない。
--
--   実測値: 2026-08-28 で買残 23,212億円 / 売残 1,728億円。
--   買残の水準は年々上がっており、2023年は平均9,293億円、2026年は平均26,935億円
--   (2023-01-13の3,462億円が最小、2026年の38,684億円が最大)。
--   桁の検査をするときはこの3倍以上の変動幅を見込んでおくこと。
--
--   【売残 > 買残 は稀にある。異常ではない】
--   2023年1月の3週(1/6・1/13・1/20)は実際に売り長だった
--   (1/13で売残5,930億円 / 買残3,462億円)。前後の週とも連続した推移で、
--   列の取り違えではないことを実ファイルで確認済み。
--   過去分191件のうち逆転はこの3週だけ。取り込みは止めず警告のみとしている。
--   また買残はほぼ全額が当限に乗る(当限 23,113億円 / 翌限以降 100億円)ため、
--   当限だけを見て増減を語るとSQ前のロールオーバーで読み違える。
--
-- 【取込手順】(スクリプト実装済み。2026-09-08)
--   1. 週間版の .xls を manual_dl_datas/program_weekly/ に集める
--        node scripts/download-arbitrage-archives.js            過去分(直近4年)を一括
--        node scripts/download-arbitrage-archives.js --latest   毎週の運用はこちら
--      ページのhrefを拾って落とす(URLの<ハッシュ>部分に規則性が無いため組み立て不可)。
--      取得済みはスキップするので、2回目以降は差分だけになる。
--      手で落として置いても構わない。
--
--   2. .xls → CSV に変換する
--        python3 scripts/convert-arbitrage-xls.py <xlsのディレクトリ> --out arbitrage.csv
--      単位の正規化(千株→株、百万円→円)と、内訳=合計・桁・日付の検証はここで行う。
--      --inspect を付けると読み取った値を人間が読める形で表示するだけで終わる。
--      ※ xlrd が必要(pip3 install xlrd)。このプロジェクトで唯一のPythonスクリプト。
--         理由はスクリプト冒頭のコメント参照。
--
--   3. CSV → DB
--        node src/loadArbitrage.js arbitrage.csv
--      ステージングをTRUNCATE → executeMany で投入 → MERGE → COMMIT。冪等。
--      --dry-run でDBに触らず内容だけ確認できる。
--
--   CSVレイアウト(convert-arbitrage-xls.py の出力):
--     pos_date,buy_cur_vol,buy_cur_val,buy_nxt_vol,buy_nxt_val,
--     sell_cur_vol,sell_cur_val,sell_nxt_vol,sell_nxt_val,src_file
--   合計(TOT)はCSVに持たせない。MERGE側で当限+翌限以降から算出する。
--   ファイルの合計欄をそのまま信じると内訳と食い違うファイルを取り込んでしまうため。
--
--   【loadDaily.js のPhaseには入れていない】
--   自動取得できないものを日次バッチのPhaseに混ぜると、毎晩「失敗」し続けて
--   本来の失敗通知が埋もれる。週1回、手で実行する運用にしている。
--
-- 前提: 01〜16 のDDLを実行済みであること。
--       ただし本テーブルは銘柄単位ではないため EQUITY_MASTER への外部キーは持たない
--       (SECTOR_SHORT_RATIO / INVESTOR_TYPE_TRADING と同じ扱い)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. ARBITRAGE_BALANCE (裁定取引残高・週次)
--------------------------------------------------------------------------------
CREATE TABLE arbitrage_balance (
    pos_date      DATE               NOT NULL,
    -- 買いポジション(現物買い + 先物売り)
    buy_cur_vol   NUMBER(20),
    buy_cur_val   NUMBER(20,2),
    buy_nxt_vol   NUMBER(20),
    buy_nxt_val   NUMBER(20,2),
    buy_tot_vol   NUMBER(20),
    buy_tot_val   NUMBER(20,2),
    -- 売りポジション(現物売り + 先物買い)
    sell_cur_vol  NUMBER(20),
    sell_cur_val  NUMBER(20,2),
    sell_nxt_vol  NUMBER(20),
    sell_nxt_val  NUMBER(20,2),
    sell_tot_vol  NUMBER(20),
    sell_tot_val  NUMBER(20,2),
    src_file      VARCHAR2(200 CHAR),
    loaded_at     TIMESTAMP          DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_arbitrage_balance PRIMARY KEY (pos_date)
);

COMMENT ON TABLE  arbitrage_balance              IS '裁定取引残高(週末の現物ポジション。JPX公表資料の手動取込)';
COMMENT ON COLUMN arbitrage_balance.pos_date     IS '基準日(週末営業日。通常は金曜)';
COMMENT ON COLUMN arbitrage_balance.buy_cur_vol  IS '裁定買残 当限(株)';
COMMENT ON COLUMN arbitrage_balance.buy_cur_val  IS '裁定買残 当限(円)';
COMMENT ON COLUMN arbitrage_balance.buy_nxt_vol  IS '裁定買残 翌限以降(株)';
COMMENT ON COLUMN arbitrage_balance.buy_nxt_val  IS '裁定買残 翌限以降(円)';
COMMENT ON COLUMN arbitrage_balance.buy_tot_vol  IS '裁定買残 合計(株)';
COMMENT ON COLUMN arbitrage_balance.buy_tot_val  IS '裁定買残 合計(円)';
COMMENT ON COLUMN arbitrage_balance.sell_cur_vol IS '裁定売残 当限(株)';
COMMENT ON COLUMN arbitrage_balance.sell_cur_val IS '裁定売残 当限(円)';
COMMENT ON COLUMN arbitrage_balance.sell_nxt_vol IS '裁定売残 翌限以降(株)';
COMMENT ON COLUMN arbitrage_balance.sell_nxt_val IS '裁定売残 翌限以降(円)';
COMMENT ON COLUMN arbitrage_balance.sell_tot_vol IS '裁定売残 合計(株)';
COMMENT ON COLUMN arbitrage_balance.sell_tot_val IS '裁定売残 合計(円)';
COMMENT ON COLUMN arbitrage_balance.src_file     IS '取込元ファイル名(どのExcel由来かを後から追えるようにする)';
COMMENT ON COLUMN arbitrage_balance.loaded_at    IS '取込日時';


--------------------------------------------------------------------------------
-- 2. ARBITRAGE_BALANCE_STG (ステージング)
--
-- 合計(TOT)は持たない。MERGE時に当限+翌限以降から算出する。
-- 「ファイルに合計欄があるのに使わない」のは意図的で、
-- 内訳と合計が食い違うファイルを取り込んでしまう事故を防ぐため。
-- 合計欄で検算したい場合は下の「取込後の確認」を使う。
--------------------------------------------------------------------------------
CREATE TABLE arbitrage_balance_stg (
    pos_date      DATE,
    buy_cur_vol   NUMBER(20),
    buy_cur_val   NUMBER(20,2),
    buy_nxt_vol   NUMBER(20),
    buy_nxt_val   NUMBER(20,2),
    sell_cur_vol  NUMBER(20),
    sell_cur_val  NUMBER(20,2),
    sell_nxt_vol  NUMBER(20),
    sell_nxt_val  NUMBER(20,2),
    src_file      VARCHAR2(200 CHAR)
);

COMMENT ON TABLE arbitrage_balance_stg IS '裁定取引残高のステージング(CSV投入先)';


--------------------------------------------------------------------------------
-- 3. V_ARBITRAGE_BALANCE_WEEKLY (前週比つきの週次ビュー)
--
-- ネット(買残 - 売残)がこのデータの主役。
-- ネットの増加  … 現物買い/先物売りの積み上がり。将来の解消売り圧力が溜まる
-- ネットの減少  … 裁定解消。現物売りが出る(=下押し要因)か、既に出た後
-- 単位は億円に揃えてある(ダッシュボードでそのまま使えるようにするため)。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_arbitrage_balance_weekly AS
SELECT a.pos_date,
       TRUNC(a.pos_date, 'IW')                             AS week_start,
       ROUND(a.buy_tot_val  / 100000000, 1)                AS buy_oku_yen,
       ROUND(a.sell_tot_val / 100000000, 1)                AS sell_oku_yen,
       ROUND((a.buy_tot_val - a.sell_tot_val) / 100000000, 1) AS net_oku_yen,
       ROUND((a.buy_tot_val - a.sell_tot_val
              - LAG(a.buy_tot_val - a.sell_tot_val)
                  OVER (ORDER BY a.pos_date)) / 100000000, 1) AS net_wow_oku_yen,
       a.buy_tot_vol,
       a.sell_tot_vol,
       a.buy_tot_vol - a.sell_tot_vol                      AS net_vol,
       -- 当限の構成比。SQ前にこれが下がるのはロールオーバーであって解消ではない
       ROUND(a.buy_cur_val / NULLIF(a.buy_tot_val, 0) * 100, 1) AS buy_cur_share_pct
FROM arbitrage_balance a;

COMMENT ON TABLE v_arbitrage_balance_weekly IS '裁定取引残高の週次推移(億円換算・前週比つき)';


--------------------------------------------------------------------------------
-- 4. 取込用 MERGE (参考。実体は src/mergeSql.js の mergeArbitrageBalance())
--
-- 通常は node src/loadArbitrage.js が実行するので、ここを手で流す必要はない。
-- CSVを使わず手作業でステージングを埋めた場合の逃げ道として残してある。
--
-- 冪等。同じ pos_date を再投入すると上書きされる。
-- MERGE では行が消えないため、誤って入れた日付を消すときは明示的に DELETE する
-- (タグマスタと同じ注意点。PROJECT.md 8.4)。
--------------------------------------------------------------------------------
-- MERGE INTO arbitrage_balance t
-- USING (
--     SELECT pos_date,
--            buy_cur_vol, buy_cur_val, buy_nxt_vol, buy_nxt_val,
--            NVL(buy_cur_vol, 0) + NVL(buy_nxt_vol, 0)   AS buy_tot_vol,
--            NVL(buy_cur_val, 0) + NVL(buy_nxt_val, 0)   AS buy_tot_val,
--            sell_cur_vol, sell_cur_val, sell_nxt_vol, sell_nxt_val,
--            NVL(sell_cur_vol, 0) + NVL(sell_nxt_vol, 0) AS sell_tot_vol,
--            NVL(sell_cur_val, 0) + NVL(sell_nxt_val, 0) AS sell_tot_val,
--            src_file
--     FROM arbitrage_balance_stg
--     WHERE pos_date IS NOT NULL
-- ) s
-- ON (t.pos_date = s.pos_date)
-- WHEN MATCHED THEN UPDATE SET
--     t.buy_cur_vol  = s.buy_cur_vol,  t.buy_cur_val  = s.buy_cur_val,
--     t.buy_nxt_vol  = s.buy_nxt_vol,  t.buy_nxt_val  = s.buy_nxt_val,
--     t.buy_tot_vol  = s.buy_tot_vol,  t.buy_tot_val  = s.buy_tot_val,
--     t.sell_cur_vol = s.sell_cur_vol, t.sell_cur_val = s.sell_cur_val,
--     t.sell_nxt_vol = s.sell_nxt_vol, t.sell_nxt_val = s.sell_nxt_val,
--     t.sell_tot_vol = s.sell_tot_vol, t.sell_tot_val = s.sell_tot_val,
--     t.src_file     = s.src_file,     t.loaded_at    = SYSTIMESTAMP
-- WHEN NOT MATCHED THEN INSERT (
--     pos_date, buy_cur_vol, buy_cur_val, buy_nxt_vol, buy_nxt_val,
--     buy_tot_vol, buy_tot_val, sell_cur_vol, sell_cur_val,
--     sell_nxt_vol, sell_nxt_val, sell_tot_vol, sell_tot_val, src_file
-- ) VALUES (
--     s.pos_date, s.buy_cur_vol, s.buy_cur_val, s.buy_nxt_vol, s.buy_nxt_val,
--     s.buy_tot_vol, s.buy_tot_val, s.sell_cur_vol, s.sell_cur_val,
--     s.sell_nxt_vol, s.sell_nxt_val, s.sell_tot_vol, s.sell_tot_val, s.src_file
-- );
--
-- COMMIT;
-- TRUNCATE TABLE arbitrage_balance_stg;


--------------------------------------------------------------------------------
-- 5. 取込後の確認
--------------------------------------------------------------------------------
-- 期間と件数
-- SELECT COUNT(*) AS rows_cnt,
--        TO_CHAR(MIN(pos_date), 'YYYY-MM-DD') AS from_date,
--        TO_CHAR(MAX(pos_date), 'YYYY-MM-DD') AS to_date
-- FROM arbitrage_balance;
--
-- 基準日が週末営業日(通常は金曜)になっているかの確認。
-- 祝日の週は木曜になる。それ以外の曜日が出たら取込ミスを疑う。
-- SELECT TO_CHAR(pos_date, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH') AS dow,
--        COUNT(*) AS cnt
-- FROM arbitrage_balance
-- GROUP BY TO_CHAR(pos_date, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH')
-- ORDER BY cnt DESC;
--
-- 週の抜け(祝日でもないのにデータが無い週)を探す
-- SELECT w.week_start
-- FROM (SELECT DISTINCT TRUNC(calendar_date, 'IW') AS week_start
--       FROM trading_calendar
--       WHERE hol_div IN ('1','2')
--         AND calendar_date BETWEEN (SELECT MIN(pos_date) FROM arbitrage_balance)
--                               AND (SELECT MAX(pos_date) FROM arbitrage_balance)) w
-- WHERE NOT EXISTS (SELECT 1 FROM arbitrage_balance a
--                   WHERE TRUNC(a.pos_date, 'IW') = w.week_start)
-- ORDER BY w.week_start;
--
-- 桁がおかしくないかの目視(単位の取り違えはここで気づける)。
-- 裁定買残は概ね数千億〜3兆円規模。億円換算で 1000〜30000 程度に収まるはず。
-- SELECT TO_CHAR(pos_date,'YYYY-MM-DD') AS pos_date,
--        buy_oku_yen, sell_oku_yen, net_oku_yen
-- FROM v_arbitrage_balance_weekly
-- ORDER BY pos_date DESC
-- FETCH FIRST 10 ROWS ONLY;


--------------------------------------------------------------------------------
-- 6. 作り直したいとき(ロールバック)
--
-- 【まず確認すること】
--   このファイルは 2026-09-08 以降、コメントだけを更新している。
--   CREATE TABLE / CREATE OR REPLACE VIEW の中身は初版から変わっていない。
--   したがって「ファイルを更新したから作り直す」必要は無い。
--   ビューだけは CREATE OR REPLACE なので、定義を変えたときは
--   DROP せずにこのファイルの 3 を再実行するだけでよい。
--
-- 作り直しが要るのは、列の追加・型変更など**表の定義そのものを変えたとき**だけ。
--
-- 【実行順序】
--   ビュー → ステージング → 本表 の順。本表を先に落とすとビューが無効になるため。
--   他テーブルからこの2表への外部キーは無いので CASCADE CONSTRAINTS は不要。
--   PURGE を付けてごみ箱に残さない(ATPの表領域を無駄に使わないため)。
--
-- 【データが入っている場合】
--   DROP すると取り込み済みの裁定残は消える。JPXのバックナンバーは
--   直近3〜4年分しか無いため、消すと再取得できない期間が出る可能性がある。
--   投入後にやり直すときは、下の退避を先に実行しておくこと。
--------------------------------------------------------------------------------

-- 退避(データが入っている場合のみ。DROPの前に実行する)
-- CREATE TABLE arbitrage_balance_bk20260908 AS SELECT * FROM arbitrage_balance;
-- SELECT COUNT(*) FROM arbitrage_balance_bk20260908;

-- DROP本体
-- DROP VIEW  v_arbitrage_balance_weekly;
-- DROP TABLE arbitrage_balance_stg PURGE;
-- DROP TABLE arbitrage_balance     PURGE;

-- 消えたことの確認(0件になれば成功)
-- SELECT object_name, object_type
-- FROM   user_objects
-- WHERE  object_name IN ('ARBITRAGE_BALANCE', 'ARBITRAGE_BALANCE_STG',
--                        'V_ARBITRAGE_BALANCE_WEEKLY')
-- ORDER BY object_name;

-- 退避から戻す(作り直した後)
-- INSERT INTO arbitrage_balance SELECT * FROM arbitrage_balance_bk20260908;
-- COMMIT;
-- DROP TABLE arbitrage_balance_bk20260908 PURGE;
