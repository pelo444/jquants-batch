# jquants プロジェクト 引き継ぎドキュメント

日本株の分析基盤。J-Quants API から取得したデータを Oracle Autonomous Database (ATP) に蓄積し、
そこから値動きの傾向を調べるための一式。

---

## 0. このドキュメントについて

**目的**: 新しい会話・新しい担当者が、過去のやりとりを読み返さずに作業を再開できるようにする。

**書くこと**: 決めたこと と **なぜそう決めたか**。特に「一度失敗して直した結果いまの形になっている」箇所は、
理由を残さないと同じ失敗を繰り返す。

**書かないこと**: コードを読めば分かること。各ファイルの詳細な仕様はソース冒頭のコメントに書いてある。

**更新のタイミング**: 設計判断をしたとき、J-Quants 側の想定外の挙動を見つけたとき、タグ体系を変えたとき。

**新しい会話の始め方**:

> `jquants-batch/docs/PROJECT.md` を読んでから、〇〇をお願いします。

---

## 1. 全体像

作業の柱は 2 つある。**プロジェクトは分けず、会話（スレッド）だけを分ける**方針。

| 柱 | 内容 | 主な成果物 |
|---|---|---|
| データ基盤 | J-Quants からの取り込み、テーブル設計、バッチ運用 | `jquants-batch/`, `ddl/` |
| トレンド調査 | 銘柄の分類（タグ付け）、値動きの分析 | `queries/`, `trend_analysis/`, タグ体系 |

2 つは独立していない。「空売り残高をどう読むか」を理解した結果が `equity_short_position` のテーブル設計になり、
「このテーマで株価が動くか」の判断がタグ体系になる。**理解 → 設計判断** の連結を切らないため、同じ場所で扱う。

金融知識の探索が長くなるときは別会話に切り出し、結論が「何を作るか」に固まった時点でこちらに持ち込む
（空売り関連の取り込みは実際にこの流れで進めた）。

---

## 2. ディレクトリ構成と配置ルール

```
/Users/pelo8/apps/jquants/
├── ddl/                     DDL・マイグレーション（gitリポジトリ外）
│   ├── 01_create_user_and_tables.sql   ユーザー作成 + 中核テーブル
│   ├── 02_staging_tables.sql           マスタ・株価のステージング
│   ├── 03_load_progress.sql            取込進捗テーブル
│   ├── 04_alter_column_sizes.sql       桁拡張（既存環境向け）
│   ├── 05_tag_master.sql               タグマスタ + FK + v_equity_tag
│   ├── 06_tag_master_add_230.sql       タグ追加（再エネ）
│   ├── 07_tag_master_add_300.sql       タグ追加（金融）
│   ├── 08_short_selling_tables.sql     空売り・信用取引の4テーブル一式
│   ├── 09_short_position_normalize_spaces.sql  既存行の空白正規化
│   ├── 10_create_claude_readonly_user.sql  Claude Desktop用読取専用ユーザー
│   └── 11_calendar_and_indices.sql     取引カレンダー・指数四本値・指数マスタ
│   └── 12_investor_types_and_earnings_date.sql  投資部門別情報・決算発表予定日
├── jquants-batch/           ★ gitリポジトリ（GitHub: pelo444/jquants-batch）
│   ├── src/                 取り込み・チャート・Webアプリ
│   ├── scripts/             運用スクリプト・調査ツール
│   ├── docs/PROJECT.md      このファイル
│   └── output/              chart.js の出力（gitignore）
├── queries/
│   ├── sql/                 分析用SQL
│   └── output/              SQLの実行結果（Excel/CSV）
├── trend_analysis/          銘柄調査のメモ（Markdown）
└── sampledata/              APIレスポンスのサンプル
```

**配置ルール（過去に明示的に決めたこと）**

- J-Quants API を介したデータ取り込みの変更は、必ず **`jquants-batch/` 配下**を更新する。
- 分析用 SQL は **`queries/sql/`** に出力する。
- DDL は `ddl/` に **連番 + 内容が分かる名前** で追加する。既存ファイルは書き換えず、追加ファイルで積み上げる
  （適用済みの環境があるため。ただし `08_*.sql` のようにコメントだけの修正は既存ファイルを直す）。
- ファイル名は内容から分かる名前にする（`test.sql` `tmp2.sql` のような名前は付けない）。

