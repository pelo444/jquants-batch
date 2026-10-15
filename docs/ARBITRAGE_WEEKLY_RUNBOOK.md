# 裁定取引残高(JPX週間公表資料)の週次取り込み手順

JPX の「プログラム売買」ページで毎週公表される週間公表資料(.xls)から、
**裁定取引に係る現物ポジション(裁定買残・裁定売残)** を `ARBITRAGE_BALANCE` に取り込む手順書。
このプロジェクトで唯一 J-Quants 由来ではないテーブルで、**週1回、手で実行する**。

背景・設計の理由は `docs/PROJECT.md`(裁定取引残高の節)と `ddl/17_arbitrage_balance.sql` の冒頭コメントにある。
この文書は「毎週何を打つか」「何を見て正常と判断するか」「止まったらどうするか」だけをまとめる。

## 1. 先に知っておくこと

| 項目 | 内容 |
|---|---|
| 公表タイミング | 毎週**第3営業日の午後**に、前週末(通常は金曜)時点の分が出る |
| 入手先ページ | `https://www.jpx.co.jp/markets/statistics-equities/program/01.html` |
| ページ名の罠 | 週間版(株数＋金額)は「裁定取引」ではなく**「プログラム売買」**ページにある。「裁定取引」ページ(`program/index.html`)は日次版で株数のみ・ファイル名が YYMMDD 6桁。取り違えない |
| ファイル | `YYYYMMDD.xls`(8桁、旧形式BIFF8)。CSVは提供されていない |
| 対象の表 | シート「週間公表資料」の「２．裁定取引に係る現物ポジション」だけ。他の表は使わない |
| 単位 | JPX は千株・百万円。変換スクリプトが**株・円**に直す(DB側では変換しない) |
| 保存先 | `~/apps/jquants/manual_dl_datas/program_weekly/`(リポジトリ外) |
| 日次バッチ | `loadDaily.js` の Phase には**入れていない**。自動取得できないものを混ぜると毎晩失敗し、本来の失敗通知が埋もれるため |

## 2. 事前準備(初回のみ)

- Node 18 以降(ダウンローダは組み込み `fetch` を使い、追加ライブラリなし)
- `pip3 install xlrd`(変換スクリプトだけが Python。xlrd 2.x で .xls は読める)
- `.env` に DB 接続情報(`GD_JQUANTS`)があること。Oracle に接続するのは手順3(取り込み)だけ

**実行場所**: `jquants-batch/` 直下、DB に接続できる環境(普段の Mac のターミナル)。
Claude(Cowork)の device_bash からは DB 接続を直接実行できないため、手順3は自分で打つ。

## 3. 毎週の手順

```bash
cd ~/apps/jquants/jquants-batch

# 1. 最新5週分の .xls を取得(取得済みはスキップされ、新しい週だけ落ちる)
node scripts/download-arbitrage-archives.js --latest

# 2. ディレクトリ内の全 .xls から CSV を作り直す
python3 scripts/convert-arbitrage-xls.py ~/apps/jquants/manual_dl_datas/program_weekly \
    --out ~/apps/jquants/manual_dl_datas/arbitrage_balance.csv

# 3. DB に触らず内容だけ確認
node src/loadArbitrage.js ~/apps/jquants/manual_dl_datas/arbitrage_balance.csv --dry-run

# 4. 本投入
node src/loadArbitrage.js ~/apps/jquants/manual_dl_datas/arbitrage_balance.csv
```

- 手順2は毎回全ファイルから CSV を作り直す。手順4は `pos_date` 単位の MERGE なので、**古い週を含んでいても差分だけが入り、何度流しても結果は同じ**(冪等)。古い .xls を消す必要はない
- 手順1の前に `node scripts/download-arbitrage-archives.js --dry-run` で何が落ちるか確認できる
- 中身を人間が読める形で見たいときは、手順2のかわりに
  `python3 scripts/convert-arbitrage-xls.py ~/apps/jquants/manual_dl_datas/program_weekly/20261002.xls --inspect`
- 手で落とした .xls を `program_weekly/` に置いても構わない(手順2から始める)

### ダウンローダのオプション

| オプション | 意味 |
|---|---|
| `--latest` | 最新ページ(`01.html`、直近5週)だけ。**毎週の運用はこちら** |
| (なし) | 最新ページ＋バックナンバー(`01-archives-NN.html`、直近4年分)を全部 |
| `--dry-run` | 対象を表示するだけでダウンロードしない |
| `--force` | 取得済みでも再取得する |
| `--out <dir>` | 出力先を変える(既定は `../manual_dl_datas/program_weekly`) |
| `--delay <ms>` | ダウンロード間隔(既定 1000ms) |

ファイルURLの `<ハッシュ>-att/` 部分に規則性がないため、URL は組み立てず、必ずページの href を拾う方式。
**逐次・1秒間隔で、並列化しない**(JPXへの負荷配慮)。JPXがエラーページを返したときに
.xls として保存しないよう、先頭4バイト(`D0 CF 11 E0`)を検査している。

## 4. 自動検証と、止まるもの・止まらないもの

