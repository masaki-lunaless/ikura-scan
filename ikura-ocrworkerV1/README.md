# ikura API gateway

Cloudflare Worker + D1で、いーくらのスタッフ認証、OCR、RECORE API中継をまとめて扱います。
ブラウザへRECORE APIキーを渡さず、会社コード・スタッフコード・個別PINでログインします。

## セキュリティ構成

- PINはスタッフごとのsalt付きPBKDF2-SHA256ハッシュで保存
- セッションは8時間。ランダムトークン本体はHttpOnly Cookie、D1にはSHA-256ハッシュのみ保存
- RECORE APIキーは初回ログイン後の接続設定画面から受け取り、AES-256-GCMで暗号化してD1に保存
- 保存済みAPIキーはブラウザへ返さず、再編集画面でも入力欄は常に空欄
- ログイン失敗は会社・スタッフ・IP単位で制限（10分内に5回失敗すると15分停止）
- RECORE中継はアプリが利用するパスとHTTPメソッドだけを許可
- CORSは`ALLOWED_ORIGINS`に指定した正確なOriginだけを許可

## 1. D1を作成して設定

```bash
cd ikura-ocrworkerV1
npx wrangler d1 create ikura-auth
```

出力された`database_id`を使い、`wrangler.toml`の`[[d1_databases]]`ブロックのコメントを外して埋めます。
`ALLOWED_ORIGINS`はフロントエンドのOriginに置き換えてください。複数ある場合はカンマ区切りです。

```bash
npx wrangler d1 migrations apply ikura-auth --remote
```

## 2. Secretを登録

```bash
npx wrangler secret put CLAUDE_API_KEY
npx wrangler secret put API_KEY_ENCRYPTION_KEY
npx wrangler secret put BOOTSTRAP_SECRET
```

`API_KEY_ENCRYPTION_KEY`には32バイトのランダム値をbase64化した文字列を登録します。例:

```bash
openssl rand -base64 32
```

`BOOTSTRAP_SECRET`にも十分長い別のランダム値を使ってください。値はソースや`.dev.vars`以外の共有ファイルへ書きません。

## 3. デプロイと最初の会社・管理者登録

```bash
npx wrangler deploy
```

初回だけ、管理者端末から次のAPIを呼び、会社と最初の管理者を作成します。この段階ではRECORE情報を登録しません。

```bash
curl -X POST 'https://ikura-ocr-proxy.example.workers.dev/admin/bootstrap' \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Secret: YOUR_BOOTSTRAP_SECRET' \
  --data '{
    "companyCode": "IKURA",
    "companyName": "いーくら",
    "staffCode": "ADMIN",
    "staffName": "管理者",
    "pin": "123456"
  }'
```

PINは4〜8桁の数字です。会社コードとスタッフコードは英数字・`_`・`-`の2〜32文字です。
登録後は`BOOTSTRAP_SECRET`をローテーションするか削除してください。すでに存在する会社コードは再登録できません。

管理者がWeb画面へ初回ログインすると、自動的に接続設定画面へ移動します。そこでRECOREの店舗名・店舗ID・APIキーを保存すると、スキャン画面が使えるようになります。
保存時だけAPIキーをWorkerへ送り、暗号化してD1へ格納します。設定画面を再度開いても既存のAPIキーは返さず、変更するときだけ新しい値を入力します。

## スタッフ追加

管理者でログインして得たCookieを使い、スタッフを追加できます。

```bash
curl -c cookies.txt -X POST 'https://ikura-ocr-proxy.example.workers.dev/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"companyCode":"IKURA","staffCode":"ADMIN","pin":"123456"}'

curl -b cookies.txt -X POST 'https://ikura-ocr-proxy.example.workers.dev/admin/staff' \
  -H 'Content-Type: application/json' \
  --data '{"staffCode":"S001","staffName":"スタッフ1","pin":"654321","role":"staff"}'
```

`GET /admin/staff`で同じ会社のスタッフ一覧を取得できます。PINハッシュは返しません。

## ローカル開発

ローカル用D1へマイグレーションを適用し、`.dev.vars`に開発専用Secretを設定します。

```bash
npx wrangler d1 migrations apply ikura-auth --local
npx wrangler dev
```

`.dev.vars`、Cookieファイル、実キーはcommitしないでください。

## API

- `POST /auth/login` — 会社コード・スタッフコード・PINでログイン
- `GET /auth/session` — 現在のセッション確認
- `POST /auth/logout` — セッション破棄
- `POST /ocr` — ログイン必須のカードOCR
- `/recore/*` — ログイン必須、許可リスト方式のRECORE中継
- `POST /admin/bootstrap` — Secret必須の初期登録
- `GET /admin/connection` — 管理者専用。接続状態と店舗情報のみ返す（APIキーは返さない）
- `PUT /admin/connection` — 管理者専用。RECORE接続を暗号化保存・更新
- `GET|POST /admin/staff` — 管理者専用のスタッフ参照・追加

本番ではフロントとWorkerを同一サイト配下（例: `app.example.jp` と `api.example.jp`）で提供するのが推奨です。異なるサイト間のCookieはiOS/Safariの追跡防止で遮断される場合があります。
