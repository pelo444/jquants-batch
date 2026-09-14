--------------------------------------------------------------------------------
-- 第三階層: シグナル検出
--
-- 第一階層・第二階層のデータから、条件に当てはまる銘柄を機械的に絞り込む。
--
--   S1 出来高急増      直近出来高 > 20日平均出来高 × 2.0
--   S2 売残の増加      信用売残 ÷ 自分の過去13週平均売残 >= しきい値
--   S3 大量保有の動き  直近14日以内に大量保有報告書が提出された
--   S4 空売り残高過大  空売り残高合計 > 発行済株式数の一定割合
--
-- 複数が同時に点灯した銘柄を SIGNAL_SCORE の降順で並べる。
--
-- 前提: queries/sql/demand_watchlist_sheet.sql が動くこと(同じテーブルを使う)。
--
-- 【この階層の位置づけ ※2026-09-13 の検証を受けて書き換え】
--   需給5指標の予測力は10年分(2016-09〜2026-09)で検証済みで、いずれも先行リターンの
--   方向を予測できなかった(queries/sql/demand_signal_backtest.sql)。
--   信用倍率の乖離だけは一度それらしい差が出たが、年別内訳で「週と週」ではなく
--   「年と年」を比べていたことが分かり(シンプソンのパラドックス)、年内で切り直すと
--   差は消えた。したがって:
--
--     **SIGNAL_SCORE は「買いシグナル」ではない。「先に中身を見る順番」でしかない。**
--
--   点灯数の多い銘柄から調べる、という優先順位付けの道具として使う。
--   スコアが高いこと自体は、その後のリターンについて何も言っていない。
--   そもそも手元のデータは上昇相場10年分しかなく、上昇依存の手法は反証できない
--   (project memory: regime_bias_limits)。
--
-- 【しきい値は params で変える】
--   運用しながら「点灯が多すぎる/少なすぎる」を見て調整する前提で、数値は全て
--   params CTE に集めてある。SQL本体・列ラベルには直接書かない
--   (SIGNALS の文言をしきい値に依存させると、params を変えた瞬間に嘘になる)。
--
-- 【対象範囲の考え方】
--   ウォッチリストだけを見ると、まだ知らない銘柄を拾えない。
--   逆に全銘柄を対象にすると流動性の低い銘柄が大量に点灯する。
--   2 でウォッチリスト、3 で全銘柄(流動性フィルタ付き)の両方を用意している。
--
-- 【割合の単位】
--   SHRT_POS_TO_SO・TOTAL_SHS_RATIO は小数表現(0.05 = 5%)。表示時に100を掛ける。
--   しきい値も小数で書くこと。0.05 と 5 を取り違えると桁が100倍ずれる。
--
--------------------------------------------------------------------------------
-- 【2026-09-14 第二階層(9/13調整)に合わせて直したこと】
--
--   本ファイルは 9/8 時点のもので、第二階層を実データに当てて直した内容が
--   反映されていなかった。同じテーブルを同じ意味で読むのだから、
--   読み方が食い違っていること自体がバグである。直した点:
--
--   (A) S4 に鮮度の窓が無かった。空売り残高報告は残高が 0.5% を割ると報告義務が
--       切れてそれきり更新されない。窓が無いと数年前の報告が「最新の空売り残高」
--       として点灯し続ける。SHORT_DAYS_SINCE / SHORT_STATUS を出し、
--       params.short_stale_days より古い報告では S4 を立てないようにした。
--   (B) S4 のしきい値 5% は、プライム大型株中心のウォッチリストでは構造的に
--       ほぼ到達しない(0.5%以上の報告分しか無く、大型株ほど欠測する)。
--       既定を 0.02 に下げた。**点灯ゼロは「空売りが無い」ではない。**
--   (C) 大量保有の集約が第二階層と別物だった。銘柄の最終1件を取るだけで、
--       提出者グループごとに畳んでいなかった(= 最後に報告したグループの割合しか
--       映らない)。TOTAL_SHS_RATIO の NULL 補完も無く、保有者1名の書類(全体の約2割)
--       では割合が空欄になっていた。第二階層の lvs_grp と同じ形に揃えた。
--   (D) LVS_RATIO_CHG_PT が「新規」「割合なし」「前回不明」を全部同じ空欄に潰していた。
--       S3 が点灯する行は定義上ほぼ新規か変更報告なので、一番重要な「新規」がまさに
--       空欄になっていた。提出者グループごとの方向を LVS_RECENT_SUMMARY に出した。
--   (E) 3月・9月のつなぎ売りの注意がコメントにしか無かった。第二階層と同じ
--       MARGIN_SEASON_WARN 列を足した。
--   (F) AVG_VOL_N(20日平均に使えた営業日数)が無く、上場直後や売買停止明けでも
--       S1 が点灯していた。params.min_avg_vol_n で足切りするようにした。
--   (G) 3 に MARGIN_DATE が無く、何日前の信用残で判定したのか分からなかった。
--   (H) 4 の20日平均出来高だけ定義が違った(直近日を含む単純平均)。
--       2・3 と同じ「直近日を含まない移動平均」に揃えた。
--   (I) 2 に delisted_flag のフィルタが無かった(3 にはあった)。
--
--   S3 の扱いは「方向を列に出すだけ」とした。退出報告(5%未満へ売り切り)でも
--   点灯させるのは、売り抜けの開始も見たいシグナルだから。ただし
--   LVS_RECENT_SUMMARY を見ずに SIGNAL_SCORE だけで判断すると向きを取り違える。
--------------------------------------------------------------------------------
-- 【2026-09-14 実データを見てさらに直したこと】
--
--   初回実行(ウォッチ21銘柄)で S1・S2 が揃って0件になったため、較正用の診断
--   5・6・7 を足して分布を確かめた。結果、**同じ「0件」でも中身は正反対だった**。
--
--   (J) S1 は壊れていなかった。 21銘柄の P95 は 1.66〜2.70 に収まり、2.0倍の
--       到達率は平均5.4%。点灯しない銘柄は1つも無い。同日0件だったのは
--       期待値1.13銘柄/日の試行が0になっただけ(確率3割強)。しきい値は据え置き。
--       **1日の結果から構造を語ったのが誤りだった。独立観測数を先に数えること。**
--   (K) S2 は本当に成立していなかった。 水準を測る形を2度捨てた:
--       信用倍率(6) → days to cover(8) → **売残の増加率**。
--       ・信用倍率の中央値は銘柄間で 2.43〜1573.5 と3桁違い、13/21銘柄は
--         2年間一度も1.0倍以下にならない。点灯上位は優待銘柄のつなぎ売り。
--       ・days to cover は最大でも2.19(しきい値に置いた5.0の半分以下)。
--         信用売残は個人中心で、大型株では日々の出来高に対して極端に小さい。
--         桁は1桁に改善したが、銘柄間16倍 > 銘柄内3倍でまだ足りなかった。
--       **どちらも「水準」を絶対値で測ろうとして失敗している。**
--       判定基準: **銘柄間のばらつき < 銘柄内のばらつき のときだけ、
--       全銘柄共通の絶対値が意味を持つ。** S1 が効いているのは
--       自己正規化された形(出来高 ÷ 自分の20日平均)だから。
--       同じ形を売残に当てた `売残 ÷ 自分の過去13週平均売残` を採った。
--       信用倍率と days to cover は判定から外し、MARGIN_RATIO /
--       MARGIN_SHRT_DTC として表示だけ残す。
--   (L) S3 の lvs_min_chg = 0.01(1pt)は 7 の分布で裏が取れた。
--       1ptあたりの密度に直すと 0.5〜1.0pt が谷、1.0〜2.0pt で反発する。
--
--   **较正の診断(5〜8)は探索用であって判断用ではない。** 分位を全期間から
--   計算しているので、その時点では知り得ない情報を含む。ここで決めた
--   「1つの絶対値」を params に置く分には実運用でも使えるが、
--   「各銘柄の分位」をそのまま条件にすると先読みバイアスになる。
--------------------------------------------------------------------------------
-- 【S2 は3月・9月に誤検知しやすい】
--   3月末・9月末の権利付最終日の直前は、株主優待・配当を取るためのつなぎ売り
--   (クロス取引)で信用売残が急増する。市場全体でも売残が平常時の1.5〜2倍に
--   なることを実データで確認している(2025-09-22週・2026-03-23週。
--   demand_macro_dashboard.sql 参照)。個別銘柄では優待人気銘柄ほど極端に効く。
--
--   この時期の「信用倍率1倍割れ」は実需の売り圧力ではなく、権利落ち後に反対売買で
--   消える。該当しうる申込日には MARGIN_SEASON_WARN = 'CROSS' が立つ。
--   立っている週は前週比ではなく前年同期と比べること。
--
-- 【信用取引残高が丸ごと欠測する週がある】
--   営業日が2日以下の週(GW・年末年始)は JPX が集計・公表しない。10年で13週あり、
--   全てその条件だった。**「残高ゼロ」ではなく「公表されていない」。**
--   本クエリは最新1件を取るので前週を拾って動き続けるが、MARGIN_DATE が
--   古いままになる。日付を必ず見ること。
--
-- 【空売り残高報告が空になるのは正常(大型株ほど起きる)】
--   V_EQUITY_SHORT_POSITION_SUM は残高割合0.5%以上の報告分だけ。時価総額が大きい
--   銘柄ほど0.5%の金額が大きく、報告者が1人も出ない状態が普通にある。
--   SHORT_RATIO_PCT が NULL なのは「空売り残高ゼロ」ではなく「0.5%以上の報告が無い」。
--
-- 【LVS_GRP_CNT = 0 は「大量保有者がいない」ではない】
--   取り込みは2021-07-01開始。それ以前から保有していて以降1度も変更報告書を
--   出していない大量保有者は、DBに存在しない。0 は「この5年で動きが無かった」。
--------------------------------------------------------------------------------


--------------------------------------------------------------------------------
-- 1. 各データの鮮度確認
--
-- シグナルは「最新値」で判定するため、どれか1つでも取込が止まっていると
-- 静かに誤判定する。バッチが動いているかを最初に見る。
--
-- 【DAYS_BEHIND の正常な範囲(2026-09-14 実測)】
--   株価・空売り残高報告・大量保有報告書 … 0〜3日。これを超えたらバッチを疑う。
--   信用取引残高 … **0〜11日が正常**。週次(申込日=金曜)で、公表は翌週の第2営業日ごろ。
--     実測では 2026-09-14(月)時点で最新が 2026-09-04(金)申込分、DAYS_BEHIND = 10 だった。
--     9/11(金)申込分は 9/16 ごろに来る。**10日遅れをバッチの停止と読み違えないこと。**
--     2026-09-25 申込分以降は日次化されるので、この目安はそこで変わる。
--
-- ただし DAYS_BEHIND が小さいことは「そのデータが新しい」ことしか言わない。
-- 銘柄ごとの最終報告が古いこと(空売り・大量保有に固有)は 2 の
-- SHORT_DAYS_SINCE / LVS_GRP_CNT_STALE で別に見る。**全体は最新でも、
-- その銘柄の最終報告が3年前ということが普通に起きる。**
--------------------------------------------------------------------------------
SELECT '株価(出来高)'      AS data_name,
       TO_CHAR(MAX(price_date), 'YYYY-MM-DD') AS latest,
       TRUNC(SYSDATE) - MAX(price_date)       AS days_behind
