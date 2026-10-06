--------------------------------------------------------------------------------
-- xs_weekly_panel / xs_long_panel の列コメント
-- 実行ユーザー: GD_JQUANTS(両表の所有者)
--
-- 両表は CTAS で作るスナップショットなので、列コメントは作り直すたびに消える。
-- DROP TABLE ... PURGE して ddl/20・22 を流し直したら、このファイルも流し直すこと。
-- 何度流しても結果は同じ(COMMENT は上書き)。CLAUDE_RO からは describe_object で見える。
--
-- 単位の約束: 割合は 0.01 = 1%(MBR・MSR・SI_RATIO・DMBR_4W・LCHG_4W)。
--             リターン・相対リターンは % そのまま(1.5 = +1.5%)。
--------------------------------------------------------------------------------

-- ===== xs_weekly_panel(ddl/20)=====
COMMENT ON COLUMN xs_weekly_panel.week_start     IS '週の起点(月曜)。行の時点。情報はこの週の最終営業日の終値時点で知り得たものだけ';
COMMENT ON COLUMN xs_weekly_panel.wk_idx         IS '営業日のある週の通し番号。h週先は wk_idx+h。重ならない標本は MOD(wk_idx,4)=0 や MOD(wk_idx,13)=0';
COMMENT ON COLUMN xs_weekly_panel.last_bd        IS 'その週の最終営業日(起点の終値の日)';
COMMENT ON COLUMN xs_weekly_panel.code           IS '銘柄コード(5桁。EQUITY_MASTER.CODE)';
COMMENT ON COLUMN xs_weekly_panel.sector17_code  IS '17業種コード(EQUITY_MASTER の現在値。時点の業種ではない)。EXR_IS の比較単位';
COMMENT ON COLUMN xs_weekly_panel.sector33_code  IS '33業種コード(現在値)。EXR_IND の比較単位';
COMMENT ON COLUMN xs_weekly_panel.sector33_name  IS '33業種名(現在値)';
COMMENT ON COLUMN xs_weekly_panel.market_name    IS '市場区分名(現在値。2022年4月の再編前の旧市場名と混在)';
COMMENT ON COLUMN xs_weekly_panel.delisted_flag  IS '上場廃止フラグ(Y/N)。廃止銘柄も最後の終値まで残してある(生存者バイアス対策)';
COMMENT ON COLUMN xs_weekly_panel.close_px       IS '週末終値(円、分割調整前の素の値)。信用残・時価総額と同じ単位系で使う';
COMMENT ON COLUMN xs_weekly_panel.adj_close      IS '分割調整後の終値(=CLOSE_PX×累積調整係数)。リターン・モメンタムはこれで測る';
COMMENT ON COLUMN xs_weekly_panel.mcap_oku       IS '時価総額(億円、0.1億円単位)。終値×発行済株式数(財務の期末値を分割で補正)。財務が無い週は NULL';
COMMENT ON COLUMN xs_weekly_panel.pbr            IS 'PBR(倍)=時価総額÷純資産。最新の開示(開示日<最終営業日)を使用';
COMMENT ON COLUMN xs_weekly_panel.mom_26w        IS '過去26週の調整後リターン(%)。26週前の行が無ければ NULL';
COMMENT ON COLUMN xs_weekly_panel.avg_vol_4w     IS '直近4週の1日平均出来高(株)。4週の窓内に分割があれば NULL';
COMMENT ON COLUMN xs_weekly_panel.si_covered     IS '空売り残高報告の取得期間が十分か(Y/N)。N の週は SI_RATIO の NULL が「報告なし」と言えない';
COMMENT ON COLUMN xs_weekly_panel.si_ratio       IS '空売り残高割合の合計(割合、0.005=0.5%)。機関のみ(個人除く)、報告者ごとの最新を積み上げ、180日で失効。NULL=0.5%以上の報告者なし(空売りゼロではない)';
COMMENT ON COLUMN xs_weekly_panel.si_rpt_cnt     IS 'SI_RATIO に入った有効な報告(報告者)の数';
COMMENT ON COLUMN xs_weekly_panel.si_oldest_calc IS 'SI_RATIO に入った報告のうち最も古い計算日(古い報告が居座っていないかの確認用)';
COMMENT ON COLUMN xs_weekly_panel.mgn_app_date   IS '使った信用取引残高の申込日(前週分。USE_WEEK=申込週+7)。公表の遅れを考慮し、その週に使えるのは前週分まで';
COMMENT ON COLUMN xs_weekly_panel.shrt_vol       IS '信用売残(株、申込日時点。分割の遡及調整なし)';
COMMENT ON COLUMN xs_weekly_panel.long_vol       IS '信用買残(株、申込日時点。分割の遡及調整なし)';
COMMENT ON COLUMN xs_weekly_panel.msr            IS '信用売残÷申込週時点の発行済株式数(割合、0.01=1%)';
COMMENT ON COLUMN xs_weekly_panel.dtc            IS '信用売残÷直近4週の1日平均出来高(日数)。売残を出来高で買い戻すのに要る日数。AVG_VOL_4W が NULL なら NULL';
COMMENT ON COLUMN xs_weekly_panel.fwd_ret_4w     IS '4週先までの最後の終値へのリターン(%、調整後)。廃止で途切れたら最後の終値まで。直近の週は NULL';
COMMENT ON COLUMN xs_weekly_panel.fwd_ret_13w    IS '13週先までの最後の終値へのリターン(%、調整後)。廃止で途切れたら最後の終値まで。直近の週は NULL';
COMMENT ON COLUMN xs_weekly_panel.delist_4w      IS '4週先までに上場廃止で途切れたら Y(清算価値が無いので倒産銘柄の損失は過小)';
COMMENT ON COLUMN xs_weekly_panel.delist_13w     IS '13週先までに上場廃止で途切れたら Y';
COMMENT ON COLUMN xs_weekly_panel.size_q         IS '時価総額の週内5分位(1=小型、5=大型)。その週の横断面の順位';
COMMENT ON COLUMN xs_weekly_panel.pbr_q          IS 'PBRの週内3分位(1=低PBR、3=高PBR)';
COMMENT ON COLUMN xs_weekly_panel.mom_q          IS '過去26週リターンの週内3分位(1=最も弱い、3=最も強い)';
COMMENT ON COLUMN xs_weekly_panel.exr_ind_4w     IS '4週先の相対リターン(%)=自分−同じ週・同じ33業種の等ウェイト平均。比較相手が5銘柄未満なら NULL';
COMMENT ON COLUMN xs_weekly_panel.exr_ind_13w    IS '13週先の相対リターン(%)=自分−同じ週・同じ33業種の等ウェイト平均';
COMMENT ON COLUMN xs_weekly_panel.exr_is_4w      IS '4週先の相対リターン(%)=自分−同じ週・同じ17業種×同じ時価総額5分位の等ウェイト平均。検証の主指標';
COMMENT ON COLUMN xs_weekly_panel.exr_is_13w     IS '13週先の相対リターン(%)=自分−同じ週・同じ17業種×同じ時価総額5分位の等ウェイト平均。検証の主指標';
COMMENT ON COLUMN xs_weekly_panel.peers_ind_13w  IS 'EXR_IND_13W の比較相手の数(同週・同33業種で13週先リターンがある銘柄数)';
COMMENT ON COLUMN xs_weekly_panel.peers_is_13w   IS 'EXR_IS_13W の比較相手の数(同週・同17業種×同規模で13週先リターンがある銘柄数)';

