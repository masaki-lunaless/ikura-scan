# CLAUDE.md — いーくら開発ガイド

このファイルは、Claudeがこのリポジトリで作業するときに最初に読むための現行仕様です。推測でアーキテクチャを置き換えず、変更前に必ず実装コードとこの文書を照合してください。

## プロダクト概要

「いーくら」は、店舗スタッフがスマートフォンでトレーディングカードを撮影し、以下を行うWebアプリです。

- 型番・商品名のOCR
- RECOREの商品マスタ検索と新規登録
- RECOREへの商品画像アップロード
- 買取ケース作成
- 一般仕入れケース作成（画面上の「店間移動」モード）

公開URL: https://ikura-ocr-proxy.lunaless.workers.dev/

## 現行アーキテクチャ

```text
iPhone / browser
  ├─ UI and camera capture (single-page index.html)
  ├─ OpenCV.js: one-pass edge detection, perspective correction, deskew
  └─ direct PUT to a RECORE-issued signed upload URL
            │ authenticated same-origin API
            ▼
Cloudflare Worker
  ├─ static asset delivery
  ├─ staff authentication and session management
  ├─ Anthropic OCR proxy
  ├─ RECORE allowlisted API proxy
  └─ Cloudflare D1
       ├─ tenants / stores / staff
       ├─ encrypted RECORE connection metadata
       ├─ sessions
       └─ login attempt rate limits
```

Remove.bg、Cloudflare R2、Workers AIは現在使用していません。

## 主要ファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` | フロントエンドの編集元。UI、カメラ、OpenCV処理、RECORE操作フロー |
| `ikura-ocrworkerV1/public/index.html` | Cloudflare Workerが配信するコピー。`index.html`と必ず同期する |
| `ikura-ocrworkerV1/worker.js` | 認証、OCR、RECOREプロキシ、暗号化処理 |
| `ikura-ocrworkerV1/migrations/0001_auth.sql` | D1の初期スキーマ |
| `ikura-ocrworkerV1/wrangler.toml` | Worker、D1、Static Assets、公開Originの設定 |

フロント変更後は、最低でも次を確認してください。

```sh
cp index.html ikura-ocrworkerV1/public/index.html
cmp -s index.html ikura-ocrworkerV1/public/index.html
```

## 画像処理エンジン

画像処理はクライアント側のOpenCV.jsです。`jscanify@1.4.3`パッケージ内のOpenCV.jsをロードしますが、jscanifyの最大輪郭ロジックは使用していません。輪郭選択と採点は`index.html`内の独自実装です。

### カタログ登録時の処理

撮影時に2系統の画像を作ります。

1. OCR用: 内側のカードガイドを中心にクロップし、文字へ画素を集中させる
2. RECORE画像用: 外側のスキャン枠を取得し、カード外周を検出・補正する

RECORE画像用の処理順:

1. グレースケール化
2. Gaussian blur
3. 元画像とヒストグラム均等化画像を用意
4. 複数Canny閾値でエッジ検出
5. Morphological closeで途切れた外周を接続
6. 面積の小さい内部柄を除外し、複数の輪郭簡略化率で凸四角形を抽出
7. 比率、面積、中央位置、直角度、対辺の平行度、回転角、端の余裕を採点
8. 四角形が閉じない場合は、輪郭を包む最小回転矩形を保険に使う
9. 選択した四隅を一回のperspective warpで水平化
10. 1400 x 1960 pxの白背景へ配置し、JPEG quality 0.98で保持

iPhone SafariでOpenCVの全検出を二周させないでください。2026-09-18に二段再検出を試したところ、例外後に全画像が固定クロップへ落ち、傾きと机が残る回帰を起こしたため撤回しました。

通常画像のCanny候補は`12/45`, `25/85`, `35/120`, `70/210`、均等化画像は`18/65`, `35/120`, `70/210`です。低い閾値はホロ／低コントラストカード対策です。

### 幾何判定

- 回転角が±3°以内、平行誤差8°以内、最大直角誤差14°以内: 通常採用候補
- 回転角が±13°以内、平行誤差15°以内、最大直角誤差24°以内: 再補正候補
- 上記を超えるもの: 不採用
- 通常検出失敗時: ガイド範囲内でもう一度外周探索
- 最終フォールバック: 固定ガイドクロップ

±3°を超えた輪郭を通常成功として扱わないこと。ただし、カード外周として妥当な候補は捨てず、再補正に使います。

### カード規格

`CARD_PRESETS`が正解比率です。

- 59 x 86 mm: 遊戯王OCG、ガンダムアーセナルベース
- 63 x 88 mm: それ以外の現行登録タイトル

選択タイトルに応じてスキャンガイド、候補採点比率、出力幅を切り替えます。

### 画像処理の既知回帰ケース

以下を壊さないこと。

- ワンピース: 外周は取れても約1°の傾きが残るケース。内側のデザイン枠より、面積が期待値に近い物理外周を優先する
- ガンダムアーセナルベース: 固定クロップで木目の机が残るケース。±3°超の四角形または最小回転矩形を同じ検出内の再補正候補として救う
- ホロカード: カード端と撮影台のコントラストが低いケース。低閾値Canny候補を維持する
- 丸角: 白背景マスクでカード角を切り落とし過ぎない