**注意**: git リポジトリは `jquants-batch/` **だけ**。`ddl/` `queries/` `trend_analysis/` は
リポジトリ外なので、git では管理されていない。

---

## 3. 実行環境

| 環境 | 役割 | 備考 |
|---|---|---|
| MacBook Air | 開発、SQL の実行、chart.js の実行 | `~/apps/jquants/` |
| OCI VM インスタンス | 日次バッチ、Web アプリの稼働 | `/opt/jquants-batch/` |
| Oracle ATP | データ本体 | ユーザー `GD_JQUANTS` |

**コードの流れ**: Mac で編集 → `git push origin main` → VM で `git pull` → VM で実行。

VM 側で直接編集すると Mac 側と食い違うので**しない**（過去に `loadDaily.js` を VM にだけ置いて
Mac に pull できていない状態になり、non-fast-forward の衝突を起こした）。

**接続情報**: `.env`（gitignore 済み）。雛形は `.env.example`。

```
JQUANTS_API_KEY / DB_USER / DB_PASSWORD / DB_CONNECT_STRING
```

---

## 4. データベース設計

### 4.1 テーブル一覧

**中核**

| テーブル | 内容 | 主キー |
|---|---|---|
| `equity_master` | 銘柄マスタ（最新断面） | `code` |
| `equity_master_hist` | 銘柄マスタの履歴（市場区分変更などを追える） | `code, as_of_date` |
| `equity_price_daily` | 日次四本値 + `adj_factor` | `code, price_date` |
| `load_progress` | 取込進捗（ファイル単位） | ファイルキー |

**分類・お気に入り**

| テーブル | 内容 |
|---|---|
| `tag_master` | タグの定義（番号・大分類・説明） |
| `favorite_tag` | 銘柄へのタグ付与（`code, tag_name` の多対多） |
| `favorite_master` | 監視中・購入候補などのフラグ |
| `v_equity_tag` | 上記を銘柄名付きで引くビュー |

**空売り・信用取引**（`08_short_selling_tables.sql`）

| テーブル | 元エンドポイント | 主キー | 粒度 |
|---|---|---|---|
| `sector_short_ratio` | `/markets/short-ratio` | `s33_code, ratio_date` | 33業種 × 日 |
| `equity_margin_interest` | `/markets/margin-interest` | `code, app_date` | 銘柄 × 申込日（2026-09-24以前は週末時点、9-25以降は日次） |
| `equity_margin_alert` | `/markets/margin-alert` | `code, app_date, pub_date` | 日々公表銘柄のみ |
| `equity_short_position` | `/markets/short-sale-report` | `position_id`（代理キー） | 銘柄 × 報告者 × 計算日 |

ビュー: `v_sector_short_ratio` / `v_equity_short_position_sum` / `v_equity_margin_alert_latest` / `v_equity_short_overview`

**「銘柄ごとの空売り残高」を見たいときの入口は `v_equity_short_position_sum`**
（報告者別の明細を 銘柄 × 計算日 で合算したもの。`reporter_count` = 何者が 0.5% 以上の
空売りを報告しているか。数が増えるほど売り方の関心が強い）。

`v_equity_margin_alert_latest` は、過誤訂正で同一申込日に複数の公表日がある行から
**公表日が最新のものだけ**を返す。訂正前の値も見たいときは実表を直接参照する。

各テーブルには `*_stg`（ステージング）が対になっている。

**取引カレンダー・指数四本値**（`11_calendar_and_indices.sql`。2026-09-06 実データ確認・初回投入 完了）

| テーブル | 元エンドポイント | 主キー |
|---|---|---|
| `trading_calendar` | `/markets/calendar` | `calendar_date` |
| `topix_price_daily` | `/indices/bars/daily/topix` | `price_date` |
| `index_price_daily` | `/indices/bars/daily` | `index_code, price_date` |
| `index_master` | (手動管理・参考データ) | `index_code` |

`index_master` はJ-Quantsにマスタ配信APIが無いため`tag_master`と同様に手動管理。
新しい指数コードが追加されたら都度INSERTを足す。

**投資部門別情報・決算発表予定日**（`12_investor_types_and_earnings_date.sql`。2026-09-06 実データ確認・初回投入 完了）

| テーブル | 元エンドポイント | 主キー | 備考 |
|---|---|---|---|
| `investor_type_trading` | `/equities/investor-types` | `section, st_date, en_date, pub_date` | 市場単位・週次。52列(13部門×4指標) |
| `earnings_schedule` | `/fins/earnings-date` | `code, fye, fq_name, pub_date` | 補助データ(FK skip対象) |

