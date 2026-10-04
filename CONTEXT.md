# salesforce-context コンテキスト

最終更新: 2026-10-04

## Why: 実現したいこと

Salesforce の業務データを、質問のたびに重いレポートとして取得せず、CSV として手元から高速に読めるようにすること。

```text
Salesforce
  ↓ Bulk API 2.0（Cron が Queue に入れ、Workflow がオブジェクト単位で取得）
R2 または Google Drive の世代管理された CSV
  ↓
ローカル DuckDB など（このリポジトリの範囲外）
```

## 現在地

2026-10-04 時点で、同期は Queue と Workflow に載っている。保存先は `sync.config.json` の `target`（`r2` または `drive`）。Drive への大きい multipart アップロードが 524 / 502 / 接続断で世代ごと落ちる問題に対し、パート分割・再開可能アップロード・オブジェクト単位の再試行で、失敗したオブジェクトだけをやり直してから manifest を進める。

## What: 確定している設計

### 同期方式

- 実行基盤は Cloudflare Worker。Cron はスロットを Queue に入れるだけにし、取得と保存はオブジェクトごとの Workflow が行う。
- 認証は OAuth refresh token フロー。secrets は `SF_CLIENT_ID` / `SF_CLIENT_SECRET` / `SF_REFRESH_TOKEN`、vars は `SF_LOGIN_URL`。Drive ターゲットでは `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` も使う。
- 取得は Bulk API 2.0 query job（結果フォーマットは CSV のみ）。job 作成とポーリングは別 step。ポーリング間隔は `step.sleep` で 2 秒から最大 30 秒、合計約 60 分まで。それを超えたら `NonRetryableError` で打ち切り、ポーリングしない step 再試行はしない。results は locator + `maxRecords`（省略時 10000）でページ取得する。結果ボディの読み取りタイムアウトは、ヘッダ取得の再試行とは別である。
- 結果 CSV の中身は加工しない。保存ファイルは 1 ファイル最大 `part_max_bytes`（省略時 8 MiB）。ページが上限を超えるときは、引用符内改行をレコード境界として `part-XXXX.csv` に分け、各ファイルに元のヘッダを付ける。
- Drive への保存は resumable upload。チャンクは 2 MiB。524 / 5xx / 接続断はチャンクを再開し、それでも失敗した step は Workflow が指数バックオフ（30 秒起点、8 回）でやり直す。Drive の 403 は、数 KB の JSON から理由を大文字小文字を無視して読む。`rateLimitExceeded` / `RATE_LIMIT_EXCEEDED` / `quotaExceeded` があれば、`status` が `PERMISSION_DENIED` でも再試行する。`status` は理由が無いときだけ見る。権限不足・容量超過・domainPolicy・forbidden・notFound などの恒久理由だけ再試行しない。ログに残す本文は先頭 300 文字だけ。アップロードセッションの 404 / 410 は、そのセッションを捨てて step の再試行で新しいセッションを開く。保存済みの Drive file / folder ID が 404 またはゴミ箱なら、R2 の ID を条件付きで消して作り直す。
- 全件同期のみ。差分同期・削除検出は後回し。

### 設定駆動（org 非依存）

- Worker のコードは org 固有情報を持たない。
- 対象オブジェクトの SOQL と cron 割り振りは、デプロイ先 R2 バケットルートの `sync.config.json` で定義し、各 step が読み込む。
- リポジトリには `sync.config.example.json`（雛形）のみ置く。実運用の `sync.config.json` は R2 とローカルのみに置き、Git に入れない。
- テスト fixture とドキュメントの例も標準オブジェクトに留める。デプロイ先のオブジェクト名、カスタム項目、件数、ID は入れない。

### 失敗と再実行