## OCRエンジン

OCRはCloudflare WorkerからAnthropic Messages APIへ送ります。

- 現行モデル: `claude-sonnet-5`
- thinking: disabled
- 通常モード: 型番のみ
- カタログ登録モード: 型番と商品名
- 応答形式: JSON

現在のプロンプトと後処理は`123/456`形式の数字型番中心です。`OP12-007`のような英字混じり型番への対応は未実装です。関連Issue: [#6](https://github.com/masaki-lunaless/ikura-scan/issues/6)

OCR用画像とRECORE保存画像は別です。ClaudeにはOCR向けクロップを送り、RECOREにはOpenCVで補正した白背景画像を送ります。

## 認証と秘密情報

### ログイン

- 入力: 会社コード、スタッフコード、4〜8桁PIN
- PIN: salt付きPBKDF2-SHA256、100,000 iterations
- セッション: ランダムトークンのSHA-256 hashをD1に保存
- Cookie: HttpOnly。HTTPSではSecureかつ`__Host-` prefix
- 有効期限: 8時間
- 制限: 10分内に5回失敗すると15分ブロック

資格情報、PIN、APIキー、暗号化キーをソース、ログ、Issue、PRへ書かないでください。

### RECORE APIキー

- ブラウザには保存しない
- WorkerでAES-GCM暗号化し、ciphertextとIVのみD1へ保存
- 暗号化鍵はCloudflare Secret `API_KEY_ENCRYPTION_KEY`
- 設定画面へ平文を返さない。保存済みフラグのみ返す
- 編集画面でAPIキーが空なら既存値を維持し、新しい値がある場合だけ差し替える
- RECOREリクエスト時だけWorker内で復号し、`Authorization`と`X-Store-Id`を付与する

## RECORE連携

Workerの`RECORE_ROUTES`にあるallowlist以外は転送しません。新規機能でRECORE endpointを追加するときは、必要なmethod/pathだけを明示的に追加してください。

### カタログ登録

```text
category ID validation
  -> card title / size preset selection
  -> capture
  -> OCR
  -> duplicate search by pa_mpn
  -> request signed public upload URL from RECORE
  -> browser PUTs image directly to signed URL
  -> POST /products
  -> search again by pa_mpn and verify registration
```

画像はCloudflareへ保存しません。RECOREが発行した署名URLへブラウザから直接アップロードします。

### 買取

商品検索、価格ルール取得、選択リスト作成後、`POST /v2/bas_cases`を使用します。

### 店間移動

画面名は「店間移動」ですが、現行実装は一般仕入れケースとして`POST /big_cases`を使用します。名称や業務定義を変更する場合は、RECORE側の意味を確認してから変更してください。

## 初回設定フロー

1. ログイン
2. セッション情報の`needsSetup`を確認
3. 未設定なら接続設定画面を強制表示
4. 管理者が店舗名、RECORE店舗ID、APIキーを保存
5. 設定完了後にモード選択へ進む

管理者以外は接続設定を編集できません。

## 未実装・Issue

- [#4 タイトル別マッピングを店舗設定で固定](https://github.com/masaki-lunaless/ikura-scan/issues/4)
- [#5 カード比率プリセットと店舗デフォルト規格](https://github.com/masaki-lunaless/ikura-scan/issues/5)
- [#6 OCRを英字混じり型番へ対応](https://github.com/masaki-lunaless/ikura-scan/issues/6)

現在、比率プリセット自体は実装済みですが、店舗デフォルトとしての永続化は未実装です。

## 変更時の原則

- 既存のログイン、暗号化済み接続情報、D1データを破壊しない
- フロントの編集元とWorker配信用コピーを同期する
- 画像処理を変更したら、標準サイズと59 x 86 mmの両方を確認する
- 厳格判定失敗を、そのまま固定クロップへ落とさない。ただしOpenCVの全検出は一回に留める
- RECORE APIをブラウザから直接呼ばず、画像の署名URLへのPUT以外はWorkerのallowlist proxyを通す
- 保存済みAPIキーをレスポンスや画面に再表示しない
- OCR失敗時もカタログ登録画面で手入力できる挙動を維持する
- 外部サービスのmodel名、API仕様、Cloudflare設定を変更するときは最新の公式ドキュメントを確認する

## 検証とデプロイ

最低限の確認:

```sh
git diff --check
node -e 'const fs=require("fs"),s=fs.readFileSync("index.html","utf8"); for(const m of s.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)){if(m[1].trim())new Function(m[1])}'
cmp -s index.html ikura-ocrworkerV1/public/index.html
```

Workerの確認とデプロイ:

```sh
cd ikura-ocrworkerV1
npx wrangler deploy --dry-run
npx wrangler deploy
```

Cloudflare Secretsの値をコマンド履歴、ドキュメント、コミットへ残さないでください。