ビュー: `v_investor_type_trading_latest`（`section, st_date, en_date`単位で公表日最新）、
`v_earnings_schedule_latest`（`code, fq_name`単位で公表日最新。決算期末はパーティションに含めない）。

いずれも過誤訂正・予定日変更を「同一キーで公表日違いの複数行」として保持する方式で、
`equity_margin_alert`と同じパターン。詳細は DDL 冒頭コメントを参照。

**財務情報・日経225オプション四本値**（`13_financial_summary_and_options.sql`。実装済み・**実データ未確認**）

| テーブル | 元エンドポイント | 主キー | 備考 |
|---|---|---|---|
| `financial_summary` | `/fins/summary` | `disc_no` | 補助データ(FK skip対象)。111列。DiscNoは開示単位でグローバルに一意 |
| `index_option_price_daily` | `/derivatives/bars/daily/options/225` | `trade_date, code, em_mrgn_trg_div` | FKなし。緊急取引証拠金発動時は同一日・銘柄で2行 |

ビュー: `v_financial_summary_latest`（`code, cur_per_type, cur_per_en`単位でDiscNo最大=最後に開示された行）。

財務情報は投資部門別情報等と異なり、DiscNo自体が開示イベントの代理キーとして
機能するため、同一キーへの単純MERGE(上書き)方式にしている(公表日違いの複数行を
保持する方式ではない)。数値項目は全て文字列型・空文字=未開示(0ではない)で来る前提。

**このTierはCowork(Claude)のdevice_bashからapi.jquants.comへ到達できないため
`inspect-bulk-csv.js`での実データ確認ができていない。本番投入前に必ず**
```bash
node scripts/inspect-bulk-csv.js financial-summary options-225 --rows 3
```
**を実行し、ヘッダー名・空欄表現が想定通りか確認すること。** 想定と違えば
`csvMapper.js`の`FINANCIAL_SUMMARY_*`/`OPTION_225_*`を実データに合わせて修正する。

### 4.2 設計上の決めごと

**（1） 取り込みは全て「ステージング → MERGE」**

CSV をそのままステージングに `executeMany` で流し込み、そこから本表へ `MERGE` する。
再実行しても同じ結果になる（冪等）ようにするため。

**（2） `equity_short_position` だけは MERGE ではなく洗い替え**

理由: `SSName` / `DICName` / `FundName` がいずれも NULL になり得るため、**自然キーが作れない**。
公表日（`disc_date`）単位で DELETE してから INSERT する（`mergeSql.replaceShortPosition`）。
主キーは意味を持たない代理キー（IDENTITY）。

**（3） 文字列長は「文字数」と「バイト数」の両方に上限がある**

`VARCHAR2(n CHAR)` は AL32UTF8 では最大 `n × 4` バイトを確保する。
`MAX_STRING_SIZE=STANDARD` の環境では 4000 バイトが上限なので、**`1000 CHAR` を超える指定はできない**
（`2000 CHAR` = 8000 バイトで `ORA-00910`）。

そのため `csvMapper.validateLengths()` は `maxSize`（バイト）と `maxChars`（文字）を**別々に**検査する。
バイト数だけ見ていると、ASCII 1200 文字が検査を通過して INSERT 時に `ORA-12899` になる。

**（4） 自由記述の列だけは、例外で止めずに切り詰める**

`notes` / `ss_name` / `ss_addr` / `dic_name` / `dic_addr` / `fund_name` は
`csvMapper.clampText()` を通す。

1. 連続する空白（半角・全角・タブ・改行）を半角スペース1つに詰める
2. それでも上限を超える場合だけ 1000 文字で切り詰め、末尾に「…」を付ける

これは提出様式の桁揃えの空白がそのまま CSV に入ってくるため
（2021年4月の訂正報告は 本文123文字 + 空白950文字 = 1073文字 だった）。
**桁が足りないのではなく空白が入っているだけ**なので、CLOB 化も `4000 BYTE` への拡張も不要。

商号にも同じ正規化をかけている。空白が残ると**同一の報告者が別名として集計される**ため。

**（5） 銘柄コードは 5 桁（`68570`）で持つ**

J-Quants の仕様に合わせる。ユーザーが 4 桁（`6857`）で入力することを想定して、
`chart.js` / Web アプリ側で 4 桁 → 5 桁の補完をしている。