| 段階 | 検査 | 外れたとき |
|---|---|---|
| 変換 | 当限＋翌限以降＝合計(株数・金額とも) | その週はCSVに出さず、エラーとして報告 |
| 変換 | 買残の合計金額が 1,000億〜10兆円 | 同上(単位の取り違え、売買列の入れ替わりを検出) |
| 変換 | 表題の「M月D日現在」とファイル名の日付が一致 | 同上 |
| 変換 | 表の見出し(「売りポジション」「買いポジション」「当限」「翌限以降」)が見つかる | 同上。行・列は決め打ちせず毎回見出しから探すので、セルのずれには強いが、表の構造そのものが変わると検出されて止まる |
| 取込前 | 買残の合計金額が 100億〜20兆円、株数が負でない | **errors = 取り込み中止** |
| 取込前 | 売残 > 買残 | **warnings = 警告のみで続行** |

- 合計(TOT)は CSV にもステージングにも持たせず、MERGE 側で当限＋翌限以降から算出する。
  ファイルの合計欄をそのまま信じると、内訳と食い違うファイルを取り込んでしまうため
- 「売残 > 買残」は異常ではない。2023年1月の3週(1/6・1/13・1/20)は実際に売り長だった。
  止めてよいのは「起きたら確実に壊れている」ものだけ、という切り分け
- 水準は年々大きく動く(買残の年平均: 2023年 9,293億円 → 2026年 26,935億円、最小 3,462億円・最大 38,684億円)。
  桁の検査を直すときはこの変動幅を見込むこと

## 5. 取り込み後の確認

```sql
-- 直近10週。億円換算で 1000〜30000 程度、基準日は通常金曜
SELECT TO_CHAR(pos_date,'YYYY-MM-DD') AS pos_date, buy_oku_yen, sell_oku_yen, net_oku_yen, net_wow_oku_yen
FROM v_arbitrage_balance_weekly
ORDER BY pos_date DESC
FETCH FIRST 10 ROWS ONLY;
```

追加の確認(`ddl/17_arbitrage_balance.sql` の「5. 取込後の確認」にSQLあり):

- 期間と件数: 最新の `pos_date` が今回取り込んだ週になっているか
- 曜日: 金曜以外が出たら取込ミスを疑う(祝日の週は木曜になる)
- 週の抜け: 祝日でもないのにデータがない週がないか(GW・お盆・年末年始の連休で抜けるのは正常)

## 6. ハマりどころ

| 症状・罠 | 原因と対処 |
|---|---|
| ファイルが見つからない | 「裁定取引」ページ(日次版)を見ている。**「プログラム売買」ページ**(`program/01.html`)が週間版 |
| エラーメッセージの日付が1日前 | JS の `toISOString().slice(0,10)` は JST で1日ずれる。`loadArbitrage.js` の `fmtDate()` を使う(DBに入る値は正しい) |
| 当限の増減を見て「解消された」と読んでしまう | 買残はほぼ全額が当限に乗り、SQ前に翌限以降へロールオーバーされる。**合計**で見る。ビューの `buy_cur_share_pct` が当限の構成比 |
| `ModuleNotFoundError: xlrd` / 「xlrd がありません」 | `pip3 install xlrd` |
| 変換でその週だけエラー | JPX側のファイル形式が変わった可能性。`--inspect` で読み取り結果を確認し、`convert-arbitrage-xls.py` の見出し探索を直す |
| 金額が3桁ずれる | 千株・百万円のまま入った。CSVを手編集していないか確認(取込前チェックの errors で止まる) |
| 古い週が取れない | JPXのバックナンバーは直近4年分のみ。再取得できない期間ができるので、投入済みデータを消さない |
| 誤って入れた日付を消したい | MERGE では行が消えない。明示的に `DELETE FROM arbitrage_balance WHERE pos_date = DATE '…'` |
| 新テーブル/ビューを足したら claude_ro で ORA-00942 | `ddl/18_grant_claude_readonly_phase8_17.sql` のように GRANT とシノニムを追加する(`arbitrage_balance`・`v_arbitrage_balance_weekly` は設定済み) |

## 7. 関係するファイル

| ファイル | 役割 |
|---|---|
| `scripts/download-arbitrage-archives.js` | .xls のダウンロード(依存なし、逐次、取得済みスキップ) |
| `scripts/convert-arbitrage-xls.py` | .xls → CSV(単位変換・検証。唯一の Python) |
| `src/loadArbitrage.js` | CSV → ステージング → MERGE(`--dry-run` あり、`sanityCheck()`) |
| `src/mergeSql.js` の `mergeArbitrageBalance()` | MERGE 本体。合計の算出、同一日付の重複は `src_file` 降順で1件に |
| `ddl/17_arbitrage_balance.sql` | `ARBITRAGE_BALANCE`・`ARBITRAGE_BALANCE_STG`・`V_ARBITRAGE_BALANCE_WEEKLY`、確認SQL、ロールバック手順 |
| `ddl/18_grant_claude_readonly_phase8_17.sql` | claude_ro への GRANT・シノニム |

### CSV レイアウト(変換スクリプトの出力)

```
pos_date,buy_cur_vol,buy_cur_val,buy_nxt_vol,buy_nxt_val,sell_cur_vol,sell_cur_val,sell_nxt_vol,sell_nxt_val,src_file
```

株数は株、金額は円。`pos_date` は `YYYY-MM-DD`。

## 8. 作り直し(ロールバック)

表の定義そのものを変えるとき以外は不要。DROP すると取り込み済みの裁定残が消え、
JPXのバックナンバーが直近4年分しかないため**再取得できない期間が出る**。
やり直す前に退避すること(手順は `ddl/17_arbitrage_balance.sql` の「6. 作り直したいとき」)。
