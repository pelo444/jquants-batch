--------------------------------------------------------------------------------
-- 財務情報・日経225オプション四本値関連テーブル (Tier 3)
-- 実行ユーザー: GD_JQUANTS
--
-- 対象データ(いずれもJ-Quants Standardプラン以上、Bulk API(CSV)で取得):
--   1. 財務情報             /fins/summary                         → FINANCIAL_SUMMARY
--   2. 日経225オプション四本値 /derivatives/bars/daily/options/225   → INDEX_OPTION_PRICE_DAILY
--
-- 【実データ未確認であることについて】
--   Tier 1・Tier 2と同じ理由(Claude(Cowork)のdevice_bashからapi.jquants.comへの通信が
--   egressで遮断されている)により、今回もinspect-bulk-csv.jsでの実データ確認ができて
--   いない。本DDL・csvMapper.js・mergeSql.jsはAPI仕様書
--   (/spec/fin-summary, /spec/drv-bars-daily-opt-225)の記載のみに基づいている。
--   ユーザーの手元で以下を必ず実行してから本番投入すること:
--     node scripts/inspect-bulk-csv.js financial-summary options-225 --rows 3
--   ヘッダー名や空欄表現がここでの想定と異なっていた場合は、csvMapper.jsの対応箇所を
--   実データに合わせて修正すること。財務情報は列数が多く(111列)、数値項目が
--   全て文字列型・空文字=未開示(0ではない)で来る前提で設計している
--   (Standardプランでの未取込データ一覧の調査メモを参照)。
--
-- 前提: 01〜04 のDDLを実行済みであること(FINANCIAL_SUMMARYがEQUITY_MASTERへの
--       外部キーを持つため)。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. FINANCIAL_SUMMARY (財務情報)
--
-- 決算短信サマリー。銘柄×開示単位(DiscNo)で1行。
--
-- 【主キーをDISC_NOのみにしている理由】
--   DiscNo(開示番号)はAPI仕様書に「出力されるjsonは開示番号で昇順に並んでいる」と
--   明記されており、開示イベント単位でグローバルに一意な代理キーとして機能する
--   (投資部門別情報や決算発表予定日のような「同一キーで公表日違いの複数行を保持する」
--   方式は不要。訂正が入る場合は新しいDiscNoで別の開示として提供される想定)。
--   CODE列は分析用に保持し、EQUITY_MASTERへの外部キーとインデックスを張る。
--
-- 【会計基準による欠損について】
--   IFRS/米国基準(USGAAP)には経常利益(OdP)の概念が無いため、該当データは空欄。
--   非連結(NC*)項目も、連結決算のみの会社では空欄になる。
--
-- 【MatChgSub等のフラグ列について】
--   'true'/'false'を表す文字列でそのまま返ってくる(0/1のフラグではない)ため、
--   VARCHAR2にそのまま保持し、toFlag()ではなくtoStr()でマッピングする。
--   SigChgInCは2024-07-22以降のレスポンスにのみ収録される(それ以前は空欄)。
--
-- 【列数が多いことについて】
--   API仕様書のデータ項目概要(111列)をそのまま反映している。列名の対応は
--   各列のCOMMENTにAPI側のフィールド名を記載した。
--------------------------------------------------------------------------------
CREATE TABLE financial_summary (
    disc_date            DATE NOT NULL,
    disc_time            VARCHAR2(10 CHAR),
    code                 VARCHAR2(10 CHAR) NOT NULL,
    disc_no              VARCHAR2(20 CHAR) NOT NULL,
    doc_type             VARCHAR2(200 CHAR) NOT NULL,
    cur_per_type         VARCHAR2(4 CHAR) NOT NULL,
    cur_per_st           DATE NOT NULL,
    cur_per_en           DATE NOT NULL,
    cur_fy_st            DATE NOT NULL,
    cur_fy_en            DATE NOT NULL,
    nxt_fy_st            DATE,
    nxt_fy_en            DATE,
    sales                NUMBER(24,6),
    op                   NUMBER(24,6),
    odp                  NUMBER(24,6),
    np                   NUMBER(24,6),
    eps                  NUMBER(24,6),
    deps                 NUMBER(24,6),
    ta                   NUMBER(24,6),
    eq                   NUMBER(24,6),
    eq_ar                NUMBER(24,6),
    bps                  NUMBER(24,6),
    cfo                  NUMBER(24,6),
    cfi                  NUMBER(24,6),
    cff                  NUMBER(24,6),
    cash_eq              NUMBER(24,6),
    div_1q               NUMBER(24,6),
    div_2q               NUMBER(24,6),
    div_3q               NUMBER(24,6),
    div_fy               NUMBER(24,6),
    div_ann              NUMBER(24,6),
    div_unit             NUMBER(24,6),
    div_total_ann        NUMBER(24,6),
    payout_ratio_ann     NUMBER(24,6),
    f_div_1q             NUMBER(24,6),
    f_div_2q             NUMBER(24,6),
    f_div_3q             NUMBER(24,6),
    f_div_fy             NUMBER(24,6),
    f_div_ann            NUMBER(24,6),
    f_div_unit           NUMBER(24,6),
    f_div_total_ann      NUMBER(24,6),
    f_payout_ratio_ann   NUMBER(24,6),
    nxf_div_1q           NUMBER(24,6),
    nxf_div_2q           NUMBER(24,6),
    nxf_div_3q           NUMBER(24,6),
    nxf_div_fy           NUMBER(24,6),
    nxf_div_ann          NUMBER(24,6),
    nxf_div_unit         NUMBER(24,6),
    nxf_payout_ratio_ann NUMBER(24,6),
    f_sales_2q           NUMBER(24,6),
    f_op_2q              NUMBER(24,6),
    f_odp_2q             NUMBER(24,6),
    f_np_2q              NUMBER(24,6),
    f_eps_2q             NUMBER(24,6),
    nxf_sales_2q         NUMBER(24,6),
    nxf_op_2q            NUMBER(24,6),
    nxf_odp_2q           NUMBER(24,6),
    nxf_np_2q            NUMBER(24,6),
    nxf_eps_2q           NUMBER(24,6),
    f_sales              NUMBER(24,6),
    f_op                 NUMBER(24,6),
    f_odp                NUMBER(24,6),
    f_np                 NUMBER(24,6),
    f_eps                NUMBER(24,6),
    nxf_sales            NUMBER(24,6),
    nxf_op               NUMBER(24,6),
    nxf_odp              NUMBER(24,6),
    nxf_np               NUMBER(24,6),
    nxf_eps              NUMBER(24,6),
    mat_chg_sub          VARCHAR2(10 CHAR),
    sig_chg_in_c         VARCHAR2(10 CHAR),
    chg_by_as_rev        VARCHAR2(10 CHAR),
    chg_no_as_rev        VARCHAR2(10 CHAR),
    chg_ac_est           VARCHAR2(10 CHAR),
    retro_rst            VARCHAR2(10 CHAR),
    sh_out_fy            NUMBER(24,6),
    tr_sh_fy             NUMBER(24,6),
    avg_sh               NUMBER(24,6),
    nc_sales             NUMBER(24,6),
    nc_op                NUMBER(24,6),
    nc_odp               NUMBER(24,6),
    nc_np                NUMBER(24,6),
    nc_eps               NUMBER(24,6),
    nc_ta                NUMBER(24,6),
    nc_eq                NUMBER(24,6),
    nc_eq_ar             NUMBER(24,6),
    nc_bps               NUMBER(24,6),
    fnc_sales_2q         NUMBER(24,6),
    fnc_op_2q            NUMBER(24,6),
    fnc_odp_2q           NUMBER(24,6),
    fnc_np_2q            NUMBER(24,6),
    fnc_eps_2q           NUMBER(24,6),
    nxfnc_sales_2q       NUMBER(24,6),
    nxfnc_op_2q          NUMBER(24,6),
    nxfnc_odp_2q         NUMBER(24,6),
    nxfnc_np_2q          NUMBER(24,6),
    nxfnc_eps_2q         NUMBER(24,6),
    fnc_sales            NUMBER(24,6),
    fnc_op               NUMBER(24,6),
    fnc_odp              NUMBER(24,6),
    fnc_np               NUMBER(24,6),
    fnc_eps              NUMBER(24,6),
    nxfnc_sales          NUMBER(24,6),
    nxfnc_op             NUMBER(24,6),
    nxfnc_odp            NUMBER(24,6),
    nxfnc_np             NUMBER(24,6),
    nxfnc_eps            NUMBER(24,6),
    sh_eq                NUMBER(24,6),
    nc_sh_eq             NUMBER(24,6),
    roe                  NUMBER(24,6),
    nc_roe               NUMBER(24,6),
    loaded_at            TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_financial_summary PRIMARY KEY (disc_no),
    CONSTRAINT fk_financial_summary_code FOREIGN KEY (code)
        REFERENCES equity_master (code)
);

