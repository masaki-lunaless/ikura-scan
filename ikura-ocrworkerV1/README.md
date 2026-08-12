# ikura-ocr-proxy — トレカ型番OCR proxy（Cloudflare Worker）

フロントから撮影画像(base64)を受け取り、Claude Vision API で
トレカの型番（`210/184` のような `数字/数字` 形式）を抽出して返すプロキシ。
Supabase Edge Functions で動いていた同等OCRプロキシの移行版。

## 仕様
- モデル: `claude-sonnet-5` / `max_tokens: 64`
- 入力: `POST` body `{ "base64Image": "..." }`（data URL・生base64どちらも可）
- 出力: `{ "codes": ["210/184"] }`（JSONのみ）
- CORS: `Access-Control-Allow-Origin: *` ＋ OPTIONSプリフライト対応
- APIキーは `wrangler secret`（`CLAUDE_API_KEY`）で管理（コード直書きなし）

## セットアップ

```bash
cd ikura-ocrworkerV1
npm install -g wrangler   # 未インストールなら（または npx wrangler を使う）
wrangler login            # 初回のみ。Cloudflareアカウント連携
```

## APIキーの登録（wrangler secret put）

```bash
npx wrangler secret put CLAUDE_API_KEY
```

実行するとプロンプトが出るので、**Claude APIキーの値を貼り付けてEnter**。
（値はコマンド引数やファイルに書かず、この対話入力で渡す。Cloudflare側に暗号化保存される）

登録済みシークレットの確認・削除:

```bash
npx wrangler secret list
npx wrangler secret delete CLAUDE_API_KEY
```

## ローカル実行

```bash
npx wrangler dev
```

`http://localhost:8787` で待ち受け。別ターミナルから動作確認:

```bash
# base64画像を作って投げる例（PNG/JPEGどちらでも）
IMG=$(base64 -i ./sample.jpg)
curl -s http://localhost:8787 \
  -H 'Content-Type: application/json' \
  -d "{\"base64Image\":\"$IMG\"}"
# => {"codes":["210/184"]}
```

> `wrangler dev` でもリモートのシークレットが使われる。ローカルだけ別の値を使いたい場合は
> `.dev.vars` に `CLAUDE_API_KEY=...` を置く（このファイルは commit しないこと）。

## デプロイ

```bash
npx wrangler deploy
```

デプロイ後に払い出される `https://ikura-ocr-proxy.<subdomain>.workers.dev` に対して
上記 curl と同じ形で疎通確認する。

## 注意
- Worker名は `ikura-ocr-proxy`。既存の `telesatei-proxy`（査定Worker）とは別物なので上書きしない。
- 本番でオリジンを絞る場合は worker.js の `CORS_HEADERS` の
  `Access-Control-Allow-Origin` を許可ドメインに変更する。