---

## 5. 取り込み処理

### 5.1 API の使い方

**Bulk API（CSV 一括取得）を使う。** 通常の REST エンドポイントは使わない。

```
GET /bulk/list?endpoint=<name>   → ファイル一覧（数千件）
GET /bulk/get?key=<Key>          → gzip された CSV の署名付きURL
```

契約プランは **Standard**。

| 定数 | エンドポイント |
|---|---|
| `ENDPOINT_MASTER` | `/equities/master` |
| `ENDPOINT_PRICE` | `/equities/bars/daily` |
| `ENDPOINT_SHORT_RATIO` | `/markets/short-ratio` |
| `ENDPOINT_MARGIN_INTEREST` | `/markets/margin-interest` |
| `ENDPOINT_MARGIN_ALERT` | `/markets/margin-alert` |
| `ENDPOINT_SHORT_POSITION` | `/markets/short-sale-report` |
| `ENDPOINT_FINANCIAL_SUMMARY` | `/fins/summary` |
| `ENDPOINT_OPTION_225` | `/derivatives/bars/daily/options/225` |

### 5.2 Phase 構成

`loadInitial.js`（初回・過去分）と `loadDaily.js`（日次）で同じ Phase 番号を使う。

| Phase | 内容 | 投入先 |
|---|---|---|
| 1 | 銘柄マスタ | `equity_master` / `equity_master_hist` |
| 2 | 上場廃止フラグの更新 | `equity_master.delisted_flag` |
| 3 | 株価四本値 | `equity_price_daily` |
| 4 | 業種別空売り比率 | `sector_short_ratio` |
| 5 | 信用取引残高 | `equity_margin_interest` |
| 6 | 日々公表信用取引残高 | `equity_margin_alert` |
| 7 | 空売り残高報告 | `equity_short_position` |
| 8 | 取引カレンダー | `trading_calendar` |
| 9 | TOPIX四本値 | `topix_price_daily` |
| 10 | 指数四本値 | `index_price_daily` |
| 11 | 投資部門別情報 | `investor_type_trading` |
| 12 | 決算発表予定日 | `earnings_schedule` |
| 13 | 財務情報 | `financial_summary` |
| 14 | 日経225オプション四本値 | `index_option_price_daily` |

Phase 4〜7 は `equity_master` への外部キーを持つので、**Phase 1 の完了後**に実行する。
Phase 8〜10 は銘柄単位のデータではないため `equity_master` への外部キーを持たず、
Phase 1 と独立して(先に)実行しても問題ない。
Phase 11 も銘柄単位ではないため外部キーを持たない。Phase 12 は補助データとして
`equity_master` への外部キーを持つため Phase 1 の完了後に実行する。
Phase 13 も補助データとして `equity_master` への外部キーを持つため Phase 1 の完了後に
実行する。Phase 14 はオプション銘柄コードで外部キーを持たない。

**一部だけ実行する**:

```bash
node src/loadInitial.js --only short              # Phase 4〜7
node src/loadInitial.js --only indices             # Phase 8〜10
node src/loadInitial.js --only tier2               # Phase 11〜12
node src/loadInitial.js --only tier3               # Phase 13〜14
node src/loadInitial.js --only short-position     # Phase 7 だけ
node src/loadInitial.js --only short-ratio,margin-interest
```

グループ: `all` / `equity`（1〜3）/ `short`（4〜7）/ `indices`（8〜10）/ `tier2`（11〜12）/ `tier3`（13〜14）

### 5.3 再開と冪等性

`load_progress` にファイル単位で状態を記録し、`STATUS='SUCCESS'` のファイルはスキップする。
途中で落ちても同じコマンドで再開できる。

**最初からやり直したい場合は `load_progress` の該当行を削除する。**

### 5.4 取込済みの状況（2026-08-30 時点）

| Phase | 状況 |
|---|---|
| 1〜3（マスタ・株価） | 完了。過去10年分 |
| 4〜7（空売り・信用取引） | **初回投入 完了** |
| 8〜10（取引カレンダー・指数四本値） | **初回投入 完了**（2026-09-06） |
| 11〜12（投資部門別情報・決算発表予定日） | **初回投入 完了**（2026-09-06） |
| 13〜14（財務情報・日経225オプション四本値） | **実装済み・実データ未確認・初回投入 未実施**（2026-09-06） |