FROM equity_price_daily
UNION ALL
SELECT '信用取引残高',
       TO_CHAR(MAX(app_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(app_date)
FROM equity_margin_interest
UNION ALL
SELECT '空売り残高報告',
       TO_CHAR(MAX(calc_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(calc_date)
FROM equity_short_position
UNION ALL
SELECT '大量保有報告書',
       TO_CHAR(MAX(sub_date), 'YYYY-MM-DD'), TRUNC(SYSDATE) - MAX(sub_date)
FROM large_volume_shareholder;


--------------------------------------------------------------------------------
-- 2. 【本命】シグナル検出(ウォッチリスト銘柄)
--
-- ウォッチ銘柄について4つのフラグを立て、1つ以上点灯した行だけを返す。
--
-- 【読む順番】
--   SIGNAL_SCORE で並ぶが、スコアだけで判断しないこと。
--     ・S1 は SPLIT_FLAG='Y' なら疑う(分割で出来高の株数基準が変わっている)
--     ・S2 は MARGIN_SEASON_WARN='CROSS' なら疑う(つなぎ売り)
--     ・S3 は LVS_RECENT_SUMMARY で向きを見る(退出報告でも点灯する)
--     ・S4 は SHORT_DAYS_SINCE を見る(報告が古いほど実態と乖離する)
--   4つとも「点灯したこと」より「なぜ点灯したか」のほうに情報がある。
--
-- 【大量保有は第二階層と同じ形で集約する】
--   提出者は子テーブル LARGE_VOLUME_SHAREHOLDER_HOLDER の HLDR_SEQ = 1。
--   親の EDINET_CODE / ISR_NAME は発行者(= 対象銘柄の会社)であって提出者ではない。
--   親側でグルーピングすると全書類が1グループに潰れ、エラーにならず
--   「それらしい数字」が出る。詳細は demand_watchlist_sheet.sql の 2 のコメント。
--
-- 【LISTAGG のあふれ対策に ON OVERFLOW TRUNCATE を使っていない】
--   scripts/claude-query.js は禁止キーワードを単語一致で判定するため、SQL本文に
--   TRUNCATE の文字列が入るとこのクエリを流せなくなる(TRUNC は別語なので可)。
--   PROJECT.md 9章(3)の推奨とはここだけ食い違うが、実行手段のほうを優先した。
--   代わりに SUBSTR(氏名,1,30) と GRP_RANK <= 10 で長さを決定的に抑えている
--   (最大でも約600バイト。ORA-01489 の4000バイトには届かない)。
--   **この理由はSQL本文のコメントにも書けない**(コメントも単語一致の対象になる)。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0   AS vol_mult_th,       -- S1: 20日平均出来高の何倍で点灯させるか
           20    AS min_avg_vol_n,     -- S1: 平均に必要な営業日数。これ未満は点灯させない
           2.0   AS shrt_mult_th,      -- S2: 信用売残が過去13週平均の何倍で点灯させるか
                                       --     9 の実測で確定(2026-09-14)。1.5だと全体の
                                       --     14.6%が点灯し多すぎた。2.0で約5%、S1と同水準
           13    AS min_shrt_n,        -- S2: 過去13週のうち売残>0だった週数の下限。
                                       --     13 = 窓が全て埋まっていることを要求する。
                                       --     S1 が avg_vol_n >= 20 で全20日を要求するのと同じ
           14    AS lvs_days_th,       -- S3: 大量保有報告書を「直近」と見なす日数
           0.05  AS lvs_min_ratio,     -- S3: 大量保有者として数える下限(5% = 報告義務の基準)
           0.01  AS lvs_min_chg,       -- S3: 実質的な変更と見なす変化幅(小数。0.01 = 1pt)
           365   AS lvs_stale_days,    -- S3: 最終報告がこれより古いグループを「古い」扱い
           0.005 AS short_min_ratio,   -- S4: 空売り残高の報告義務基準(0.5%)。表示の判定用
           0.02  AS short_ratio_th,    -- S4: 空売り残高割合(小数。0.02 = 2%)
           180   AS short_stale_days   -- S4: 報告がこれより古いと点灯させない
    FROM dual
),
target AS (
    SELECT f.code
    FROM favorite_master f
    WHERE f.is_watching = 1
    -- タグで絞る場合はここを差し替える:
    -- SELECT t.code FROM favorite_tag t WHERE t.tag_name IN ('130_semi_equip_material')
),
px AS (
    SELECT p.code,
           p.price_date,
           p.close_price,
           p.volume,
           -- 直近日を含めず、その前の20営業日の平均。直近日を含めると
           -- 急増した当日の出来高が平均を押し上げ、倍率が鈍る
           AVG(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           -- 平均に使えた営業日数。20未満なら「20日平均」ではない(上場直後・売買停止明け)
           COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                               ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
               OVER (PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)           AS split_flag,
           ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
    FROM equity_price_daily p
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
      AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
),
px_latest AS (
    SELECT code, price_date, close_price, volume, avg_vol_20d, avg_vol_n, split_flag
    FROM px WHERE rn = 1
),
mgn_wk AS (
    -- 【必ず週次に畳んでから窓を取る】
    --   信用取引残高は 2026-09-25 申込分から**週次(申込日=金曜)から日次に変わる**。
    --   app_date の行そのものに ROWS 13 PRECEDING を当てると、その日を境に
    --   「13週前まで」が「13営業日前まで」に化ける。エラーにならず、
    --   窓の長さだけが静かに1/5になる。週の最終申込日を1行に畳んでおけば
    --   切り替わりをまたいでも意味が変わらない。
    --   欠測週(営業日2日以下のGW・年末年始)はそもそも行が無いので、
    --   13行の窓が13暦週より長くなることはある。0では埋めない。
    SELECT code, week_start, app_date, long_vol, shrt_vol
    FROM (
        SELECT m.code,
               TRUNC(m.app_date, 'IW') AS week_start,
               m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
          AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -15)
    )
    WHERE rn = 1
),
mgn AS (
    -- 最新週の信用残と、その週を含めない過去13週の売残平均
    -- 【長期の水準は平均ではなく中央値で取る(2026-09-14)】
    --   最初は 52週平均を使ったが、**平均は裾に引っ張られる**。サンドラッグは
    --   中央値15,100株に対し過去に15倍の急増があり、52週平均が中央値の2倍以上に
    --   押し上げられていた。1回のスパイクが1年間バーを上げ続ける。
    --   中央値なら効かない。MEDIAN は窓付きの分析関数にできないが、
    --   **ここで要るのは最新1週だけ**なので rn=1 に絞ってから相関副問合せで取れる。
    SELECT m.code, m.app_date, m.long_vol, m.shrt_vol, m.avg_shrt_13w, m.shrt_n_13w,
           (SELECT MEDIAN(x.shrt_vol)
            FROM mgn_wk x
            WHERE x.code = m.code
              AND x.week_start <  m.week_start
              AND x.week_start >= m.week_start - 364)                          AS med_shrt_52w
    FROM (
        SELECT w.code, w.week_start, w.app_date, w.long_vol, w.shrt_vol,
               AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                     ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) AS avg_shrt_13w,
               -- 売残>0 だった週数。少ない銘柄は平均が0近辺になり倍率が発散する
               COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
                   OVER (PARTITION BY w.code ORDER BY w.week_start
                         ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)            AS shrt_n_13w,
               ROW_NUMBER() OVER (PARTITION BY w.code ORDER BY w.week_start DESC) AS rn
        FROM mgn_wk w
    ) m
    WHERE m.rn = 1
),
sp AS (
    -- 【窓で切り落とさず、鮮度を列で出す】
    --   報告が古いこと自体が情報なので、最新1件はそのまま取る。
    --   S4 を立てるかどうかだけ params.short_stale_days で判定する。
    --   走査量を抑えるため3年で切っているが、これは表示の下限であって
    --   シグナルの鮮度判定ではない(混同しないこと)。
    SELECT code, calc_date, total_shrt_ratio, reporter_count
    FROM (
        SELECT v.code, v.calc_date, v.total_shrt_ratio, v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = v.code)
          AND v.calc_date >= ADD_MONTHS(TRUNC(SYSDATE), -36)
    )
    WHERE rn = 1
),
lvs_grp AS (
    -- 提出者グループごとの最新1件(全期間)。2 の LVS_GRP_CNT / LVS_TOTAL_PCT の土台。
    -- TOTAL_SHS_RATIO の補完は保有者1名の書類に限る。2名以上は共同保有者の
    -- 重複計上があり、子の合計では親を再現できない(426件中62件が不一致・最大13.72pt)。
    -- 詳細は demand_watchlist_sheet.sql の 2 / project memory: large_volume_ratio_nulls。
    SELECT code, sub_date, doc_id, total_shs_ratio
    FROM (
        SELECT l.code, l.sub_date, l.doc_id,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio,
               ROW_NUMBER() OVER (
                   PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)                AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)
    )
    WHERE rn = 1
),
lvs_snap AS (
    SELECT g.code,
           COUNT(CASE WHEN g.total_shs_ratio >= p.lvs_min_ratio THEN 1 END) AS grp_cnt,
           SUM(CASE WHEN g.total_shs_ratio >= p.lvs_min_ratio
                    THEN g.total_shs_ratio END)                            AS total_ratio,
           COUNT(CASE WHEN g.total_shs_ratio IS NULL THEN 1 END)           AS grp_cnt_noratio,
           COUNT(CASE WHEN g.total_shs_ratio >= p.lvs_min_ratio
                       AND g.sub_date < TRUNC(SYSDATE) - p.lvs_stale_days
                      THEN 1 END)                                          AS grp_cnt_stale
    FROM lvs_grp g
    CROSS JOIN params p
    GROUP BY g.code
),
lvs_recent_grp AS (
    -- 直近 lvs_days_th 日以内に報告したグループ。グループごとに最新1件へ畳む。
    -- 【方向の判定順に意味がある】
    --   割合が無い書類を最初に分けないと、NULL 比較が全て偽になって
    --   最後の ELSE '変化なし' に落ち、嘘をつく(第二階層で一度やらかした形)。
    --   退出(5%未満へ)を新規より先に見るのは、5%未満への変更報告も
    --   TOTAL_SHS_RATIO_LAST を持つとは限らないため。
    SELECT g.code, g.grp_name, g.sub_date, g.doc_id, g.grp_docs,
           g.total_shs_ratio, g.total_shs_ratio_last,
           ROW_NUMBER() OVER (PARTITION BY g.code
                              ORDER BY g.sub_date DESC, g.grp_name) AS grp_rank,
           CASE WHEN g.total_shs_ratio IS NULL                      THEN '割合なし'
                WHEN g.total_shs_ratio <  p.lvs_min_ratio           THEN '退出'
                WHEN g.total_shs_ratio_last IS NULL                 THEN '新規'
                WHEN g.total_shs_ratio >  g.total_shs_ratio_last    THEN '買い増し'
                WHEN g.total_shs_ratio <  g.total_shs_ratio_last    THEN '売り減らし'
                ELSE '変化なし' END                                 AS direction,
           -- 【形式的な変更報告を落とすための印】
           --   変更報告書の提出義務は保有割合の1%以上の増減で生じる。実データでも
           --   変化幅は 1.0〜1.2pt の群と 0.0x pt の群にはっきり分かれた
           --   (2026-09-14: 東芝 -1.22 / 野村 -1.08 / キャピタル -1.04 /
           --    三井住友DS +1.09 に対し、SHIFT の2件は +0.06 と +0.03)。
           --   後者は発行済株式総数の変動や共同保有者の構成変更による提出と考えられ、
           --   実質的な売買ではない。**この解釈は 7 の分布で裏を取ること。**
           --   落とさないものが3つある。いずれも「小さいから無視してよい」が成り立たない:
           --     ・割合なし … 判定できない。NULLを0扱いしない原則(第二階層と同じ)
           --     ・退出     … 5.2%→4.9% は -0.3pt でも報告義務が切れる節目
           --     ・新規     … 前回が無いので差が取れない
           CASE WHEN g.total_shs_ratio IS NULL                      THEN 'Y'
                WHEN g.total_shs_ratio <  p.lvs_min_ratio           THEN 'Y'
                WHEN g.total_shs_ratio_last IS NULL                 THEN 'Y'
                WHEN ABS(g.total_shs_ratio - g.total_shs_ratio_last)
                       >= p.lvs_min_chg                             THEN 'Y'
                ELSE 'N' END                                        AS is_material
    FROM (
        SELECT l.code,
               h.hldr_name                           AS grp_name,
               l.sub_date, l.doc_id,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio,
               COALESCE(l.total_shs_ratio_last,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio_last,
               COUNT(*) OVER (PARTITION BY l.code,
                                           NVL(h.hldr_edinet_code, h.hldr_name)) AS grp_docs,
               ROW_NUMBER() OVER (
                   PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)                AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        CROSS JOIN params pp
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)
          AND l.sub_date >= TRUNC(SYSDATE) - pp.lvs_days_th
    ) g
    CROSS JOIN params p
    WHERE g.rn = 1
),
lvs_recent AS (
    SELECT code,
           SUM(grp_docs)                                            AS recent_docs,
           COUNT(*)                                                 AS recent_grps,
           COUNT(CASE WHEN is_material = 'Y' THEN 1 END)            AS recent_material,
           MAX(sub_date)                                            AS last_sub_date,
           -- LISTAGG のあふれ対策は「氏名を60文字に切る」「直近10グループまで」で
           -- 長さを決定的に抑える方式。理由は本節冒頭の【LISTAGG のあふれ対策】参照。
           -- 全角60文字=180バイト、1グループ最大215バイト、10グループで約2,150バイト。
           -- 10グループを超えた分は LVS_RECENT_GRPS の件数にだけ現れる。
           -- それでも切れる社名がある(2026-09-14: キャピタル・リサーチ〜)。
           -- 正式名称が要るときは demand_watchlist_sheet.sql の 7 を銘柄指定で見ること。
           LISTAGG(CASE WHEN grp_rank <= 10 THEN
                   SUBSTR(grp_name, 1, 60) || ':' || direction ||
                   CASE WHEN total_shs_ratio IS NOT NULL
                        THEN ' ' || TO_CHAR(ROUND(total_shs_ratio * 100, 2), 'FM9990.00') || '%'
                   END ||
                   CASE WHEN total_shs_ratio IS NOT NULL
                         AND total_shs_ratio_last IS NOT NULL
                        THEN '(' ||
                             TO_CHAR(ROUND((total_shs_ratio - total_shs_ratio_last) * 100, 2),
                                     'FMS9990.00') || 'pt)'
                   END ||
                   CASE WHEN is_material = 'N' THEN '[形式的]' END
                   END,
                   ' / ') WITHIN GROUP (ORDER BY sub_date DESC, grp_name)
                                                                    AS recent_summary
    FROM lvs_recent_grp
    GROUP BY code
),
flags AS (
    SELECT em.code,
           em.co_name,
           em.market_name,
           px_latest.price_date,
           px_latest.close_price,
           px_latest.volume,
           ROUND(px_latest.avg_vol_20d)                                  AS avg_vol_20d,
           px_latest.avg_vol_n,
           ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
           NVL(px_latest.split_flag, 'N')                                AS split_flag,
           mgn.app_date                                                  AS margin_date,
           ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)              AS margin_ratio,
           ROUND(mgn.shrt_vol / NULLIF(px_latest.avg_vol_20d, 0), 2)     AS margin_shrt_dtc,
           ROUND(mgn.shrt_vol / NULLIF(mgn.avg_shrt_13w, 0), 2)          AS margin_shrt_vs_13w,
           ROUND(mgn.shrt_vol / NULLIF(mgn.med_shrt_52w, 0), 2)          AS margin_shrt_vs_med52,
           mgn.shrt_n_13w                                                AS margin_shrt_n_13w,
           mgn.shrt_vol                                                  AS margin_shrt_vol,
           CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
                 AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
                THEN 'CROSS' END                                         AS margin_season_warn,
           sp.calc_date                                                  AS short_calc_date,
           TRUNC(SYSDATE) - sp.calc_date                                 AS short_days_since,
           ROUND(sp.total_shrt_ratio * 100, 2)                           AS short_ratio_pct,
           -- 【SHORT_RATIO_PCT = 0.00 は「空売り残高ゼロ」ではない】
           --   0.5%を割ったことを知らせる報告が最後に出ると、合計が0近辺で止まる。
           --   2026-09-14 の実行で三井金属が 0.00% / REPORTER_COUNT=1 で出た。
           --   '報告なし'(そもそも報告が無い) と '報告終了'(0.5%を割った) を分ける。
           CASE WHEN sp.calc_date IS NULL                  THEN '報告なし'
                WHEN sp.total_shrt_ratio >= p.short_min_ratio THEN '残高あり'
                ELSE '報告終了' END                                      AS short_status,
           sp.reporter_count,
           NVL(lvs_recent.recent_docs, 0)                                AS lvs_recent_docs,
           NVL(lvs_recent.recent_grps, 0)                                AS lvs_recent_grps,
           NVL(lvs_recent.recent_material, 0)                            AS lvs_recent_material,
           lvs_recent.last_sub_date                                      AS lvs_last_sub_date,
           lvs_recent.recent_summary                                     AS lvs_recent_summary,
           NVL(lvs_snap.grp_cnt, 0)                                      AS lvs_grp_cnt,
           ROUND(lvs_snap.total_ratio * 100, 2)                          AS lvs_total_pct,
           NVL(lvs_snap.grp_cnt_noratio, 0)                              AS lvs_grp_cnt_noratio,
           NVL(lvs_snap.grp_cnt_stale, 0)                                AS lvs_grp_cnt_stale,
           -- S1: 出来高急増。20日分の平均が取れていない銘柄は判定対象外
           CASE WHEN px_latest.avg_vol_20d > 0
                 AND px_latest.avg_vol_n >= p.min_avg_vol_n
                 AND px_latest.volume >= px_latest.avg_vol_20d * p.vol_mult_th
                THEN 1 ELSE 0 END                                        AS sig_volume,
           -- S2: 信用売残の増加(売残 ÷ 自分の過去13週平均売残)。
           --
           --   【水準を測る形を2度捨てて、増加率に落ち着いた経緯(2026-09-14)】
           --     (1) 信用倍率1倍割れ … 6 の実測で銘柄間の中央値が 2.43〜1573.5 と
           --         **3桁違う**。21銘柄中13銘柄は2年間一度も1倍以下にならない。
           --         点灯上位は優待銘柄のつなぎ売りで、実質「優待銘柄検出器」だった。
           --     (2) days to cover … 8 の実測で最大でも 2.19。信用売残は個人中心で、
           --         大型株では日々の出来高に対して極端に小さい(信越化学 0.03日分)。
           --         「5日」は米国株の short interest を前提にした経験則で移植できない。
           --         桁は3桁→1桁に改善したが、銘柄間 P50 0.02〜0.33(16倍)がなお
           --         銘柄内 P50→P95(約3倍)を上回り、どこに線を引いても
           --         **イベントではなく銘柄を選んでしまう**。
           --
           --   【判定基準】銘柄間のばらつきが銘柄内のばらつきより小さいときだけ、
           --     全銘柄共通の絶対値が意味を持つ。S1(出来高倍率)は銘柄間1.6倍 <
           --     銘柄内2.6倍でこれを満たす。**S1 が効いているのは自己正規化された
           --     形だから。** 同じ形を売残に当てたのがこのシグナル。
           --
           --   【つなぎ売りの影響は、このウォッチリストでは見えない(10 で実測)】
           --     月×月末までの週数で測ったところ、3月の点灯率は6.7%・9月は8.1%で、
           --     4月10.4%・5月10.2%より低い。3月の中央値 0.810 は12か月で**最低**、
           --     月末に近づくほど下がる(0.838→0.817→0.846→0.796→0.725)。
           --     **つなぎ売りの想定と逆向き。**
           --     市場全体では権利付最終日の週に売残が1.5〜2倍になるのが実測されている
           --     (2025-09-22週・2026-03-23週)のに出ないのは、
           --     **ウォッチ21銘柄がほぼ優待の無い大型株だから**。優待クロスは
           --     優待銘柄に集中するので、この顔ぶれの中央値には現れない。
           --     **これはリストの性質であって指標の性質ではない。**
           --     優待銘柄を入れたら復活する。MARGIN_SEASON_WARN は残しておく。
           --     なお 10 は21銘柄が同じ週に相関するため実効観測数が極めて小さい。
           --     月ごとの差を論じられる標本ではない(「3月・9月が他を明確に
           --     上回ってはいない」までしか言えない)。
           --
           --   【SHRT_N_13W のガード】
           --     santec は100週中78週、ＱＤレーザは42週が売残ゼロ。平均が0近辺だと
           --     倍率が発散する。過去13週のうち売残>0 が min_shrt_n 週に満たない
           --     銘柄は「売り方がいない」として判定対象外にする(S1 の avg_vol_n と同じ役割)。
           --     9 の実測では santec が100週すべて、ＱＤレーザが58週落ちた。
           --     **落ちること自体が正しい**(売り方がいない銘柄に増加率は定義できない)。
           --   【上場直後は倍率が発散する(このガードでも防ぎきれない)】
           --     キオクシアの MAX_MULT は 455.06 だった。上場からの週数が少ないうちは
           --     過去13週平均そのものが小さく、少しの増加で桁違いの倍率になる。
           --     MARGIN_SHRT_N_13W が13でも、水準が低ければ起きる。
           --     倍率が2桁を超えている行は水準(MARGIN_SHRT_VOL)を必ず見ること。
           --   【SHRT_VOL >= MED_SHRT_52W を足した理由(11 の結論、2026-09-14)】
           --     13週平均が凹んでいると、水準が長期の並より低くても倍率だけ跳ねる。
           --     実測では点灯116件のうち14件(12.1%)が**自分の2年中央値未満の水準**で
           --     点灯していた(住友電工4/17・三井金属4/11・Appier3/17・ＪＸ金属3/11に集中)。
           --     窓を伸ばす案は捨てた: 26週で193件・52週で205件と**点灯がむしろ増え**、
           --     中央値未満の比率は12.1%→9.8%→6.8%としか下がらない。
           --     点灯率を倍にして汚染を半分にするのは割に合わない。
           --     窓は13週のままにして、**水準が長期の並を下回るものを落とす**。
           --     **バーは平均ではなく中央値。** 最初 52週平均で実装したところ、
           --     2 の7銘柄中5銘柄が落ち、しかもサンドラッグ(N13_BELOW_MED = 0、
           --     つまり落とすべきでない銘柄)まで消えた。平均は裾に引っ張られ、
           --     1回の急増が1年間バーを上げ続けるため。中央値なら効かない。
           --     11 で測ると 中央値は116→113(落ちた3件は全て汚染)、
           --     平均は116→108(汚染でない5件まで落ちた)。中央値が正しい。
           --
           --   【ただしこのバーは弱い。問題が解決したとは考えないこと(11 で実測)】
           --     入れた後も**汚染14件のうち11件が残る**(取れるのは3件だけ)。
           --     住友電工4件・三井金属4件・ＪＸ金属3件はバーを素通りする。
           --     理由: これらは売残が1年かけて下がり続けており、
           --     **過去52週の中央値もその低下に追随している**から。
           --     そもそも「2年中央値未満」という汚染の定義は全期間から取った物差しで、
           --     その週には知り得ない。**残る11件は、当時の情報では原理的に検出できない。**
           --     さらに、水準が1年下がり続けた銘柄で売残が倍になったのは
           --     「売り方が戻ってきた」という本物の転換かもしれず、誤検知と
           --     決めつける根拠も無い。バーは副作用が無いので残してあるだけ。
           --
           --   売残の増加率は、予測力を検証した5指標には**含まれていない**
           --   (検証済みなのは信用倍率の水準と乖離)。効くという根拠は無い。
           CASE WHEN mgn.shrt_vol > 0
                 AND mgn.avg_shrt_13w > 0
                 AND mgn.shrt_n_13w >= p.min_shrt_n
                 AND mgn.shrt_vol / mgn.avg_shrt_13w >= p.shrt_mult_th
                 -- 水準が過去52週の中央値を下回るものは「増加」と呼ばない(11 の結論)
                 AND mgn.shrt_vol >= mgn.med_shrt_52w
                THEN 1 ELSE 0 END                                        AS sig_margin,
           -- S3: 直近に「実質的な」大量保有報告書が提出された。
           --   向きは問わない(退出でも点灯させる)が、形式的な変更報告は数えない。
           --   LVS_RECENT_DOCS > 0 なのに LVS_RECENT_MATERIAL = 0 の行は、
           --   報告は出たが実質的な動きではなかったということ。向きは
           --   LVS_RECENT_SUMMARY で必ず確認する。
           CASE WHEN lvs_recent.recent_material > 0 THEN 1 ELSE 0 END    AS sig_lvs,
           -- S4: 空売り残高が一定割合超。古い報告では立てない((A) 参照)
           CASE WHEN sp.total_shrt_ratio > p.short_ratio_th
                 AND sp.calc_date >= TRUNC(SYSDATE) - p.short_stale_days
                THEN 1 ELSE 0 END                                        AS sig_short
    FROM equity_master em
    JOIN target ON target.code = em.code
    CROSS JOIN params p
    LEFT JOIN px_latest   ON px_latest.code   = em.code
    LEFT JOIN mgn         ON mgn.code         = em.code
    LEFT JOIN sp          ON sp.code          = em.code
    LEFT JOIN lvs_recent  ON lvs_recent.code  = em.code
    LEFT JOIN lvs_snap    ON lvs_snap.code    = em.code
    WHERE em.delisted_flag = 'N'
)
SELECT code,
       co_name,
       market_name,
       sig_volume + sig_margin + sig_lvs + sig_short                 AS signal_score,
       -- 点灯したシグナルを1列にまとめる。HTML側でバッジにする想定。
       -- 【文言にしきい値を書かないこと】params を変えた瞬間に嘘になる
       RTRIM(
         CASE WHEN sig_volume = 1 THEN '出来高急増 '     END ||
         CASE WHEN sig_margin = 1 THEN '売残の増加 '     END ||
         CASE WHEN sig_lvs    = 1 THEN '大量保有提出 '   END ||
         CASE WHEN sig_short  = 1 THEN '空売り残高過大 ' END
       )                                                             AS signals,
       -- S1 の材料
       TO_CHAR(price_date, 'YYYY-MM-DD')                             AS price_date,
       close_price,
       volume,
       avg_vol_20d,
       avg_vol_n,
       vol_vs_20d,
       split_flag,
       -- S2 の材料
       TO_CHAR(margin_date, 'YYYY-MM-DD')                            AS margin_date,
       margin_ratio,
       margin_shrt_dtc,
       margin_shrt_vs_13w,
       margin_shrt_vs_med52,
       margin_shrt_n_13w,
       margin_shrt_vol,
       margin_season_warn,
       -- S3 の材料
       TO_CHAR(lvs_last_sub_date, 'YYYY-MM-DD')                      AS lvs_last_sub_date,
       lvs_recent_docs,
       lvs_recent_grps,
       lvs_recent_material,
       lvs_recent_summary,
       lvs_grp_cnt,
       lvs_total_pct,
       lvs_grp_cnt_noratio,
       lvs_grp_cnt_stale,
       -- S4 の材料
       TO_CHAR(short_calc_date, 'YYYY-MM-DD')                        AS short_calc_date,
       short_days_since,
       short_status,
       short_ratio_pct,
       reporter_count
