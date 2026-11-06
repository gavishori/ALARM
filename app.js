import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDxGXV0B_vacFz09GHMSlt4kpYFlqFOld8",
  authDomain: "alarm-eba80.firebaseapp.com",
  projectId: "alarm-eba80",
  appId: "1:582180340928:web:49744c597f6c23d6da1925",
  messagingSenderId: "582180340928",
};
const WORKER = "https://alarm-tuya.gavishori.workers.dev";

const $ = (id) => document.getElementById(id);
const auth = getAuth(initializeApp(firebaseConfig));

// ---------- Hebrew labels for common Tuya alarm codes ----------
const MODE_HE = { arm: "דרוכה", armed: "דרוכה", home: "דריכת בית", disarm: "מנוטרלת", disarmed: "מנוטרלת", sos: "מצוקה" };
// Tuya's own names for this host are partly Chinese; translate by name too.
const NAME_HE = {
  "设置密码": "סיסמת יחידה", "未接听重复拨打次数": "חיוגים חוזרים כשאין מענה", "主机状态": "מצב היחידה",
  "恢复出厂设置": "איפוס להגדרות יצרן", "子设备管理": "ניהול גלאים", "紧急状态": "מצב חירום",
};
// Never offered as controls: factory reset, raw/password data, and anything that would set off the siren.
const HIDDEN = new Set(["恢复出厂设置", "设置密码", "子设备管理", "factory_reset", "password", "password_set", "sub_admin", "alarm_call_number", "alarm_sms_number"]);
const READONLY = new Set(["主机状态", "紧急状态", "master_state", "sos_state"]);
const MSG_HE = {
  "Doorbell": "פעמון", "System Disarmed": "המערכת נוטרלה", "System Armed": "המערכת נדרכה", "Home Armed": "דריכת בית",
  "System Armed Home": "דריכת בית", "SOS": "מצוקה", "Low Battery": "סוללה חלשה", "Power Off": "הפסקת חשמל", "AC Power Off": "הפסקת חשמל",
  "Power On": "החשמל חזר", "AC Power Recover": "החשמל חזר", "Tamper": "פירוק גלאי", "Alarm": "אזעקה", "Door Open": "דלת נפתחה",
};
const heMsg = (v) => MSG_HE[v] || String(v).replace(/\bZone\b/i, "אזור").replace(/\bAlarm\b/i, "אזעקה");
const LABELS = {
  delay_set: "השהיית יציאה (שניות)", alarm_delay_time: "השהיית כניסה (שניות)", alarm_time: "משך צפירה (דקות)",
  switch_alarm_sound: "צפירה", switch_alarm_light: "נורית אזעקה", switch_alarm_sms: "התראת SMS", switch_alarm_call: "חיוג בזמן אזעקה",
  switch_alarm_propel: "התראה לאפליקציה", switch_mode_sound: "צליל בשינוי מצב", switch_mode_light: "נורית בשינוי מצב",
  switch_kb_sound: "צליל מקלדת", switch_kb_light: "תאורת מקלדת", switch_low_battery: "התראת סוללה חלשה",
  alarm_volume_value: "עוצמת צפירה", alarm_volume: "עוצמת צפירה", muffling: "השתקה", alarm_call_number: "מספרי חיוג",
  alarm_sms_number: "מספרי SMS", switch_mode_dl_sound: "צליל בהשהיה", master_language: "שפה",
  master_state: "מצב היחידה", alarm_msg: "הודעה", master_mode: "שינוי מצב", sos_state: "מצב חירום",
};
const VALUE_HE = { low: "נמוך", middle: "בינוני", high: "גבוה", mute: "מושתק", normal: "רגיל", alarm: "אזעקה", true: "פעיל", false: "כבוי", ...MODE_HE };
const SENSOR_STATUS = {
  doorcontact_state: (v) => v ? ["פתוח", "warn"] : ["סגור", "ok"],
  pir: (v) => v === "pir" ? ["תנועה", "warn"] : ["שקט", "ok"],
  smoke_sensor_status: (v) => v === "alarm" ? ["עשן!", "bad"] : ["תקין", "ok"],
  gas_sensor_status: (v) => v === "alarm" ? ["גז!", "bad"] : ["תקין", "ok"],
  watersensor_state: (v) => v === "alarm" ? ["מים!", "bad"] : ["יבש", "ok"],
  battery_percentage: (v) => [`🔋 ${v}%`, v < 20 ? "bad" : ""],
  battery_state: (v) => [`🔋 ${VALUE_HE[v] || v}`, v === "low" ? "bad" : ""],
  temper_alarm: (v) => v ? ["פירוק!", "bad"] : null,
};

