export { TuyaListener } from "./listener.js";
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


// ---------- Cloud watcher (runs every minute) ----------
// Phone notifications when the home PC service is off: reads the alarm's cloud log for
// doorbell presses (sos_state) and alarms (master_state=alarm) and pushes them to ntfy.
const FS = (env, path) => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${env.FIREBASE_API_KEY}`;
async function fsDoc(env, path) {
  try {
    const r = await fetch(FS(env, path));
    if (!r.ok) return {};
    const f = (await r.json()).fields || {};
    return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.integerValue !== undefined ? Number(v.integerValue) : Object.values(v)[0]]));
  } catch { return {}; }
}
function q(params) { return Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&"); }
async function push(env, title, message, priority, tags) {
  if (env.TG_TOKEN && env.TG_CHAT) {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: `<b>${title}</b>
${message}`, parse_mode: "HTML" }),
    });
    return;
  }
  if (!env.NTFY_TOPIC) return;
  await fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, priority, tags: [tags] }) });
}
async function watch(env, now, dry) {
  const alive = await fsDoc(env, "bell/alive");
  const pcOn = alive.ts && now - alive.ts < 150_000;
  const set = { phone: true, alarm_push: true, ...(await fsDoc(env, "bell/settings")) };
  const start = now - 90_000, end = now - 30_000; // logs arrive with a short delay
  const path = `/v1.0/devices/${env.DEVICE_ID}/logs?` + q({ type: 7, start_time: start, end_time: end, size: 100 });
  const res = await tuya(env, "GET", path);
  const logs = (res.result && res.result.logs) || [];
  const DOORBELL_MSG = "AEQAbwBvAHIAYgBlAGwAbA=="; // "Doorbell" (UTF-16BE, base64)
  const bell = logs.filter((l) => (l.code === "sos_state" && String(l.value) === "true") || (l.code === "alarm_msg" && l.value === DOORBELL_MSG));
  const alarm = logs.filter((l) => l.code === "master_state" && l.value === "alarm");
  const t = (l) => new Date(l.event_time).toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const out = { pcOn, bell: bell.length, alarm: alarm.length, logs: dry ? logs : undefined, tuya: res.success ? "ok" : res.msg };
  if (pcOn || dry) return out;
  if (bell.length && set.phone) await push(env, "🔔 מצלצלים בדלת", t(bell[0]), 4, "bell");
  if (alarm.length && set.alarm_push) await push(env, "🚨 אזעקה בבית!", t(alarm[0]), 5, "rotating_light");
  return out;
}

const ALLOWED = [/^\/v1\.0\/iot-03\/devices\//, /^\/v1\.0\/devices\//, /^\/v2\.0\/cloud\/thing\//, /^\/v1\.0\/users\//, /^\/v1\.0\/iot-01\/associated-users\/devices/];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // Keep the instant listener connected; fall back to polling the cloud log while it is down.
      const stub = env.LISTENER.get(env.LISTENER.idFromName("alarm"));
      const info = await (await stub.fetch("https://listener/ensure")).json().catch(() => ({}));
      // Until Tuya has actually delivered a message, keep polling too (e.g. no messaging rule yet).
      if (!info.connected || !info.messages) await watch(env, event.scheduledTime, false);
    })());
  },
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
      if (url.pathname === "/watch-test") {
        if (!env.BELL_KEY || url.searchParams.get("key") !== env.BELL_KEY) throw new HttpError(403, "no");
        const mins = Number(url.searchParams.get("mins") || 0);
        return json(await watch(env, Date.now() - mins * 60_000, true));
      }
      if (url.pathname === "/listener") {
        if (!env.BELL_KEY || url.searchParams.get("key") !== env.BELL_KEY) throw new HttpError(403, "no");
        const stub = env.LISTENER.get(env.LISTENER.idFromName("alarm"));
        return json(await (await stub.fetch("https://listener/ensure")).json());
      }
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