FROM flags
WHERE sig_volume + sig_margin + sig_lvs + sig_short > 0
ORDER BY signal_score DESC, vol_vs_20d DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 3. シグナル検出(全銘柄・流動性フィルタ付き)
--
-- ウォッチリストの外から候補を拾うための版。2 と判定ロジックは同じで、
-- 対象を「東証プライム/スタンダード/グロース かつ 20日平均売買代金が一定以上」に
-- 差し替えてある。
--
-- 流動性フィルタを入れる理由: 出来高が普段ほぼ0の銘柄は、数千株の売買で
-- 簡単に「20日平均の2倍」を超える。フィルタ無しだとその手の銘柄で埋まる。
--
-- 【2 との唯一の意図的な違い: 大量保有の全期間スナップショットを作らない】
--   2 の LVS_GRP_CNT / LVS_TOTAL_PCT は全4,215銘柄・65,311件を提出者グループへ
--   畳む必要があり、絞り込みの1本目としては重い。S3 の判定と向きの表示には
--   直近14日の書類だけで足りるので、こちらはそれだけを見る。
--   点灯した銘柄の「いま誰が何%持っているか」は
--   demand_watchlist_sheet.sql の 7(銘柄指定)で見ること。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0        AS vol_mult_th,
           20         AS min_avg_vol_n,
           2.0        AS shrt_mult_th,
           13         AS min_shrt_n,
           14         AS lvs_days_th,
           0.05       AS lvs_min_ratio,
           0.01       AS lvs_min_chg,
           0.005      AS short_min_ratio,
           0.02       AS short_ratio_th,
           180        AS short_stale_days,
           50000000   AS min_turnover_20d   -- 20日平均売買代金の下限(円)。5000万円
    FROM dual
),
px AS (
    SELECT p.code,
           p.price_date,
           p.close_price,
           p.volume,
           AVG(p.volume)         OVER (PARTITION BY p.code ORDER BY p.price_date
                                       ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           COUNT(p.volume)       OVER (PARTITION BY p.code ORDER BY p.price_date
                                       ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
           AVG(p.turnover_value) OVER (PARTITION BY p.code ORDER BY p.price_date
                                       ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_turnover_20d,
           MAX(CASE WHEN p.adj_factor <> 1 THEN 'Y' END)
               OVER (PARTITION BY p.code ORDER BY p.price_date
                     ROWS BETWEEN 20 PRECEDING AND CURRENT ROW)                   AS split_flag,
           ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC)     AS rn
    FROM equity_price_daily p
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
),
px_latest AS (
    SELECT px.code, px.price_date, px.close_price, px.volume,
           px.avg_vol_20d, px.avg_vol_n, px.avg_turnover_20d, px.split_flag
    FROM px
    CROSS JOIN params
    JOIN equity_master em
      ON em.code = px.code
     AND em.delisted_flag = 'N'
     AND em.market_name IN ('プライム', 'スタンダード', 'グロース')
    WHERE px.rn = 1
      AND px.avg_turnover_20d >= params.min_turnover_20d
),
mgn_wk AS (
    -- 週次に畳んでから窓を取る理由は 2 の同名 CTE のコメント参照(日次化への備え)
    SELECT code, week_start, app_date, long_vol, shrt_vol
    FROM (
        SELECT m.code,
               TRUNC(m.app_date, 'IW') AS week_start,
               m.app_date, m.long_vol, m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -15)
    )
    WHERE rn = 1
),
mgn AS (
    -- 長期の水準は中央値。理由は 2 の同名 CTE のコメント参照
    SELECT m.code, m.app_date, m.long_vol, m.shrt_vol, m.avg_shrt_13w, m.shrt_n_13w,
           (SELECT MEDIAN(x.shrt_vol)
            FROM mgn_wk x
            WHERE x.code = m.code
              AND x.week_start <  m.week_start
              AND x.week_start >= m.week_start - 364)                          AS med_shrt_52w
    FROM (
        SELECT w.code, w.week_start, w.app_date, w.long_vol, w.shrt_vol,
               AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                     ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) AS avg_shrt_13w,
               COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
                   OVER (PARTITION BY w.code ORDER BY w.week_start
                         ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)            AS shrt_n_13w,
               ROW_NUMBER() OVER (PARTITION BY w.code ORDER BY w.week_start DESC) AS rn
        FROM mgn_wk w
    ) m
    WHERE m.rn = 1
),
sp AS (
    -- 2 と同じ考え方。窓は表示の下限であって、鮮度判定は SHORT_STALE_DAYS で行う
    SELECT code, calc_date, total_shrt_ratio, reporter_count
    FROM (
        SELECT v.code, v.calc_date, v.total_shrt_ratio, v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE v.calc_date >= ADD_MONTHS(TRUNC(SYSDATE), -36)
    )
    WHERE rn = 1
),
lvs_recent_grp AS (
    SELECT g.code, g.grp_name, g.sub_date, g.grp_docs,
           g.total_shs_ratio, g.total_shs_ratio_last,
           ROW_NUMBER() OVER (PARTITION BY g.code
                              ORDER BY g.sub_date DESC, g.grp_name) AS grp_rank,
           CASE WHEN g.total_shs_ratio IS NULL                      THEN '割合なし'
                WHEN g.total_shs_ratio <  p.lvs_min_ratio           THEN '退出'
                WHEN g.total_shs_ratio_last IS NULL                 THEN '新規'
                WHEN g.total_shs_ratio >  g.total_shs_ratio_last    THEN '買い増し'
                WHEN g.total_shs_ratio <  g.total_shs_ratio_last    THEN '売り減らし'
                ELSE '変化なし' END                                 AS direction,
           -- 【形式的な変更報告を落とすための印】
           --   変更報告書の提出義務は保有割合の1%以上の増減で生じる。実データでも
           --   変化幅は 1.0〜1.2pt の群と 0.0x pt の群にはっきり分かれた
           --   (2026-09-14: 東芝 -1.22 / 野村 -1.08 / キャピタル -1.04 /
           --    三井住友DS +1.09 に対し、SHIFT の2件は +0.06 と +0.03)。
           --   後者は発行済株式総数の変動や共同保有者の構成変更による提出と考えられ、
           --   実質的な売買ではない。**この解釈は 7 の分布で裏を取ること。**
           --   落とさないものが3つある。いずれも「小さいから無視してよい」が成り立たない:
           --     ・割合なし … 判定できない。NULLを0扱いしない原則(第二階層と同じ)
           --     ・退出     … 5.2%→4.9% は -0.3pt でも報告義務が切れる節目
           --     ・新規     … 前回が無いので差が取れない
           CASE WHEN g.total_shs_ratio IS NULL                      THEN 'Y'
                WHEN g.total_shs_ratio <  p.lvs_min_ratio           THEN 'Y'
                WHEN g.total_shs_ratio_last IS NULL                 THEN 'Y'
                WHEN ABS(g.total_shs_ratio - g.total_shs_ratio_last)
                       >= p.lvs_min_chg                             THEN 'Y'
                ELSE 'N' END                                        AS is_material
    FROM (
        SELECT l.code,
               h.hldr_name                           AS grp_name,
               l.sub_date, l.doc_id,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio,
               COALESCE(l.total_shs_ratio_last,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS total_shs_ratio_last,
               COUNT(*) OVER (PARTITION BY l.code,
                                           NVL(h.hldr_edinet_code, h.hldr_name)) AS grp_docs,
               ROW_NUMBER() OVER (
                   PARTITION BY l.code, NVL(h.hldr_edinet_code, h.hldr_name)
                   ORDER BY l.sub_date DESC, l.doc_id DESC)                AS rn
        FROM large_volume_shareholder l
        JOIN large_volume_shareholder_holder h
          ON h.doc_id = l.doc_id
         AND h.hldr_seq = 1
        CROSS JOIN params pp
        WHERE l.sub_date >= TRUNC(SYSDATE) - pp.lvs_days_th
    ) g
    CROSS JOIN params p
    WHERE g.rn = 1
),
lvs_recent AS (
    SELECT code,
           SUM(grp_docs)                                            AS recent_docs,
           COUNT(*)                                                 AS recent_grps,
           COUNT(CASE WHEN is_material = 'Y' THEN 1 END)            AS recent_material,
           MAX(sub_date)                                            AS last_sub_date,
           -- LISTAGG のあふれ対策は「氏名を60文字に切る」「直近10グループまで」で
           -- 長さを決定的に抑える方式。理由は本節冒頭の【LISTAGG のあふれ対策】参照。
           -- 全角60文字=180バイト、1グループ最大215バイト、10グループで約2,150バイト。
           -- 10グループを超えた分は LVS_RECENT_GRPS の件数にだけ現れる。
           -- それでも切れる社名がある(2026-09-14: キャピタル・リサーチ〜)。
           -- 正式名称が要るときは demand_watchlist_sheet.sql の 7 を銘柄指定で見ること。
           LISTAGG(CASE WHEN grp_rank <= 10 THEN
                   SUBSTR(grp_name, 1, 60) || ':' || direction ||
                   CASE WHEN total_shs_ratio IS NOT NULL
                        THEN ' ' || TO_CHAR(ROUND(total_shs_ratio * 100, 2), 'FM9990.00') || '%'
                   END ||
                   CASE WHEN total_shs_ratio IS NOT NULL
                         AND total_shs_ratio_last IS NOT NULL
                        THEN '(' ||
                             TO_CHAR(ROUND((total_shs_ratio - total_shs_ratio_last) * 100, 2),
                                     'FMS9990.00') || 'pt)'
                   END ||
                   CASE WHEN is_material = 'N' THEN '[形式的]' END
                   END,
                   ' / ') WITHIN GROUP (ORDER BY sub_date DESC, grp_name)
                                                                    AS recent_summary
    FROM lvs_recent_grp
    GROUP BY code
),
flags AS (
    SELECT em.code,
           em.co_name,
           em.market_name,
           em.sector33_name,
           px_latest.price_date,
           px_latest.close_price,
           ROUND(px_latest.avg_vol_20d)                                  AS avg_vol_20d,
           px_latest.avg_vol_n,
           ROUND(px_latest.volume / NULLIF(px_latest.avg_vol_20d, 0), 2) AS vol_vs_20d,
           ROUND(px_latest.avg_turnover_20d / 1000000)                   AS avg_turnover_20d_mil,
           NVL(px_latest.split_flag, 'N')                                AS split_flag,
           mgn.app_date                                                  AS margin_date,
           ROUND(mgn.long_vol / NULLIF(mgn.shrt_vol, 0), 2)              AS margin_ratio,
           ROUND(mgn.shrt_vol / NULLIF(px_latest.avg_vol_20d, 0), 2)     AS margin_shrt_dtc,
           ROUND(mgn.shrt_vol / NULLIF(mgn.avg_shrt_13w, 0), 2)          AS margin_shrt_vs_13w,
           ROUND(mgn.shrt_vol / NULLIF(mgn.med_shrt_52w, 0), 2)          AS margin_shrt_vs_med52,
           mgn.shrt_n_13w                                                AS margin_shrt_n_13w,
           CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
                 AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
                THEN 'CROSS' END                                         AS margin_season_warn,
           sp.calc_date                                                  AS short_calc_date,
           TRUNC(SYSDATE) - sp.calc_date                                 AS short_days_since,
           ROUND(sp.total_shrt_ratio * 100, 2)                           AS short_ratio_pct,
           -- 【SHORT_RATIO_PCT = 0.00 は「空売り残高ゼロ」ではない】
           --   0.5%を割ったことを知らせる報告が最後に出ると、合計が0近辺で止まる。
           --   2026-09-14 の実行で三井金属が 0.00% / REPORTER_COUNT=1 で出た。
           --   '報告なし'(そもそも報告が無い) と '報告終了'(0.5%を割った) を分ける。
           CASE WHEN sp.calc_date IS NULL                  THEN '報告なし'
                WHEN sp.total_shrt_ratio >= p.short_min_ratio THEN '残高あり'
                ELSE '報告終了' END                                      AS short_status,
           sp.reporter_count,
           NVL(lvs_recent.recent_docs, 0)                                AS lvs_recent_docs,
           NVL(lvs_recent.recent_grps, 0)                                AS lvs_recent_grps,
           NVL(lvs_recent.recent_material, 0)                            AS lvs_recent_material,
           lvs_recent.last_sub_date                                      AS lvs_last_sub_date,
           lvs_recent.recent_summary                                     AS lvs_recent_summary,
           CASE WHEN px_latest.avg_vol_20d > 0
                 AND px_latest.avg_vol_n >= p.min_avg_vol_n
                 AND px_latest.volume >= px_latest.avg_vol_20d * p.vol_mult_th
                THEN 1 ELSE 0 END                                        AS sig_volume,
           CASE WHEN mgn.shrt_vol > 0
                 AND mgn.avg_shrt_13w > 0
                 AND mgn.shrt_n_13w >= p.min_shrt_n
                 AND mgn.shrt_vol / mgn.avg_shrt_13w >= p.shrt_mult_th
                 -- 水準が過去52週の中央値を下回るものは「増加」と呼ばない(11 の結論)
                 AND mgn.shrt_vol >= mgn.med_shrt_52w
                THEN 1 ELSE 0 END                                        AS sig_margin,
           CASE WHEN lvs_recent.recent_material > 0 THEN 1 ELSE 0 END    AS sig_lvs,
           CASE WHEN sp.total_shrt_ratio > p.short_ratio_th
                 AND sp.calc_date >= TRUNC(SYSDATE) - p.short_stale_days
                THEN 1 ELSE 0 END                                        AS sig_short
    FROM px_latest
    JOIN equity_master em ON em.code = px_latest.code
    CROSS JOIN params p
    LEFT JOIN mgn        ON mgn.code        = px_latest.code
    LEFT JOIN sp         ON sp.code         = px_latest.code
    LEFT JOIN lvs_recent ON lvs_recent.code = px_latest.code
)
SELECT code,
       co_name,
       market_name,
       sector33_name,
       sig_volume + sig_margin + sig_lvs + sig_short                     AS signal_score,
       RTRIM(
         CASE WHEN sig_volume = 1 THEN '出来高急増 '     END ||
         CASE WHEN sig_margin = 1 THEN '売残の増加 '     END ||
         CASE WHEN sig_lvs    = 1 THEN '大量保有提出 '   END ||
         CASE WHEN sig_short  = 1 THEN '空売り残高過大 ' END
       )                                                                 AS signals,
       TO_CHAR(price_date, 'YYYY-MM-DD')                                 AS price_date,
       close_price,
       vol_vs_20d,
       avg_vol_n,
       avg_turnover_20d_mil,
       split_flag,
       TO_CHAR(margin_date, 'YYYY-MM-DD')                                AS margin_date,
       margin_ratio,
       margin_shrt_dtc,
       margin_shrt_vs_13w,
       margin_shrt_vs_med52,
       margin_shrt_n_13w,
       margin_season_warn,
       TO_CHAR(short_calc_date, 'YYYY-MM-DD')                            AS short_calc_date,
       short_days_since,
       short_status,
       short_ratio_pct,
       reporter_count,
       TO_CHAR(lvs_last_sub_date, 'YYYY-MM-DD')                          AS lvs_last_sub_date,
       lvs_recent_docs,
       lvs_recent_grps,
       lvs_recent_material,
       lvs_recent_summary
FROM flags
WHERE sig_volume + sig_margin + sig_lvs + sig_short >= 2   -- 2つ以上の同時点灯に絞る
ORDER BY signal_score DESC, vol_vs_20d DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY;


--------------------------------------------------------------------------------
-- 4. 補助シグナル(4つの本則に加えて見ておくと効くもの)
--
-- 2 の4条件は「今まさに起きている変化」を捉えるが、
-- 踏み上げの燃料がどれだけ溜まっているかは別に見たほうがよい。
--
--   days to cover     信用売残 ÷ 20日平均出来高。買い戻しに何日かかるか
--   日々公表銘柄入り  取引所が残高を毎日公表する水準まで積み上がった銘柄
--   報告者数の増加    0.5%以上の空売りを報告する主体が増えている
--
-- 【20日平均出来高の定義は 2・3 と揃えてある(2026-09-14 修正)】
--   以前はここだけ「直近日を含む単純平均(rn <= 20)」で、2 の VOL_VS_20D の分母
--   (直近日を含まない移動平均)と違っていた。同じファイルの中で同じ名前の値が
--   2種類あると、DAYS_TO_COVER と第二階層の MARGIN_SHRT_DTC が微妙にずれる。
--
-- 【MARGIN_SEASON_WARN は DAYS_TO_COVER にも効く】
--   3月・9月のつなぎ売りで売残が膨らむ週は DAYS_TO_COVER も一緒に跳ねる。
--   踏み上げの燃料が溜まったわけではない。
--------------------------------------------------------------------------------
WITH target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
avg_vol AS (
    SELECT code, avg_vol_20d, avg_vol_n
    FROM (
        SELECT p.code,
               AVG(p.volume)   OVER (PARTITION BY p.code ORDER BY p.price_date
                                     ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
               COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                                     ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n,
               ROW_NUMBER() OVER (PARTITION BY p.code ORDER BY p.price_date DESC) AS rn
        FROM equity_price_daily p
        WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -4)
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
    )
    WHERE rn = 1
),
mgn AS (
    SELECT code, app_date, shrt_vol, long_vol
    FROM (
        SELECT m.code, m.app_date, m.shrt_vol, m.long_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
          AND m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -6)
    )
    WHERE rn = 1
),
alert AS (
    -- 日々公表銘柄。同一申込日の訂正は公表日が最新の行だけを見る。
    -- 30日窓なので、指定が外れた後もしばらく 'Y' のまま残る(APP_DATE を見ること)。
    SELECT code, app_date, sl_ratio, shrt_out_ratio, tse_mrgn_reg_cls
    FROM (
        SELECT a.code, a.app_date, a.sl_ratio, a.shrt_out_ratio, a.tse_mrgn_reg_cls,
               ROW_NUMBER() OVER (PARTITION BY a.code ORDER BY a.app_date DESC) AS rn
        FROM v_equity_margin_alert_latest a
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = a.code)
          AND a.app_date >= TRUNC(SYSDATE) - 30
    )
    WHERE rn = 1
),
sp AS (
    SELECT code,
           MAX(CASE WHEN rn = 1 THEN calc_date END)       AS calc_date,
           MAX(CASE WHEN rn = 1 THEN reporter_count END)  AS reporter_count,
           MAX(CASE WHEN rn = 2 THEN reporter_count END)  AS reporter_count_prev
    FROM (
        SELECT v.code, v.calc_date, v.reporter_count,
               ROW_NUMBER() OVER (PARTITION BY v.code ORDER BY v.calc_date DESC) AS rn
        FROM v_equity_short_position_sum v
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = v.code)
          AND v.calc_date >= ADD_MONTHS(TRUNC(SYSDATE), -36)
    )
    WHERE rn <= 2
    GROUP BY code
)
SELECT em.code,
       em.co_name,
       TO_CHAR(mgn.app_date, 'YYYY-MM-DD')                          AS margin_date,
       CASE WHEN TO_CHAR(mgn.app_date, 'MM') IN ('03', '09')
             AND TO_NUMBER(TO_CHAR(mgn.app_date, 'DD')) >= 15
            THEN 'CROSS' END                                        AS margin_season_warn,
       mgn.shrt_vol                                                 AS margin_shrt_vol,
       ROUND(avg_vol.avg_vol_20d)                                   AS avg_vol_20d,
       avg_vol.avg_vol_n,
       ROUND(mgn.shrt_vol / NULLIF(avg_vol.avg_vol_20d, 0), 1)      AS days_to_cover,
       CASE WHEN alert.code IS NOT NULL THEN 'Y' ELSE 'N' END       AS daily_publication,
       TO_CHAR(alert.app_date, 'YYYY-MM-DD')                        AS alert_app_date,
       alert.sl_ratio                                               AS alert_sl_ratio,
       alert.tse_mrgn_reg_cls,
       TO_CHAR(sp.calc_date, 'YYYY-MM-DD')                          AS short_calc_date,
       TRUNC(SYSDATE) - sp.calc_date                                AS short_days_since,
       sp.reporter_count,
       sp.reporter_count - sp.reporter_count_prev                   AS reporter_chg
