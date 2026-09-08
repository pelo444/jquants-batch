#!/usr/bin/env python3
"""
JPX週間公表資料(.xls) → 裁定取引残高CSV 変換ツール

【何をするか】
  日本取引所グループ「プログラム売買」ページ(01.html)で配布される週間公表資料
  (20260828.xls のような YYYYMMDD 8桁のファイル)から、
  「２．裁定取引に係る現物ポジション」の表だけを抜き出し、
  ARBITRAGE_BALANCE_STG に投入できるCSVに変換する。

  ファイル内の他の表(プログラム売買の売買、取引参加者別裁定取引の状況)は使わない。

【なぜこのプロジェクトで唯一のPythonスクリプトなのか】
  旧形式(BIFF8)の .xls を読む必要があり、Node側で読むには SheetJS を
  npm公開レジストリ外から入れることになる。取り込みバッチ本体に
  その依存を増やしたくないため、変換工程だけをPythonに切り出した。
  DBへの投入は従来どおり Node(src/loadArbitrage.js)が行う。
  CSVという中間形式を挟むのはこの分界点を作るためでもある。

【必要なもの】
  pip3 install xlrd
  ※ xlrd 2.x は .xlsx を読めないが、.xls は読める。JPXの配布は .xls なので問題ない。

【使い方】
  # 1ファイル(標準出力にCSV)
  python3 scripts/convert-arbitrage-xls.py path/to/20260828.xls

  # ディレクトリ内の全 .xls をまとめて1つのCSVに(バックナンバーの一括変換)
  python3 scripts/convert-arbitrage-xls.py ~/apps/jquants/manual_dl_datas/program_weekly \
      --out ~/apps/jquants/manual_dl_datas/arbitrage_balance.csv

  # 中身の確認だけ(CSVを書かず、読み取った値を人間が読める形で表示)
  python3 scripts/convert-arbitrage-xls.py path/to/20260828.xls --inspect

【単位の変換】
  JPXの掲載単位は 千株 / 百万円。ARBITRAGE_BALANCE は 株 / 円 で持つため、
  ここで 1000倍 / 1000000倍 する。DB側では一切変換しない。

【表のどこを読んでいるか(2026年8月28日分で確認)】
  シートは1枚(「週間公表資料」)。行番号は固定ではなく、下記の手順で毎回探す:
    1. 「裁定取引に係る現物ポジション」を含む行を探す        → 表の開始位置
    2. その直後の「売りポジション」「買いポジション」の行     → 売り/買いの列境界
    3. その次の「当限」「翌限以降」「合計」の行               → 期の列位置
    4. 表の中の「株　数」「金　額」の行                       → 値
  行・列を固定で決め打ちしないのは、週によってセル結合がずれても壊れないようにするため。
  ただし表の構造そのものが変わったら検出できないので、
  下記のバリデーションで気づけるようにしてある。

【バリデーション(壊れたまま気づかず取り込まないための仕掛け)】
  ・当限 + 翌限以降 = 合計 が成り立つか(株数・金額の両方)
  ・買残の合計金額が 1000億〜10兆円の範囲に収まるか(桁と、売り/買いの取り違え検出)
  ・表題に書かれた月日が、ファイル名の日付と一致するか
  いずれかが崩れたら、その行はCSVに出さずエラーとして報告する。
"""

import argparse
import csv
import os
import re
import sys
from datetime import date

try:
    import xlrd
except ImportError:
    sys.exit('xlrd がありません。 pip3 install xlrd を実行してください。')

VOL_UNIT = 1000        # 千株 → 株
VAL_UNIT = 1000000     # 百万円 → 円

# 買残の合計金額(円)の妥当範囲。桁の取り違えと、売り/買いの列の取り違えを弾く。
# 実績としては概ね1兆〜3兆円だが、過去に遡ると幅があるので広めに取ってある。
BUY_TOTAL_MIN = 100_000_000_000        # 1000億円
BUY_TOTAL_MAX = 10_000_000_000_000     # 10兆円

CSV_HEADER = [
    'pos_date',
    'buy_cur_vol', 'buy_cur_val', 'buy_nxt_vol', 'buy_nxt_val',
    'sell_cur_vol', 'sell_cur_val', 'sell_nxt_vol', 'sell_nxt_val',
    'src_file',
]


def norm(v):
    """セルの値を、比較しやすい文字列に正規化する。
    JPXの表は「株　　数」のように全角空白で桁を揃えているため空白を全て除去する
    (この癖は csvMapper.clampText() が空売り残高報告でやっているのと同じ理由)。"""
    if v is None:
        return ''
    s = str(v)
    return re.sub(r'[\s　]+', '', s)


def cell_num(sheet, r, c):
    """数値セルなら float を、それ以外(空欄・'-'・文字列)なら None を返す。"""
    if r >= sheet.nrows or c >= sheet.ncols:
        return None
    v = sheet.cell_value(r, c)
    if isinstance(v, float) and not isinstance(v, bool):
        return v
    return None