-- ===== xs_long_panel(ddl/22)=====
-- 週・銘柄・業種・規模・先行リターン・相対リターン・売残まわりの列は xs_weekly_panel の同名列のコピー
COMMENT ON COLUMN xs_long_panel.week_start     IS '週の起点(月曜)。xs_weekly_panel と同じ';
COMMENT ON COLUMN xs_long_panel.wk_idx         IS '営業日のある週の通し番号。重ならない標本は MOD(wk_idx,4)=0(4週)・MOD(wk_idx,13)=0(13週)';
COMMENT ON COLUMN xs_long_panel.last_bd        IS 'その週の最終営業日';
COMMENT ON COLUMN xs_long_panel.code           IS '銘柄コード(5桁)';
COMMENT ON COLUMN xs_long_panel.sector17_code  IS '17業種コード(現在値)';
COMMENT ON COLUMN xs_long_panel.sector33_name  IS '33業種名(現在値)';
COMMENT ON COLUMN xs_long_panel.delisted_flag  IS '上場廃止フラグ(Y/N)';
COMMENT ON COLUMN xs_long_panel.mcap_oku       IS '時価総額(億円)。その週の値';
COMMENT ON COLUMN xs_long_panel.pbr            IS 'PBR(倍)';
COMMENT ON COLUMN xs_long_panel.mom_26w        IS '過去26週の調整後リターン(%)';
COMMENT ON COLUMN xs_long_panel.shrt_dtc       IS '売残側のDTC(日数)=信用売残÷4週平均出来高。xs_weekly_panel.DTC のコピー。層別(SDTC_Q)の元';
COMMENT ON COLUMN xs_long_panel.size_q         IS '時価総額の週内5分位(1=小型)';
COMMENT ON COLUMN xs_long_panel.pbr_q          IS 'PBRの週内3分位(1=低PBR)';
COMMENT ON COLUMN xs_long_panel.mom_q          IS '過去26週リターンの週内3分位(1=最も弱い)';
COMMENT ON COLUMN xs_long_panel.rev_q          IS '過去4週リターン(RET_4W_PAST)の週内3分位(1=直近で最も下げた)。買い方は逆張りが多いので、買残の増減が直近の下げの言い換えでないかを見る層';
COMMENT ON COLUMN xs_long_panel.sdtc_q         IS '売残側DTC(SHRT_DTC)の週内3分位(0=売残ゼロ、1〜3、3が最大)';
COMMENT ON COLUMN xs_long_panel.mbr_q          IS 'MBRの週内3分位(0=買残ゼロ、1〜3、3が最大)';
COMMENT ON COLUMN xs_long_panel.fwd_ret_4w     IS '4週先リターン(%、調整後)';
COMMENT ON COLUMN xs_long_panel.fwd_ret_13w    IS '13週先リターン(%、調整後)';
COMMENT ON COLUMN xs_long_panel.delist_4w      IS '4週先までに上場廃止で途切れたら Y';
COMMENT ON COLUMN xs_long_panel.delist_13w     IS '13週先までに上場廃止で途切れたら Y';
COMMENT ON COLUMN xs_long_panel.exr_ind_4w     IS '4週先の相対リターン(%、同週・同33業種平均との差)';
COMMENT ON COLUMN xs_long_panel.exr_ind_13w    IS '13週先の相対リターン(%、同週・同33業種平均との差)';
COMMENT ON COLUMN xs_long_panel.exr_is_4w      IS '4週先の相対リターン(%、同週・同17業種×同規模5分位平均との差)。検証の主指標';
COMMENT ON COLUMN xs_long_panel.exr_is_13w     IS '13週先の相対リターン(%、同週・同17業種×同規模5分位平均との差)。検証の主指標';
COMMENT ON COLUMN xs_long_panel.mgn_app_date   IS '使った信用取引残高の申込日(前週分)';
COMMENT ON COLUMN xs_long_panel.long_vol       IS '信用買残(株、申込日時点。分割の遡及調整なし)';
COMMENT ON COLUMN xs_long_panel.shrt_vol       IS '信用売残(株、申込日時点。分割の遡及調整なし)';
COMMENT ON COLUMN xs_long_panel.ret_4w_past    IS '過去4週の調整後リターン(%)。REV_Q の元';
COMMENT ON COLUMN xs_long_panel.mbr            IS '買残比率(割合、0.01=1%)=買残株数×申込週の終値÷申込週の時価総額(=買残÷発行済株式数)。MSR の買い版';
COMMENT ON COLUMN xs_long_panel.ldtc           IS '買残÷申込週時点の直近4週の1日平均出来高(日数)。DTC の買い版。出来高が NULL(窓内に分割)なら NULL';
COMMENT ON COLUMN xs_long_panel.dmbr_4w        IS 'MBRの4週間の変化(割合、0.01=1pt)=MBR(申込週 t-1)−MBR(申込週 t-5)。買残の増減';
COMMENT ON COLUMN xs_long_panel.lchg_4w        IS '買残株数(累積調整係数で割って分割を消したもの)の4週増加率(割合、参考)。4週前MBRが0.1%未満なら NULL';