FROM equity_master em
JOIN target ON target.code = em.code
LEFT JOIN mgn     ON mgn.code     = em.code
LEFT JOIN avg_vol ON avg_vol.code = em.code
LEFT JOIN alert   ON alert.code   = em.code
LEFT JOIN sp      ON sp.code      = em.code
WHERE em.delisted_flag = 'N'
ORDER BY days_to_cover DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 5. 【較正】出来高倍率の分位(ウォッチ銘柄 × 過去2年)
--
-- 2 の S1(出来高急増)のしきい値を決めるための診断。
--
-- 【結論: しきい値 2.0 は据え置き(2026-09-14 実測)】
--   21銘柄の P95 は 1.66(三菱UFJ)〜2.70(ＱＤレーザ)に収まり、**桁が違わない**。
--   P50 も 0.85〜0.96 でほぼ同じ。VOL_VS_20D は自分自身の20日平均で割った
--   自己正規化された指標なので、全銘柄共通の絶対値でしきい値を引ける。
--   2.0倍の到達率は 2.06%〜10.49%(平均5.4%)、486営業日で10〜51日。
--   点灯しない銘柄は1つも無い。
--
--   **同日の 2 で S1 が0件だったのは、しきい値が高いからではない。**
--   21銘柄 × 平均5.4% = 期待値1.13銘柄/日。0件になる確率は3割強あり、
--   しかも出来高急増は市場全体で同時に起きるので実際はもっと高い。
--   1日のスナップショットから「このシグナルは構造的に死んでいる」と
--   読んだのは誤りだった。**独立観測数を数えないまま構造を語らないこと**
--   (demand_backtest_results.md の教訓がそのまま当てはまる)。
--
--   N_DAYS が486に満たない銘柄(ＪＸ金属345・キオクシア403)は上場が新しいため。
--   AVG_VOL_N >= 20 のガードが効いている証拠でもある。
--
-- 【読み方】
--   ・DAYS_GE_TH が0の銘柄は、現行しきい値では**永久に点灯しない**
--   ・P95 / P99 から「年に何日点灯してほしいか」を逆算する
--     (2年 ≒ 490営業日。P99 なら約5日、P95 なら約24日点灯する)
--   ・銘柄間で P95 が大きく違うなら、全銘柄共通の絶対値では無理という結論になる
--
-- 【先読みバイアスについて】
--   ここで出す分位は全期間から計算しているので、その時点では知り得ない情報を含む。
--   **しきい値を選ぶための探索用であって、判断用ではない。**
--   ここで決めた「1つの絶対値」を params に置く分には実運用でも使えるが、
--   「各銘柄の P95」をそのままシグナルの条件にすると先読みになる
--   (その週までのデータだけで計算し直す必要がある)。
--   demand_signal_backtest.sql の 3(探索用)と 4(判断用)の区別と同じ話。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0 AS cur_vol_mult_th,   -- 現行の 2 の params.vol_mult_th
           24  AS months_back        -- 分布を見る期間(か月)
    FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
