// いーくら API gateway: staff login, OCR, and RECORE proxy.
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const RECORE_API_URL = "https://co-api.recore-pos.com";
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 64;
const MAX_TOKENS_FULL = 300;
const SESSION_COOKIE = "__Host-ikura_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
// Cloudflare Workers Web Crypto supports PBKDF2 iteration counts up to 100,000.
const PIN_ITERATIONS = 100000;
const LOGIN_WINDOW_SECONDS = 10 * 60;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BLOCK_SECONDS = 15 * 60;

const PROMPT_CODE =
  'カード画像から数字/数字形式の型番のみ抽出。JSON形式のみで返答: {"codes":["210/184"]}';
const PROMPT_FULL =
  'トレカ画像から情報を抽出しJSONのみで返答。型番は数字/数字形式(例:1/77)。' +
  '該当なしは空文字/空配列。余計な文章は出さない。' +
  '{"codes":["1/77"],"title":"カード名"}';

const RECORE_ROUTES = [
  ["GET", /^\/products$/],
  ["GET", /^\/products\/categories$/],
  ["GET", /^\/setting\/price_product_company_rules$/],
  ["POST", /^\/products$/],
  ["POST", /^\/upload\/public$/],
  ["POST", /^\/big_cases$/],
  ["POST", /^\/v2\/bas_cases$/],
];