COMMENT ON TABLE financial_summary IS '財務情報(決算短信サマリー、開示単位DiscNoで一意)';
COMMENT ON COLUMN financial_summary.disc_date            IS '開示日(DiscDate)';
COMMENT ON COLUMN financial_summary.disc_time            IS '開示時刻(DiscTime)';
COMMENT ON COLUMN financial_summary.code                 IS '銘柄コード(Code)';
COMMENT ON COLUMN financial_summary.disc_no              IS '開示番号(主キー・開示単位で一意)(DiscNo)';
COMMENT ON COLUMN financial_summary.doc_type             IS '開示書類種別(DocType)';
COMMENT ON COLUMN financial_summary.cur_per_type         IS '当会計期間の種類(1Q/2Q/3Q/4Q/5Q/FY)(CurPerType)';
COMMENT ON COLUMN financial_summary.cur_per_st           IS '当会計期間開始日(CurPerSt)';
COMMENT ON COLUMN financial_summary.cur_per_en           IS '当会計期間終了日(CurPerEn)';
COMMENT ON COLUMN financial_summary.cur_fy_st            IS '当事業年度開始日(CurFYSt)';
COMMENT ON COLUMN financial_summary.cur_fy_en            IS '当事業年度終了日(CurFYEn)';
COMMENT ON COLUMN financial_summary.nxt_fy_st            IS '翌事業年度開始日(無い場合NULL)(NxtFYSt)';
COMMENT ON COLUMN financial_summary.nxt_fy_en            IS '翌事業年度終了日(無い場合NULL)(NxtFYEn)';
COMMENT ON COLUMN financial_summary.sales                IS '売上高(Sales)';
COMMENT ON COLUMN financial_summary.op                   IS '営業利益(OP)';
COMMENT ON COLUMN financial_summary.odp                  IS '経常利益(IFRS/米国基準は空欄)(OdP)';
COMMENT ON COLUMN financial_summary.np                   IS '当期純利益(NP)';
COMMENT ON COLUMN financial_summary.eps                  IS '一株あたり当期純利益(EPS)';
COMMENT ON COLUMN financial_summary.deps                 IS '潜在株式調整後一株あたり当期純利益(DEPS)';
COMMENT ON COLUMN financial_summary.ta                   IS '総資産(TA)';
COMMENT ON COLUMN financial_summary.eq                   IS '純資産(Eq)';
COMMENT ON COLUMN financial_summary.eq_ar                IS '自己資本比率(EqAR)';
COMMENT ON COLUMN financial_summary.bps                  IS '一株あたり純資産(BPS)';
COMMENT ON COLUMN financial_summary.cfo                  IS '営業活動によるキャッシュ・フロー(CFO)';
COMMENT ON COLUMN financial_summary.cfi                  IS '投資活動によるキャッシュ・フロー(CFI)';
COMMENT ON COLUMN financial_summary.cff                  IS '財務活動によるキャッシュ・フロー(CFF)';
COMMENT ON COLUMN financial_summary.cash_eq              IS '現金及び現金同等物期末残高(CashEq)';
COMMENT ON COLUMN financial_summary.div_1q               IS '一株あたり配当実績_第1四半期末(Div1Q)';
COMMENT ON COLUMN financial_summary.div_2q               IS '一株あたり配当実績_第2四半期末(Div2Q)';
COMMENT ON COLUMN financial_summary.div_3q               IS '一株あたり配当実績_第3四半期末(Div3Q)';
COMMENT ON COLUMN financial_summary.div_fy               IS '一株あたり配当実績_期末(DivFY)';
COMMENT ON COLUMN financial_summary.div_ann              IS '一株あたり配当実績_合計(DivAnn)';
COMMENT ON COLUMN financial_summary.div_unit             IS '1口当たり分配金(DivUnit)';
COMMENT ON COLUMN financial_summary.div_total_ann        IS '配当金総額(DivTotalAnn)';
COMMENT ON COLUMN financial_summary.payout_ratio_ann     IS '配当性向(PayoutRatioAnn)';
COMMENT ON COLUMN financial_summary.f_div_1q             IS '一株あたり配当予想_第1四半期末(FDiv1Q)';
COMMENT ON COLUMN financial_summary.f_div_2q             IS '一株あたり配当予想_第2四半期末(FDiv2Q)';
COMMENT ON COLUMN financial_summary.f_div_3q             IS '一株あたり配当予想_第3四半期末(FDiv3Q)';
COMMENT ON COLUMN financial_summary.f_div_fy             IS '一株あたり配当予想_期末(FDivFY)';
COMMENT ON COLUMN financial_summary.f_div_ann            IS '一株あたり配当予想_合計(FDivAnn)';
COMMENT ON COLUMN financial_summary.f_div_unit           IS '1口当たり予想分配金(FDivUnit)';
COMMENT ON COLUMN financial_summary.f_div_total_ann      IS '予想配当金総額(FDivTotalAnn)';
COMMENT ON COLUMN financial_summary.f_payout_ratio_ann   IS '予想配当性向(FPayoutRatioAnn)';
COMMENT ON COLUMN financial_summary.nxf_div_1q           IS '一株あたり配当予想_翌事業年度第1四半期末(NxFDiv1Q)';
COMMENT ON COLUMN financial_summary.nxf_div_2q           IS '一株あたり配当予想_翌事業年度第2四半期末(NxFDiv2Q)';
COMMENT ON COLUMN financial_summary.nxf_div_3q           IS '一株あたり配当予想_翌事業年度第3四半期末(NxFDiv3Q)';
COMMENT ON COLUMN financial_summary.nxf_div_fy           IS '一株あたり配当予想_翌事業年度期末(NxFDivFY)';
COMMENT ON COLUMN financial_summary.nxf_div_ann          IS '一株あたり配当予想_翌事業年度合計(NxFDivAnn)';
COMMENT ON COLUMN financial_summary.nxf_div_unit         IS '1口当たり翌事業年度予想分配金(NxFDivUnit)';
COMMENT ON COLUMN financial_summary.nxf_payout_ratio_ann IS '翌事業年度予想配当性向(NxFPayoutRatioAnn)';
COMMENT ON COLUMN financial_summary.f_sales_2q           IS '売上高_予想_第2四半期末(FSales2Q)';
COMMENT ON COLUMN financial_summary.f_op_2q              IS '営業利益_予想_第2四半期末(FOP2Q)';
COMMENT ON COLUMN financial_summary.f_odp_2q             IS '経常利益_予想_第2四半期末(FOdP2Q)';
COMMENT ON COLUMN financial_summary.f_np_2q              IS '当期純利益_予想_第2四半期末(FNP2Q)';
COMMENT ON COLUMN financial_summary.f_eps_2q             IS '一株あたり当期純利益_予想_第2四半期末(FEPS2Q)';
COMMENT ON COLUMN financial_summary.nxf_sales_2q         IS '売上高_予想_翌事業年度第2四半期末(NxFSales2Q)';
COMMENT ON COLUMN financial_summary.nxf_op_2q            IS '営業利益_予想_翌事業年度第2四半期末(NxFOP2Q)';
COMMENT ON COLUMN financial_summary.nxf_odp_2q           IS '経常利益_予想_翌事業年度第2四半期末(NxFOdP2Q)';
COMMENT ON COLUMN financial_summary.nxf_np_2q            IS '当期純利益_予想_翌事業年度第2四半期末(NxFNp2Q)';
COMMENT ON COLUMN financial_summary.nxf_eps_2q           IS '一株あたり当期純利益_予想_翌事業年度第2四半期末(NxFEPS2Q)';
COMMENT ON COLUMN financial_summary.f_sales              IS '売上高_予想_期末(FSales)';
COMMENT ON COLUMN financial_summary.f_op                 IS '営業利益_予想_期末(FOP)';
COMMENT ON COLUMN financial_summary.f_odp                IS '経常利益_予想_期末(FOdP)';
COMMENT ON COLUMN financial_summary.f_np                 IS '当期純利益_予想_期末(FNP)';
COMMENT ON COLUMN financial_summary.f_eps                IS '一株あたり当期純利益_予想_期末(FEPS)';
COMMENT ON COLUMN financial_summary.nxf_sales            IS '売上高_予想_翌事業年度期末(NxFSales)';
COMMENT ON COLUMN financial_summary.nxf_op               IS '営業利益_予想_翌事業年度期末(NxFOP)';
COMMENT ON COLUMN financial_summary.nxf_odp              IS '経常利益_予想_翌事業年度期末(NxFOdP)';
COMMENT ON COLUMN financial_summary.nxf_np               IS '当期純利益_予想_翌事業年度期末(NxFNp)';
COMMENT ON COLUMN financial_summary.nxf_eps              IS '一株あたり当期純利益_予想_翌事業年度期末(NxFEPS)';
COMMENT ON COLUMN financial_summary.mat_chg_sub          IS '期中における重要な子会社の異動(MatChgSub)';
COMMENT ON COLUMN financial_summary.sig_chg_in_c         IS '期中における連結範囲の重要な変更(2024-07-22以降のみ収録)(SigChgInC)';
COMMENT ON COLUMN financial_summary.chg_by_as_rev        IS '会計基準等の改正に伴う会計方針の変更(ChgByASRev)';
COMMENT ON COLUMN financial_summary.chg_no_as_rev        IS '会計基準等の改正に伴う変更以外の会計方針の変更(ChgNoASRev)';
COMMENT ON COLUMN financial_summary.chg_ac_est           IS '会計上の見積りの変更(ChgAcEst)';
COMMENT ON COLUMN financial_summary.retro_rst            IS '修正再表示(RetroRst)';
COMMENT ON COLUMN financial_summary.sh_out_fy            IS '期末発行済株式数(ShOutFY)';
COMMENT ON COLUMN financial_summary.tr_sh_fy             IS '期末自己株式数(TrShFY)';
COMMENT ON COLUMN financial_summary.avg_sh               IS '期中平均株式数(AvgSh)';
COMMENT ON COLUMN financial_summary.nc_sales             IS '売上高_非連結(NCSales)';
COMMENT ON COLUMN financial_summary.nc_op                IS '営業利益_非連結(NCOP)';
COMMENT ON COLUMN financial_summary.nc_odp               IS '経常利益_非連結(NCOdP)';
COMMENT ON COLUMN financial_summary.nc_np                IS '当期純利益_非連結(NCNP)';
COMMENT ON COLUMN financial_summary.nc_eps               IS '一株あたり当期純利益_非連結(NCEPS)';
COMMENT ON COLUMN financial_summary.nc_ta                IS '総資産_非連結(NCTA)';
COMMENT ON COLUMN financial_summary.nc_eq                IS '純資産_非連結(NCEq)';
COMMENT ON COLUMN financial_summary.nc_eq_ar             IS '自己資本比率_非連結(NCEqAR)';
COMMENT ON COLUMN financial_summary.nc_bps               IS '一株あたり純資産_非連結(NCBPS)';
COMMENT ON COLUMN financial_summary.fnc_sales_2q         IS '売上高_予想_第2四半期末_非連結(FNCSales2Q)';
COMMENT ON COLUMN financial_summary.fnc_op_2q            IS '営業利益_予想_第2四半期末_非連結(FNCOP2Q)';
COMMENT ON COLUMN financial_summary.fnc_odp_2q           IS '経常利益_予想_第2四半期末_非連結(FNCOdP2Q)';
COMMENT ON COLUMN financial_summary.fnc_np_2q            IS '当期純利益_予想_第2四半期末_非連結(FNCNP2Q)';
COMMENT ON COLUMN financial_summary.fnc_eps_2q           IS '一株あたり当期純利益_予想_第2四半期末_非連結(FNCEPS2Q)';
COMMENT ON COLUMN financial_summary.nxfnc_sales_2q       IS '売上高_予想_翌事業年度第2四半期末_非連結(NxFNCSales2Q)';
COMMENT ON COLUMN financial_summary.nxfnc_op_2q          IS '営業利益_予想_翌事業年度第2四半期末_非連結(NxFNCOP2Q)';
COMMENT ON COLUMN financial_summary.nxfnc_odp_2q         IS '経常利益_予想_翌事業年度第2四半期末_非連結(NxFNCOdP2Q)';
COMMENT ON COLUMN financial_summary.nxfnc_np_2q          IS '当期純利益_予想_翌事業年度第2四半期末_非連結(NxFNCNP2Q)';
COMMENT ON COLUMN financial_summary.nxfnc_eps_2q         IS '一株あたり当期純利益_予想_翌事業年度第2四半期末_非連結(NxFNCEPS2Q)';
COMMENT ON COLUMN financial_summary.fnc_sales            IS '売上高_予想_期末_非連結(FNCSales)';
COMMENT ON COLUMN financial_summary.fnc_op               IS '営業利益_予想_期末_非連結(FNCOP)';
COMMENT ON COLUMN financial_summary.fnc_odp              IS '経常利益_予想_期末_非連結(FNCOdP)';
COMMENT ON COLUMN financial_summary.fnc_np               IS '当期純利益_予想_期末_非連結(FNCNP)';
COMMENT ON COLUMN financial_summary.fnc_eps              IS '一株あたり当期純利益_予想_期末_非連結(FNCEPS)';
COMMENT ON COLUMN financial_summary.nxfnc_sales          IS '売上高_予想_翌事業年度期末_非連結(NxFNCSales)';
COMMENT ON COLUMN financial_summary.nxfnc_op             IS '営業利益_予想_翌事業年度期末_非連結(NxFNCOP)';
COMMENT ON COLUMN financial_summary.nxfnc_odp            IS '経常利益_予想_翌事業年度期末_非連結(NxFNCOdP)';
COMMENT ON COLUMN financial_summary.nxfnc_np             IS '当期純利益_予想_翌事業年度期末_非連結(NxFNCNP)';
COMMENT ON COLUMN financial_summary.nxfnc_eps            IS '一株あたり当期純利益_予想_翌事業年度期末_非連結(NxFNCEPS)';
COMMENT ON COLUMN financial_summary.sh_eq                IS '自己資本(ShEq)';
COMMENT ON COLUMN financial_summary.nc_sh_eq             IS '自己資本_非連結(NCShEq)';
COMMENT ON COLUMN financial_summary.roe                  IS '自己資本利益率(ROE)';
COMMENT ON COLUMN financial_summary.nc_roe               IS '自己資本利益率_非連結(NCROE)';
COMMENT ON COLUMN financial_summary.loaded_at IS '取込日時';