px AS (
    SELECT p.code, p.price_date, p.volume,
           AVG(p.volume)   OVER (PARTITION BY p.code ORDER BY p.price_date
                                 ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                                 ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n
    FROM equity_price_daily p
    CROSS JOIN params pp
    -- 期間の先頭でも20日平均が成立するよう3か月ぶん助走をつける
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -(pp.months_back + 3))
      AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
),
r AS (
    SELECT px.code, px.price_date, px.volume / px.avg_vol_20d AS ratio
    FROM px
    CROSS JOIN params pp
    WHERE px.avg_vol_n >= 20
      AND px.avg_vol_20d > 0
      AND px.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -pp.months_back)
)
SELECT em.code,
       em.co_name,
       em.market_name,
       COUNT(*)                                                           AS n_days,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY r.ratio), 2)    AS p50,
       ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY r.ratio), 2)    AS p90,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.ratio), 2)    AS p95,
       ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY r.ratio), 2)    AS p99,
       ROUND(MAX(r.ratio), 2)                                             AS max_ratio,
       COUNT(CASE WHEN r.ratio >= p.cur_vol_mult_th THEN 1 END)           AS days_ge_th,
       ROUND(COUNT(CASE WHEN r.ratio >= p.cur_vol_mult_th THEN 1 END)
             * 100 / COUNT(*), 2)                                         AS pct_ge_th
