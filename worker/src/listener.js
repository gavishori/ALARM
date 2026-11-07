// Alarm loop (Durable Object; the class keeps its original name for the deployed binding).
// When an alarm is detected it sends a Telegram alert every 10 seconds until the system is
// disarmed, the "stop" button is pressed, or 5 minutes pass.
import { deviceStatus, telegram, hhmmss } from "./tuya.js";

const EVERY = 10_000;
const MAX = 5 * 60_000;

export class TuyaListener {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const s = (await this.state.storage.get("alarm")) || { active: false };
    if (url.pathname === "/alarm-start") {
      if (!s.active) {
        const at = Number(url.searchParams.get("at")) || Date.now();
        await this.state.storage.put("alarm", { active: true, started: Date.now(), at, n: 1 });
        await this.send(1, at);
        await this.state.storage.setAlarm(Date.now() + EVERY);
      }
    } else if (url.pathname === "/alarm-stop") {
      if (s.active) {
        await this.state.storage.put("alarm", { ...s, active: false });
        await telegram(this.env, "alarm", "🔕 ההתראות הושתקו", hhmmss() + " · האזעקה עצמה לא נוטרלה");
      }
    }
    return Response.json((await this.state.storage.get("alarm")) || { active: false });
  }

  async send(n, at) {
    await telegram(this.env, "alarm", `🚨 אזעקה בבית! (${n})`, `התחילה ב-${hhmmss(at)} · חוזר כל 10 שניות עד נטרול`,
      [{ text: "🔕 השתק התראות", callback_data: "stop" }]);
  }

  async alarm() {
    const s = await this.state.storage.get("alarm");
    if (!s || !s.active) return;
    const st = await deviceStatus(this.env).catch(() => null);
    if (st && st.master_mode === "disarmed") {
      await this.state.storage.put("alarm", { ...s, active: false });
      await telegram(this.env, "alarm", "✅ המערכת נוטרלה", hhmmss() + " · ההתראות נעצרו");
      return;
    }
    if (Date.now() - s.started > MAX) {
      await this.state.storage.put("alarm", { ...s, active: false });
      await telegram(this.env, "alarm", "⏹️ ההתראות נעצרו אחרי 5 דקות", "המערכת עדיין לא נוטרלה");
      return;
    }
    const n = s.n + 1;
    await this.state.storage.put("alarm", { ...s, n });
    await this.send(n, s.at);
    await this.state.storage.setAlarm(Date.now() + EVERY);
  }
}