-- 銘柄単位で時系列を引く分析用
CREATE INDEX ix_financial_summary_code ON financial_summary (code, cur_per_en);
-- 公表日ベースで「直近に開示された財務情報」を追う分析用
CREATE INDEX ix_financial_summary_disc_date ON financial_summary (disc_date);


--------------------------------------------------------------------------------
-- 2. INDEX_OPTION_PRICE_DAILY (日経225オプション四本値)
--
-- 日経225指数オプション(Weekly・フレックスオプションを除く)の日次四本値・
-- 清算値段・理論価格。銘柄への外部キーは無い(オプション銘柄コードは
-- EQUITY_MASTERの株式銘柄コードとは体系が異なる)。
--
-- 【主キーに緊急取引証拠金発動区分(EmMrgnTrgDiv)を含めている理由】
--   API仕様書に明記の通り、緊急取引証拠金が発動した場合は同一取引日・銘柄に対して
--   清算価格算出時(002)と緊急取引証拠金算出時(001)の2行が発生する。
--   (取引日, 銘柄コード, EmMrgnTrgDiv) の組み合わせで一意という仕様書の指示に従う。
--
-- 【EO/EH/EL/EC・Settle等が2016-07-19以降のみという点について】
--   ナイト・セッション四本値(EO/EH/EL/EC。取引開始日初日は空文字)、および
--   Settle/Theo/BaseVol/UnderPx/IV/IRは2016-07-19以降のみ提供される。
--   それ以前の行はNUMBER列がNULLになる想定(toNumRelaxedで空文字→NULL)。
--------------------------------------------------------------------------------
CREATE TABLE index_option_price_daily (
    trade_date         DATE NOT NULL,
    code               VARCHAR2(20 CHAR) NOT NULL,
    o                  NUMBER(24,6),
    h                  NUMBER(24,6),
    l                  NUMBER(24,6),
    c                  NUMBER(24,6),
    eo                 NUMBER(24,6),
    eh                 NUMBER(24,6),
    el                 NUMBER(24,6),
    ec                 NUMBER(24,6),
    ao                 NUMBER(24,6),
    ah                 NUMBER(24,6),
    al                 NUMBER(24,6),
    ac                 NUMBER(24,6),
    vo                 NUMBER(24,6),
    oi                 NUMBER(24,6),
    va                 NUMBER(24,6),
    contract_month     VARCHAR2(7 CHAR),
    strike_price       NUMBER(24,6),
    vo_oa              NUMBER(24,6),
    em_mrgn_trg_div    VARCHAR2(10 CHAR) NOT NULL,
    pc_div             VARCHAR2(10 CHAR),
    last_trading_date  DATE,
    sq_date            DATE,
    settle_price       NUMBER(24,6),
    theoretical_price  NUMBER(24,6),
    base_volatility    NUMBER(24,6),
    underlying_price   NUMBER(24,6),
    implied_volatility NUMBER(24,6),
    interest_rate      NUMBER(24,6),
    loaded_at          TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_index_option_price_daily PRIMARY KEY (trade_date, code, em_mrgn_trg_div)
);