FROM r
JOIN equity_master em ON em.code = r.code
CROSS JOIN params p
GROUP BY em.code, em.co_name, em.market_name
ORDER BY p95 DESC;


--------------------------------------------------------------------------------
-- 6. 【較正】信用倍率の分位(ウォッチ銘柄 × 過去2年)
--
-- 旧 S2(信用倍率1倍割れ)のしきい値を決めるための診断。
--
-- 【結論: 信用倍率はシグナルから外した(2026-09-14)】
--   この診断の結果、S2 は days to cover に置き換えた(8 で較正する)。
--   信用倍率は 2 の MARGIN_RATIO として表示だけ残している。
--   本クエリは判断の経緯として残してある。ウォッチ銘柄を入れ替えたら
--   もう一度流すと、置き換えの判断がその顔ぶれでも成り立つかを確かめられる。
--
--   外した理由:
--     ・中央値が銘柄間で 2.43(三井金属)〜1573.5(santec)と**3桁違う**。
--       全銘柄共通の絶対値を引けない。
--     ・21銘柄中13銘柄は2年間(100週)で一度も 1.0倍以下にならない。
--       その13銘柄にとって S2 は構造的に存在しないシグナルだった。
--     ・N_LE_TH の首位はサンドラッグ(17週)だが、P05 0.29 → P05_EX_CROSS 0.50 と
--       つなぎ売り週を除くと5%点が1.7倍に跳ねる。MIN_RATIO 0.07 も権利取りの週。
--       **点灯上位が優待銘柄で占められており、実質「優待銘柄検出器」だった。**
--     ・そもそも信用倍率は水準・乖離とも予測力が無いと検証済み
--       (demand_signal_backtest.sql / project memory: demand_backtest_results)。
-- 2026-09-14 の実行では最小でも 1.94倍(東京建物)、最大 491.54倍(ＱＤレーザ)で、
-- **銘柄間で桁が2つ違った**。しきい値1.0に届く銘柄が無いだけでなく、
-- そもそも全銘柄共通の絶対値でしきい値を引けるのかを、まずここで確かめる。
--
-- 【P05_EX_CROSS を隣に置いてある理由】
--   3月・9月の権利付最終日前の週は、優待・配当のつなぎ売りで信用売残が1.5〜2倍に
--   膨らみ、信用倍率が一時的に下がる。**下側の分位はこの週に汚染される。**
--   P05 と P05_EX_CROSS(該当週を除いたもの)が大きく違う銘柄は、
--   低い倍率の正体がつなぎ売りだということ。優待人気銘柄ほど差が出るはず。
--
-- 【N_NO_SHORT】
--   売残が0の週。信用倍率が計算できない(分母0)。この数が多い銘柄は
--   そもそも空売りされておらず、S2 は構造的に無縁。
--   **欠測ではなく「売り方がいない」という意味のある0。**
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 1.0 AS cur_margin_ratio_th,   -- 旧 S2 のしきい値(2026-09-14 に廃止。下記参照)
           24  AS months_back
    FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
m AS (
    SELECT mi.code,
           mi.app_date,
           mi.shrt_vol,
           CASE WHEN mi.shrt_vol > 0 THEN mi.long_vol / mi.shrt_vol END   AS ratio,
           CASE WHEN TO_CHAR(mi.app_date, 'MM') IN ('03', '09')
                 AND TO_NUMBER(TO_CHAR(mi.app_date, 'DD')) >= 15
                THEN 'Y' ELSE 'N' END                                     AS cross_week
    FROM equity_margin_interest mi
    CROSS JOIN params pp
    WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = mi.code)
      AND mi.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -pp.months_back)
)
SELECT em.code,
       em.co_name,
       em.market_name,
       COUNT(*)                                                           AS n_obs,
       COUNT(CASE WHEN m.shrt_vol IS NULL OR m.shrt_vol = 0 THEN 1 END)   AS n_no_short,
       COUNT(CASE WHEN m.cross_week = 'Y' THEN 1 END)                     AS n_cross_week,
       ROUND(MIN(m.ratio), 2)                                             AS min_ratio,
       ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY m.ratio), 2)    AS p05,
       ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (
                 ORDER BY CASE WHEN m.cross_week = 'N' THEN m.ratio END), 2) AS p05_ex_cross,
       ROUND(PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY m.ratio), 2)    AS p10,
       ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY m.ratio), 2)    AS p25,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY m.ratio), 2)    AS p50,
       COUNT(CASE WHEN m.ratio <= p.cur_margin_ratio_th THEN 1 END)       AS n_le_th
FROM m
JOIN equity_master em ON em.code = m.code
CROSS JOIN params p
GROUP BY em.code, em.co_name, em.market_name
ORDER BY p10;


--------------------------------------------------------------------------------
-- 7. 【較正】大量保有報告書の変化幅の分布(ウォッチ銘柄 × 全期間)
--
-- 2 の S3 で使う params.lvs_min_chg(既定 0.01 = 1pt)の裏取り。
--
-- 【確かめたい仮説】
--   変更報告書の提出義務は「保有割合の1%以上の増減」で生じる。2026-09-14 の実行で
--   観測した変化幅は 1.0〜1.2pt の群(東芝 -1.22 / 野村 -1.08 / キャピタル -1.04 /
--   三井住友DS +1.09)と 0.0x pt の群(SHIFT の +0.06 / +0.03)に分かれていた。
--   後者は発行済株式総数の変動や共同保有者の構成変更による形式的な提出で、
--   実質的な売買ではないのではないか、というのが仮説。
--
-- 【結論: 仮説は支持された。lvs_min_chg = 0.01 を採用(2026-09-14 実測)】
--   **バケットの幅が違うので件数をそのまま比べてはいけない。** 1ptあたりの
--   密度に直すと、どちらの変更報告書にもはっきり谷ができる:
--
--     コード2(変更報告書)       230 → 30 → 16 → 46 → 3.7 (件/pt)
--     コード5(変更報告書(特例))  520 → 235 → 110 → 153 → 5 (件/pt)
--     (バケットは <0.1 / 0.1-0.5 / 0.5-1.0 / 1.0-2.0 / 2.0-5.0)
--
--   **谷は 0.5〜1.0pt にあり、1.0〜2.0pt で反発する。** 提出義務が
--   「1%以上の増減」で生じることと整合する。1.0pt で切ると変化幅の
--   計算できる478件のうち234件(49%)が残る。
--
-- 【この表で分かったその他】
--   ・**ウォッチ銘柄の大量保有者は機関投資家が中心**。書類の8割が特例
--     (コード4: 56件 / コード5: 419件)で、通常の報告(コード1: 11件 /
--     コード2: 108件)は2割しかない。特例報告は経営支配目的でない
--     機関投資家が使う制度。
--   ・コード4(特例の新規)は56件中52件が前回割合を持たない。当然だが、
--     この56件は変化幅で絞れないので全て「新規」として残る。
--   ・N_NORATIO の合計は 48 + 4 = 52件で、第二階層で数えた
--     「親NULL / 保有者2名以上 = 52件」と**完全に一致**した(整合性チェック)。
--   ・DOCS の合計は595件。第二階層の594件(2026-09-13時点)との差1件は、
--     当日キオクシアの書類が1件増えたため。
--   ・退出(N_EXIT)は66件ある。変化幅によらず残す設計なので全部拾う。
--
-- 【N_NORATIO / N_NO_PREV は分母から外れる】
--   割合そのものが無い書類(共同保有者2名以上で親の合計欄がNULL)と、
--   前回の割合が無い書類(新規報告)は、変化幅が計算できない。
--   バケットの合計は DOCS ではなく N_CHG に一致する。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 0.05 AS lvs_min_ratio FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
d AS (
    -- 補完は 2 と同じ(保有者1名の書類に限る)。CROSS APPLY は使わず素直な入れ子にする
    SELECT large_hldg_type_code,
           ratio,
           ratio_last,
           ABS(ratio - ratio_last) AS chg
    FROM (
        SELECT l.large_hldg_type_code,
               COALESCE(l.total_shs_ratio,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS ratio,
               COALESCE(l.total_shs_ratio_last,
                        (SELECT CASE WHEN COUNT(*) = 1 THEN SUM(hh.shs_ratio_last) END
                         FROM large_volume_shareholder_holder hh
                         WHERE hh.doc_id = l.doc_id))                      AS ratio_last
        FROM large_volume_shareholder l
        WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = l.code)
    )
)
SELECT d.large_hldg_type_code,
       CASE d.large_hldg_type_code
            WHEN '1' THEN '大量保有報告書(新規)'
            WHEN '2' THEN '変更報告書'
            WHEN '3' THEN '変更報告書(短期大量譲渡)'
            WHEN '4' THEN '大量保有報告書(特例)'
            WHEN '5' THEN '変更報告書(特例)'
            WHEN '0' THEN '不明'
            ELSE d.large_hldg_type_code END                                AS type_name,
       COUNT(*)                                                            AS docs,
       COUNT(CASE WHEN d.ratio IS NULL THEN 1 END)                         AS n_noratio,
       COUNT(CASE WHEN d.ratio IS NOT NULL
                   AND d.ratio_last IS NULL THEN 1 END)                    AS n_no_prev,
       COUNT(CASE WHEN d.ratio < p.lvs_min_ratio THEN 1 END)               AS n_exit,
       COUNT(d.chg)                                                        AS n_chg,
       -- 変化幅(絶対値)のバケット。値は小数表現なので 0.01 = 1pt
       COUNT(CASE WHEN d.chg <  0.001 THEN 1 END)                          AS lt_0_1pt,
       COUNT(CASE WHEN d.chg >= 0.001 AND d.chg < 0.005 THEN 1 END)        AS pt_0_1_to_0_5,
       COUNT(CASE WHEN d.chg >= 0.005 AND d.chg < 0.01  THEN 1 END)        AS pt_0_5_to_1_0,
       COUNT(CASE WHEN d.chg >= 0.01  AND d.chg < 0.02  THEN 1 END)        AS pt_1_0_to_2_0,
       COUNT(CASE WHEN d.chg >= 0.02  AND d.chg < 0.05  THEN 1 END)        AS pt_2_0_to_5_0,
       COUNT(CASE WHEN d.chg >= 0.05 THEN 1 END)                           AS ge_5_0pt,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY d.chg) * 100, 3) AS med_chg_pt
FROM d
CROSS JOIN params p
GROUP BY d.large_hldg_type_code
ORDER BY d.large_hldg_type_code;


