// ============================================================
// いーくらスキャン proxy — Cloudflare Worker
// フロント → [このWorker] → 外部API（キーを隠蔽）
//   ・POST /          … トレカ型番OCR（Claude Vision, sonnet-4-6）
//   ・POST /removebg  … 背景除去（remove.bg）→ 透過PNGをbase64で返す
//   ・CORS対応（* ＋ OPTIONSプリフライト）
//   ・APIキーは wrangler secret（CLAUDE_API_KEY / REMOVEBG_API_KEY）。直書きしない
// ============================================================

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const REMOVEBG_API_URL = "https://api.remove.bg/v1.0/removebg";
const MODEL = "claude-sonnet-5"; // OCR用: 高解像度Vision(長辺2576px)で小さな型番の読取を強化
const MAX_TOKENS = 64;
const MAX_TOKENS_FULL = 300;

// 型番だけ（買取/店間移動モード用・軽量）
const PROMPT_CODE =
  'カード画像から数字/数字形式の型番のみ抽出。JSON形式のみで返答: {"codes":["210/184"]}';

// フル抽出（カタログ登録モード用・一旦タイトル＋型番のみ）
const PROMPT_FULL =
  'トレカ画像から情報を抽出しJSONのみで返答。型番は数字/数字形式(例:1/77)。' +
  '該当なしは空文字/空配列。余計な文章は出さない。' +
  '{"codes":["1/77"],"title":"カード名"}';

// CORSヘッダー（全レスポンス共通）
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// data URL でも生base64でも受け取れるよう正規化
function parseImage(base64Image) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(base64Image);
  if (m) return { mediaType: m[1], data: m[2] };
  return { mediaType: "image/jpeg", data: base64Image };
}

// ArrayBuffer → base64（大きい画像でも安全なようチャンク分割）
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, ""); // 末尾スラ除去
    if (path === "/removebg") {
      return handleRemoveBg(request, env);
    }
    return handleOcr(request, env); // "/" ほか（後方互換でOCR）
  },
};

// ---- OCR（Claude Vision）----
async function handleOcr(request, env) {
  if (!env.CLAUDE_API_KEY) {
    return json({ error: "CLAUDE_API_KEY is not configured" }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const base64Image = payload && payload.base64Image;
  if (!base64Image || typeof base64Image !== "string") {
    return json({ error: "base64Image is required" }, 400);
  }

  const { mediaType, data } = parseImage(base64Image);
  const full = payload.mode === "full"; // カタログ登録モード=タイトルも抽出

  let apiRes;
  try {
    apiRes = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: full ? MAX_TOKENS_FULL : MAX_TOKENS,
        thinking: { type: "disabled" }, // OCRは短い抽出のみ。思考不要＆max_tokens温存
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              { type: "text", text: full ? PROMPT_FULL : PROMPT_CODE },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!apiRes.ok) {
    const detail = await apiRes.text();
    return json({ error: "Claude API error", status: apiRes.status, detail }, 502);
  }

  const result = await apiRes.json();
  const text = (result.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (full) {
    const obj = parseJsonLoose(text);
    return json({
      codes: Array.isArray(obj.codes) ? obj.codes.filter((c) => typeof c === "string") : extractCodes(text),
      title: typeof obj.title === "string" ? obj.title : "",
    });
  }
  return json({ codes: extractCodes(text) });
}

// テキストから {...} を取り出してJSONパース（失敗時 {}）
function parseJsonLoose(text) {
  if (!text) return {};
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fallthrough */
      }
    }
  }
  return {};
}

// ---- 背景除去（remove.bg）----
async function handleRemoveBg(request, env) {
  if (!env.REMOVEBG_API_KEY) {
    return json({ error: "REMOVEBG_API_KEY is not configured" }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const base64Image = payload && payload.base64Image;
  if (!base64Image || typeof base64Image !== "string") {
    return json({ error: "base64Image is required" }, 400);
  }

  // data URL 接頭辞が付いていても生base64だけに
  const { mediaType, data } = parseImage(base64Image);

  // base64フィールド(image_file_b64)は上限が小さく大きい画像で failed_to_read_image になる。
  // バイナリの image_file で送る（remove.bg推奨・上限が大きい）
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const form = new FormData();
  form.append("image_file", new Blob([bytes], { type: mediaType || "image/jpeg" }), "image");
  form.append("size", "auto"); // プランに応じた最大解像度（無料枠はpreview相当）
  form.append("format", "png"); // 透過PNG
  form.append("crop", "true"); // 背景除去後、被写体(カード)の外接矩形にピッタリ切り抜き
  form.append("crop_margin", "0"); // 余白なし

  let res;
  try {
    res = await fetch(REMOVEBG_API_URL, {
      method: "POST",
      headers: { "X-Api-Key": env.REMOVEBG_API_KEY },
      body: form,
    });
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!res.ok) {
    const detail = await res.text();
    let code = "", title = "";
    try {
      const e = (JSON.parse(detail).errors || [{}])[0];
      code = e.code || "";
      title = e.title || "";
    } catch {
      /* detailはそのまま返す */
    }
    return json({ error: "remove.bg error", code, title, status: res.status, detail }, 502);
  }

  const buf = await res.arrayBuffer();
  return json({ base64Image: bufToBase64(buf), mime: "image/png" });
}

// 返答テキストを堅牢にパースして codes(string[]) を返す
function extractCodes(text) {
  if (!text) return [];
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (Array.isArray(obj.codes)) return obj.codes.filter((c) => typeof c === "string");
  } catch {
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (Array.isArray(obj.codes)) return obj.codes.filter((c) => typeof c === "string");
      } catch {
        /* fallthrough */
      }
    }
  }
  const found = cleaned.match(/\d+\/\d+/g);
  return found ? Array.from(new Set(found)) : [];
}