- 5 本の cron は JST 2:00 / 10:00 / 18:00 のまま。1 cron は 1〜2 オブジェクトまで。
- 世代 ID は `scheduledTime`（UTC、時まで）から決まり、同じ時の cron は同じ世代を共有する。
- Workflow はオブジェクトごとに分かれる。片方のアップロード失敗が、もう片方の完了を消さない。
- 進捗の正は R2 の `generations/{runId}/_objects/{objectKey}.json`。`_state.json` と `manifest.json` はそこから組み立てて保存先に書く。
- manifest は、設定上の全オブジェクトが進捗に揃い、かつその世代が現在の manifest より新しいときだけ切り替える。欠けている間、または遅れて終わった古い世代では、直前の世代を指したまま。
- Queue の再配送は Workflow の起動に使う。同じインスタンス ID が既にあれば、完了・実行中は触らず、`errored` / `terminated` だけ `restart()` する。
- Drive 向け CSV は一度 R2 の `staging/` に置き、パートごとの upload step が Drive へ送る。step の戻り値に CSV 本体は載せない。
- Drive の世代フォルダとオブジェクトフォルダの ID は R2 の `drive-layout/` に条件付き put で 1 つだけ残す。後続 step は検索し直さない。`_state.json` と `manifest.json` の file ID も同じ。
- 実行には Workers Paid が必要。`limits.cpu_ms` は 60000。Free の Workflow step（CPU 10ms）では大きいページを分割できない。

### 保存形式・世代管理

- 形式は Bulk API 結果の生 CSV（UTF-8、ヘッダ行付き）。ファイル名は `part-0000.csv` からの連番。
- レイアウト: `generations/{YYYY-MM-DD-HH}/{objectKey}/part-XXXX.csv`（Drive では世代フォルダがルート直下）+ `_state.json` + ルートの `manifest.json`。
- 読む側は `manifest.json` の `parts` を辿るか、`{prefix}part-*.csv` を glob する。パート数は増えてよい。各パートは単独の CSV。
- manifest 切替後に、直近 6 世代だけ残して古い世代を削除する。

### Cloudflare Worker

- TypeScript strict、Bun、`wrangler.json`、compatibility date `2026-07-29`、`nodejs_compat`。
- R2 binding 名は `R2`。Queue binding は `SYNC_QUEUE`。Workflow binding は `SYNC_WORKFLOW`（class `SyncWorkflow`）。
- observability 有効。binding 型は `wrangler types` で生成する。
- fetch ハンドラは 404 のみ返す。外部から同期を起動する経路は公開しない。
- `sync.config.json` の `cron_groups` のキーと `wrangler.json` の `crons` は必ず一致させる。
- デプロイ前に Queue `salesforce-context-sync` と DLQ `salesforce-context-sync-dlq` を作る。Workflow は `wrangler deploy` が作る。デプロイは UTC 17時・1時・9時の :03 から :45 を避ける。進行中の世代は旧 `_state.json` を新しいコードが読まない。

## 非目的

- MCP read model / D1 の read model を作ること
- Salesforce の完全な複製基盤を作ること
- Salesforce へ更新を書き戻すこと
- 読み取り側のツール（DuckDB ビュー定義など）をこのリポジトリで持つこと
- 同期結果の通知（Slack 等）

## 未決事項

1. 削除レコードの検出方法
2. 同期失敗時の通知（Slack 等）の要否

部分失敗の再実行は、オブジェクト単位の Workflow step 再試行と Queue からの `restart()` で行う。ページサイズは `max_records` と `part_max_bytes` で調整し、パートごとのバイト数はログに出す。

## 再開手順

1. この `CONTEXT.md` と `AGENTS.md` を読む。
2. `jj status` で既存変更を確認する。
3. `node_modules` がなければ `bun install`。
4. `bun run check` と `bun run test` を通す。

## 次の実装で守る受け入れ条件

- 同期が途中失敗しても `manifest.json` が直前の世代を指し続ける。
- 1 オブジェクトまたは 1 パートのアップロード失敗は、その Workflow step の再試行で同じ世代の中でやり直す。
- ログ、例外、R2 メタデータへ秘密値を含めない。失敗応答の本文は先頭だけ。
- ローカル test で fetch モックによる同期全体と manifest 切替を検証する。
- 1 step の fetch 回数を、ページ取得とパートアップロードに分けて抑える。
- org 固有情報（SOQL、スキーマ、件数、アカウント ID 等）をリポジトリに入れない。