// ---------- API ----------
async function api(method, path, body) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch(WORKER + "/api" + path, {
    method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ success: false, msg: "HTTP " + r.status }));
  if (!j.success) throw new Error(j.msg || j.code || "שגיאה");
  return j.result;
}

function showMsg(text, isErr) {
  const m = $("msg");
  m.textContent = text; m.className = "msg" + (isErr ? " err" : ""); m.hidden = !text;
  if (text && !isErr) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 4000);
}

// ---------- State ----------
let devId = localStorage.getItem("alarmDev") || "bfb38a8ec85a3ee13fuund";
let spec = { functions: [], status: [] };
let status = {};

async function loadDevices() {
  const res = await api("GET", "/v2.0/cloud/thing/device?page_size=20");
  const list = Array.isArray(res) ? res : res.list || [];
  const sel = $("devSel");
  sel.innerHTML = list.map((d) => `<option value="${d.id}">${esc(d.customName || d.name)} (${d.category})</option>`).join("");
  if (list.length && !list.find((d) => d.id === devId)) devId = (list.find((d) => d.category === "mal") || list[0] || {}).id || "";
  sel.value = devId;
  if (!devId) throw new Error("לא נמצאו מכשירים בפרויקט Tuya");
}

async function loadAll() {
  $("btnRefresh").disabled = true;
  try {
    if (!$("devSel").options.length) await loadDevices().catch((e) => console.warn("device list", e));
    const [info, st, sp] = await Promise.all([
      api("GET", `/v1.0/iot-03/devices/${devId}`),
      api("GET", `/v1.0/iot-03/devices/${devId}/status`),
      api("GET", `/v1.0/iot-03/devices/${devId}/specification`).catch(() => ({ functions: [], status: [] })),
    ]);
    spec = sp; status = Object.fromEntries(st.map((s) => [s.code, s.value]));
    const { local_key, ...safeInfo } = info;
    $("raw").textContent = JSON.stringify({ info: safeInfo, status, spec }, null, 1);
    // Full thing model: lists every data point the device has, including ones missing from the standard spec.
    api("GET", `/v2.0/cloud/thing/${devId}/model`).then((m) => {
      let props = [];
      try { props = JSON.parse(m.model).services.flatMap((sv) => sv.properties.map((p) => ({ id: p.abilityId, code: p.code, name: p.name, mode: p.accessMode, type: p.typeSpec }))); } catch {}
      $("raw").textContent = JSON.stringify({ model: props }, null, 1) + "\n\n" + $("raw").textContent;
    }).catch((e) => { $("raw").textContent = "model: " + e.message + "\n\n" + $("raw").textContent; });
    renderStatus(info);
    renderSettings();
    loadSensors();
    loadLogs();
  } catch (e) { showMsg("טעינה נכשלה: " + e.message, true); }
  finally { $("btnRefresh").disabled = false; }
}

// The device's own enum values for master_mode (e.g. "disarmed" rather than "disarm").
const modeKey = (v) => String(v || "").replace(/ed$/, "");
function modeValue(key) {
  const f = (spec.functions || []).find((x) => x.code === "master_mode");
  let range = []; try { range = JSON.parse(f?.values || "{}").range || []; } catch {}
  return range.find((r) => modeKey(r) === key) || key;
}

