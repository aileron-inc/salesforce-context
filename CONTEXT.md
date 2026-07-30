# salesforce-context コンテキスト

最終更新: 2026-07-30

## Why: 実現したいこと

Salesforce の業務データを、質問のたびに重いレポートとして取得せず、CSV として手元から高速に読めるようにすること。

```text
Salesforce
  ↓ Bulk API 2.0（Cloudflare Worker Cron）
R2 の世代管理された CSV
  ↓
ローカル DuckDB など（このリポジトリの範囲外）
```

## 現在地

2026-07-30 時点で、同期 Worker は完成し、1デプロイ先での本番稼働実績がある。

## What: 確定している設計

### 同期方式

- 実行基盤は Cloudflare Worker + Cron Trigger（Free プランで動作する設計）。
- 認証は OAuth refresh token フロー。secrets は `SF_CLIENT_ID` / `SF_CLIENT_SECRET` / `SF_REFRESH_TOKEN`、vars は `SF_LOGIN_URL`。
- 取得は Bulk API 2.0 query job（結果フォーマットは CSV のみ）。job 作成 → 指数バックオフでポーリング（2秒→最大30秒）→ results を locator + `maxRecords=10000` でページ取得。
- 結果 CSV は**一切加工せず**、1ページ = 1ファイルとしてそのまま R2 に保存する（各ページにヘッダ行が含まれるので単独で妥当な CSV）。
- 全件同期のみ。差分同期・削除検出は後回し。

### 設定駆動（org 非依存）

- Worker のコードは org 固有情報を持たない。
- 対象オブジェクトの SOQL と cron 割り振りは、デプロイ先 R2 バケットルートの `sync.config.json` で定義し、起動時に読み込む。
- リポジトリには `sync.config.example.json`（雛形）のみ置く。実運用の `sync.config.json` は R2 とローカルのみに置き、Git に入れない。

### Free プラン制約への設計適合

計測で判明した制約: invocation あたり CPU 2秒・サブリクエスト 50・メモリ 128MB・Cron Trigger は1 Worker 最大5個。

これに収めるため:

- 全オブジェクトを1回で処理せず、**5つの Cron Trigger に分割**して1 invocation あたり1〜2オブジェクトを処理する。
- `controller.cron` で担当オブジェクトを判別する。割り振りは `sync.config.json` の `cron_groups`。
- 世代 ID は `scheduledTime`（UTC、時まで）から決定論的に生成し、複数 invocation で同一世代を共有する。
- 各 invocation は完了オブジェクトを `generations/{runId}/_state.json` に追記し、全オブジェクト揃った invocation が `manifest.json` を切り替える。

### 保存形式・世代管理

- 形式は Bulk API 結果の生 CSV（UTF-8、ヘッダ行付き）。1ファイル最大 10,000 レコード。
- レイアウト: `generations/{YYYY-MM-DD-HH}/{objectKey}/part-XXXX.csv` + `generations/{runId}/_state.json` + ルートの `manifest.json`。
- 全オブジェクト完了後にだけ `manifest.json` を切り替える。途中失敗時は直前の世代を指し続ける。
- manifest 切替後に、直近6世代だけ残して古い世代を削除する。
- 読む側は `manifest.json` の `parts` を辿るか、`{prefix}part-*.csv` を glob する。

### Cloudflare Worker

- TypeScript strict、Bun、`wrangler.json`、compatibility date `2026-07-29`、`nodejs_compat`。
- R2 binding 名は `R2`。
- observability 有効。binding 型は `wrangler types` で生成。
- fetch ハンドラは 404 のみ返す。外部から同期を起動する経路は公開しない。
- `sync.config.json` の `cron_groups` のキーと `wrangler.json` の `crons` は必ず一致させる。

## 非目的

- MCP read model / D1 の read model を作ること
- Google Drive など別ストレージへの転送
- Salesforce の完全な複製基盤を作ること
- Salesforce へ更新を書き戻すこと
- 読み取り側のツール（DuckDB ビュー定義など）をこのリポジトリで持つこと

## 未決事項

1. 削除レコードの検出方法
2. 同期失敗時の通知（Slack 等）の要否
3. 部分失敗時の再実行経路
4. ページサイズ（`maxRecords=10000`）の監視

## 再開手順

1. この `CONTEXT.md` と `AGENTS.md` を読む。
2. `jj status` で既存変更を確認する。
3. `node_modules` がなければ `bun install`。
4. `bun run check` と `bun run test` を通す。

## 次の実装で守る受け入れ条件

- 同期が途中失敗しても `manifest.json` が直前の世代を指し続ける。
- ログ、例外、R2 メタデータへ秘密値を含めない。
- ローカル test で fetch モックによる同期全体と manifest 切替を検証する。
- Free プランの制約（CPU 2秒・サブリクエスト 50・メモリ 128MB・Cron 最大5本）を超える処理は設計段階で分割する。
- org 固有情報（SOQL、スキーマ、件数、アカウント ID 等）をリポジトリに入れない。