export default {
  async fetch(request, env) {
    if (!originAllowed(request, env)) {
      return json(request, env, { error: "Origin not allowed" }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (!env.DB) return json(request, env, { error: "Database is not configured" }, 503);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/auth/login" && request.method === "POST") return await handleLogin(request, env);
      if (path === "/auth/logout" && request.method === "POST") return await handleLogout(request, env);
      if (path === "/auth/session" && request.method === "GET") return await handleSession(request, env);
      if (path === "/admin/bootstrap" && request.method === "POST") return await handleBootstrap(request, env);

      const session = await requireSession(request, env);
      if (!session) {
        return json(request, env, { error: "Authentication required" }, 401, {
          "Set-Cookie": clearSessionCookie(request),
        });
      }
      if (path === "/admin/connection" && request.method === "GET") {
        return await getConnection(request, env, session);
      }
      if (path === "/admin/connection" && request.method === "PUT") {
        return await saveConnection(request, env, session);
      }
      if (path === "/admin/staff" && request.method === "GET") return await listStaff(request, env, session);
      if (path === "/admin/staff" && request.method === "POST") return await createStaff(request, env, session);
      if (path === "/catalog/bulk" && request.method === "POST") {
        return await registerCatalogBulk(request, env, session);
      }
      if (path.startsWith("/recore/")) {
        return await proxyRecore(request, env, session, path.slice("/recore".length));
      }
      if ((path === "/" || path === "/ocr") && request.method === "POST") {
        return await handleOcr(request, env);
      }
      return json(request, env, { error: "Not Found" }, 404);
    } catch (error) {
      if (error && error.status === 400) return json(request, env, { error: error.message }, 400);
      console.error("request_failed", error instanceof Error ? error.message : String(error));
      return json(request, env, { error: "Internal Server Error" }, 500);
    }
  },
};

async function handleBootstrap(request, env) {
  if (!env.BOOTSTRAP_SECRET) {
    return json(request, env, { error: "BOOTSTRAP_SECRET is not configured" }, 503);
  }
  const supplied = request.headers.get("X-Bootstrap-Secret") || "";
  if (!(await safeStringEqual(supplied, env.BOOTSTRAP_SECRET))) {
    return json(request, env, { error: "Forbidden" }, 403);
  }

  const body = await readJson(request);
  const companyCode = normalizeCode(body.companyCode);
  const staffCode = normalizeCode(body.staffCode);
  const companyName = cleanText(body.companyName, 100) || companyCode;
  const staffName = cleanText(body.staffName, 100) || "管理者";
  const pin = String(body.pin || "");
  if (!validCode(companyCode) || !validCode(staffCode) || !validPin(pin)) {
    return json(request, env, { error: "Invalid bootstrap payload" }, 400);
  }

  const existing = await env.DB.prepare("SELECT id FROM tenants WHERE code = ?")
    .bind(companyCode).first();
  if (existing) return json(request, env, { error: "Company code already exists" }, 409);

  const tenantId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  const pinRecord = await hashPin(pin);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tenants (id, code, name, active, created_at) VALUES (?, ?, ?, 1, ?)"
    ).bind(tenantId, companyCode, companyName, now),
    env.DB.prepare(
      "INSERT INTO stores (id, tenant_id, name, recore_store_id, active, created_at) VALUES (?, ?, '未設定', NULL, 1, ?)"
    ).bind(storeId, tenantId, now),
    env.DB.prepare(
      "INSERT INTO staff (id, tenant_id, store_id, code, name, role, pin_hash, pin_salt, active, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, 1, ?)"
    ).bind(staffId, tenantId, storeId, staffCode, staffName, pinRecord.hash, pinRecord.salt, now),
  ]);
  return json(request, env, { ok: true, companyCode, staffCode }, 201);
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const companyCode = normalizeCode(body.companyCode);
  const staffCode = normalizeCode(body.staffCode);
  const pin = String(body.pin || "");
  if (!validCode(companyCode) || !validCode(staffCode) || !validPin(pin)) {
    return json(request, env, { error: "会社コード、スタッフコード、PINを確認してください" }, 400);
  }

  const rateKey = await sha256Hex(`${companyCode}:${staffCode}:${clientIp(request)}`);
  const now = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare(
    "SELECT failures, window_started_at, blocked_until FROM login_attempts WHERE key_hash = ?"
  ).bind(rateKey).first();
  if (attempt && Number(attempt.blocked_until) > now) {
    return json(request, env, { error: "試行回数が多すぎます。しばらく待ってから再試行してください" }, 429, {
      "Retry-After": String(Number(attempt.blocked_until) - now),
    });
  }

  const row = await env.DB.prepare(
    `SELECT s.id AS staff_id, s.name AS staff_name, s.role, s.pin_hash, s.pin_salt,
            s.store_id, t.id AS tenant_id, t.name AS company_name,
            st.name AS store_name, st.recore_store_id,
            c.credentials_ciphertext
       FROM staff s
       JOIN tenants t ON t.id = s.tenant_id AND t.active = 1
       JOIN stores st ON st.id = s.store_id AND st.active = 1
       LEFT JOIN connections c ON c.tenant_id = t.id AND c.provider = 'recore' AND c.active = 1
      WHERE t.code = ? AND s.code = ? AND s.active = 1`
  ).bind(companyCode, staffCode).first();
  let valid = false;
  if (row) {
    valid = await verifyPin(pin, row.pin_salt, row.pin_hash);
  } else {
    // Unknown staff still performs the expensive derivation to reduce account-enumeration timing signals.
    await hashPin(pin, new Uint8Array(16));
  }
  if (!valid) {
    await recordLoginFailure(env.DB, rateKey, attempt, now);
    return json(request, env, { error: "会社コード、スタッフコード、PINを確認してください" }, 401);
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(rateKey).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  const token = randomToken();
  const expiresAt = now + SESSION_TTL_SECONDS;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, staff_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(await sha256Hex(token), row.staff_id, expiresAt, now).run();
  return json(request, env, { ok: true, user: publicSession(row), expiresAt }, 200, {
    "Set-Cookie": sessionCookie(request, token),
  });
}

async function handleLogout(request, env) {
  const token = readSessionToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256Hex(token)).run();
  }
  return json(request, env, { ok: true }, 200, { "Set-Cookie": clearSessionCookie(request) });
}