function renderStatus(info) {
  const on = info.online;
  $("online").textContent = on ? "מחובר" : "לא מחובר";
  $("online").className = "chip " + (on ? "ok" : "bad");
  if ("charge_state" in status) {
    $("power").hidden = false;
    $("power").textContent = status.charge_state ? "🔌 חשמל" : "🔋 על סוללה";
    $("power").className = "chip " + (status.charge_state ? "ok" : "warn");
  }
  const mode = status.master_mode;
  $("modeNow").textContent = MODE_HE[mode] || mode || "—";
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === modeKey(mode)));
  $("alarmBanner").hidden = !(status.master_state === "alarm" || status.alarm_state === "alarm" || mode === "sos");
}

async function setMode(mode) {
  if (mode === "sos" && !confirm("להפעיל אזעקת מצוקה?")) return;
  if (mode === "arm" && !confirm("לדרוך את האזעקה במצב מלא?")) return;
  document.querySelectorAll(".mode").forEach((b) => (b.disabled = true));
  try {
    await api("POST", `/v1.0/iot-03/devices/${devId}/commands`, { commands: [{ code: "master_mode", value: modeValue(mode) }] });
    status.master_mode = modeValue(mode);
    renderStatus({ online: true });
    showMsg("נשלח: " + MODE_HE[mode]);
    setTimeout(loadAll, 2500);
  } catch (e) { showMsg("הפקודה נכשלה: " + e.message, true); }
  finally { document.querySelectorAll(".mode").forEach((b) => (b.disabled = false)); }
}

// ---------- Settings (built from the device's own function list) ----------
function renderSettings() {
  const box = $("settings");
  const fns = (spec.functions || []).filter((f) => f.code !== "master_mode" && !HIDDEN.has(f.code) && !HIDDEN.has(f.name) && ["Boolean", "Enum", "Integer"].includes(f.type));
  if (!fns.length) { box.innerHTML = '<p class="muted">המכשיר לא חושף הגדרות דרך הענן.</p>'; return; }
  box.innerHTML = "";
  for (const f of fns) {
    let v; try { v = JSON.parse(f.values || "{}"); } catch { v = {}; }
    const cur = status[f.code];
    const row = document.createElement("div");
    row.className = "setting";
    row.innerHTML = `<span>${esc(LABELS[f.code] || NAME_HE[f.name] || f.name || f.code)}</span>`;
    let input;
    if (READONLY.has(f.code) || READONLY.has(f.name)) {
      row.insertAdjacentHTML("beforeend", `<span class="chip">${esc(VALUE_HE[String(cur)] || String(cur ?? "—"))}</span>`);
    } else if (f.type === "Boolean") {
      row.insertAdjacentHTML("beforeend", `<label class="switch"><input type="checkbox" ${cur ? "checked" : ""}><span></span></label>`);
      input = row.querySelector("input");
      input.onchange = () => sendSetting(f.code, input.checked, input);
    } else if (f.type === "Enum") {
      input = document.createElement("select");
      input.innerHTML = (v.range || []).map((o) => `<option value="${esc(o)}" ${o === cur ? "selected" : ""}>${esc(VALUE_HE[o] || o)}</option>`).join("");
      input.onchange = () => sendSetting(f.code, input.value, input);
      row.append(input);
    } else if (f.type === "Integer") {
      input = document.createElement("input");
      Object.assign(input, { type: "number", min: v.min ?? 0, max: v.max ?? 999, step: v.step ?? 1, value: cur ?? "" });
      input.onchange = () => sendSetting(f.code, Number(input.value), input);
      row.append(input);
    } else {
      row.insertAdjacentHTML("beforeend", `<span class="muted">${esc(String(cur ?? "—"))}</span>`);
    }
    box.append(row);
  }
}