def find_row(sheet, predicate, start=0, end=None):
    """条件を満たす最初の行番号を返す。見つからなければ None。"""
    end = sheet.nrows if end is None else min(end, sheet.nrows)
    for r in range(start, end):
        texts = [norm(sheet.cell_value(r, c)) for c in range(sheet.ncols)]
        if predicate(texts):
            return r
    return None


def parse_sheet(sheet, src_file):
    """シートから裁定取引に係る現物ポジションを読み取り、dictで返す。
    構造が想定と違えばValueErrorを投げる。"""

    # --- 1. 表の開始位置 -----------------------------------------------------
    sec = find_row(sheet, lambda t: any('裁定取引に係る現物ポジション' in x for x in t))
    if sec is None:
        raise ValueError('「裁定取引に係る現物ポジション」の表が見つかりません')

    # 表の終わりは「(注)」または「取引参加者別」まで。値の探索範囲を閉じておかないと
    # 下にある別の表の「株数」行を拾ってしまう。
    sec_end = find_row(
        sheet,
        lambda t: any(x.startswith('（注）') or x.startswith('(注)') or '取引参加者別' in x for x in t),
        start=sec + 1,
    )
    sec_end = sec_end if sec_end is not None else sheet.nrows

    # --- 2. 売り/買いの列境界 ------------------------------------------------
    side_row = find_row(
        sheet,
        lambda t: any('売りポジション' in x for x in t) and any('買いポジション' in x for x in t),
        start=sec + 1, end=sec_end,
    )
    if side_row is None:
        raise ValueError('「売りポジション」「買いポジション」の行が見つかりません')

    sell_col = buy_col = None
    for c in range(sheet.ncols):
        t = norm(sheet.cell_value(side_row, c))
        if '売りポジション' in t and sell_col is None:
            sell_col = c
        if '買いポジション' in t and buy_col is None:
            buy_col = c
    if sell_col is None or buy_col is None or not (sell_col < buy_col):
        raise ValueError(f'売り/買いの列を特定できません (sell={sell_col}, buy={buy_col})')

    # --- 3. 期(当限/翌限以降/合計)の列位置 -----------------------------------
    hdr_row = find_row(
        sheet,
        lambda t: any(x == '当限' for x in t) and any(x == '翌限以降' for x in t),
        start=side_row, end=sec_end,
    )
    if hdr_row is None:
        raise ValueError('「当限」「翌限以降」の見出し行が見つかりません')

    # 列 → (side, term) の対応表を作る。売りブロックが左、買いブロックが右。
    colmap = {}
    for c in range(sheet.ncols):
        t = norm(sheet.cell_value(hdr_row, c))
        if t not in ('当限', '翌限以降', '合計'):
            continue
        side = 'sell' if c < buy_col else 'buy'
        term = {'当限': 'cur', '翌限以降': 'nxt', '合計': 'tot'}[t]
        colmap[(side, term)] = c

    need = [(s, t) for s in ('sell', 'buy') for t in ('cur', 'nxt', 'tot')]
    missing = [k for k in need if k not in colmap]
    if missing:
        raise ValueError(f'見出しの列を特定できません: {missing}')

    # --- 4. 株数行・金額行 ---------------------------------------------------
    # 「前週末比」の行は読まない(必要ならDB側でLAGで出せる)。
    vol_row = find_row(sheet, lambda t: any(x == '株数' for x in t), start=hdr_row, end=sec_end)
    val_row = find_row(sheet, lambda t: any(x == '金額' for x in t), start=hdr_row, end=sec_end)
    if vol_row is None or val_row is None:
        raise ValueError(f'株数/金額の行が見つかりません (vol={vol_row}, val={val_row})')

    out = {}
    for (side, term), c in colmap.items():
        v = cell_num(sheet, vol_row, c)
        a = cell_num(sheet, val_row, c)
        if v is None or a is None:
            raise ValueError(f'{side}_{term} の値が数値ではありません (col={c})')
        out[f'{side}_{term}_vol'] = int(round(v * VOL_UNIT))
        out[f'{side}_{term}_val'] = int(round(a * VAL_UNIT))

    # --- 5. 表題に書かれた月日 -----------------------------------------------
    title = ' '.join(norm(sheet.cell_value(sec, c)) for c in range(sheet.ncols))
    m = re.search(r'(\d{1,2})月(\d{1,2})日現在', title)
    out['_title_md'] = (int(m.group(1)), int(m.group(2))) if m else None
    out['_src_file'] = src_file
    return out