Phase 8〜10 は`inspect-bulk-csv.js`で実データを確認した結果、想定通りのヘッダーで
問題は無かった(`csvMapper.js`の修正は不要だった)。DDL適用・初回投入(`--only indices`)
ともにエラー無く完了している。

Phase 11〜12 はユーザーの手元で`inspect-bulk-csv.js`によるヘッダー確認・DDL適用・
初回投入(`--only tier2`)を実行し、エラー無く完了している。

Phase 13〜14 はDDL(`13_financial_summary_and_options.sql`)・`csvMapper.js`・
`mergeSql.js`・`loadInitial.js`・`loadDaily.js`・`inspect-bulk-csv.js`の対応まで
完了しているが、Cowork(Claude)のdevice_bashからapi.jquants.comへの通信が
egressで遮断されているため実データでの確認ができていない。ユーザーの手元で
次の順で実行すること:
1. `node scripts/inspect-bulk-csv.js financial-summary options-225 --rows 3` でヘッダー確認
2. 想定と違えば `csvMapper.js` の該当マッピングを実データに合わせて修正
3. `ddl/13_financial_summary_and_options.sql` を適用
4. `node src/loadInitial.js --only tier3` で初回投入

Phase 7（空売り残高報告）は全 139 ファイル。途中 2 回止まっており、いずれも対処済み:

- 名証単独上場銘柄（`38080`）による外部キー違反 → スキップして報告する方式に変更
- `notes` の文字数超過 → `clampText()` で空白を詰めてから切り詰める方式に変更（4.2(4)）

以降は `loadDaily.js` の日次実行で更新される。

**確認**: 初回投入より前に取り込んだ行には桁揃えの空白が残っているため、
`ddl/09_short_position_normalize_spaces.sql` を1回実行する必要がある（冪等）。
実行済みかどうかは、STEP 1 の「要正規化件数」が 0 かどうかで判定できる。

### 5.5 エラーの扱い方（明示的に決めた方針）

| データの位置づけ | 外部キー違反が出たとき |
|---|---|
| 中核（株価・マスタ） | **中断する**。データの欠損が分析結果を直接歪めるため |
| 補助（空売り・信用取引） | **スキップして最後に報告する**（`skipUnknownCodes` / `reportSkippedCodes`） |

`loadDaily.js` の Phase 4〜7 は、**1 つ落ちても他を止めない**。
各 Phase を try/catch で囲んで失敗を集め、最後にまとめて例外を投げる。

---

## 6. J-Quants 実データの癖（ハマりどころ）

過去に実際にぶつかったもの。**新しいエンドポイントを追加するときは必ず `inspect-bulk-csv.js` で確認する。**

**（1） 会社名の英数字が全角**

`co_name` は `ＫＤＤＩ` `ソフトバンクグループ` のように英数字が全角。
銘柄名で検索・照合する SQL では `TO_SINGLE_BYTE()` で正規化する。

**（2） `TO_SINGLE_BYTE()` は「・」も変換する**

`・`(U+30FB) → `･`(U+FF65) になる。中黒を除去したいときは**両方**を `REPLACE` する必要がある。

**（3） 実際の社名が想像と違う**

- `9432` は「日本電信電話」ではなく **`ＮＴＴ`**
- ガス会社は片仮名ではなく漢字: **東京瓦斯 / 大阪瓦斯 / 東邦瓦斯**
  （ただし 西部ガスHD / 静岡ガス は片仮名。統一されていない）

銘柄名で照合する SQL を書いたら、必ず「期待した社名で引けたか」を確認するステップを入れる。

**（4） 空欄の表現がエンドポイントで違う**

- 空売り残高報告: 空欄は空文字ではなく **`-`** で来る → `toStrDashNull()`
- ETF 等で算出できない数値: **`*`** で来る → `toNumRelaxed()`（`-` `*` `－` `＊` を NULL 扱い）
- ただし銘柄マスタの `ScaleCat` の `-` は「規模区分なし」という**意味のある値**なので NULL 化しない
  → 既定の `toStr()` は `-` を保持する仕様。使い分けに注意。

**（5） `PubReason` は 6 列に展開されず、1 列に Python 辞書形式の文字列で来る**

```
{'Restricted': '0', 'DailyPublication': '0', 'Monitoring': '0', ...}
```

シングルクォートなので JSON として解釈できない。`csvMapper.parsePubReason()` が
JSON.parse を試し、失敗したら正規表現で拾う。