async function sendSetting(code, value, el) {
  el.disabled = true;
  try {
    await api("POST", `/v1.0/iot-03/devices/${devId}/commands`, { commands: [{ code, value }] });
    status[code] = value;
    showMsg("ההגדרה נשמרה");
  } catch (e) { showMsg("שמירה נכשלה: " + e.message, true); renderSettings(); }
  finally { el.disabled = false; }
}

// ---------- Sensors ----------
// The host keeps its RF sensors in the sub_admin data point: per sensor
// [index, type, zone, ff ff ff, name length, name in UTF-16BE].
function parseSensors(b64) {
  const out = [];
  if (!b64) return out;
  const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let i = 3;
  while (i + 7 <= b.length) {
    const idx = b[i], type = b[i + 1], zone = b[i + 2], len = b[i + 6];
    const nb = b.slice(i + 7, i + 7 + len);
    let name = "";
    for (let k = 0; k + 1 < nb.length; k += 2) name += String.fromCharCode((nb[k] << 8) | nb[k + 1]);
    out.push({ idx, type, zone, name: name.trim() });
    i += 7 + len;
  }
  return out;
}
function loadSensors() {
  const ul = $("sensors");
  let list = [];
  try { list = parseSensors(status.sub_admin); } catch {}
  if (!list.length) { ul.innerHTML = '<li class="muted">היחידה לא דיווחה על גלאים</li>'; return; }
  ul.innerHTML = list.map((x) => `<li><div><div class="sensor-name">${esc(x.name || "גלאי " + (x.idx + 1))}</div>
    <div class="sensor-sub">מספר ${x.idx + 1}</div></div></li>`).join("");
}

// ---------- Event log ----------
async function loadLogs() {
  const ul = $("logs");
  try {
    const end = Date.now(), start = end - 7 * 864e5;
    const res = await api("GET", `/v1.0/devices/${devId}/logs?type=7&start_time=${start}&end_time=${end}&size=40`);
    const logs = (res.logs || []).filter((l) => ["master_mode", "master_state", "alarm_msg", "sub_state", "alarm_state"].includes(l.code) || l.code?.startsWith("alarm"));
    if (!logs.length) { ul.innerHTML = '<li class="muted">אין אירועים בשבוע האחרון</li>'; return; }
    ul.innerHTML = logs.map((l) => {
      const t = new Date(l.event_time).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
      const raw = decodeMaybe(l.value);
      const val = VALUE_HE[raw] || heMsg(raw);
      return `<li><span>${esc(LABELS[l.code] || l.code)}: ${esc(val)}</span><span class="muted">${t}</span></li>`;
    }).join("");
  } catch (e) { ul.innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
}
function decodeMaybe(v) {
  if (typeof v === "string" && /^[A-Za-z0-9+/=]{8,}$/.test(v)) {
    try { return new TextDecoder("utf-16be").decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))); } catch {}
  }
  return String(v);
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- Wiring ----------
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("btnRefresh").onclick = loadAll;
$("devSel").onchange = (e) => { devId = e.target.value; localStorage.setItem("alarmDev", devId); loadAll(); };
$("btnCopy").onclick = () => navigator.clipboard.writeText($("raw").textContent).then(() => showMsg("הועתק"));
$("btnOut").onclick = () => signOut(auth);
$("btnLogin").onclick = async () => {
  $("loginErr").textContent = "";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) await signInWithRedirect(auth, new GoogleAuthProvider());
    else $("loginErr").textContent = e.message;
  }
};
getRedirectResult(auth).catch((e) => ($("loginErr").textContent = e.message));

onAuthStateChanged(auth, (u) => {
  $("login").hidden = !!u; $("app").hidden = !u; $("btnOut").hidden = !u;
  if (u) { loadAll(); clearInterval(window._poll); window._poll = setInterval(() => !document.hidden && loadAll(), 30000); }
  else clearInterval(window._poll);
});
