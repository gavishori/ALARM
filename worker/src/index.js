// ALARM worker:
//  - /api/*      signed Tuya Cloud calls for the page (owner's Firebase sign-in only)
//  - cron        every minute reads the alarm's cloud log: door opened -> Telegram,
//                alarm -> starts the repeating alarm loop (listener.js)
//  - /tg-hook    Telegram button presses (stop the repeating alerts)
import { tuya, fsDoc, telegram, hhmmss, HttpError } from "./tuya.js";
export { TuyaListener } from "./listener.js";

const enc = new TextEncoder();

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

// Tuya query strings must be signed with keys in sorted order.
function sortedPath(url) {
  const keys = [...url.searchParams.keys()].sort();
  const qs = keys.map((k) => k + "=" + url.searchParams.get(k)).join("&");
  return url.pathname.replace(/^\/api/, "") + (qs ? "?" + qs : "");
}
const q = (params) => Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&");
const loop = (env) => env.LISTENER.get(env.LISTENER.idFromName("alarm"));

// ---------- Cloud watcher (every minute) ----------
const DOORBELL_MSG = "AEQAbwBvAHIAYgBlAGwAbA=="; // "Doorbell" (UTF-16BE, base64) - sent when the front door opens
async function watch(env, now, dry) {
  const alive = await fsDoc(env, "bell/alive");
  const pcOn = alive.ts && now - alive.ts < 150_000;
  const set = { phone: true, alarm_push: true, ...(await fsDoc(env, "bell/settings")) };
  const start = now - 70_000, end = now - 10_000; // logs reach the cloud within a few seconds
  const path = `/v1.0/devices/${env.DEVICE_ID}/logs?` + q({ type: 7, start_time: start, end_time: end, size: 100 });
  const res = await tuya(env, "GET", path);
  const logs = (res.result && res.result.logs) || [];
  const door = logs.filter((l) => (l.code === "sos_state" && String(l.value) === "true") || (l.code === "alarm_msg" && l.value === DOORBELL_MSG));
  const alarm = logs.filter((l) => l.code === "master_state" && l.value === "alarm");
  const out = { pcOn, door: door.length, alarm: alarm.length, logs: dry ? logs : undefined, tuya: res.success ? "ok" : res.msg };
  if (dry) return out;
  if (alarm.length && set.alarm_push) await loop(env).fetch("https://loop/alarm-start?at=" + alarm[0].event_time);
  if (!pcOn && door.length && set.phone) await telegram(env, "door", "🚪 דלת הכניסה נפתחה", hhmmss(door[0].event_time));
  return out;
}

const ALLOWED = [/^\/v1\.0\/iot-03\/devices\//, /^\/v1\.0\/devices\//, /^\/v2\.0\/cloud\/thing\//, /^\/v1\.0\/users\//, /^\/v1\.0\/iot-01\/associated-users\/devices/];
const keyOk = (url, env) => env.BELL_KEY && url.searchParams.get("key") === env.BELL_KEY;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watch(env, event.scheduledTime, false));
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

      // Telegram button presses. Telegram sends the secret we registered with setWebhook.
      if (url.pathname === "/tg-hook") {
        if (!env.TG_HOOK_SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_HOOK_SECRET) throw new HttpError(403, "no");
        const upd = await req.json();
        const cb = upd.callback_query;
        const okChat = cb && [String(env.TG_ALARM_CHAT), String(env.TG_CHAT)].includes(String(cb.message?.chat?.id));
        if (cb && okChat && cb.data === "stop") await loop(env).fetch("https://loop/alarm-stop");
        if (cb) {
          const token = String(cb.message?.chat?.id) === String(env.TG_ALARM_CHAT) ? env.TG_ALARM_TOKEN : env.TG_TOKEN;
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: okChat ? "ההתראות הושתקו" : "" }),
          });
        }
        return json({ ok: true });
      }

      // Owner diagnostics (BELL_KEY).
      if (url.pathname === "/watch-test") {
        if (!keyOk(url, env)) throw new HttpError(403, "no");
        return json(await watch(env, Date.now() - Number(url.searchParams.get("mins") || 0) * 60_000, true));
      }
      if (url.pathname === "/alarm-test" || url.pathname === "/alarm-stop" || url.pathname === "/loop") {
        if (!keyOk(url, env)) throw new HttpError(403, "no");
        const p = { "/alarm-test": "/alarm-start", "/alarm-stop": "/alarm-stop", "/loop": "/state" }[url.pathname];
        return json(await (await loop(env).fetch("https://loop" + p)).json());
      }
      if (url.pathname === "/tuya-debug") {
        if (!keyOk(url, env)) throw new HttpError(403, "no");
        const p = url.searchParams.get("path") || "";
        if (!/^\/v1\.0\/(devices\/[^/]+$|iot-03\/devices\/[^/]+(\/status)?$)/.test(p)) throw new HttpError(403, "path");
        return json(await tuya(env, "GET", p));
      }
      if (url.pathname === "/health") return json({ ok: true, tuyaKeys: !!(env.TUYA_ID && env.TUYA_SECRET), alarmBot: !!env.TG_ALARM_TOKEN });

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
