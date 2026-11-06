// Always-on listener for Tuya's Message Service (Pulsar over WebSocket).
// Tuya pushes every report from the alarm the moment it happens; we turn doorbell
// presses and alarms into Telegram messages within seconds. The cron pings this object
// every minute so the connection is re-opened if it ever drops.

const PULSAR_EU = "https://mqe.tuyaeu.com:8285/";
const DOORBELL_MSG = "AEQAbwBvAHIAYgBlAGwAbA=="; // "Doorbell" as UTF-16BE, base64

const md5hex = async (s) => {
  // WebCrypto has no MD5; Workers expose it through the node-compatible digest name.
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class TuyaListener {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.info = { connected: false, since: 0, lastMessage: 0, messages: 0, lastError: "", lastEvent: "" };
    this.lastBell = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ensure") await this.ensure();
    return Response.json(this.info);
  }

  async ensure() {
    if (this.ws && this.info.connected) return;
    try {
      const id = this.env.TUYA_ID;
      const password = (await md5hex(id + (await md5hex(this.env.TUYA_SECRET)))).substring(8, 24);
      const topic = `ws/v2/consumer/persistent/${id}/out/event/${id}-sub?ackTimeoutMillis=3000&subscriptionType=Failover`;
      const resp = await fetch(PULSAR_EU + topic, { headers: { Upgrade: "websocket", username: id, password } });
      const ws = resp.webSocket;
      if (!ws) throw new Error("no websocket (HTTP " + resp.status + ") " + (await resp.text()).slice(0, 200));
      ws.accept();
      this.ws = ws;
      this.info.connected = true;
      this.info.since = Date.now();
      this.info.lastError = "";
      ws.addEventListener("message", (e) => this.state.waitUntil(this.onMessage(e.data)));
      const down = (why) => { this.info.connected = false; this.ws = null; this.info.lastError = why; };
      ws.addEventListener("close", (e) => down("closed " + e.code + " " + (e.reason || "")));
      ws.addEventListener("error", () => down("socket error"));
    } catch (e) {
      this.info.connected = false;
      this.info.lastError = String(e.message || e);
    }
  }

  async onMessage(raw) {
    this.info.lastMessage = Date.now();
    this.info.messages++;
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (msg.messageId) this.ws?.send(JSON.stringify({ messageId: msg.messageId })); // ack
    try {
      const outer = JSON.parse(new TextDecoder().decode(b64(msg.payload)));
      const data = await this.decrypt(outer.data, msg.properties?.em);
      const body = JSON.parse(data);
      const st = (body.bizData?.properties || body.status || []);
      if ((body.devId || body.bizData?.devId) && (body.devId || body.bizData?.devId) !== this.env.DEVICE_ID) return;
      for (const s of st) await this.onStatus(s.code, s.value);
    } catch (e) {
      this.info.lastError = "decode: " + (e.message || e);
    }
  }

  async decrypt(data, em) {
    const key = new TextEncoder().encode(this.env.TUYA_SECRET.substring(8, 24));
    const bytes = b64(data);
    if (em === "aes_gcm" || !em) {
      try {
        const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
        const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, k, bytes.slice(12));
        return new TextDecoder().decode(out);
      } catch (e) { if (em === "aes_gcm") throw e; }
    }
    throw new Error("unsupported encryption " + em);
  }

  async notify(title, message, settingKey) {
    const env = this.env;
    try {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/bell/settings?key=${env.FIREBASE_API_KEY}`);
      const f = r.ok ? (await r.json()).fields || {} : {};
      if (f[settingKey] && f[settingKey].booleanValue === false) return;
    } catch {}
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: `<b>${title}</b>
${message}`, parse_mode: "HTML" }),
    });
  }

  async onStatus(code, value) {
    this.info.lastEvent = code + "=" + String(value).slice(0, 40);
    const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
    const isBell = (code === "sos_state" && String(value) === "true") || (code === "alarm_msg" && value === DOORBELL_MSG);
    if (isBell) {
      if (Date.now() - this.lastBell < 5000) return; // one press reports twice
      this.lastBell = Date.now();
      await this.notify("🔔 מצלצלים בדלת", time, "phone");
    } else if (code === "master_state" && value === "alarm") {
      await this.notify("🚨 אזעקה בבית!", time, "alarm_push");
    }
  }
}
