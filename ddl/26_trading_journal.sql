--------------------------------------------------------------------------------
-- 売買・判断・メモの記録(/journal)
-- 実行ユーザー: 1〜4節は GD_JQUANTS、5節は CLAUDE_RO
--
-- 【何のための表か】
--   これまでの横断面検証では、公開データから機械的に作った銘柄選別ルールに
--   事前基準を満たすものは見つからなかった(claude/*_backtest.md)。
--   市場データは全員の判断が相殺された後の残りで、競争で偏りが消える。
--   一方、自分の判断の癖は誰にも裁定されずに持続するので、少ない標本でも測れる。
--   そのための記録。画面は src/web/public/journal.html、手順は docs/JOURNAL.md。
--
-- 【表の構成】
--   JNL_IMPORT_BATCH      楽天証券CSVの取込単位(同じファイルを2回入れても重複しない)
--   JNL_TRADE             約定(CSV取込)。保有は持たない。ここから計算する(二重管理を避ける)
--   JNL_DECISION          判断の記録。売買と別に、売買のその時に書く。見送りも書く。
--                         **追記のみ**(UPDATE/DELETE はトリガーで拒否)。訂正は新しい行で
--                         SUPERSEDES_ID に元の行を指す。結果を見てから理由を書き換えないため
--   JNL_REVIEW            判断の振り返り(追記のみ)
--   JNL_NOTE              日々のメモ(編集可)
--   JNL_NOTE_IMAGE        手書きメモの写真。画面側で長辺1600pxのJPEGに縮めてから保存する
--                         (再エンコードで位置情報などのEXIFも落ちる)。文字起こしは後から入れる
--   JNL_ACCOUNT_SNAPSHOT  口座全体の評価額・現金・入出金(週1回程度)。投資比率を見るため
--   JNL_DECISION_EVAL_V   判断ごとに、判断時点の値動き(直前20営業日・ボラ・高値からの下落)と
--                         その後20/60営業日のリターン(対TOPIX)を株価から自動で付けるビュー
--
-- 【容量】テキストはほぼゼロ。写真は1枚300KB前後なので、年に数百枚で約100MB。
--
-- 【実行順序】
--   1〜4節を GD_JQUANTS で実行する(トリガーは / で区切ってある。SQL Developer なら
--   「スクリプトの実行(F5)」で流す)。5節は CLAUDE_RO で接続し直して実行する
--   (GD_JQUANTS のままだと ORA-01471。claude_readonly_db_access 参照)。
--
-- 前提: ddl/10 を実行済み(CLAUDE_RO がある)。EQUITY_PRICE_DAILY・TOPIX_PRICE_DAILY がある。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 約定(楽天証券CSV)
--------------------------------------------------------------------------------

CREATE TABLE jnl_import_batch (
    batch_id        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          VARCHAR2(30)        NOT NULL,
    file_name       VARCHAR2(300 CHAR),
    file_sha256     VARCHAR2(64)        NOT NULL,
    encoding        VARCHAR2(20),
    rows_total      NUMBER              NOT NULL,
    rows_inserted   NUMBER              NOT NULL,
    rows_duplicate  NUMBER              NOT NULL,
    imported_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE jnl_import_batch IS '約定CSVの取込単位。同じファイルを再取込しても JNL_TRADE.DEDUP_KEY で重複を弾く';
COMMENT ON COLUMN jnl_import_batch.source IS '取込元。RAKUTEN_JP_STOCK = 楽天証券 国内株式の取引履歴CSV';
COMMENT ON COLUMN jnl_import_batch.file_sha256 IS 'ファイル内容のSHA-256。同じファイルを入れたかどうかの確認用(重複判定は行単位)';

CREATE TABLE jnl_trade (
    trade_id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source           VARCHAR2(30)        NOT NULL,
    batch_id         NUMBER              REFERENCES jnl_import_batch (batch_id),
    dedup_key        VARCHAR2(80)        NOT NULL,
    trade_date       DATE                NOT NULL,
    settle_date      DATE,
    code             VARCHAR2(10)        NOT NULL,
    name             VARCHAR2(200 CHAR),
    market           VARCHAR2(50 CHAR),
    account_type     VARCHAR2(50 CHAR),
    trade_type       VARCHAR2(50 CHAR),
    side_raw         VARCHAR2(20 CHAR),
    side             CHAR(1)             NOT NULL,
    position_kind    VARCHAR2(10)        NOT NULL,
    position_effect  VARCHAR2(10)        NOT NULL,
    margin_type      VARCHAR2(50 CHAR),
    qty              NUMBER              NOT NULL,
    price            NUMBER              NOT NULL,
    fee              NUMBER,
    tax              NUMBER,
    other_cost       NUMBER,
    settle_amount    NUMBER,
    tax_type         VARCHAR2(50 CHAR),
    raw_json         CLOB,
    created_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_trade_dedup_uk UNIQUE (dedup_key),
    CONSTRAINT jnl_trade_side_ck CHECK (side IN ('B', 'S')),
    CONSTRAINT jnl_trade_kind_ck CHECK (position_kind IN ('CASH', 'MLONG', 'MSHORT')),
    CONSTRAINT jnl_trade_effect_ck CHECK (position_effect IN ('OPEN', 'CLOSE', 'CONVERT', 'DEPOSIT', 'WITHDRAW')),
    CONSTRAINT jnl_trade_raw_ck CHECK (raw_json IS JSON)
);

CREATE INDEX jnl_trade_code_ix ON jnl_trade (code, trade_date);

COMMENT ON TABLE jnl_trade IS '約定。保有はここから計算する(保有の表は持たない)';
COMMENT ON COLUMN jnl_trade.dedup_key IS '行の内容のハッシュ + ファイル内で同一内容の何件目か。期間が重なるCSVを入れても重複しない';
COMMENT ON COLUMN jnl_trade.code IS '5桁コード(4桁は末尾に0を付けてJ-Quantsと揃える)';
COMMENT ON COLUMN jnl_trade.side IS 'B=買(買付・買建・買埋・現引)、S=売(売付・売建・売埋・現渡)';
COMMENT ON COLUMN jnl_trade.position_kind IS 'CASH=現物、MLONG=信用買建玉、MSHORT=信用売建玉。現引・現渡は信用側の行として記録する';
COMMENT ON COLUMN jnl_trade.position_effect IS 'OPEN=増える(現物の買い・信用新規)、CLOSE=減る(現物の売り・信用返済)、CONVERT=現引/現渡(信用の建玉が閉じて現物が増減する)、DEPOSIT/WITHDRAW=入庫/出庫。楽天は株式分割で増えた株も入庫で記録する(保有計算でDBの分割日と突き合わせ、分割なら取得費0として扱う)';
COMMENT ON COLUMN jnl_trade.settle_amount IS 'CSVの受渡金額(円)。現物は手数料・税込みの受渡額、信用返済は決済損益。符号はCSVのまま';
COMMENT ON COLUMN jnl_trade.raw_json IS 'CSVの1行をそのままJSONで保存(列名→値)。解釈を後で直せるように';


--------------------------------------------------------------------------------
-- 2. 判断と振り返り(追記のみ)
--------------------------------------------------------------------------------

CREATE TABLE jnl_decision (
    decision_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_date     DATE                NOT NULL,
    code              VARCHAR2(10)        NOT NULL,
    action            VARCHAR2(10)        NOT NULL,
    reason_cat        VARCHAR2(20)        NOT NULL,
    reason_text       VARCHAR2(4000 CHAR) NOT NULL,
    idea_source       VARCHAR2(20),
    expect_ret_pct    NUMBER,
    horizon_weeks     NUMBER,
    invalidation      VARCHAR2(1000 CHAR),
    confidence        NUMBER(1),
    planned_stop_pct  NUMBER,
    size_note         VARCHAR2(500 CHAR),
    emotion           VARCHAR2(200 CHAR),
    supersedes_id     NUMBER              REFERENCES jnl_decision (decision_id),
    created_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_decision_action_ck CHECK (action IN ('BUY', 'ADD', 'TRIM', 'SELL', 'PASS', 'HOLD')),
    CONSTRAINT jnl_decision_reason_ck CHECK (reason_cat IN (
        'EARNINGS', 'DIP', 'MOMENTUM', 'NEWS', 'THEME', 'VALUE', 'DIVIDEND',
        'RECOMMEND', 'REBALANCE', 'STOPLOSS', 'TAKEPROFIT', 'OTHER')),
    CONSTRAINT jnl_decision_source_ck CHECK (idea_source IN (
        'OWN_SCREEN', 'NEWS', 'SNS', 'DISCLOSURE', 'MEDIA', 'PERSON', 'APP', 'OTHER')),
    CONSTRAINT jnl_decision_conf_ck CHECK (confidence BETWEEN 1 AND 5)
);

CREATE INDEX jnl_decision_code_ix ON jnl_decision (code, decision_date);

COMMENT ON TABLE jnl_decision IS '判断の記録。追記のみ(トリガーでUPDATE/DELETEを拒否)。見送り(PASS)も書く';
COMMENT ON COLUMN jnl_decision.decision_date IS '判断した日(画面の入力)。CREATED_AT との差が1日を超える行は後から書いた記録として評価ビューで印を付ける';
COMMENT ON COLUMN jnl_decision.action IS 'BUY=新規買い、ADD=買い増し、TRIM=一部売り、SELL=全部売り、PASS=見送り(買わなかった)、HOLD=売らずに持つと決めた';
COMMENT ON COLUMN jnl_decision.invalidation IS '何が起きたら間違いと認めるか(判断の時点で書く)';
COMMENT ON COLUMN jnl_decision.confidence IS '確信度 1〜5';
COMMENT ON COLUMN jnl_decision.emotion IS '判断時の状態のタグ(カンマ区切り)。例: 焦り,取り残される不安,自信,迷い';
COMMENT ON COLUMN jnl_decision.supersedes_id IS '訂正のとき、訂正前の行。元の行は残る';

CREATE TABLE jnl_review (
    review_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_id     NUMBER              NOT NULL REFERENCES jnl_decision (decision_id),
    review_date     DATE                NOT NULL,
    outcome_note    VARCHAR2(4000 CHAR),
    reason_verdict  VARCHAR2(10)        NOT NULL,
    lesson          VARCHAR2(2000 CHAR),
    created_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_review_verdict_ck CHECK (reason_verdict IN ('RIGHT', 'PARTLY', 'WRONG', 'UNKNOWN'))
);

CREATE INDEX jnl_review_decision_ix ON jnl_review (decision_id);

COMMENT ON TABLE jnl_review IS '判断の振り返り。追記のみ。1つの判断に何度でも書ける';
COMMENT ON COLUMN jnl_review.reason_verdict IS '理由そのものは当たっていたか(値動きの結果とは分ける)。RIGHT/PARTLY/WRONG/UNKNOWN';

CREATE OR REPLACE TRIGGER jnl_decision_append_only
BEFORE UPDATE OR DELETE ON jnl_decision
BEGIN
    RAISE_APPLICATION_ERROR(-20001,
        'JNL_DECISION は追記のみです。訂正は新しい行を入れて SUPERSEDES_ID で元の行を指してください');
END;
/

CREATE OR REPLACE TRIGGER jnl_review_append_only
BEFORE UPDATE OR DELETE ON jnl_review
BEGIN
    RAISE_APPLICATION_ERROR(-20002, 'JNL_REVIEW は追記のみです。追加の振り返りを新しい行で書いてください');
END;
/


--------------------------------------------------------------------------------
-- 3. メモ・写真・口座
--------------------------------------------------------------------------------

CREATE TABLE jnl_note (
    note_id      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    note_date    DATE                NOT NULL,
    body         CLOB,
    codes        VARCHAR2(400),
    idea_source  VARCHAR2(20),
    created_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT jnl_note_source_ck CHECK (idea_source IN (
        'OWN_SCREEN', 'NEWS', 'SNS', 'DISCLOSURE', 'MEDIA', 'PERSON', 'APP', 'OTHER'))
);

CREATE INDEX jnl_note_date_ix ON jnl_note (note_date);

COMMENT ON TABLE jnl_note IS '日々のメモ。判断と違い編集できる';
COMMENT ON COLUMN jnl_note.codes IS '関連銘柄の5桁コード(カンマ区切り)';

CREATE TABLE jnl_note_image (
    image_id        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    note_id         NUMBER              NOT NULL REFERENCES jnl_note (note_id) ON DELETE CASCADE,
    file_name       VARCHAR2(300 CHAR),
    mime            VARCHAR2(50)        NOT NULL,
    byte_size       NUMBER              NOT NULL,
    width           NUMBER,
    height          NUMBER,
    image           BLOB                NOT NULL,
    transcription   CLOB,
    transcribed_at  TIMESTAMP,
    created_at      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX jnl_note_image_note_ix ON jnl_note_image (note_id);

COMMENT ON TABLE jnl_note_image IS '手書きメモの写真(長辺1600pxのJPEGに縮めて保存)。文字起こしは後から入れる';
COMMENT ON COLUMN jnl_note_image.transcription IS '文字起こし。NULL = 未着手';

CREATE TABLE jnl_account_snapshot (
    snap_date        DATE PRIMARY KEY,
    cash_yen         NUMBER,
    stock_value_yen  NUMBER,
    deposit_yen      NUMBER DEFAULT 0 NOT NULL,
    withdrawal_yen   NUMBER DEFAULT 0 NOT NULL,
    note             VARCHAR2(1000 CHAR),
    created_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE jnl_account_snapshot IS '口座全体の評価額と現金(週1回程度)。投資比率 = 株式評価額 ÷ (株式評価額 + 現金)';
COMMENT ON COLUMN jnl_account_snapshot.deposit_yen IS '前回のスナップショットからこの日までの入金。運用成績から入出金を除くため';


--------------------------------------------------------------------------------
-- 4. 判断の評価ビュー
--
--   基準日 BASE_DATE = 判断日以前で最後に終値がある営業日。その終値が基準。
--   判断前: VOL_20D_PCT = 直前20営業日の日次リターンの標準偏差(%)、
--           RET_20D_PRE_PCT = 直前20営業日のリターン、DD_250D_PCT = 250営業日高値からの下落、
--           TURNOVER_20D_OKU = 直前20営業日の平均売買代金(億円/日)
--   判断後: 20営業日後・60営業日後(約4週・13週)のリターンと、同じ日付の TOPIX、その差 EXR。
--           まだその日が来ていなければ NULL。
--   すべて分割調整済み(AdjFactor の累積積)。生の値動きなので、業種や規模は揃えていない
--   (検証の EXR_IS とは物差しが違う。粗い目安として使う)。
--   PASS(見送り)も同じ物差しで測れる。「見送った銘柄のほうが上がった」かどうかが分かる。
--------------------------------------------------------------------------------

CREATE OR REPLACE VIEW jnl_decision_eval_v AS
SELECT d.decision_id, d.decision_date, d.code, d.action, d.reason_cat, d.idea_source,
       d.confidence, d.expect_ret_pct, d.horizon_weeks, d.planned_stop_pct, d.emotion,
       d.supersedes_id, d.created_at,
       CASE WHEN CAST(d.created_at AS DATE) - d.decision_date > 1 THEN 'Y' ELSE 'N' END AS late_entry,
       CASE WHEN EXISTS (SELECT 1 FROM jnl_decision s WHERE s.supersedes_id = d.decision_id)
            THEN 'Y' ELSE 'N' END AS is_superseded,
       b.d0 AS base_date,
       b.c0 AS base_close,
       ROUND(pre.vol20, 3) AS vol_20d_pct,
       ROUND((b.c0 / pre.c20 - 1) * 100, 2) AS ret_20d_pre_pct,
       ROUND((b.c0 / pre.hi250 - 1) * 100, 2) AS dd_250d_pct,
       ROUND(pre.to20, 2) AS turnover_20d_oku,
       f20.d1 AS date_20d,
       ROUND((f20.c1 / (b.c0 * NVL(a20.f, 1)) - 1) * 100, 2) AS ret_20d_pct,
       ROUND((t20.c / tb.c - 1) * 100, 2) AS topix_20d_pct,
       ROUND(((f20.c1 / (b.c0 * NVL(a20.f, 1))) - (t20.c / tb.c)) * 100, 2) AS exr_20d_pct,
       f60.d1 AS date_60d,
       ROUND((f60.c1 / (b.c0 * NVL(a60.f, 1)) - 1) * 100, 2) AS ret_60d_pct,
       ROUND((t60.c / tb.c - 1) * 100, 2) AS topix_60d_pct,
       ROUND(((f60.c1 / (b.c0 * NVL(a60.f, 1))) - (t60.c / tb.c)) * 100, 2) AS exr_60d_pct
FROM jnl_decision d
OUTER APPLY (
    SELECT p.price_date AS d0, p.close_price AS c0
    FROM equity_price_daily p
    WHERE p.code = d.code AND p.price_date <= d.decision_date AND p.close_price IS NOT NULL
    ORDER BY p.price_date DESC FETCH FIRST 1 ROWS ONLY) b
OUTER APPLY (
    SELECT x.price_date AS d1, x.close_price AS c1
    FROM equity_price_daily x
    WHERE x.code = d.code AND x.price_date > b.d0 AND x.close_price IS NOT NULL
    ORDER BY x.price_date OFFSET 19 ROWS FETCH NEXT 1 ROWS ONLY) f20
OUTER APPLY (
    SELECT x.price_date AS d1, x.close_price AS c1
    FROM equity_price_daily x
    WHERE x.code = d.code AND x.price_date > b.d0 AND x.close_price IS NOT NULL
    ORDER BY x.price_date OFFSET 59 ROWS FETCH NEXT 1 ROWS ONLY) f60
OUTER APPLY (
    SELECT EXP(SUM(LN(NVL(y.adj_factor, 1)))) AS f
    FROM equity_price_daily y
    WHERE y.code = d.code AND y.price_date > b.d0 AND y.price_date <= f20.d1) a20
OUTER APPLY (
    SELECT EXP(SUM(LN(NVL(y.adj_factor, 1)))) AS f
    FROM equity_price_daily y
    WHERE y.code = d.code AND y.price_date > b.d0 AND y.price_date <= f60.d1) a60
OUTER APPLY (SELECT t.close_price AS c FROM topix_price_daily t WHERE t.price_date = b.d0) tb
OUTER APPLY (SELECT t.close_price AS c FROM topix_price_daily t WHERE t.price_date = f20.d1) t20
OUTER APPLY (SELECT t.close_price AS c FROM topix_price_daily t WHERE t.price_date = f60.d1) t60
OUTER APPLY (
    SELECT STDDEV(CASE WHEN rn <= 20 THEN r END) * 100 AS vol20,
           MAX(CASE WHEN rn = 21 THEN adjc END) AS c20,
           MAX(adjc) AS hi250,
           AVG(CASE WHEN rn <= 20 THEN tv END) / 1e8 AS to20
    FROM (
        SELECT ROW_NUMBER() OVER (ORDER BY q.price_date DESC) AS rn,
               q.turnover_value AS tv,
               q.close_price * EXP(NVL(SUM(LN(NVL(q.adj_factor, 1))) OVER (
                   ORDER BY q.price_date DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)) AS adjc,
               q.close_price / (LAG(q.close_price) OVER (ORDER BY q.price_date) * NVL(q.adj_factor, 1)) - 1 AS r
        FROM (
            SELECT z.price_date, z.close_price, z.adj_factor, z.turnover_value
            FROM equity_price_daily z
            WHERE z.code = d.code AND z.price_date <= b.d0 AND z.close_price IS NOT NULL
            ORDER BY z.price_date DESC FETCH FIRST 251 ROWS ONLY) q)) pre;

COMMENT ON TABLE jnl_decision_eval_v IS '判断ごとの判断前の値動きと、その後20/60営業日のリターン(対TOPIX)。分割調整済み・業種規模は未調整';


--------------------------------------------------------------------------------
-- 4b. CLAUDE_RO への権限(GD_JQUANTS で実行)
--   写真の本体(JNL_NOTE_IMAGE)は分析に不要なので付与しない。
--   文字起こしは JNL_NOTE_IMAGE_TEXT_V で見せる。
--------------------------------------------------------------------------------

CREATE OR REPLACE VIEW jnl_note_image_text_v AS
SELECT image_id, note_id, file_name, byte_size, width, height, transcription, transcribed_at, created_at
FROM jnl_note_image;

GRANT SELECT ON jnl_import_batch      TO claude_ro;
GRANT SELECT ON jnl_trade             TO claude_ro;
GRANT SELECT ON jnl_decision          TO claude_ro;
GRANT SELECT ON jnl_review            TO claude_ro;
GRANT SELECT ON jnl_note              TO claude_ro;
GRANT SELECT ON jnl_note_image_text_v TO claude_ro;
GRANT SELECT ON jnl_account_snapshot  TO claude_ro;
GRANT SELECT ON jnl_decision_eval_v   TO claude_ro;


--------------------------------------------------------------------------------
-- 5. シノニム(CLAUDE_RO で接続し直して実行)
--   先に SELECT USER FROM dual; で CLAUDE_RO であることを確認する
--------------------------------------------------------------------------------

-- SELECT USER FROM dual;

CREATE OR REPLACE SYNONYM jnl_import_batch      FOR gd_jquants.jnl_import_batch;
CREATE OR REPLACE SYNONYM jnl_trade             FOR gd_jquants.jnl_trade;
CREATE OR REPLACE SYNONYM jnl_decision          FOR gd_jquants.jnl_decision;
CREATE OR REPLACE SYNONYM jnl_review            FOR gd_jquants.jnl_review;
CREATE OR REPLACE SYNONYM jnl_note              FOR gd_jquants.jnl_note;
CREATE OR REPLACE SYNONYM jnl_note_image_text_v FOR gd_jquants.jnl_note_image_text_v;
CREATE OR REPLACE SYNONYM jnl_account_snapshot  FOR gd_jquants.jnl_account_snapshot;
CREATE OR REPLACE SYNONYM jnl_decision_eval_v   FOR gd_jquants.jnl_decision_eval_v;