--------------------------------------------------------------------------------
-- 8. 【較正】days to cover の分位(ウォッチ銘柄 × 過去2年)
--
-- days to cover をシグナルに使えるかを確かめた診断(不採用。経緯として残す)。
-- 5 と同じ形で、銘柄間で共通の絶対値が引けるかをまず確かめる。
--
-- 【結論: days to cover も採らなかった(2026-09-14 実測)】
--   **21銘柄の最大値が 2.19 で、暫定しきい値 5.0 に誰も届かなかった。**
--   原因は単位ではなく対象。SHRT_VOL は信用売残(個人中心)で、機関投資家の
--   空売りは別枠(0.5%報告 = S4)。日本の大型株では信用売残が日々の出来高に
--   対して極端に小さい(信越化学 185,700株 ÷ 590万株 = 0.03日分)。
--   **「days to cover 5日」は米国株の short interest(機関の空売りを含む合計)を
--   前提にした経験則で、信用売残単独には移植できない。**
--
--   しきい値を0.5に直せば済む話ではなかった:
--     銘柄間 P50 0.02〜0.33 = 16倍  >  銘柄内 P50→P95 = 約3倍
--   どこに線を引いてもイベントではなく銘柄を選ぶ。0.20 に置くと
--   あさひ(P50 0.33)は半分以上の週で点灯し、santec・Appier・ＪＸ金属は
--   永久に点灯しない。信用倍率と同じ失敗の、程度の軽い版だった。
--   → S2 は 9 の「売残の増加率」に置き換えた。DTC は表示列として残す。
--
-- 【この診断で分かったその他】
--   ・サンドラッグ P95 0.42 → P95_EX_CROSS 0.17。**上側の裾の大半がつなぎ売り。**
--     6 の下側の裾(P05 0.29 → 0.50)と同じ現象が逆向きに出た。
--   ・あさひは P95 0.99 / EX_CROSS 0.97 でほぼ同じ。季節性ではなく構造的に売残が厚い。
--   ・santec 78/100週・ＱＤレーザ 42/100週が売残ゼロ。
--     **この2銘柄は信用売残ベースのシグナルと構造的に無縁**(9 の SHRT_N_13W ガードの根拠)。
--
-- 【2 とは分母の時点が違う(意図的)】
--   2 は直近営業日の20日平均出来高で割っている(第二階層と揃えるため)。
--   ここでは**申込日時点**の20日平均で割る。過去の分布を見る目的では、
--   その週に実際に計算できた値でなければ意味がないため。
--   N_DTC が N_OBS より小さいのは、申込日に株価の行が無い週(祝日等)と
--   20日平均が成立しない期間を落としているから。
--
-- 【P95_EX_CROSS】
--   3月・9月のつなぎ売り週は売残が1.5〜2倍に膨らむので DTC も跳ねる。
--   P95 と P95_EX_CROSS が大きく違う銘柄は、上側の裾がつなぎ売りでできている。
--   6 のサンドラッグ(P05 0.29 → P05_EX_CROSS 0.50)と同じ見方。
--
-- 【DTC = 0 は欠測ではない】
--   売残0の週は 0 になる(santec は100週中78週が売残0)。
--   そういう銘柄は S2 と構造的に無縁。N_ZERO で見える。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 5.0 AS cur_dtc_th,        -- 当時の暫定しきい値(不採用。誰も届かなかった)
           24  AS months_back
    FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
px AS (
    SELECT p.code, p.price_date,
           AVG(p.volume)   OVER (PARTITION BY p.code ORDER BY p.price_date
                                 ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20d,
           COUNT(p.volume) OVER (PARTITION BY p.code ORDER BY p.price_date
                                 ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_n
    FROM equity_price_daily p
    CROSS JOIN params pp
    WHERE p.price_date >= ADD_MONTHS(TRUNC(SYSDATE), -(pp.months_back + 3))
      AND EXISTS (SELECT 1 FROM target t WHERE t.code = p.code)
),
d AS (
    SELECT mi.code,
           mi.app_date,
           mi.shrt_vol,
           mi.shrt_vol / px.avg_vol_20d                                   AS dtc,
           CASE WHEN TO_CHAR(mi.app_date, 'MM') IN ('03', '09')
                 AND TO_NUMBER(TO_CHAR(mi.app_date, 'DD')) >= 15
                THEN 'Y' ELSE 'N' END                                     AS cross_week
    FROM equity_margin_interest mi
    JOIN px ON px.code = mi.code
           AND px.price_date = mi.app_date
    CROSS JOIN params pp
    WHERE EXISTS (SELECT 1 FROM target t WHERE t.code = mi.code)
      AND mi.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -pp.months_back)
      AND px.avg_vol_n >= 20
      AND px.avg_vol_20d > 0
)
SELECT em.code,
       em.co_name,
       em.market_name,
       COUNT(*)                                                           AS n_dtc,
       COUNT(CASE WHEN d.shrt_vol = 0 OR d.shrt_vol IS NULL THEN 1 END)   AS n_zero,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY d.dtc), 2)      AS p50,
       ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY d.dtc), 2)      AS p75,
       ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY d.dtc), 2)      AS p90,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY d.dtc), 2)      AS p95,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
                 ORDER BY CASE WHEN d.cross_week = 'N' THEN d.dtc END), 2) AS p95_ex_cross,
       ROUND(MAX(d.dtc), 2)                                               AS max_dtc,
       COUNT(CASE WHEN d.dtc >= p.cur_dtc_th THEN 1 END)                  AS n_ge_th
FROM d
JOIN equity_master em ON em.code = d.code
CROSS JOIN params p
GROUP BY em.code, em.co_name, em.market_name
ORDER BY p95 DESC;


--------------------------------------------------------------------------------
-- 9. 【較正】信用売残の増加率の分位(ウォッチ銘柄 × 過去2年)
--
-- 2 の S2(売残の増加)のしきい値 params.shrt_mult_th を決めるための診断。
-- 5 と同じ形。**S1 と同じ「自己正規化された倍率」なので、S1 と同じように
-- 銘柄間で桁が揃うはず**というのがここで確かめたいこと。
--
-- 【合否の判定基準(6・8 で2度失敗して固まった型)】
--   銘柄間のばらつき(P95 の最大 ÷ 最小)と、銘柄内のばらつき(P50 → P95 の中央値)
--   を比べる。**銘柄間 < 銘柄内 なら共通の絶対値が効く。**
--     S1 出来高倍率     : 銘柄間 1.6倍 < 銘柄内 2.6倍  → 効いた
--     旧S2 信用倍率     : 銘柄間 647倍 > 銘柄内 3.8倍  → 論外
--     days to cover     : 銘柄間 16倍  > 銘柄内 3倍    → 足りない
--     売残の増加率      : 銘柄間 3.1倍 > 銘柄内 2.2倍  → **判定は微妙。採用した**
--
-- 【結論: 採用。shrt_mult_th = 2.0 / min_shrt_n = 13(2026-09-14 実測)】
--   判定基準は**わずかに満たしていない**(銘柄間3.1倍 > 銘柄内2.2倍)。
--   それでも採ったのは、失敗した2つとは性質が違うため:
--     ・**P50 が 0.73〜1.10(1.5倍)と、中心は完全に揃っている。**
--       ばらつくのは裾の厚みだけ。信用倍率は中心が647倍ずれていた。
--     ・**santec を除く全銘柄が点灯する。** 信用倍率では13/21銘柄が
--       2年間一度も点灯しなかった。「永久に点灯しない銘柄」が無いことが
--       絶対値を使えるかの実務的な分かれ目。
--   残る非対称は認識しておくこと: サンドラッグ・Appier・ＪＸ金属・住友電工は
--   三菱商事・東京建物の2〜3倍の頻度で点灯する。
--   これ以上詰めるなら銘柄内のローリング分位(先読み回避が必要)に行く。
--
--   しきい値2.0の根拠: 1.5 では点灯が 290/1,981週 = **14.6%** で、21銘柄なら
--   毎週3.1銘柄が点灯して絞り込みにならない。各銘柄の P95 の中央値が
--   ちょうど2.0前後(キーエンス1.99・フジクラ1.94)で、ここに置くと全体で約5%。
--   **S1 の到達率5.4%と揃う。**
--
-- 【P95_EX_CROSS を必ず隣で見る】
--   設計時は「3月・9月のつなぎ売りでこの倍率は年2回ほぼ全銘柄で点灯する」と
--   見込んでいたが、**実測では外れた。** 点灯290件のうちつなぎ売り週は36件
--   (12.4%)で、つなぎ売り週が全体に占める割合(約12%)とほぼ同じ。点灯率は
--   平常週と変わらない。P95 と P95_EX_CROSS が乖離したのはサンドラッグ
--   (4.72 → 3.10)だけで、9銘柄はむしろ EX_CROSS のほうが高かった。
--   理由は推測: つなぎ売りは数週かけて積み上がるので前週比の倍率が跳ねにくく、
--   膨らんだ売残が翌週以降の13週平均に入って分母も上がるため。
--   **優待人気銘柄では効くので、この列は今後も隣に置いておく。**
--
-- 【N_USABLE / N_THIN】
--   過去13週のうち売残>0 が min_shrt_n 週に満たない週は倍率が発散するので除外
--   (N_THIN)。実測では santec が100週すべて、ＱＤレーザが58週落ちた。
--   **落ちること自体が正しい**(売り方がいない銘柄に増加率は定義できない)。
--
-- 【MAX_MULT が桁違いの銘柄に注意】
--   キオクシアの MAX_MULT は 455.06。上場からの週数が少ないうちは過去13週平均
--   そのものが小さく、少しの増加で桁違いの倍率になる。min_shrt_n を13にしても
--   水準が低ければ起きる。倍率が2桁を超える行は水準を必ず見ること。
--
-- 【週次に畳んでから窓を取っている】
--   2 の mgn_wk と同じ理由。2026-09-25 申込分からの日次化で
--   ROWS 13 PRECEDING の意味が変わるのを避ける。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0 AS cur_shrt_mult_th,  -- 現行の 2 の params.shrt_mult_th
           13  AS min_shrt_n,        -- 現行の 2 の params.min_shrt_n
           -- ※ 2026-09-14 の観測(点灯290件・つなぎ売り36件・全体の14.6%)は
           --   1.5 / 10 で取ったもの。上の結論はその数字に基づく。
           --   いま流すと採用後の値(2.0 / 13)での分布が出るので、
           --   N_GE_TH は当時の記録より小さくなる。
           24  AS months_back
    FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
wk AS (
    SELECT code, week_start, shrt_vol
    FROM (
        SELECT m.code,
               TRUNC(m.app_date, 'IW') AS week_start,
               m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        CROSS JOIN params pp
        -- 13週の助走ぶんを余分に取る
        WHERE m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -(pp.months_back + 4))
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
    )
    WHERE rn = 1
),
r AS (
    SELECT code, week_start, shrt_vol, avg_shrt_13w, shrt_n_13w,
           CASE WHEN shrt_n_13w >= min_shrt_n AND avg_shrt_13w > 0
                THEN shrt_vol / avg_shrt_13w END                          AS mult,
           CASE WHEN TO_CHAR(week_start, 'MM') IN ('03', '09')
                 AND TO_NUMBER(TO_CHAR(week_start, 'DD')) >= 11
                THEN 'Y' ELSE 'N' END                                     AS cross_week
    FROM (
        SELECT w.code, w.week_start, w.shrt_vol,
               AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                     ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) AS avg_shrt_13w,
               COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
                   OVER (PARTITION BY w.code ORDER BY w.week_start
                         ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)             AS shrt_n_13w,
               pp.min_shrt_n,
               pp.months_back
        FROM wk w
        CROSS JOIN params pp
    )
    WHERE week_start >= ADD_MONTHS(TRUNC(SYSDATE), -months_back)
)
SELECT em.code,
       em.co_name,
       em.market_name,
       COUNT(*)                                                           AS n_weeks,
       COUNT(r.mult)                                                      AS n_usable,
       COUNT(*) - COUNT(r.mult)                                           AS n_thin,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY r.mult), 2)     AS p50,
       ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY r.mult), 2)     AS p75,
       ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY r.mult), 2)     AS p90,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.mult), 2)     AS p95,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
                 ORDER BY CASE WHEN r.cross_week = 'N' THEN r.mult END), 2) AS p95_ex_cross,
       ROUND(MAX(r.mult), 2)                                              AS max_mult,
       COUNT(CASE WHEN r.mult >= p.cur_shrt_mult_th THEN 1 END)           AS n_ge_th,
       COUNT(CASE WHEN r.mult >= p.cur_shrt_mult_th
                   AND r.cross_week = 'Y' THEN 1 END)                     AS n_ge_th_cross
FROM r
JOIN equity_master em ON em.code = r.code
CROSS JOIN params p
GROUP BY em.code, em.co_name, em.market_name
ORDER BY p95 DESC NULLS LAST;


--------------------------------------------------------------------------------
-- 10. 【較正】売残倍率の季節性(月 × 月末までの週数)
--
-- 9 では「つなぎ売りの影響は小さい」と結論したが、その判定は cross_week を
-- 「3月・9月の DD >= 11 の週」と決め打ちして出したものだった。**窓の定義が
-- 間違っていれば、汚染が無いという結論もそのまま間違っている。**
-- ここでは窓を決め打ちせず、実際に売残倍率がいつ膨らむのかを測る。
--
-- 【読み方】
--   WKS_TO_MONTH_END = 0 がその月の最終週、1 が1週前、…。
--   NULL の行はその月の合計(GROUPING SETS で出している)。
--   3月・9月の特定の週だけ MED_MULT / PCT_GE_TH が他の月より高ければ、
--   つなぎ売りはその週に集中しているということ。
--   **どの週から膨らみ始めるかで MARGIN_SEASON_WARN の窓を決め直す。**
--   現行の警告は「申込日が3月・9月の15日以降」。これが遅すぎないかを見る。
--
-- 【月末を基準にしている理由】
--   つなぎ売りは権利付最終日(≒月末の2営業日前)に向けて積み上がり、
--   権利落ち後に反対売買で消える。暦日ではなく月末からの距離で揃えないと、
--   月ごとに週の切れ目がずれて山がぼやける。
--   厳密には権利付最終日を TRADING_CALENDAR から求めるべきだが、
--   月末アンカーで山が見えるならそこまでしなくてよい。
--
-- 【N が小さい行に注意】
--   1セルあたり 21銘柄 × 2年 = 最大42観測。月末までの週数が4になる月は
--   少ないので N が一桁になる行がある。そこの数字は読まない。
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0 AS cur_shrt_mult_th,
           13  AS min_shrt_n,
           24  AS months_back
    FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
