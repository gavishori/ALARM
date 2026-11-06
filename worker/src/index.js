// ALARM worker: signs requests to the Tuya Cloud API on behalf of the page.
// Only the owner's Firebase (Google) sign-in may use it. Tuya keys stay here as secrets.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg))).toUpperCase();
}

// ---------- Firebase ID token check ----------
let jwksCache = { keys: null, until: 0 };
async function googleKeys() {
  if (jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const j = await r.json();
  jwksCache = { keys: j.keys, until: Date.now() + 3600_000 };
  return j.keys;
}
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function verifyUser(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, "missing token");
  const [h, p, s] = m[1].split(".");
  const head = JSON.parse(new TextDecoder().decode(b64url(h)));
  const body = JSON.parse(new TextDecoder().decode(b64url(p)));
  const jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk) throw new HttpError(401, "unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), enc.encode(h + "." + p));
  const now = Date.now() / 1000;
  if (!ok || body.aud !== env.FIREBASE_PROJECT || body.iss !== "https://securetoken.google.com/" + env.FIREBASE_PROJECT || body.exp < now)
    throw new HttpError(401, "bad token");
  if (body.email !== env.OWNER_EMAIL) throw new HttpError(403, "not allowed");
  return body;
}

// ---------- Tuya Cloud ----------
let tuyaToken = { value: null, until: 0 };
async function tuyaSign(env, method, path, bodyStr, accessToken) {
  const t = Date.now().toString();
  const stringToSign = [method, await sha256(bodyStr || ""), "", path].join("\n");
  const sign = await hmac(env.TUYA_SECRET, env.TUYA_ID + (accessToken || "") + t + stringToSign);
  const h = { client_id: env.TUYA_ID, sign, t, sign_method: "HMAC-SHA256" };
  if (accessToken) h.access_token = accessToken;
  return h;
}
async function getToken(env) {
  if (tuyaToken.value && Date.now() < tuyaToken.until) return tuyaToken.value;
  const path = "/v1.0/token?grant_type=1";
  const r = await fetch(env.TUYA_HOST + path, { headers: await tuyaSign(env, "GET", path, "") });
  const j = await r.json();
  if (!j.success) throw new HttpError(502, "tuya token: " + (j.msg || j.code));
  tuyaToken = { value: j.result.access_token, until: Date.now() + (j.result.expire_time - 120) * 1000 };
  return tuyaToken.value;
}
async function tuya(env, method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const token = await getToken(env);
  const headers = await tuyaSign(env, method, path, bodyStr, token);
  if (bodyStr) headers["Content-Type"] = "application/json";
  const r = await fetch(env.TUYA_HOST + path, { method, headers, body: bodyStr || undefined });
  const j = await r.json();
  if (!j.success && (j.code === 1010 || j.code === 1011)) tuyaToken = { value: null, until: 0 }; // expired token
  return j;
}

// Tuya query strings must be signed with keys in sorted order.
function sortedPath(url) {
  const keys = [...url.searchParams.keys()].sort();
  const qs = keys.map((k) => k + "=" + url.searchParams.get(k)).join("&");
  return url.pathname.replace(/^\/api/, "") + (qs ? "?" + qs : "");
}

const ALLOWED = [/^\/v1\.0\/iot-03\/devices\//, /^\/v1\.0\/devices\//, /^\/v2\.0\/cloud\/thing\//, /^\/v1\.0\/users\//, /^\/v1\.0\/iot-01\/associated-users\/devices/];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export default {
  async fetch(req, env) {
    const origins = env.ALLOWED_ORIGINS.split(",");
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      Vary: "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      const url = new URL(req.url);
      if (url.pathname === "/health") return json({ ok: true, tuyaKeys: !!(env.TUYA_ID && env.TUYA_SECRET) });
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
      await verifyUser(req, env);
      if (!env.TUYA_ID || !env.TUYA_SECRET) throw new HttpError(503, "tuya keys not set");
      const path = sortedPath(url);
      if (!ALLOWED.some((re) => re.test(path))) throw new HttpError(403, "path not allowed");
      const body = ["POST", "PUT"].includes(req.method) ? await req.json() : null;
      return json(await tuya(env, req.method, path, body));
    } catch (e) {
      return json({ success: false, msg: e.message }, e.status || 500);
    }
  },
};
