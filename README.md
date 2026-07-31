# salesforce-context

Salesforce の業務データを Cloudflare R2 の CSV として同期する、Cloudflare Workers 製の同期基盤。

```text
Salesforce → Bulk API 2.0 → R2 (CSV, 世代管理) → ローカル DuckDB などで読む
```

読み取り側（DuckDB のビュー定義など）はこのリポジトリの範囲外。

## 構成

- Cloudflare Worker の Cron Trigger（Free プランで動作）
- Free プランの制約に収めるため、5本の Cron に処理を分割し、1回の起動で1〜2オブジェクトを同期する
  - 1日3回（JST 2:00 / 10:00 / 18:00 開始）。各ブロック内で candidates +3分 / jobs+companies +13分 / matchings +23分 / contracts+interviews +33分 / interviewers +43分 にずらして実行
- OAuth refresh token でアクセストークンを取得
- Bulk API 2.0 query job で7オブジェクトを SOQL 全件取得（ポーリングは指数バックオフ）
- 結果 CSV は加工せず、1ページ（最大10,000レコード）= 1ファイルとして R2 に保存
- 全オブジェクト完了後に `manifest.json` を切り替え

Worker は起動時に R2 バケットルートの `sync.config.json` を読み込む（コードは org 非依存）。雛形は `sync.config.example.json` を参照。実運用の `sync.config.json` は Git に入れず、R2 に配置する。
`sync.config.json` の `cron_groups` のキーと `wrangler.json` の `crons` は一致させること。

## R2 レイアウト

```text
manifest.json                       現在の世代へのポインタ
generations/{YYYY-MM-DD-HH}/_state.json
generations/{YYYY-MM-DD-HH}/candidates/part-0000.csv ...
generations/{YYYY-MM-DD-HH}/jobs/part-0000.csv ...
generations/{YYYY-MM-DD-HH}/companies/part-0000.csv
generations/{YYYY-MM-DD-HH}/matchings/part-0000.csv ...
generations/{YYYY-MM-DD-HH}/contracts/part-0000.csv
generations/{YYYY-MM-DD-HH}/interviews/part-0000.csv
generations/{YYYY-MM-DD-HH}/interviewers/part-0000.csv
```

同期が途中で失敗した場合、`manifest.json` は直前の世代を指し続ける。

## ローカル準備

```sh
bun install
bun run check
bun run test
```

## シークレット

次の値を `.dev.vars`（ローカル）と `wrangler secret put`（本番）で設定する。Git には入れない。

- `SF_CLIENT_ID`
- `SF_CLIENT_SECRET`
- `SF_REFRESH_TOKEN`

## 手動実行

ローカルで scheduled イベントを試す:

```sh
bun run dev -- --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+17+*+*+*"
```

（cron 文字列は `sync.config.json` の `cron_groups` のキーのどれかを指定する）

## 新しい org へのセットアップ

（AI エージェント向け手順書）を参照。

## セキュリティ

- `.dev.vars` を commit しない。
- 旧 `copy_to_drive` の鍵・token・実データを Git に入れない。
- レコード本文や token をログへ出さない。
- Worker の fetch は 404 のみを返し、外部から同期を起動する経路は公開しない。