**（6） マスタに存在しない銘柄コードが来る**

例: `38080` = オーケーウェブ（旧オウケイウェイヴ）。**名古屋証券取引所の単独上場**銘柄で、
J-Quants の銘柄マスタは東証銘柄しか持たない。
→ マスタの取込漏れではないので、スキップして報告する（5.4 参照）。

**（7） 自由記述に桁揃えの空白が大量に入る**

4.2(4) 参照。

**（8） 信用取引残高の金額項目は 2026-09-25 申込分以降のみ**

`ShrtVal` / `LongVal` などは古いファイルには存在しない。NULL 許容の列として定義し、
`inspect-bulk-csv.js` では `optional` として扱う（無くても異常ではない）。

---

## 7. 新しいエンドポイントを追加する手順（定型）

1. **`ddl/NN_*.sql`** — 本表・ステージング・インデックス・ビューを作る
2. **`src/csvMapper.js`** — `*_COLUMNS` / `*_VALUE_EXPRESSIONS` / `*_BIND_DEFS` / `map*Row()` を追加
3. **`src/mergeSql.js`** — `merge*()` を追加（自然キーが作れなければ洗い替え）
4. **`src/loadInitial.js`** — `ENDPOINT_*` 定数、`*_HANDLERS`、Phase 関数、`PHASE_DEFS` に登録
5. **`src/loadDaily.js`** — Phase 一覧に追加
6. **`scripts/inspect-bulk-csv.js`** — `TARGETS` に追加して実データのヘッダーを確認
7. **`queries/sql/*.sql`** — 分析用のクエリを書く

**必ず 6 を先に流す**。CSV のヘッダー名は API 仕様書に明記されていないため、
実データを見ないと列名も空欄の表現も分からない。

```bash
node scripts/inspect-bulk-csv.js                 # 全エンドポイント
node scripts/inspect-bulk-csv.js short-position  # 個別
```

---

## 8. タグ体系

### 8.1 番号ルール

`tag_master` で管理。タグ名は `<3桁番号>_<英字スラッグ>` の形式（例: `110_ai_model`）。

| 番号 | 大分類 |
|---|---|
| 100番台 | AI・テクノロジー |
| 200番台 | 資源・素材 |
| 300番台 | 金融 |

- **10 刻み**で採番する（`110` `120` …）。間の番号は細分用に空けてある。
- 番号を持たない**個別テーマ**は `tag_type='THEME'`、`tag_code` は NULL（例: `photoelectric_fusion` 光電融合）。
- 1 銘柄に複数タグを付与できる（`favorite_tag` の `UNIQUE(code, tag_name)`）。

### 8.2 現在のタグ

| タグ名 | 表示名 | 範囲 |
|---|---|---|
| `110_ai_model` | AIモデル開発 | 基盤モデル・LLM 自体の開発。国内上場では該当が少ない |
| `120_semi_design_mfg` | 半導体 設計・製造 | GPU/ASIC/HBM/パワー半導体。ファブレス・IDM・ファウンドリ |
| `130_semi_equip_material` | 半導体 製造装置・素材 | 製造/検査装置、ウエハ・レジスト・特殊ガス |
| `140_power_datacenter` | 電力・データセンターインフラ | 発電・送配電、DC 建設運営、冷却/電源/変圧器、通信インフラ |
| `150_ai_application` | AI応用サービス | AI が差別化要因・収益源になっている企業 |
| `210_rare_metal` | レアメタル・非鉄金属 | 採掘・製錬・加工・リサイクル |
| `220_energy_resource` | エネルギー・資源 | 石油・ガス・石炭・ウラン、資源権益を持つ商社 |
| `230_renewable_energy` | 再生可能エネルギー | 再エネ発電所の開発・保有・運営、再エネ EPC |
| `310_bank` | 銀行 | 上場する全ての銀行（311/312/313 と併用） |
| `311_bank_major` | 大手銀行・信託 | メガバンク・信託・ゆうちょ |
| `312_bank_regional` | 地方銀行 | 地銀・第二地銀とその持株会社 |
| `313_bank_digital` | ネット・決済系銀行 | ネット専業・決済プラットフォーム型 |
| `320_insurance` | 保険 | 生保・損保の引受会社とその持株会社 |
| `330_insurance_agency` | 保険代理店・保険ショップ | 募集・仲介。収益は募集手数料 |
| `photoelectric_fusion` | 光電融合 | IOWN 構想を含む個別テーマ |

