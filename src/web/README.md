# 株価タグ分析 Webアプリ

タグと期間を指定して、分割調整済みの騰落率一覧と終値チャートを見るためのExpressアプリです。
CLIの `chart.js` と同じモジュール（`db.js` / `chartQuery.js` / `chartHtml.js`）を再利用しています。

## 機能

1. **騰落率一覧** — タグと期間を指定して、分割調整済みの期間騰落率を降順の表で表示
   - 列クリックで並べ替え、CSVダウンロード
   - 行をチェックして任意の銘柄だけをグラフ化
2. **チャート** — 同じ条件で終値の折れ線グラフを縦に並べて表示
   - 騰落率の上位N件／下位N件、または表で選択した銘柄
   - `chart.js` が生成するのと同じ自己完結型HTMLを iframe で表示

## 起動

```bash
cd /path/to/jquants-batch
npm install          # express が追加されています
npm run web
# → http://127.0.0.1:3000
```

`.env` はバッチと共通です。DB接続情報（`JQB_DB_*`）だけ使います。
J-Quantsのアクセスキー（`JQB_JQUANTS_API_KEY`）は不要です
（`config.js` をセクション単位の遅延評価にしてあるため、未設定でも起動します）。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `JQB_WEB_PORT` | `3000` | 待ち受けポート |
| `JQB_WEB_HOST` | `127.0.0.1` | 待ち受けアドレス |
| `JQB_WEB_CHART_MAX_CODES` | `60` | 1回のチャート表示で扱う銘柄数の上限 |
| `JQB_WEB_CHART_MAX_YEARS` | `3` | チャートの期間上限（年） |

**`JQB_WEB_HOST` は既定の `127.0.0.1` のままにしてください。**
このアプリには認証がありません。外部からのアクセスは必ずリバースプロキシ経由にします。

## OCI VMへの配備

### 1. 配置と依存関係

```bash
cd ~/jquants-batch
git pull
npm install --omit=dev
```

### 2. systemd サービスとして常駐させる

同梱の `jquants-web.service` を雛形として使います。
`User` / `WorkingDirectory` / `Environment` を環境に合わせて書き換えてください。

```bash
sudo cp src/web/jquants-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jquants-web
sudo systemctl status jquants-web
journalctl -u jquants-web -f      # ログ
```

### 3. リバースプロキシから繋ぐ

既存の認証サービスの背後に置きます。nginx の場合の例:

```nginx
location /stocks/ {
    # ここで既存の認証をかける（auth_request など）
    proxy_pass         http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

アプリ内のパスはすべてルート相対（`/api/...`、`/chart`）です。
サブパス（例 `/stocks/`）で公開する場合は上の例のように `proxy_pass` の末尾に `/` を付けて
プレフィックスを剥がしてください。

### 4. ファイアウォール

アプリは `127.0.0.1` でしか待ち受けないので、3000番ポートをセキュリティリストや
firewalld で開ける必要はありません。開けないでください。

## 認証を組み込むとき（次フェーズ）

現状は認証なしです。組み込む際の接続点は次の3つです。

1. **リバースプロキシで完結させる**（推奨・実装不要）
   nginx の `auth_request` などで既存の認証サービスに委譲し、通過したリクエストだけを
   このアプリに流す。アプリ側の変更は不要です。

2. **ユーザーを識別したい場合**
   プロキシが付けたヘッダ（例 `X-Forwarded-User`）を `server.js` のログ出力ミドルウェアで
   拾えます。「誰がどのタグを見たか」を記録したい場合はここに追加します。

3. **アプリ内で認証する場合**
   `app.use(express.static(...))` の**前**にミドルウェアを1つ挟むのが最小の変更です。
   `/healthz` だけは除外してください（監視から叩けなくなるため）。

## API

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/healthz` | 死活監視。`{"ok":true}` を返す |
| GET | `/api/meta` | タグ一覧・最新営業日・上限値 |
| GET | `/api/performance` | 騰落率一覧（JSON） |
| GET | `/chart` | チャートHTML（iframe用） |

### `/api/performance` のパラメータ

| 名前 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `tags` | ○ | — | タグ名のカンマ区切り（OR条件）。`tag_master` に無い名前はエラー |
| `from` | | 終了日の1年前 | `YYYY-MM-DD` |
| `to` | | 最新営業日 | `YYYY-MM-DD` |
| `minDays` | | `0` | 最低営業日数。流動性が極端に低い銘柄を除く |
| `excludeFund` | | `1` | ETF・REIT等（`sector17_code='99'`）を除外 |
| `excludeDelisted` | | `1` | 上場廃止銘柄を除外 |

### `/chart` のパラメータ

`/api/performance` と同じパラメータに加えて:

| 名前 | 既定 | 説明 |
|---|---|---|
| `limit` | `30` | 表示件数 |
| `order` | `desc` | `desc`=騰落率上位 / `asc`=下位 |
| `codes` | — | 銘柄コードを直接指定（指定時は `tags` より優先） |

## 実装メモ

### 元のSQLからの変更点

`queries/sql/rate_price_change.sql` はタグでの絞り込みを最終WHERE句のEXISTSで行っていますが、
その形だと `adj` CTE が**期間内の全上場銘柄**について累積調整係数を計算してから捨てることに
なります。Webのレスポンスとしては無駄が大きいため、`webQuery.js` では対象銘柄を先に
確定させ、`adj` の入力をその銘柄だけに絞っています。結果は同じで、走査量が銘柄数に
比例するようになります。

### キャッシュ

株価は日次でしか変わらないので、同じ条件のクエリ結果とチャートHTMLを5分だけメモリに
保持します（最大60エントリ）。日次バッチの直後に古い結果が見えることがありますが、
5分待つか、サービスを再起動すれば消えます。

### 銘柄数の上限

表は数百件でも問題ありませんが、チャートは1銘柄1枚のSVGを描くのでブラウザ側が重くなります。
そのため上限を分けています（表=無制限、チャート=既定60件）。
地方銀行タグのように70銘柄超あるものは、チャートでは上位/下位を切り出して見る前提です。

## トラブルシュート

| 症状 | 確認 |
|---|---|
| 起動時に「環境変数 JQB_DB_... が設定されていません」 | `.env` がプロジェクトルートにあるか。systemd から起動する場合は `WorkingDirectory` が正しいか |
| タグが1件も表示されない | `ddl/05_tag_master.sql` を実行済みか |
| 「該当する銘柄がありませんでした」 | そのタグに銘柄が登録されているか（`/api/meta` の件数で確認） |
| チャートが空 | 期間内にその銘柄の株価データがあるか。新規上場銘柄は起点が後ろにずれます |
| 応答が遅い | `DBMS_STATS.GATHER_TABLE_STATS(USER,'EQUITY_PRICE_DAILY',cascade=>TRUE)` で統計情報を更新 |
