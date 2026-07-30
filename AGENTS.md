# salesforce-context 作業ガイド

このリポジトリの目的は、Salesforce の業務データを R2 の CSV として同期し、ローカルの DuckDB などから高速に読めるようにすること。

## 最優先の設計境界

- 同期は Cloudflare Worker の Cron Trigger から Bulk API 2.0 で全件取得し、結果 CSV を**加工せずそのまま** R2 に書き込む。
- 取得単位は Salesforce オブジェクト（SOQL）。レポートの UI CSV export は使わない。
- **Worker のコードは org 非依存**。対象オブジェクトの SOQL と cron 割り振りは R2 バケットルートの `sync.config.json` で定義し、起動時に読み込む。リポジトリには雛形の `sync.config.example.json` のみ置き、実運用の `sync.config.json` は Git に入れない。
- Free プランの制約（CPU 2秒・サブリクエスト 50・メモリ 128MB・Cron 最大5本）を前提に設計する。1 invocation で処理するのは1〜2オブジェクトまで。
- `sync.config.json` の `cron_groups` のキーと `wrangler.json` の `crons` は必ず一致させる（不一致の cron は「担当なし」で何もしない）。
- 世代は `generations/{YYYY-MM-DD-HH}/`（UTC 時まで）に書き、全オブジェクト完了後にだけ `manifest.json` を切り替える。途中失敗時は前の世代の manifest を残す。同期は1日3回（JST 2/10/18時）。
- CSV のパース・変換（Parquet 化など）を Worker 内でやらない。変換は読み取り側の責務。
- MCP read model、D1、Google Drive 転送は作らない（要件として削除済み）。
- Salesforce への書き戻しはしない。読み取り専用。
- Salesforce のトークン、Client Secret、Cookie、秘密鍵、実データを Git に入れない。

## 現在の実装範囲

実装するもの:

- Cloudflare Worker の Cron 同期（`scheduled` ハンドラ、5本の Cron で分割）
- OAuth refresh token によるアクセストークン取得
- Bulk API 2.0 query job の作成・指数バックオフでのポーリング・結果CSV取得
- 結果 CSV の素通し保存（`maxRecords=10000` のページ = 1ファイル）
- `_state.json` による世代内の進捗管理と、全件成功後の `manifest.json` 切替
- 直近6世代を残す旧世代 cleanup
- Workers runtime 上でのテスト（Salesforce API は fetch モック）

まだ実装しないもの:

- 差分同期・削除検出
- 複数 org 対応
- 同期結果の通知（Slack 等）
- 読み取り側のツール（DuckDB 側のビュー定義などは別リポジトリで）

## 開発規約

- 日本語で記録・報告する。
- Why → What → How の順で、目的と手段を混ぜない。
- パッケージ管理とスクリプト実行には Bun を使う。
- TypeScript は `strict` を維持する。
- binding 型は手書きせず、`wrangler types` で生成する。
- Worker の binding には `env.R2` からアクセスし、Cloudflare REST API 経由で R2 を操作しない。
- request 固有の mutable state を module scope に置かない。
- Promise は必ず `await`、`return`、または `ctx.waitUntil()` で追跡する。
- ログは構造化 JSON とし、秘密値やレコード本文を出力しない。
- 対象オブジェクトや取得項目はデプロイ先 R2 の `sync.config.json` で管理する。リポジトリには org 固有情報（SOQL、スキーマ、件数、アカウント ID 等）を入れない。

## 作業開始時に読む順番

1. `CONTEXT.md`
2. `README.md`
3. `sync.config.example.json`
4. `src/config.ts`
5. `src/index.ts`
6. `test/`

`CONTEXT.md` の「未決事項」を確定事項として扱わないこと。実装判断をしたら、コードと同じ変更で `CONTEXT.md` も更新する。

## 完了条件

- `bun run check` が成功する。
- `bun run test` が成功する。
- 同期失敗時も `manifest.json` が直前の世代を指し続ける。
- 秘密値と Salesforce の実データが差分に含まれない。