### 8.3 タグを分ける／分けない基準

**判断の軸は「株価がそのテーマで動くか」**。事業として関わっているかではない。

- **分ける**: 同じ業種でも**値動きの要因（driver）が違う**なら別タグにする
  - `220`（資源市況で動く）と `230`（FIT/FIP・電力卸価格・金利で動く）
  - `320`（保険引受）と `330`（募集手数料）— JPX33業種ではどちらも「保険業」だが別物
  - `311`（海外金利・為替・政策保有株）/ `312`（国内利上げ・再編思惑）/ `313`（口座数・決済件数の成長）
- **分けない**: 銘柄数が少ないうちは細分しない。増えたら分割する
  - `130` → 将来 `131`=装置 / `132`=素材
  - `140` → 将来 `141`=電力 / `142`=DC 設備・運営
- **含めない**: 社内業務で AI を使っているだけの企業は `150` に含めない（範囲が発散するため）
  - 過去にメルカリ・Sansan を `110` に入れかけたが、GENIAC 採択はあるものの
    ドメイン特化モデルであり基盤モデル開発ではないため除外した

### 8.4 タグ付けの運用上の注意

- `tag_master` への投入は `MERGE` なので、**MERGE では行が消えない**。
  タグから銘柄を外すときは明示的に `DELETE` する（`05_tag_master.sql` の STEP 5 がその例）。
- `favorite_tag.tag_name` は `tag_master.tag_name` への外部キー。
  タグ名を変えるときは 新タグ INSERT → `favorite_tag` を UPDATE → 旧タグ DELETE の順。
- 候補銘柄の調査メモは `trend_analysis/*.md` に残す。

---

## 9. 分析 SQL を書くときの決めごと

**（1） 株価は必ず分割調整する**

「その日より後に発生した `adj_factor` の累積積」を終値に掛けて、期間末の株価水準に揃える。
Oracle には積の集計関数が無いので `EXP(SUM(LN(...)))` で代用する。

```sql
close_price *
NVL(EXP(SUM(LN(NULLIF(adj_factor, 0))) OVER (
      PARTITION BY code
      ORDER BY price_date
      ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)), 1)
```

- `NULLIF(adj_factor, 0)` … `LN(0)` を避ける
- **`NVL(..., 1)` は必須**。最終行は「自分より後の行」が無く `SUM()` が NULL になる
- 累積積は取得期間内の行だけが対象。期間より後の分割は反映されない

**（2） 銘柄名で照合するときは `TO_SINGLE_BYTE()` を通す**（6章(1)(2)参照）

**（3） よく使う Oracle 構文**

- 期間の最初/最後の値: `KEEP (DENSE_RANK FIRST/LAST ORDER BY ...)`
- 重複排除: `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)`
- コードのカンマ連結: `LISTAGG(code, ',') ... ON OVERFLOW TRUNCATE`
- 上位 n 件: `FETCH FIRST n ROWS ONLY`

**（4） 既存の分析 SQL**

| ファイル | 内容 |
|---|---|
| `rate_price_change.sql` | 指定期間の騰落率（Web アプリの一覧の元） |
| `tagged_equity_list.sql` | タグ付き銘柄の一覧 |
| `equity_search_by_code_or_name.sql` | コード/社名からの検索 |
| `equity_market_segment_change_history.sql` | 市場区分の変更履歴 |
| `market_segment_turnover_and_volatility.sql` | 市場区分別の売買代金・変動率 |
| `short_selling_overview.sql` | 空売りの概観（days to cover を含む8本） |
| `tag_insert_*.sql` | タグ付与の投入 SQL（100/200/300番台） |

---

## 10. ツール

### 10.1 chart.js — 銘柄チャート一覧

指定銘柄の終値（分割調整済み）を 1 銘柄 1 グラフで縦に並べた、自己完結型の HTML を出力する。
外部 CDN に依存しないのでオフラインでも開ける。

```bash
node src/chart.js --codes 44880,55740,68570 --years 1
node src/chart.js --tag 110_ai_model --years 3 --open
node src/chart.js --list-tags
```

**制限（処理負荷を抑えるための既定値）**: 期間は最大 3 年、銘柄数は既定 30。
超えた場合は警告して切り詰める。

### 10.2 Web アプリ（`src/web/`）