wk AS (
    SELECT code, week_start, shrt_vol
    FROM (
        SELECT m.code,
               TRUNC(m.app_date, 'IW') AS week_start,
               m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        CROSS JOIN params pp
        WHERE m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -(pp.months_back + 4))
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
    )
    WHERE rn = 1
),
r AS (
    SELECT code,
           week_start,
           TO_CHAR(week_start, 'MM')                          AS mon,
           FLOOR((LAST_DAY(week_start) - week_start) / 7)      AS wks_to_end,
           CASE WHEN shrt_n_13w >= min_shrt_n AND avg_shrt_13w > 0
                THEN shrt_vol / avg_shrt_13w END               AS mult
    FROM (
        SELECT w.code, w.week_start, w.shrt_vol,
               AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                     ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) AS avg_shrt_13w,
               COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
                   OVER (PARTITION BY w.code ORDER BY w.week_start
                         ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)             AS shrt_n_13w,
               pp.min_shrt_n, pp.months_back
        FROM wk w
        CROSS JOIN params pp
    )
    WHERE week_start >= ADD_MONTHS(TRUNC(SYSDATE), -months_back)
)
SELECT r.mon,
       CASE WHEN GROUPING(r.wks_to_end) = 1 THEN NULL
            ELSE r.wks_to_end END                                          AS wks_to_month_end,
       CASE WHEN GROUPING(r.wks_to_end) = 1 THEN '(月計)' END              AS is_total,
       COUNT(r.mult)                                                       AS n,
       ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY r.mult), 3)      AS med_mult,
       ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY r.mult), 3)      AS p90_mult,
       COUNT(CASE WHEN r.mult >= p.cur_shrt_mult_th THEN 1 END)            AS n_ge_th,
       ROUND(COUNT(CASE WHEN r.mult >= p.cur_shrt_mult_th THEN 1 END)
             * 100 / NULLIF(COUNT(r.mult), 0), 1)                          AS pct_ge_th
FROM r
CROSS JOIN params p
GROUP BY GROUPING SETS ((r.mon), (r.mon, r.wks_to_end))
ORDER BY r.mon, GROUPING(r.wks_to_end) DESC, r.wks_to_end DESC;


--------------------------------------------------------------------------------
-- 11. 【較正】「低い基準からの戻り」で点灯した件数と、それを落とす条件の比較
--
-- 【なぜこれが要るか(2026-09-14 に見つかった設計欠陥)】
--   S2 は「売残 ÷ 自分の過去13週平均」で測る。**13週平均が凹んでいると、
--   水準が長期の並より低くても倍率だけ跳ねる。**
--   S1(出来高)で同じ問題が目立たないのは、出来高の平均回帰が速く窓が20日と
--   短いため。売残は数か月単位で水準が動くので13週では基準が安定しない。
--
-- 【この診断で決めること】
--   (1) 基準窓を伸ばして解決するか(13 / 26 / 52週)
--   (2) 窓はそのままに「水準が低いものを落とす」条件を足すなら、
--       バーを **52週平均** と **52週中央値** のどちらに置くか
--
-- 【N13_BELOW_MED が汚染の実測値】
--   点灯したが水準は自分の2年中央値未満 = 低い基準からの戻りで点灯した件数。
--   2026-09-14 の実測では 116件中14件(12.1%)。住友電工4/17・三井金属4/11・
--   Appier3/17・ＪＸ金属3/11 に集中していた。
--
-- 【窓を伸ばす案は捨てた(2026-09-14)】
--   13週116件 / 26週193件 / 52週205件と**点灯がむしろ増え**、中央値未満の比率は
--   12.1% → 9.8% → 6.8% としか下がらない。売残が水準を切り上げている銘柄では、
--   長い平均ほど現在値との差が開くため。点灯率を倍にして汚染を半分にするのは
--   割に合わない。→ 窓は13週のままにして、水準の下限を足す方向にした。
--
-- 【バーに平均を使ってはいけない(2026-09-14、実際に失敗した)】
--   最初 `売残 >= 52週平均` を実装したところ、2 の7銘柄中5銘柄が新条件で
--   落ちた。しかもサンドラッグは N13_BELOW_MED = 0、つまり**落とすべき対象では
--   なかったのに消えた**。原因は**平均が裾に引っ張られること**。サンドラッグは
--   中央値15,100株に対し過去に15倍の急増があり、52週平均が中央値の2倍以上に
--   押し上げられていた。**1回のスパイクが1年間バーを上げ続ける。**
--   → 中央値に変更した。ここで両方を並べて、その判断が正しいか確かめる。
--
-- 【読み方】
--   ・N13_AVG52 / N13_MED52 … それぞれのバーを通した後の点灯数。
--     N13(116)からどれだけ減るか。減りすぎるバーは厳しすぎる。
--   ・N13_AVG52_BAD / N13_MED52_BAD … 通した後に**残ってしまった**中央値未満の点灯。
--     0 に近いほどバーとして機能している。
--   ・**落としたい14件を落とし、それ以外をなるべく残すバーを選ぶ。**
--     減った数だけを見て「厳しいほど良い」と読まないこと。
--
-- 【結論(2026-09-14 実測、全21銘柄・約2,060銘柄週)】
--   | バー | 通過 | 残った汚染 |
--   |---|---|---|
--   | なし     | 116 | 14 |
--   | 52週平均 | 108 | 11 |
--   | 52週中央値 | 113 | 11 |
--
--   **中央値が平均に勝つ**のは確認できた(同じ3件を落として、平均が余分に落とす
--   5件を落とさない)。中央値を採用。点灯率は 113/2,060 = 5.5% で、
--   S1 の 5.4% と揃っており 9 の較正はいまの条件でも成立している
--   (11 は min_shrt_n=13 / th=2.0 の現行条件で走っているので、9 の流し直しは不要)。
--
--   **しかし、どちらのバーも汚染14件のうち3件しか取れない。**
--   住友電工4・三井金属4・ＪＸ金属3 は N13_AVG52 も N13_MED52 も N13 と同数で、
--   まったく減っていない。売残が1年かけて下がり続けている銘柄では、
--   **過去52週の中央値もその低下に追随する**ため、どんな移動窓を基準にしても
--   「2年中央値より低い」は検出できない。
--   **2年中央値という物差し自体が全期間から取った先読みの量**であり、
--   その週には計算できない。**残る11件は原理的に検出不能。**
--
--   踏み込んで言えば、これを「汚染」と呼べるかも怪しい。水準が1年下がり続けた
--   銘柄で売残が倍になったのは「売り方が戻ってきた」という本物の転換かもしれない。
--   **先読みの物差しで引いた線を、誤検知の定義として使っていたことになる。**
--   バーは副作用が無いので残してあるが、**これで解決したとは考えないこと。**
--
-- 【MEDIAN の使い分け】
--   MED_SHRT(汚染の判定)は過去2年の全期間から取っており、その週には知り得ない。
--   **これは設計の当否を見るための物差しで、判断には使えない。**
--   一方 MED52(バー)は各週の過去52週だけから取っており、その週に計算できる。
--   2 で実際に使っているのは後者。**探索用と判断用を混ぜないこと。**
--------------------------------------------------------------------------------
WITH params AS (
    SELECT 2.0 AS cur_shrt_mult_th,
           13  AS min_shrt_n,
           24  AS months_back
    FROM dual
),
target AS (
    SELECT f.code FROM favorite_master f WHERE f.is_watching = 1
),
wk AS (
    SELECT code, week_start, shrt_vol
    FROM (
        SELECT m.code,
               TRUNC(m.app_date, 'IW') AS week_start,
               m.shrt_vol,
               ROW_NUMBER() OVER (PARTITION BY m.code, TRUNC(m.app_date, 'IW')
                                  ORDER BY m.app_date DESC) AS rn
        FROM equity_margin_interest m
        CROSS JOIN params pp
        -- 52週の窓の助走ぶんを余分に取る
        WHERE m.app_date >= ADD_MONTHS(TRUNC(SYSDATE), -(pp.months_back + 14))
          AND EXISTS (SELECT 1 FROM target t WHERE t.code = m.code)
    )
    WHERE rn = 1
),
w AS (
    SELECT w.code, w.week_start, w.shrt_vol,
           AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                 ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) AS avg13,
           AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                 ROWS BETWEEN 26 PRECEDING AND 1 PRECEDING) AS avg26,
           AVG(w.shrt_vol) OVER (PARTITION BY w.code ORDER BY w.week_start
                                 ROWS BETWEEN 52 PRECEDING AND 1 PRECEDING) AS avg52,
           COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
               OVER (PARTITION BY w.code ORDER BY w.week_start
                     ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING)             AS n13,
           COUNT(CASE WHEN w.shrt_vol > 0 THEN 1 END)
               OVER (PARTITION BY w.code ORDER BY w.week_start
                     ROWS BETWEEN 52 PRECEDING AND 1 PRECEDING)             AS n52
    FROM wk w
),
r AS (
    SELECT w.code, w.week_start, w.shrt_vol, w.avg52,
           CASE WHEN w.n13 >= pp.min_shrt_n AND w.avg13 > 0
                THEN w.shrt_vol / w.avg13 END                               AS m13,
           CASE WHEN w.n13 >= pp.min_shrt_n AND w.avg26 > 0
                THEN w.shrt_vol / w.avg26 END                               AS m26,
           CASE WHEN w.n52 >= 45 AND w.avg52 > 0
                THEN w.shrt_vol / w.avg52 END                               AS m52,
           -- その週に計算できる形の中央値(判断用。2 で実際に使っているのはこれ)
           (SELECT MEDIAN(x.shrt_vol)
            FROM wk x
            WHERE x.code = w.code
              AND x.week_start <  w.week_start
              AND x.week_start >= w.week_start - 364)                       AS med52
    FROM w
    CROSS JOIN params pp
    WHERE w.week_start >= ADD_MONTHS(TRUNC(SYSDATE), -pp.months_back)
),
med AS (
    -- 汚染の判定に使う物差し(探索用。全期間から取っているので判断には使えない)
    SELECT code, MEDIAN(shrt_vol) AS med_shrt
    FROM r
    GROUP BY code
)
SELECT em.code,
       em.co_name,
       med.med_shrt,
       COUNT(CASE WHEN r.m13 >= p.cur_shrt_mult_th THEN 1 END)             AS n13,
       COUNT(CASE WHEN r.m13 >= p.cur_shrt_mult_th
                   AND r.shrt_vol < med.med_shrt THEN 1 END)               AS n13_below_med,
       -- バー候補1: 52週平均以上
       COUNT(CASE WHEN r.m13 >= p.cur_shrt_mult_th
                   AND r.shrt_vol >= r.avg52 THEN 1 END)                   AS n13_avg52,
       COUNT(CASE WHEN r.m13 >= p.cur_shrt_mult_th
                   AND r.shrt_vol >= r.avg52
                   AND r.shrt_vol <  med.med_shrt THEN 1 END)              AS n13_avg52_bad,
       -- バー候補2: 52週中央値以上(採用したほう)
       COUNT(CASE WHEN r.m13 >= p.cur_shrt_mult_th
                   AND r.shrt_vol >= r.med52 THEN 1 END)                   AS n13_med52,
       COUNT(CASE WHEN r.m13 >= p.cur_shrt_mult_th
                   AND r.shrt_vol >= r.med52
                   AND r.shrt_vol <  med.med_shrt THEN 1 END)              AS n13_med52_bad,
       -- 参考: 窓を伸ばした場合(採用しなかった)
       COUNT(CASE WHEN r.m26 >= p.cur_shrt_mult_th THEN 1 END)             AS n26,
       COUNT(CASE WHEN r.m52 >= p.cur_shrt_mult_th THEN 1 END)             AS n52
FROM r
JOIN med ON med.code = r.code
JOIN equity_master em ON em.code = r.code
CROSS JOIN params p
GROUP BY em.code, em.co_name, med.med_shrt
ORDER BY n13_below_med DESC, n13 DESC;