COMMENT ON TABLE index_option_price_daily IS '日経225オプション四本値(日次。緊急取引証拠金発動時は同一日・銘柄で複数行)';
COMMENT ON COLUMN index_option_price_daily.trade_date         IS '取引日(Date)';
COMMENT ON COLUMN index_option_price_daily.code               IS '銘柄コード(オプション銘柄コード)(Code)';
COMMENT ON COLUMN index_option_price_daily.o                  IS '日通し始値(O)';
COMMENT ON COLUMN index_option_price_daily.h                  IS '日通し高値(H)';
COMMENT ON COLUMN index_option_price_daily.l                  IS '日通し安値(L)';
COMMENT ON COLUMN index_option_price_daily.c                  IS '日通し終値(C)';
COMMENT ON COLUMN index_option_price_daily.eo                 IS 'ナイト・セッション始値(初日は空欄)(EO)';
COMMENT ON COLUMN index_option_price_daily.eh                 IS 'ナイト・セッション高値(初日は空欄)(EH)';
COMMENT ON COLUMN index_option_price_daily.el                 IS 'ナイト・セッション安値(初日は空欄)(EL)';
COMMENT ON COLUMN index_option_price_daily.ec                 IS 'ナイト・セッション終値(初日は空欄)(EC)';
COMMENT ON COLUMN index_option_price_daily.ao                 IS '日中始値(AO)';
COMMENT ON COLUMN index_option_price_daily.ah                 IS '日中高値(AH)';
COMMENT ON COLUMN index_option_price_daily.al                 IS '日中安値(AL)';
COMMENT ON COLUMN index_option_price_daily.ac                 IS '日中終値(AC)';
COMMENT ON COLUMN index_option_price_daily.vo                 IS '取引高(Vo)';
COMMENT ON COLUMN index_option_price_daily.oi                 IS '建玉(OI)';
COMMENT ON COLUMN index_option_price_daily.va                 IS '取引代金(Va)';
COMMENT ON COLUMN index_option_price_daily.contract_month     IS '限月(YYYY-MM)(CM)';
COMMENT ON COLUMN index_option_price_daily.strike_price       IS '権利行使価格(Strike)';
COMMENT ON COLUMN index_option_price_daily.vo_oa              IS '立会内取引高(2016-07-19以降のみ)(VoOA)';
COMMENT ON COLUMN index_option_price_daily.em_mrgn_trg_div    IS '緊急取引証拠金発動区分(001=発動時,002=清算価格算出時。主キーの一部)(EmMrgnTrgDiv)';
COMMENT ON COLUMN index_option_price_daily.pc_div             IS 'プットコール区分(1=プット,2=コール)(PCDiv)';
COMMENT ON COLUMN index_option_price_daily.last_trading_date  IS '取引最終年月日(2016-07-19以降のみ)(LTD)';
COMMENT ON COLUMN index_option_price_daily.sq_date            IS 'SQ日(2016-07-19以降のみ)(SQD)';
COMMENT ON COLUMN index_option_price_daily.settle_price       IS '清算値段(2016-07-19以降のみ)(Settle)';
COMMENT ON COLUMN index_option_price_daily.theoretical_price  IS '理論価格(2016-07-19以降のみ)(Theo)';
COMMENT ON COLUMN index_option_price_daily.base_volatility    IS '基準ボラティリティ(2016-07-19以降のみ)(BaseVol)';
COMMENT ON COLUMN index_option_price_daily.underlying_price   IS '原証券価格(2016-07-19以降のみ)(UnderPx)';
COMMENT ON COLUMN index_option_price_daily.implied_volatility IS 'インプライドボラティリティ(2016-07-19以降のみ)(IV)';
COMMENT ON COLUMN index_option_price_daily.interest_rate      IS '理論価格計算用金利(2016-07-19以降のみ)(IR)';
COMMENT ON COLUMN index_option_price_daily.loaded_at IS '取込日時';

