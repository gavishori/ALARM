// Shared helpers: signed Tuya Cloud calls, Firestore reads, Telegram sends.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg))).toUpperCase();
}

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

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
export async function tuya(env, method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const token = await getToken(env);
  const headers = await tuyaSign(env, method, path, bodyStr, token);
  if (bodyStr) headers["Content-Type"] = "application/json";
  const r = await fetch(env.TUYA_HOST + path, { method, headers, body: bodyStr || undefined });
  const j = await r.json();
  if (!j.success && (j.code === 1010 || j.code === 1011)) tuyaToken = { value: null, until: 0 }; // expired token
  return j;
}
export async function deviceStatus(env) {
  const r = await tuya(env, "GET", `/v1.0/iot-03/devices/${env.DEVICE_ID}/status`);
  return r.success ? Object.fromEntries(r.result.map((s) => [s.code, s.value])) : null;
}

// ---------- Firestore (public read of the doorbell settings) ----------
export async function fsDoc(env, path) {
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${env.FIREBASE_API_KEY}`);
    if (!r.ok) return {};
    const f = (await r.json()).fields || {};
    return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.integerValue !== undefined ? Number(v.integerValue) : Object.values(v)[0]]));
  } catch { return {}; }
}

// ---------- Telegram ----------
// kind "alarm" goes to the separate alarm bot (its own loud sound) when it is set up.
export async function telegram(env, kind, title, message, buttons) {
  const alarmBot = kind === "alarm" && env.TG_ALARM_TOKEN && env.TG_ALARM_CHAT;
  const token = alarmBot ? env.TG_ALARM_TOKEN : env.TG_TOKEN;
  const chat = alarmBot ? env.TG_ALARM_CHAT : env.TG_CHAT;
  if (!token || !chat) return;
  const body = { chat_id: chat, text: `<b>${title}</b>\n${message}`, parse_mode: "HTML" };
  if (buttons) body.reply_markup = { inline_keyboard: [buttons] };
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
export const hhmmss = (ms = Date.now()) => new Date(ms).toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
