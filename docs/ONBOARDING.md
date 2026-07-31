# 新しい org へのセットアップ手順（AI エージェント向け）

このドキュメントは、AI エージェント（Claude Code 等）が salesforce-context を新しい Salesforce org / Cloudflare アカウントへセットアップするための手順書。人間が読んでもよいが、エージェントがそのまま実行できる粒度で書く。

## 前提

- 対象 org の Salesforce 認証情報（OAuth の client_id / client_secret / refresh_token）が入手できること
- デプロイ先 Cloudflare アカウントが決まっていること（Free プランで動く）
- `sf` CLI または同等の手段で対象 org にクエリできること

## 手順

### 1. R2 バケットを作る

バケット名はデプロイ先で一意なら何でもよい（例: `salesforce-context`）。

### 2. 対象オブジェクトと項目を決める

業務で必要なオブジェクトを洗い出す。既存の Salesforce レポートがある場合は、レポート ID から項目定義を機械取得できる:

```sh
sf api request rest "/services/data/v67.0/analytics/reports/{REPORT_ID}/describe" -o {ORG}
```

`reportExtendedMetadata.detailColumnInfo` が「表示ラベル → API 項目名・型」の対応表。これを使って SOQL を組み立てる。

変換ルール:

- プレフィックス（`Account.`、`Matching__c.` 等）は主オブジェクトに対しては剥がす
- カスタム参照 `A.B__c.Name` → `B__r.Name`
- `FK_X__c.Y` → `X__r.Y`
- 標準エイリアス: `OPPORTUNITY_ID`→`Id`、`STAGE_NAME`→`StageName`、`ACCOUNT_NAME`→`Account.Name`、`ACCOUNT.NAME`→`Name`、`INDUSTRY`→`Industry`、`URL`→`Website`、`EMPLOYEES`→`NumberOfEmployees`、`LAST_UPDATE`→`LastModifiedDate`
- 別オブジェクトの項目（例: 求職者レポートの `Contact.*`）は主オブジェクトから直接取れないことがある。その場合は主従を逆にして親参照で取る（例: `FROM Contact ... Account.Field__c`）
- 同一オブジェクトの用途切り分け（例: 個人/法人の Account）は `RecordType.DeveloperName` で WHERE を書く。レコードタイプは `SELECT Id, Name, DeveloperName FROM RecordType WHERE SobjectType = '...'` で確認

### 3. sync.config.json を作る

`sync.config.example.json` を雛形に、対象 org 用の `sync.config.json` を作る。

- `objects[]`: `{ key, label, soql }`。SELECT には必ず `Id` と `SystemModstamp` を含める
- `cron_groups`: オブジェクトの件数を `SELECT COUNT() FROM ...` で調べ、**重いオブジェクトは単独スロット**にする。目安:
  - 10万件超 → 単独
  - それ以下 → 2〜3オブジェクトで1スロットを共有
  - スロットは最大5個（Cron Trigger の上限）
  - cron キーは `wrangler.json` の `crons` と完全一致させる

### 4. R2 に設定を配置する

```sh
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects/sync.config.json" \
  -H "Authorization: Bearer {CF_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @sync.config.json
```

### 5. シークレットを設定する

```sh
wrangler secret put SF_CLIENT_ID
wrangler secret put SF_CLIENT_SECRET
wrangler secret put SF_REFRESH_TOKEN
```

### 6. デプロイして初回同期を検証する

`wrangler.json` の `bucket_name` と `crons` をデプロイ先に合わせて `wrangler deploy`。

検証方法: 一時的に cron を数分後にずらしてデプロイ → `wrangler tail` で観測 → 完了したら本番 cron に戻して再デプロイ。成功の確認は:

- tail に `sync completed` が出る
- R2 の `manifest.json` に全オブジェクトが載る

### 7. 運用ドキュメントを生成して R2 に置く

デプロイ先固有のドキュメントは**公開リポジトリに入れず**、R2 バケットの `repo-docs/` に置く。生成するもの:

| ファイル | 内容 |
|---|---|
| `repo-docs/duckdb-usage.md` | データの読み方。バケット構造、manifest 契約、DuckDB 接続例（ACCOUNT_ID 埋め込み）、鮮度の見方、注意事項 |
| `repo-docs/objects.md` | 手順2で取得した「レポート ↔ API 項目」対応表。項目の意味を調べるときの参照用 |
| `repo-docs/CONTEXT.md` | そのデプロイ先の運用コンテキスト。スケジュール、件数、担当者、固有の意思決定 |

テンプレートは各ファイルの「構造（見出し）」を既存デプロイのものに倣って作成する。account ID・件数・SOQL など固有情報は R2 側にだけ書く。

## やってはいけないこと

- org 固有情報（SOQL、スキーマ、件数、アカウント ID、レポート ID）を公開リポジトリにコミットすること
- 秘密値を Git・ログ・R2 メタデータに書くこと
- 読み取り側のツール（DuckDB ビュー等）をこのリポジトリに追加すること