def validate(rec, pos_date, strict=True):
    """内訳と合計、桁、日付の整合を確認する。問題があればメッセージのリストを返す。"""
    problems = []

    for side in ('sell', 'buy'):
        for kind in ('vol', 'val'):
            cur = rec[f'{side}_cur_{kind}']
            nxt = rec[f'{side}_nxt_{kind}']
            tot = rec[f'{side}_tot_{kind}']
            if cur + nxt != tot:
                problems.append(
                    f'{side}_{kind}: 当限({cur}) + 翌限以降({nxt}) = {cur + nxt} が '
                    f'合計({tot}) と一致しません'
                )

    buy_tot = rec['buy_tot_val']
    if not (BUY_TOTAL_MIN <= buy_tot <= BUY_TOTAL_MAX):
        problems.append(
            f'買残の合計金額 {buy_tot:,}円 が想定範囲外です。'
            f'単位の取り違えか、売り/買いの列が入れ替わっている可能性があります'
        )

    md = rec.get('_title_md')
    if md is not None and md != (pos_date.month, pos_date.day):
        problems.append(
            f'表題の日付({md[0]}月{md[1]}日) と ファイル名の日付({pos_date}) が一致しません'
        )
    elif md is None and strict:
        problems.append('表題から「M月D日現在」を読み取れませんでした')

    return problems


def pos_date_from_filename(path):
    """ファイル名の YYYYMMDD 8桁を基準日として使う。
    表題には年が書かれていないため(「8月28日現在」)、年をまたぐ週で
    表題だけから年を決めるのは危険。ファイル名を正とし、月日で突き合わせる。"""
    base = os.path.basename(path)
    m = re.search(r'(20\d{2})(\d{2})(\d{2})', base)
    if not m:
        raise ValueError(f'ファイル名から日付(YYYYMMDD)を読み取れません: {base}')
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def process(path, inspect=False):
    pos_date = pos_date_from_filename(path)
    book = xlrd.open_workbook(path)
    last_err = None
    for sheet in book.sheets():
        try:
            rec = parse_sheet(sheet, os.path.basename(path))
        except ValueError as e:
            last_err = e
            continue
        problems = validate(rec, pos_date)
        return pos_date, rec, problems
    raise ValueError(f'{os.path.basename(path)}: {last_err}')


def main():
    ap = argparse.ArgumentParser(description='JPX週間公表資料(.xls)から裁定取引残高CSVを作る')
    ap.add_argument('path', help='.xls ファイル、またはそれらが入ったディレクトリ')
    ap.add_argument('--out', help='CSVの出力先。省略時は標準出力')
    ap.add_argument('--inspect', action='store_true',
                    help='CSVを書かず、読み取った値を人間が読める形で表示する')
    args = ap.parse_args()

    if os.path.isdir(args.path):
        files = sorted(
            os.path.join(args.path, f) for f in os.listdir(args.path)
            if f.lower().endswith('.xls') and not f.startswith('~$')
        )
    else:
        files = [args.path]
    if not files:
        sys.exit(f'.xls が見つかりません: {args.path}')

    rows, failed = [], 0
    for f in files:
        try:
            pos_date, rec, problems = process(f)
        except (ValueError, xlrd.XLRDError) as e:
            print(f'[NG] {os.path.basename(f)}: {e}', file=sys.stderr)
            failed += 1
            continue

        if problems:
            failed += 1
            print(f'[NG] {os.path.basename(f)} ({pos_date})', file=sys.stderr)
            for p in problems:
                print(f'     - {p}', file=sys.stderr)
            continue

        if args.inspect:
            print(f'--- {os.path.basename(f)}  基準日 {pos_date} ---')
            print(f'  裁定買残  当限 {rec["buy_cur_vol"]:>16,}株  {rec["buy_cur_val"]:>18,}円')
            print(f'            翌限 {rec["buy_nxt_vol"]:>16,}株  {rec["buy_nxt_val"]:>18,}円')
            print(f'            合計 {rec["buy_tot_vol"]:>16,}株  {rec["buy_tot_val"]:>18,}円'
                  f'  ({rec["buy_tot_val"] / 100000000:,.0f}億円)')
            print(f'  裁定売残  当限 {rec["sell_cur_vol"]:>16,}株  {rec["sell_cur_val"]:>18,}円')
            print(f'            翌限 {rec["sell_nxt_vol"]:>16,}株  {rec["sell_nxt_val"]:>18,}円')
            print(f'            合計 {rec["sell_tot_vol"]:>16,}株  {rec["sell_tot_val"]:>18,}円'
                  f'  ({rec["sell_tot_val"] / 100000000:,.0f}億円)')
            net = rec['buy_tot_val'] - rec['sell_tot_val']
            print(f'  ネット(買-売)          {net:>18,}円  ({net / 100000000:,.0f}億円)')
            continue

        rows.append([
            pos_date.isoformat(),
            rec['buy_cur_vol'], rec['buy_cur_val'], rec['buy_nxt_vol'], rec['buy_nxt_val'],
            rec['sell_cur_vol'], rec['sell_cur_val'], rec['sell_nxt_vol'], rec['sell_nxt_val'],
            rec['_src_file'],
        ])

    if not args.inspect:
        out = open(args.out, 'w', newline='', encoding='utf-8') if args.out else sys.stdout
        try:
            w = csv.writer(out)
            w.writerow(CSV_HEADER)
            w.writerows(rows)
        finally:
            if args.out:
                out.close()
        print(f'{len(rows)}件を書き出しました' + (f' → {args.out}' if args.out else ''),
              file=sys.stderr)

    if failed:
        print(f'{failed}件が検証に失敗しました。上のメッセージを確認してください。', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
