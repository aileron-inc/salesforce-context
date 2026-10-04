# salesforce-context

Salesforce の業務データを、Cloudflare Workers から Bulk API 2.0 で取得し、世代管理された CSV として R2 または Google Drive に置く同期基盤。

```text
Cron → Queue → Workflow（オブジェクト単位）
                 ├─ Salesforce Bulk API 2.0
                 └─ R2 または Google Drive（CSV, 世代管理）
                      → ローカル DuckDB などで読む
```

読み取り側（DuckDB のビュー定義など）はこのリポジトリの範囲外。

## 構成

- Cron は同期本体を実行しない。スロットを Queue `salesforce-context-sync` に入れてすぐ戻る
- Queue consumer が、その cron の担当オブジェクトごとに Workflow インスタンスを 1 つ起動する
- Workflow の step は失敗すると指数バックオフで再試行する（初期遅延 30 秒、最大 8 回）。Drive への PUT も 524 / 5xx / 接続断と、権限不足以外の 403 を再試行する
- オブジェクトが成功するたびに進捗を記録し、全オブジェクトが揃い、その世代が現在の manifest より新しいときだけ `manifest.json` を切り替える
- スケジュールは 1 日 3 回（JST 2:00 / 10:00 / 18:00）。`wrangler.json` の 5 本の cron は変えていない
- 結果 CSV は加工せず保存する。1 ファイルは最大 8 MiB（`part_max_bytes` で変更可）。Salesforce の 1 ページがそれより大きいときは、引用符内の改行を壊さない境界で `part-0000.csv` 以降に分割し、各ファイルにヘッダ行を繰り返す
- 読み手はこれまで通り `manifest.json` の `parts` か `{prefix}part-*.csv` を使う。パートが小さくなるだけで、名前と manifest の形は同じ
- `manifest.json` は、今指している世代より新しい世代が全部揃ったときだけ進む。遅れて終わった古い世代では戻さない

## 実行プラン

Workflow の各 step は Worker の CPU 時間を使う。Free プランの step は CPU 10ms で、100MB 近い結果ページの分割は終わらない。この Worker は **Workers Paid** で動かす。`wrangler.json` の `limits.cpu_ms` は `60000`。約 100MB の CSV 分割はローカルで約 0.6 秒だったので、この値は遅い実行環境とより大きいページ向けの余裕である。

`sync.config.json` の `cron_groups` のキーと `wrangler.json` の `crons` は一致させる。Worker は起動時に R2 の `sync.config.json` を読む。雛形は `sync.config.example.json`。

## レイアウト

公開する契約（R2 ターゲットでも Drive ターゲットでも同じ意味）:

```text
manifest.json
{generation}/_state.json
{generation}/{objectKey}/part-0000.csv ...
```

R2 ターゲットのキーは `generations/{YYYY-MM-DD-HH}/...` とバケットルートの `manifest.json`。Drive ターゲットはルートフォルダ直下に `manifest.json` と `{YYYY-MM-DD-HH}/` フォルダを作る。

世代 ID は cron の `scheduledTime` を UTC の時までに切った `YYYY-MM-DD-HH`。同じ時の 5 本の cron は同じ世代を共有する。

同期の途中や、一部オブジェクトの再試行中は `manifest.json` が直前の世代を指したままになる。全オブジェクトの進捗が揃い、その世代が現在より新しいときだけ manifest を更新し、直近 6 世代以外を削除する。

R2 には公開データとは別に、次の内部キーを書く。読み手は使わない。

```text
generations/{YYYY-MM-DD-HH}/_objects/{objectKey}.json   オブジェクトごとの進捗
staging/{YYYY-MM-DD-HH}/{objectKey}/part-XXXX.csv       Drive アップロード前の一時 CSV
drive-layout/{YYYY-MM-DD-HH}/...                        Drive の世代フォルダとオブジェクトフォルダの ID
drive-layout/manifest.json                              Drive 上の manifest.json の file ID
```

Drive の世代フォルダとオブジェクトフォルダは、世代の最初に 1 回だけ作り、ID を R2 へ条件付きで書く。先に書いた方が勝ち、遅れた方が作ったフォルダはゴミ箱へ入れる。後続の step はその ID を使い、フォルダを検索し直さない。`_state.json` と `manifest.json` の file ID も同じ方法で 1 つに決める。

## ログ

構造化 JSON。秘密値とレコード本文は出さない。失敗した HTTP 応答はステータスと本文の先頭だけを残す。

- `bulk query ready` … `bulk_wait_ms`（Bulk ジョブ完了までの待ち）
- `page downloaded` … `download_ms`, `download_bytes`
- `part stored` … `bytes`, `upload_ms`（保存先へのアップロード）

## ローカル準備

```sh
bun install
bun run check
bun run test
```

## デプロイ前に必要な Cloudflare リソース

アカウントは **Workers Paid** にする。Free のままでは Workflow step の CPU 10ms を超えてページ分割が失敗する。

`wrangler deploy` は Workflow 定義を作るが、Queue は先に作っておく。デプロイは **UTC 17時・1時・9時の :03 から :45 のあいだを避ける**。本番 cron がその窓で動く。新しいコードは世代の途中に残っている旧 `_state.json` を読まないので、進行中の世代に載せるとその回の `manifest.json` は進まない。

```sh
npx wrangler queues create salesforce-context-sync-dlq
npx wrangler queues create salesforce-context-sync
npx wrangler deploy
```

| リソース | 名前 | 作り方 |
|---|---|---|
| Queue | `salesforce-context-sync` | 上の `queues create`。consumer は max_retries 10、retry_delay 120 秒 |
| Queue（DLQ） | `salesforce-context-sync-dlq` | 先に作る。Workflow を起動できなかったスロットが入る |
| Workflow | `salesforce-context-sync` | `wrangler deploy` が binding `SYNC_WORKFLOW` / class `SyncWorkflow` から作成する |
| R2 | `salesforce-context` | 既存バケット。設定変更は不要。`sync.config.json` はそのまま読める |
| シークレット | 下記 | 既存の値を維持する。今回の変更で増やすものはない |

シークレット（`.dev.vars` と `wrangler secret put`。Git に入れない）:

- `SF_CLIENT_ID`
- `SF_CLIENT_SECRET`
- `SF_REFRESH_TOKEN`
- Drive ターゲットのとき `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- Drive ターゲットのとき `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

`SF_LOGIN_URL` は `wrangler.json` の var。任意の `sync.config.json` 項目 `part_max_bytes`（正の整数、省略時 8388608）でパート上限を変えられる。

## 手動実行

```sh
bun run dev -- --test-scheduled
curl "http://localhost:8787/__scheduled?cron=3+17,1,9+*+*+*"
```

ローカルでは Queue consumer と Workflow が続く。cron 文字列は `sync.config.json` の `cron_groups` のキーにする。

## 新しい org へのセットアップ

`docs/ONBOARDING.md` を参照。

## セキュリティ

- `.dev.vars` を commit しない。
- 旧 `copy_to_drive` の鍵・token・実データを Git に入れない。
- レコード本文や token をログへ出さない。失敗応答の本文は先頭 300 文字だけ。
- Worker の fetch は 404 のみを返し、外部から同期を起動する経路は公開しない。
