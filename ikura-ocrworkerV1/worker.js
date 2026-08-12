// ============================================================
// トレカ型番OCR proxy — Cloudflare Worker
// フロント → [このWorker] → Claude Vision API
//   ・撮影画像(base64)を受け取り、型番（210/184 のような 数字/数字 形式）を抽出
//   ・APIキーは wrangler secret（CLAUDE_API_KEY）で隠蔽。コード直書きしない
//   ・CORS対応（Access-Control-Allow-Origin: * ＋ OPTIONSプリフライト）
//   ・Supabase Edge Functions の同等OCRプロキシからの移行
// ============================================================

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6"; // Telesatei査定Workerと揃える
const MAX_TOKENS = 64;

const PROMPT =
  'カード画像から数字/数字形式の型番のみ抽出。JSON形式のみで返答: {"codes":["210/184"]}';

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

// data URL（data:image/png;base64,....）でも生base64でも受け取れるよう正規化
function parseImage(base64Image) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(base64Image);
  if (m) return { mediaType: m[1], data: m[2] };
  return { mediaType: "image/jpeg", data: base64Image };
}

export default {
  async fetch(request, env) {
    // プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    if (!env.CLAUDE_API_KEY) {
      return json({ error: "CLAUDE_API_KEY is not configured" }, 500);
    }

    // 入力パース
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

    // Claude Vision API 呼び出し
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
          max_tokens: MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data },
                },
                { type: "text", text: PROMPT },
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

    // Claudeの返答テキストから codes を取り出す
    const text =
      (result.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

    const codes = extractCodes(text);
    return json({ codes });
  },
};

// 返答テキストを堅牢にパースして codes(string[]) を返す
function extractCodes(text) {
  if (!text) return [];

  // 1) まずJSONとして素直に読む（```json フェンスも許容）
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (Array.isArray(obj.codes)) {
      return obj.codes.filter((c) => typeof c === "string");
    }
  } catch {
    // 2) 本文中の {...} を拾ってJSONパース
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (Array.isArray(obj.codes)) {
          return obj.codes.filter((c) => typeof c === "string");
        }
      } catch {
        /* fallthrough */
      }
    }
  }

  // 3) 最後の砦: 数字/数字 パターンを正規表現で拾う
  const found = cleaned.match(/\d+\/\d+/g);
  return found ? Array.from(new Set(found)) : [];
}