async function handleSession(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return json(request, env, { authenticated: false }, 401, {
      "Set-Cookie": clearSessionCookie(request),
    });
  }
  return json(request, env, {
    authenticated: true, user: publicSession(session), expiresAt: Number(session.expires_at),
  });
}

async function getConnection(request, env, session) {
  if (session.role !== "admin") return json(request, env, { error: "Forbidden" }, 403);
  const row = await env.DB.prepare(
    `SELECT c.provider, c.credentials_ciphertext, st.name AS store_name, st.recore_store_id
       FROM stores st
       LEFT JOIN connections c ON c.tenant_id = st.tenant_id
         AND c.provider = 'recore' AND c.active = 1
      WHERE st.id = ? AND st.tenant_id = ? AND st.active = 1`
  ).bind(session.store_id, session.tenant_id).first();
  if (!row) return json(request, env, { error: "Store not found" }, 404);
  return json(request, env, {
    provider: "recore",
    configured: Boolean(row.credentials_ciphertext && row.recore_store_id),
    storeName: row.store_name === "未設定" ? "" : row.store_name,
    storeId: row.recore_store_id || "",
    apiKeySaved: Boolean(row.credentials_ciphertext),
  });
}

async function saveConnection(request, env, session) {
  if (session.role !== "admin") return json(request, env, { error: "Forbidden" }, 403);
  if (!env.API_KEY_ENCRYPTION_KEY) {
    return json(request, env, { error: "Encryption key is not configured" }, 503);
  }
  const body = await readJson(request);
  const provider = String(body.provider || "").toLowerCase();
  const storeName = cleanText(body.storeName, 100);
  const storeId = cleanText(String(body.storeId || ""), 100);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (provider !== "recore" || !storeName || !storeId) {
    return json(request, env, { error: "接続先、店舗名、店舗IDを入力してください" }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id, credentials_ciphertext, credentials_iv FROM connections WHERE tenant_id = ? AND provider = 'recore'"
  ).bind(session.tenant_id).first();
  if (!existing && !apiKey) {
    return json(request, env, { error: "初回設定ではAPIキーが必要です" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  let connectionStatement;
  if (apiKey) {
    const encrypted = await encryptSecret(apiKey, env.API_KEY_ENCRYPTION_KEY);
    connectionStatement = env.DB.prepare(
      `INSERT INTO connections
         (id, tenant_id, provider, credentials_ciphertext, credentials_iv, active, created_at, updated_at)
       VALUES (?, ?, 'recore', ?, ?, 1, ?, ?)
       ON CONFLICT(tenant_id, provider) DO UPDATE SET
         credentials_ciphertext = excluded.credentials_ciphertext,
         credentials_iv = excluded.credentials_iv,
         active = 1,
         updated_at = excluded.updated_at`
    ).bind(existing ? existing.id : crypto.randomUUID(), session.tenant_id,
      encrypted.ciphertext, encrypted.iv, now, now);
  } else {
    connectionStatement = env.DB.prepare(
      "UPDATE connections SET active = 1, updated_at = ? WHERE tenant_id = ? AND provider = 'recore'"
    ).bind(now, session.tenant_id);
  }

  await env.DB.batch([
    connectionStatement,
    env.DB.prepare(
      "UPDATE stores SET name = ?, recore_store_id = ? WHERE id = ? AND tenant_id = ?"
    ).bind(storeName, storeId, session.store_id, session.tenant_id),
  ]);
  return json(request, env, {
    ok: true,
    connection: { provider: "recore", configured: true, storeName, storeId, apiKeySaved: true },
    user: { ...publicSession(session), storeName, needsSetup: false },
  });
}

async function listStaff(request, env, session) {
  if (session.role !== "admin") return json(request, env, { error: "Forbidden" }, 403);
  const result = await env.DB.prepare(
    `SELECT s.code, s.name, s.role, s.active, st.name AS store_name, st.recore_store_id
       FROM staff s JOIN stores st ON st.id = s.store_id
      WHERE s.tenant_id = ? ORDER BY s.code`
  ).bind(session.tenant_id).all();
  return json(request, env, { staff: result.results || [] });
}

async function createStaff(request, env, session) {
  if (session.role !== "admin") return json(request, env, { error: "Forbidden" }, 403);
  const body = await readJson(request);
  const staffCode = normalizeCode(body.staffCode);
  const staffName = cleanText(body.staffName, 100);
  const pin = String(body.pin || "");
  const role = body.role === "admin" ? "admin" : "staff";
  const requestedStore = cleanText(String(body.recoreStoreId || ""), 100);
  if (!validCode(staffCode) || !staffName || !validPin(pin)) {
    return json(request, env, { error: "Invalid staff payload" }, 400);
  }

  let storeId = session.store_id;
  if (requestedStore) {
    const store = await env.DB.prepare(
      "SELECT id FROM stores WHERE tenant_id = ? AND recore_store_id = ? AND active = 1"
    ).bind(session.tenant_id, requestedStore).first();
    if (!store) return json(request, env, { error: "Store not found" }, 404);
    storeId = store.id;
  }
  const pinRecord = await hashPin(pin);
  try {
    await env.DB.prepare(
      "INSERT INTO staff (id, tenant_id, store_id, code, name, role, pin_hash, pin_salt, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"
    ).bind(crypto.randomUUID(), session.tenant_id, storeId, staffCode, staffName, role,
      pinRecord.hash, pinRecord.salt, Math.floor(Date.now() / 1000)).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return json(request, env, { error: "Staff code already exists" }, 409);
    }
    throw error;
  }
  return json(request, env, { ok: true, staffCode }, 201);
}

async function requireSession(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT se.expires_at, s.id AS staff_id, s.name AS staff_name, s.role, s.store_id,
            t.id AS tenant_id, t.name AS company_name,
            c.credentials_ciphertext, c.credentials_iv,
            st.name AS store_name, st.recore_store_id
       FROM sessions se
       JOIN staff s ON s.id = se.staff_id AND s.active = 1
       JOIN tenants t ON t.id = s.tenant_id AND t.active = 1
       JOIN stores st ON st.id = s.store_id AND st.active = 1
       LEFT JOIN connections c ON c.tenant_id = t.id AND c.provider = 'recore' AND c.active = 1
      WHERE se.token_hash = ? AND se.expires_at > ?`
  ).bind(await sha256Hex(token), Math.floor(Date.now() / 1000)).first();
}

async function proxyRecore(request, env, session, upstreamPath) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(upstreamPath); }
  catch { return json(request, env, { error: "Invalid path" }, 400); }
  const allowed = RECORE_ROUTES.some(([method, pattern]) =>
    method === request.method && pattern.test(decodedPath));
  if (!allowed) return json(request, env, { error: "RECORE route not allowed" }, 403);
  if (!env.API_KEY_ENCRYPTION_KEY) {
    return json(request, env, { error: "Encryption key is not configured" }, 503);
  }
  if (!session.credentials_ciphertext || !session.credentials_iv || !session.recore_store_id) {
    return json(request, env, { error: "Connection setup required" }, 409);
  }

  const apiKey = await decryptSecret(
    session.credentials_ciphertext, session.credentials_iv, env.API_KEY_ENCRYPTION_KEY
  );
  const sourceUrl = new URL(request.url);
  const upstreamUrl = new URL(decodedPath + sourceUrl.search, RECORE_API_URL);
  const headers = new Headers({
    Authorization: apiKey,
    "X-Store-Id": String(session.recore_store_id),
  });
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  let response;
  try {
    response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  } catch {
    return json(request, env, { error: "RECORE request failed" }, 502);
  }
  const responseHeaders = corsHeaders(request, env);
  const responseType = response.headers.get("Content-Type");
  if (responseType) responseHeaders.set("Content-Type", responseType);
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

async function registerCatalogBulk(request, env, session) {
  if (!env.API_KEY_ENCRYPTION_KEY) {
    return json(request, env, { error: "Encryption key is not configured" }, 503);
  }
  if (!session.credentials_ciphertext || !session.credentials_iv || !session.recore_store_id) {
    return json(request, env, { error: "Connection setup required" }, 409);
  }
  const payload = await readJson(request);
  if (!payload || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 20) {
    return json(request, env, { error: "items must contain 1 to 20 entries" }, 400);
  }
  const apiKey = await decryptSecret(
    session.credentials_ciphertext, session.credentials_iv, env.API_KEY_ENCRYPTION_KEY
  );
  const results = await mapWithConcurrency(payload.items, 3, async (raw, index) => {
    const clientId = cleanText(raw && raw.clientId, 80) || String(index);
    try {
      const item = normalizeCatalogItem(raw);
      if (item.mpn) {
        const existing = await recoreJsonRequest(
          apiKey, session.recore_store_id,
          `/products?pa_mpn=${encodeURIComponent(item.mpn)}&limit=10`, "GET"
        );
        if (Array.isArray(existing) && existing.length) {
          return { clientId, status: "existing", product: existing[0] };
        }
      }
      const attribute = {};
      if (item.mpn) attribute.mpn = item.mpn;
      if (item.rarity) attribute.custom_rarity = item.rarity;
      if (item.expansion) attribute.custom_expansion_name = item.expansion;
      const body = { title: item.title, category_id: item.categoryId, attribute };
      if (item.imageUrls.length) body.image_urls = item.imageUrls;
      const product = await recoreJsonRequest(
        apiKey, session.recore_store_id, "/products", "POST", body
      );
      return { clientId, status: "created", product };
    } catch (error) {
      return {
        clientId,
        status: "failed",
        error: error instanceof Error ? error.message : "Registration failed",
      };
    }
  });
  const summary = results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, { created: 0, existing: 0, failed: 0 });
  return json(request, env, { results, summary });
}

function normalizeCatalogItem(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid item");
  const title = cleanText(raw.title, 200);
  const categoryId = Number(raw.categoryId);
  if (!title) throw new Error("title is required");
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) throw new Error("categoryId is invalid");
  const imageUrls = Array.isArray(raw.imageUrls)
    ? raw.imageUrls.slice(0, 3).map((value) => cleanText(value, 2000)).filter((value) => {
        try { return new URL(value).protocol === "https:"; }
        catch { return false; }
      })
    : [];
  return {
    title,
    categoryId,
    mpn: cleanText(raw.mpn, 100),
    rarity: cleanText(raw.rarity, 100),
    expansion: cleanText(raw.expansion, 200),
    imageUrls,
  };
}

async function recoreJsonRequest(apiKey, storeId, path, method, body) {
  const response = await fetch(new URL(path, RECORE_API_URL), {
    method,
    headers: {
      Authorization: apiKey,
      "X-Store-Id": String(storeId),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`RECORE ${method} failed (${response.status})`);
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`RECORE ${method} returned invalid JSON`); }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function handleOcr(request, env) {
  if (!env.CLAUDE_API_KEY) return json(request, env, { error: "OCR is not configured" }, 503);
  const payload = await readJson(request);
  const base64Image = payload && payload.base64Image;
  if (!base64Image || typeof base64Image !== "string") {
    return json(request, env, { error: "base64Image is required" }, 400);
  }
  const { mediaType, data } = parseImage(base64Image);
  const full = payload.mode === "full";
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
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: full ? PROMPT_FULL : PROMPT_CODE },
        ] }],
      }),
    });
  } catch {
    return json(request, env, { error: "OCR request failed" }, 502);
  }
  if (!apiRes.ok) return json(request, env, { error: "OCR service error", status: apiRes.status }, 502);
  const result = await apiRes.json();
  const text = (result.content || []).filter((block) => block.type === "text")
    .map((block) => block.text).join("").trim();
  if (full) {
    const obj = parseJsonLoose(text);
    return json(request, env, {
      codes: Array.isArray(obj.codes) ? obj.codes.filter((code) => typeof code === "string") : extractCodes(text),
      title: typeof obj.title === "string" ? obj.title : "",
    });
  }
  return json(request, env, { codes: extractCodes(text) });
}

function publicSession(row) {
  return {
    name: row.staff_name,
    role: row.role,
    companyName: row.company_name,
    storeName: row.store_name === "未設定" ? "" : row.store_name,
    needsSetup: !row.credentials_ciphertext || !row.recore_store_id,
  };
}

async function recordLoginFailure(db, key, attempt, now) {
  const inWindow = attempt && now - Number(attempt.window_started_at) < LOGIN_WINDOW_SECONDS;
  const failures = inWindow ? Number(attempt.failures) + 1 : 1;
  const windowStartedAt = inWindow ? Number(attempt.window_started_at) : now;
  const blockedUntil = failures >= LOGIN_FAILURE_LIMIT ? now + LOGIN_BLOCK_SECONDS : 0;
  await db.prepare(
    `INSERT INTO login_attempts (key_hash, failures, window_started_at, blocked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key_hash) DO UPDATE SET failures = excluded.failures,
       window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until`
  ).bind(key, failures, windowStartedAt, blockedUntil).run();
}

async function hashPin(pin, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PIN_ITERATIONS }, key, 256
  );
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt) };
}

async function verifyPin(pin, saltBase64, expectedBase64) {
  const actual = await hashPin(pin, base64ToBytes(saltBase64));
  return crypto.subtle.timingSafeEqual(base64ToBytes(actual.hash), base64ToBytes(expectedBase64));
}

async function encryptSecret(value, keyBase64) {
  const key = await importEncryptionKey(keyBase64, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(value)
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptSecret(ciphertext, iv, keyBase64) {
  const key = await importEncryptionKey(keyBase64, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}

async function importEncryptionKey(value, usages) {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32) throw new Error("API_KEY_ENCRYPTION_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

async function safeStringEqual(a, b) {
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  for (const item of cookie.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (name === SESSION_COOKIE || name === "ikura_session") return rest.join("=");
  }
  return "";
}

function sessionCookie(request, token) {
  const isSecure = new URL(request.url).protocol === "https:";
  const name = isSecure ? SESSION_COOKIE : "ikura_session";
  const security = isSecure ? "; Secure; SameSite=None" : "; SameSite=Lax";
  return `${name}=${token}; Path=/; HttpOnly${security}; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie(request) {
  const isSecure = new URL(request.url).protocol === "https:";
  const name = isSecure ? SESSION_COOKIE : "ikura_session";
  const security = isSecure ? "; Secure; SameSite=None" : "; SameSite=Lax";
  return `${name}=; Path=/; HttpOnly${security}; Max-Age=0`;
}

function clientIp(request) { return request.headers.get("CF-Connecting-IP") || "unknown"; }
function normalizeCode(value) { return typeof value === "string" ? value.trim().toUpperCase() : ""; }
function validCode(value) { return /^[A-Z0-9_-]{2,32}$/.test(value); }
function validPin(value) { return /^\d{4,8}$/.test(value); }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }

async function readJson(request) {
  try { return await request.json(); }
  catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

function parseImage(base64Image) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(base64Image);
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: "image/jpeg", data: base64Image };
}

function parseJsonLoose(text) {
  if (!text) return {};
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (match) try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  return {};
}

function extractCodes(text) {
  const obj = parseJsonLoose(text);
  if (Array.isArray(obj.codes)) return obj.codes.filter((code) => typeof code === "string");
  const found = String(text || "").match(/\d+\/\d+/g);
  return found ? Array.from(new Set(found)) : [];
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function configuredOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  return configuredOrigins(env).includes(origin);
}

function corsHeaders(request, env) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Bootstrap-Secret",
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && originAllowed(request, env)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}
