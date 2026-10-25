--------------------------------------------------------------------------------
-- 材料(/events)のカレンダーの表
-- 実行ユーザー: 1〜2節は GD_JQUANTS、3節は CLAUDE_RO
--
-- 【何のための表か】
--   縦長の月間カレンダーに、米国の金利・原油・ドル円・社債利回り・CPI の数字を並べ、
--   右の備考欄に紛争(イラン・ロシア)の英語の見出しと、半導体関連6社の決算(SEC の提出書類と見出し)を出す。
--   外のデータを毎日1回 src/loadEventCalendar.js で取り込む(Mac で実行)。
--
-- 【日付】
--   数字・見出し・決算はすべて米国の日付(現地の日付)。国内の営業日にずらさない。
--
-- 設計: Project 文書 claude/event_calendar_design.md
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. 表(GD_JQUANTS)
--------------------------------------------------------------------------------

-- 日ごとの数字(1系列1日1行)。系列の一覧は src/loadEventCalendar.js の SERIES
CREATE TABLE ext_series_daily (
    series_code VARCHAR2(40) NOT NULL,
    obs_date    DATE         NOT NULL,
    value       NUMBER,
    loaded_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT ext_series_daily_pk PRIMARY KEY (series_code, obs_date)
);

COMMENT ON TABLE ext_series_daily IS '材料(/events)の日ごとの数字。FRED・Yahoo・FINRA から取得';
COMMENT ON COLUMN ext_series_daily.series_code IS '系列。例 DGS10(米10年金利)、CL=F(WTI先物)、CRWV_975_2031(コアウィーブ 9.75% 2031年債の利回り)';
COMMENT ON COLUMN ext_series_daily.obs_date IS '米国の日付。CPI(CPIAUCSL)は対象月の1日';
COMMENT ON COLUMN ext_series_daily.value IS '値。金利・利回りは%、原油はドル、ドル円は円、CPIは指数';

-- 統計の発表日(今は CPI だけ)
CREATE TABLE ext_release_date (
    series_code  VARCHAR2(40) NOT NULL,
    release_date DATE         NOT NULL,
    ref_period   DATE         NOT NULL,
    loaded_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT ext_release_date_pk PRIMARY KEY (series_code, release_date)
);

COMMENT ON TABLE ext_release_date IS '統計の発表日。ALFRED の版の日付から取る';
COMMENT ON COLUMN ext_release_date.ref_period IS '発表された対象月の1日(発表月の前の月)';

-- ニュースの見出し(1話題1日最大2件)
CREATE TABLE news_headline (
    topic       VARCHAR2(40)   NOT NULL,
    news_date   DATE           NOT NULL,
    rank_no     NUMBER(2)      NOT NULL,
    title       VARCHAR2(1000) NOT NULL,
    source_name VARCHAR2(200),
    url         VARCHAR2(2000),
    loaded_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT news_headline_pk PRIMARY KEY (topic, news_date, rank_no)
);

COMMENT ON TABLE news_headline IS '材料(/events)の備考欄の見出し。Google ニュースの RSS で取った英語の見出しのうち、決めた出どころの上位';
COMMENT ON COLUMN news_headline.topic IS 'iran / russia / earn:MU のような話題';
COMMENT ON COLUMN news_headline.news_date IS '記事の日付(RSS の pubDate、グリニッジ標準時の日付)';
COMMENT ON COLUMN news_headline.rank_no IS 'Google の並びで、決めた出どころの中の何番目か(1から)';

-- 見出しを取りに行った記録。行が無い日は「まだ取っていない」、ITEM_COUNT=0 は「取ったが該当なし」
CREATE TABLE news_fetch_log (
    topic      VARCHAR2(40) NOT NULL,
    news_date  DATE         NOT NULL,
    item_count NUMBER(4)    NOT NULL,
    fetched_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT news_fetch_log_pk PRIMARY KEY (topic, news_date)
);

COMMENT ON TABLE news_fetch_log IS '見出しを取りに行った記録(話題×日)。取り直さないために使う';
COMMENT ON COLUMN news_fetch_log.item_count IS '決めた出どころの見出しで、その日の日付のものの数(保存は上位2件まで)';

-- 決算発表の提出書類(SEC EDGAR)
CREATE TABLE earnings_filing (
    ticker        VARCHAR2(10)  NOT NULL,
    accession_no  VARCHAR2(30)  NOT NULL,
    filing_date   DATE          NOT NULL,
    form_type     VARCHAR2(10)  NOT NULL,
    items         VARCHAR2(100),
    acceptance_at VARCHAR2(30),
    doc_url       VARCHAR2(500),
    loaded_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT earnings_filing_pk PRIMARY KEY (ticker, accession_no)
);

CREATE INDEX earnings_filing_date_ix ON earnings_filing (filing_date);

COMMENT ON TABLE earnings_filing IS '決算発表の提出書類。8-K は項目 2.02 を含むもの、TSMC は決算の 6-K';
COMMENT ON COLUMN earnings_filing.filing_date IS 'SEC の提出日(米国の日付)';
COMMENT ON COLUMN earnings_filing.acceptance_at IS 'SEC の受付日時(EDGAR の acceptanceDateTime をそのまま)';

--------------------------------------------------------------------------------
-- 2. CLAUDE_RO への権限(GD_JQUANTS)
--------------------------------------------------------------------------------
GRANT SELECT ON ext_series_daily TO claude_ro;
GRANT SELECT ON ext_release_date TO claude_ro;
GRANT SELECT ON news_headline TO claude_ro;
GRANT SELECT ON news_fetch_log TO claude_ro;
GRANT SELECT ON earnings_filing TO claude_ro;

--------------------------------------------------------------------------------
-- 3. シノニム(CLAUDE_RO で接続し直して実行。先に SELECT USER FROM dual;)
--------------------------------------------------------------------------------
-- SELECT USER FROM dual;
CREATE OR REPLACE SYNONYM ext_series_daily FOR gd_jquants.ext_series_daily;
CREATE OR REPLACE SYNONYM ext_release_date FOR gd_jquants.ext_release_date;
CREATE OR REPLACE SYNONYM news_headline FOR gd_jquants.news_headline;
CREATE OR REPLACE SYNONYM news_fetch_log FOR gd_jquants.news_fetch_log;
CREATE OR REPLACE SYNONYM earnings_filing FOR gd_jquants.earnings_filing;