OCI VM 上で稼働する Express アプリ。機能は 2 つ。

1. タグ + 期間 → **騰落率順の一覧テーブル**
2. タグ + 期間 → **終値の折れ線グラフ**

```bash
JQB_WEB_PORT=8080 npm run web
```

- 既定ポート 3000。systemd ユニットは `src/web/jquants-web.service`
- API: `/api/meta` `/api/performance` `/chart` `/healthz`
- フロントは依存ライブラリなし（`public/` の素の HTML/CSS/JS）

**認証は未実装**。OCI VM 上で稼働中の既存の認証サービス経由でアクセスさせる方針だが、**次フェーズ**。

### 10.3 inspect-bulk-csv.js

Bulk API の CSV ヘッダーを実データで確認する。DB には接続しない。7 章参照。

### 10.4 claude-query.js — Claude Desktop 用 読み取り専用アクセス

Claude Desktop に直接 SQL を組み立てさせて分析させたい場合の入口。
GD_JQUANTS(取込バッチ用、フル権限)とは別に、SELECT のみの `claude_ro` ユーザーを
`ddl/10_create_claude_readonly_user.sql` で作成し、そのユーザーで接続する。

```bash
node scripts/claude-query.js "SELECT code, co_name FROM equity_master WHERE code = '68570'"
node scripts/claude-query.js --json "SELECT ..."
```

**設計判断(なぜこうしたか)**:

- 資格情報は取込バッチの `.env` とは別ファイル `.env.claude-readonly` に置く。
  `src/config.js` 経由の GD_JQUANTS 資格情報とは完全に分離し、
  このツールが書き込み権限アカウントを誤って使うことがないようにする。
- 防御を DB 側(`claude_ro` に SELECT 以外を付与しない)とアプリ側
  (`claude-query.js` が SELECT/WITH 以外を拒否)の二重にしている。
  最終的な防御線は DB 側の権限であり、アプリ側のチェックは過信しないこと。
- `LOAD_PROGRESS` と `*_STG`(ステージング)は分析に不要なので付与対象から外した。
- 初期セットアップ手順は `ddl/10_create_claude_readonly_user.sql` の冒頭コメント、
  `.env` の雛形は `jquants-batch/claude-readonly-env.example.txt` を参照。

---

## 11. 運用

**日次バッチ**: `scripts/run-daily.sh` を cron で実行する。

```
30 18 * * 1-5 /opt/jquants-batch/scripts/run-daily.sh
```

- J-Quants の当日データは 17:30 頃以降に利用可能。余裕を見て 18:30 以降
- ログは `logs/daily_YYYYMMDD.log`、60 日で自動削除
- **成功時は何も出力しない**（cron の MAILTO で失敗時だけ通知が飛ぶようにするため）

---

## 12. 未対応・今後の課題

- [ ] **空売りデータを使った分析方針の具体化**。データは揃ったので、次はここから。
      入口は `v_equity_short_position_sum`（銘柄 × 計算日）と
      `queries/sql/short_selling_overview.sql`（days to cover を含む8本）
- [ ] **Web アプリの認証**（既存の OCI 認証サービス経由）
- [ ] タグ付けの継続（`trend_analysis/` のメモをもとに自分の観点で作り上げる）
- [ ] 銘柄数が増えたら `130` / `140` の細分（8.3 参照）
- [ ] **セキュリティ**: `jquants-batch/.git/config` の remote URL に GitHub の
      Personal Access Token が平文で埋まっている。credential helper（macOS なら
      `git config --global credential.helper osxkeychain`）に移すか SSH 接続に変える。
      トークンを差し替えるときは、旧トークンを GitHub 側で失効させること

---

## 13. 用語

| 用語 | 意味 |
|---|---|
| 空売り残高報告 | 残高割合 0.5% 以上の空売りポジションの報告義務。報告者単位で公表される |
| 日々公表銘柄 | 信用取引の残高が基準を超え、取引所が毎日残高を公表する銘柄 |
| days to cover | 空売り残高 ÷ 平均出来高。買い戻しに何日かかるかの目安 |
| AdjFactor | 株式分割・併合の調整係数。1 でない日に分割等が発生している |
| ScaleCat | JPX の規模区分（TOPIX Core30 など）。`-` は「区分なし」という有効な値 |
| S33 / sector33 | JPX の 33 業種分類。銀行業 = 7050、保険業 = 7150 |