-- 銘柄(限月×権利行使価格×プットコール)単位で時系列を引く分析用
CREATE INDEX ix_index_option_price_daily_code ON index_option_price_daily (code, trade_date);


--------------------------------------------------------------------------------
-- 3. ステージングテーブル
--------------------------------------------------------------------------------
CREATE TABLE financial_summary_stg (
    disc_date            DATE NOT NULL,
    disc_time            VARCHAR2(10 CHAR),
    code                 VARCHAR2(10 CHAR) NOT NULL,
    disc_no              VARCHAR2(20 CHAR) NOT NULL,
    doc_type             VARCHAR2(200 CHAR) NOT NULL,
    cur_per_type         VARCHAR2(4 CHAR) NOT NULL,
    cur_per_st           DATE NOT NULL,
    cur_per_en           DATE NOT NULL,
    cur_fy_st            DATE NOT NULL,
    cur_fy_en            DATE NOT NULL,
    nxt_fy_st            DATE,
    nxt_fy_en            DATE,
    sales                NUMBER(24,6),
    op                   NUMBER(24,6),
    odp                  NUMBER(24,6),
    np                   NUMBER(24,6),
    eps                  NUMBER(24,6),
    deps                 NUMBER(24,6),
    ta                   NUMBER(24,6),
    eq                   NUMBER(24,6),
    eq_ar                NUMBER(24,6),
    bps                  NUMBER(24,6),
    cfo                  NUMBER(24,6),
    cfi                  NUMBER(24,6),
    cff                  NUMBER(24,6),
    cash_eq              NUMBER(24,6),
    div_1q               NUMBER(24,6),
    div_2q               NUMBER(24,6),
    div_3q               NUMBER(24,6),
    div_fy               NUMBER(24,6),
    div_ann              NUMBER(24,6),
    div_unit             NUMBER(24,6),
    div_total_ann        NUMBER(24,6),
    payout_ratio_ann     NUMBER(24,6),
    f_div_1q             NUMBER(24,6),
    f_div_2q             NUMBER(24,6),
    f_div_3q             NUMBER(24,6),
    f_div_fy             NUMBER(24,6),
    f_div_ann            NUMBER(24,6),
    f_div_unit           NUMBER(24,6),
    f_div_total_ann      NUMBER(24,6),
    f_payout_ratio_ann   NUMBER(24,6),
    nxf_div_1q           NUMBER(24,6),
    nxf_div_2q           NUMBER(24,6),
    nxf_div_3q           NUMBER(24,6),
    nxf_div_fy           NUMBER(24,6),
    nxf_div_ann          NUMBER(24,6),
    nxf_div_unit         NUMBER(24,6),
    nxf_payout_ratio_ann NUMBER(24,6),
    f_sales_2q           NUMBER(24,6),
    f_op_2q              NUMBER(24,6),
    f_odp_2q             NUMBER(24,6),
    f_np_2q              NUMBER(24,6),
    f_eps_2q             NUMBER(24,6),
    nxf_sales_2q         NUMBER(24,6),
    nxf_op_2q            NUMBER(24,6),
    nxf_odp_2q           NUMBER(24,6),
    nxf_np_2q            NUMBER(24,6),
    nxf_eps_2q           NUMBER(24,6),
    f_sales              NUMBER(24,6),
    f_op                 NUMBER(24,6),
    f_odp                NUMBER(24,6),
    f_np                 NUMBER(24,6),
    f_eps                NUMBER(24,6),
    nxf_sales            NUMBER(24,6),
    nxf_op               NUMBER(24,6),
    nxf_odp              NUMBER(24,6),
    nxf_np               NUMBER(24,6),
    nxf_eps              NUMBER(24,6),
    mat_chg_sub          VARCHAR2(10 CHAR),
    sig_chg_in_c         VARCHAR2(10 CHAR),
    chg_by_as_rev        VARCHAR2(10 CHAR),
    chg_no_as_rev        VARCHAR2(10 CHAR),
    chg_ac_est           VARCHAR2(10 CHAR),
    retro_rst            VARCHAR2(10 CHAR),
    sh_out_fy            NUMBER(24,6),
    tr_sh_fy             NUMBER(24,6),
    avg_sh               NUMBER(24,6),
    nc_sales             NUMBER(24,6),
    nc_op                NUMBER(24,6),
    nc_odp               NUMBER(24,6),
    nc_np                NUMBER(24,6),
    nc_eps               NUMBER(24,6),
    nc_ta                NUMBER(24,6),
    nc_eq                NUMBER(24,6),
    nc_eq_ar             NUMBER(24,6),
    nc_bps               NUMBER(24,6),
    fnc_sales_2q         NUMBER(24,6),
    fnc_op_2q            NUMBER(24,6),
    fnc_odp_2q           NUMBER(24,6),
    fnc_np_2q            NUMBER(24,6),
    fnc_eps_2q           NUMBER(24,6),
    nxfnc_sales_2q       NUMBER(24,6),
    nxfnc_op_2q          NUMBER(24,6),
    nxfnc_odp_2q         NUMBER(24,6),
    nxfnc_np_2q          NUMBER(24,6),
    nxfnc_eps_2q         NUMBER(24,6),
    fnc_sales            NUMBER(24,6),
    fnc_op               NUMBER(24,6),
    fnc_odp              NUMBER(24,6),
    fnc_np               NUMBER(24,6),
    fnc_eps              NUMBER(24,6),
    nxfnc_sales          NUMBER(24,6),
    nxfnc_op             NUMBER(24,6),
    nxfnc_odp            NUMBER(24,6),
    nxfnc_np             NUMBER(24,6),
    nxfnc_eps            NUMBER(24,6),
    sh_eq                NUMBER(24,6),
    nc_sh_eq             NUMBER(24,6),
    roe                  NUMBER(24,6),
    nc_roe               NUMBER(24,6),
    loaded_at            TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE index_option_price_daily_stg (
    trade_date         DATE NOT NULL,
    code               VARCHAR2(20 CHAR) NOT NULL,
    o                  NUMBER(24,6),
    h                  NUMBER(24,6),
    l                  NUMBER(24,6),
    c                  NUMBER(24,6),
    eo                 NUMBER(24,6),
    eh                 NUMBER(24,6),
    el                 NUMBER(24,6),
    ec                 NUMBER(24,6),
    ao                 NUMBER(24,6),
    ah                 NUMBER(24,6),
    al                 NUMBER(24,6),
    ac                 NUMBER(24,6),
    vo                 NUMBER(24,6),
    oi                 NUMBER(24,6),
    va                 NUMBER(24,6),
    contract_month     VARCHAR2(7 CHAR),
    strike_price       NUMBER(24,6),
    vo_oa              NUMBER(24,6),
    em_mrgn_trg_div    VARCHAR2(10 CHAR) NOT NULL,
    pc_div             VARCHAR2(10 CHAR),
    last_trading_date  DATE,
    sq_date            DATE,
    settle_price       NUMBER(24,6),
    theoretical_price  NUMBER(24,6),
    base_volatility    NUMBER(24,6),
    underlying_price   NUMBER(24,6),
    implied_volatility NUMBER(24,6),
    interest_rate      NUMBER(24,6),
    loaded_at          TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE financial_summary_stg        IS '財務情報のステージング';
COMMENT ON TABLE index_option_price_daily_stg IS '日経225オプション四本値のステージング';


--------------------------------------------------------------------------------
-- 4. 分析用ビュー
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 銘柄×決算期(CurPerEn)単位で最後に開示されたレコードのみ
--
-- 同一の決算期について、進捗(3Q→通期)ではなく同一期間の開示が複数回ある場合
-- (訂正等、新しいDiscNoで再提供されるケース)に、DiscNoが最大＝最後に開示された
-- 行だけを返す。通常の「前年同期」「直近4四半期」等の時系列取得には
-- FINANCIAL_SUMMARYを直接、CUR_PER_TYPE等で絞って参照する方が素直な場合が多い。
--------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_financial_summary_latest AS
SELECT *
FROM (
    SELECT f.*,
           ROW_NUMBER() OVER (PARTITION BY f.code, f.cur_per_type, f.cur_per_en
                              ORDER BY f.disc_no DESC) AS rn
    FROM financial_summary f
)
WHERE rn = 1;

COMMENT ON TABLE v_financial_summary_latest IS '財務情報(銘柄×決算期×決算区分ごとに最後に開示された行のみ)';


--------------------------------------------------------------------------------
-- 確認用
--------------------------------------------------------------------------------
-- SELECT table_name FROM user_tables
--  WHERE table_name IN ('FINANCIAL_SUMMARY','INDEX_OPTION_PRICE_DAILY')
--  ORDER BY table_name;
--
-- SELECT endpoint_name, status, COUNT(*) AS files, MAX(finished_at) AS last_finished
-- FROM load_progress
-- WHERE endpoint_name IN ('/fins/summary','/derivatives/bars/daily/options/225')
-- GROUP BY endpoint_name, status
-- ORDER BY endpoint_name, status;
