# ikura-scan

トレーディングカードをスマートフォンで撮影し、型番OCR、RECOREの商品検索・登録、買取／一般仕入れケース作成まで行うWebアプリです。

- 公開環境: https://ikura-ocr-proxy.lunaless.workers.dev/
- 実装・運用情報: [CLAUDE.md](./CLAUDE.md)
- フロントエンド: `index.html`（デプロイ用コピーは`ikura-ocrworkerV1/public/index.html`）
- API／認証／RECOREプロキシ: `ikura-ocrworkerV1/worker.js`
- Cloudflare設定: `ikura-ocrworkerV1/wrangler.toml`
