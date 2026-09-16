--------------------------------------------------------------------------------
-- 空売り残高の「報告者ごとの有効期間」ビュー
-- 実行ユーザー: GD_JQUANTS
--
-- 【なぜ要るか(2026-09-16)】
--   V_EQUITY_SHORT_POSITION_SUM は銘柄×**計算日**の合計なので、その日に報告した
--   報告者の分しか入らない。報告者Aが9/1に1.0%、報告者Bが9/5に0.6%を報告すると、
--   9/5の行は0.6%で、Aの1.0%は入らない。
--   第二階層・第三階層(S4)・Webアプリはこの最新計算日の行を「最新の空売り残高」と
--   読んでいた。実測で**2,317銘柄中1,539銘柄が0.1pt以上ずれ、平均で約37%過小**
--   (持ち越し合計1.393% / 最新計算日の読み方0.873%)。KLab はビュー4.06%に対し
--   報告者10者の持ち越し合計が21.23%だった。
--
--   残高の総量を見るには、報告者ごとに最新の報告を持ち越して合計する必要がある。
--   その読み方をこのビュー1か所に閉じ込める(需給3階層・横断面検証で読み方を揃えるため)。
--
-- 【このビューが返すもの】
--   報告1件を1行とし、「その報告が有効な期間」の終わり(NEXT_DISC_DATE)を付ける。
--     有効期間 = DISC_DATE(公表日) 〜 同じ報告者の次の報告の公表日(の前日まで)
--   ある基準日 D 時点の残高は、次の条件の行を合計すれば出る:
--     DISC_DATE <= D AND D < NVL(NEXT_DISC_DATE, DATE '9999-12-31')   … D で有効な報告
--     AND SHRT_POS_TO_SO >= 0.005                                     … 0.5%未満は終了報告
--     AND CALC_DATE >= D - 180                                        … 古すぎる報告は失効
--   0.5%の基準と失効日数は**使う側の params で持つ**(しきい値をビューに埋めないため)。
--
-- 【報告者の同定】
--   SS_NAME / DIC_NAME / FUND_NAME の組。表記ゆれ(全角/半角・大文字/小文字)で
--   同じ報告者が別人扱いになると前の報告を打ち切れず二重に数えるので、
--   UPPER(TO_SINGLE_BYTE()) でそろえてからキーにする
--   (実測: ＳＭＢＣ日興証券 全角/半角 4,063件、REGULUS MASTER FUND 大小文字 398件 ほか計7組)。
--
-- 【個人の報告は含めない】
--   SS_NAME='個人' は20,111件あり住所も空欄で、別々の個人を区別できない。
--   前回報告の日付・割合でつなぐ方法も13%がつながらなかった(ddl/20 冒頭に内訳)。
--   **このビューの合計は「個人以外(機関)の空売り残高」。**
--
-- 【失効(既定180日)の副作用】
--   報告は残高が0.1pt以上動いたとき・0.5%を割ったときに出る。半年以上動かない
--   大口の残高は、実在していても失効扱いで合計から落ちる。
--   使う側で「失効扱いの報告の件数」を別に出して、落ちた分があることを見せること。
--
-- 前提: ddl/08(EQUITY_SHORT_POSITION)を実行済みであること。
-- ★ 実行後、CLAUDE_RO への GRANT とシノニムを忘れないこと(本ファイル末尾)。
--------------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_short_position_carry_iv AS
SELECT s.position_id,
       s.code,
       s.disc_date,
       s.calc_date,
       s.shrt_pos_to_so,
       s.shrt_pos_shares,
       s.ss_name,
       s.dic_name,
       s.fund_name,
       UPPER(TO_SINGLE_BYTE(NVL(s.ss_name,   '-'))) || ' | ' ||
       UPPER(TO_SINGLE_BYTE(NVL(s.dic_name,  '-'))) || ' | ' ||
       UPPER(TO_SINGLE_BYTE(NVL(s.fund_name, '-')))                    AS reporter_key,
       LEAD(s.disc_date) OVER (
           PARTITION BY s.code,
                        UPPER(TO_SINGLE_BYTE(NVL(s.ss_name,   '-'))),
                        UPPER(TO_SINGLE_BYTE(NVL(s.dic_name,  '-'))),
                        UPPER(TO_SINGLE_BYTE(NVL(s.fund_name, '-')))
           ORDER BY s.calc_date, s.disc_date, s.position_id)           AS next_disc_date
FROM equity_short_position s
WHERE NVL(s.ss_name, '-') <> '個人';

COMMENT ON TABLE v_short_position_carry_iv IS
  '空売り残高報告(個人以外)に報告者ごとの有効期間の終わり(次の報告の公表日)を付けたもの。基準日時点の残高は有効な行の合計(ddl/21)';


--------------------------------------------------------------------------------
-- 動作確認: 今日時点の持ち越し合計(上位20銘柄)。KLab(36560)が約21%で出ること
--------------------------------------------------------------------------------
-- SELECT i.code,
--        ROUND(SUM(i.shrt_pos_to_so) * 100, 2) AS carry_pct,
--        COUNT(*)                              AS reporters
-- FROM v_short_position_carry_iv i
-- WHERE i.disc_date <= TRUNC(SYSDATE)
--   AND TRUNC(SYSDATE) < NVL(i.next_disc_date, DATE '9999-12-31')
--   AND i.shrt_pos_to_so >= 0.005
--   AND i.calc_date >= TRUNC(SYSDATE) - 180
-- GROUP BY i.code
-- ORDER BY carry_pct DESC
-- FETCH FIRST 20 ROWS ONLY;


--------------------------------------------------------------------------------
-- CLAUDE_RO への権限付与
-- 1 を GD_JQUANTS で、2 を CLAUDE_RO で接続し直して実行する。
-- **一気に流すと 2 で ORA-01471 になる**(GD_JQUANTS は同名の実体を持つため)。
--------------------------------------------------------------------------------

-- 1. GD_JQUANTS で実行
-- GRANT SELECT ON gd_jquants.v_short_position_carry_iv TO claude_ro;

-- 2. CLAUDE_RO で接続し直して実行
-- SELECT USER AS connected_as FROM dual;   -- CLAUDE_RO であること
-- CREATE SYNONYM v_short_position_carry_iv FOR gd_jquants.v_short_position_carry_iv;
