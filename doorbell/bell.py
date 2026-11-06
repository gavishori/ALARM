# Doorbell + alarm companion for the W210 alarm host.
# Talks to the host directly on the home network (Tuya local protocol 3.5, no cloud),
# and on a doorbell press plays the chosen chime on this PC and pushes a phone notification
# (with a camera snapshot when go2rtc is running). Settings come from the ALARM page (Firestore).
import base64, json, os, sys, tempfile, threading, time, urllib.request, wave, winsound
from datetime import datetime
from email.header import Header

import tinytuya

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.local.json"), encoding="utf-8"))
SETTINGS_URL = ("https://firestore.googleapis.com/v1/projects/alarm-eba80/databases/(default)"
                "/documents/bell/settings?key=" + CFG["firebase_api_key"])
DEFAULTS = {"pc_sound": False, "tone": "dingdong", "volume": 80, "phone": True, "alarm_push": True,
            "quiet_from": "22:00", "quiet_to": "07:00", "quiet_volume": 25, "camera": "", "test": 0}
DP_BELL, DP_MODE, DP_STATE, DP_MSG = "44", "1", "32", "26"

settings = dict(DEFAULTS)
last_ring = 0.0
connected = False


def log(*a):
    line = datetime.now().strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)
    with open(os.path.join(HERE, "bell.log"), "a", encoding="utf-8") as f:
        f.write(line + "\n")


# ---------- settings from the page ----------
def fetch_settings():
    with urllib.request.urlopen(SETTINGS_URL, timeout=10) as r:
        fields = json.load(r).get("fields", {})
    out = dict(DEFAULTS)
    for k, v in fields.items():
        out[k] = next(iter(v.values()))
        if "integerValue" in v: out[k] = int(out[k])
    return out


ALIVE_URL = SETTINGS_URL.replace("/bell/settings?", "/bell/alive?")


def heartbeat():
    # Tells the cloud watcher the PC is handling notifications (avoids duplicate pushes).
    body = json.dumps({"fields": {"ts": {"integerValue": str(int(time.time() * 1000))}}}).encode()
    req = urllib.request.Request(ALIVE_URL, data=body, method="PATCH", headers={"Content-Type": "application/json"})
    try: urllib.request.urlopen(req, timeout=10).read()
    except Exception: pass


def settings_loop():
    global settings
    first = True
    while True:
        try:
            new = fetch_settings()
            if not first and new.get("test") != settings.get("test"):
                log("test ring requested from the page")
                threading.Thread(target=ring, args=(True,), daemon=True).start()
            settings = new
            first = False
        except Exception as e:
            if first and not getattr(settings_loop, "warned", False):
                log("settings: using defaults (", e, ")"); settings_loop.warned = True
        if connected: heartbeat()
        time.sleep(15)


# ---------- sound ----------
def in_quiet_hours():
    now = datetime.now().strftime("%H:%M")
    a, b = settings["quiet_from"], settings["quiet_to"]
    return (a <= now < b) if a < b else (now >= a or now < b)


def play(tone, volume):
    src = os.path.join(HERE, "sounds", tone + ".wav")
    if not os.path.exists(src): src = os.path.join(HERE, "sounds", "dingdong.wav")
    with wave.open(src) as w:
        params, frames = w.getparams(), w.readframes(w.getnframes())
    import array
    a = array.array("h", frames)
    k = max(0, min(100, volume)) / 100
    a = array.array("h", (int(s * k) for s in a))
    out = os.path.join(tempfile.gettempdir(), "alarm_bell.wav")
    with wave.open(out, "wb") as w:
        w.setparams(params); w.writeframes(a.tobytes())
    winsound.PlaySound(out, winsound.SND_FILENAME)


# ---------- phone ----------
def telegram(title, message, image=None):
    token, chat = CFG["tg_token"], CFG["tg_chat"]
    text = f"<b>{title}</b>\n{message}"
    if image:
        boundary = "----alarm" + str(int(time.time() * 1000))
        crlf = "\r\n"
        parts = []
        for k, v in (("chat_id", str(chat)), ("caption", text), ("parse_mode", "HTML")):
            parts.append(f'--{boundary}{crlf}Content-Disposition: form-data; name="{k}"{crlf}{crlf}{v}{crlf}'.encode("utf-8"))
        parts.append(f'--{boundary}{crlf}Content-Disposition: form-data; name="photo"; filename="door.jpg"{crlf}'
                     f'Content-Type: image/jpeg{crlf}{crlf}'.encode() + image + crlf.encode())
        parts.append(f"--{boundary}--{crlf}".encode())
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendPhoto", data=b"".join(parts),
                                     headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    else:
        body = json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML"}).encode("utf-8")
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body,
                                     headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=20).read()


def push(title, message, priority=4, tags="bell", image=None):
    try:
        if CFG.get("tg_token") and CFG.get("tg_chat"):
            telegram(title, message, image)
            return
        topic = CFG.get("ntfy_topic")
        if not topic: return
        headers = {"Title": Header(title, "utf-8").encode(), "Priority": str(priority), "Tags": tags}
        if image:
            headers["Filename"] = "door.jpg"
            headers["Message"] = Header(message, "utf-8").encode()
            data = image
        else:
            data = message.encode("utf-8")
        req = urllib.request.Request("https://ntfy.sh/" + topic, data=data, headers=headers, method="PUT" if image else "POST")
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        log("push failed:", e)


def snapshot():
    cam = settings.get("camera")
    if not cam: return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:1984/api/frame.jpeg?src={cam}", timeout=6) as r:
            return r.read()
    except Exception as e:
        log("snapshot failed:", e)
        return None


# ---------- events ----------
def ring(test=False):
    global last_ring
    if not test and time.time() - last_ring < 4: return  # one press can report twice
    last_ring = time.time()
    quiet = in_quiet_hours()
    vol = settings["quiet_volume"] if quiet else settings["volume"]
    log("ring", "(test)" if test else "", "tone", settings["tone"], "vol", vol, "quiet" if quiet else "")
    if settings.get("phone"):
        threading.Thread(target=lambda: push("🚪 דלת הכניסה נפתחה" + (" (בדיקה)" if test else ""),
                                             datetime.now().strftime("%H:%M:%S"), 4, "bell", snapshot()), daemon=True).start()
    if settings.get("pc_sound") and vol > 0:
        play(settings["tone"], vol)


def on_dps(dps):
    for k, v in dps.items():
        if k == DP_BELL and v is True:
            threading.Thread(target=ring, daemon=True).start()
        elif k == DP_STATE and v == "alarm":
            log("ALARM!")
            if settings.get("alarm_push"):
                push("🚨 אזעקה בבית!", datetime.now().strftime("%H:%M:%S"), 5, "rotating_light", snapshot())
        elif k == DP_MSG and isinstance(v, str):
            try: msg = base64.b64decode(v).decode("utf-16be")
            except Exception: continue
            log("message:", msg)
            # The bell is not always re-reported on DP 44 (value already true), but the message always comes.
            if msg.strip().lower() == "doorbell":
                threading.Thread(target=ring, daemon=True).start()
        elif k == DP_MODE:
            log("mode:", v)


def main():
    global connected
    threading.Thread(target=settings_loop, daemon=True).start()
    log("doorbell service starting")
    while True:
        try:
            d = tinytuya.Device(CFG["device_id"], CFG["ip"], CFG["local_key"], version=3.5)
            d.set_socketPersistent(True); d.set_socketTimeout(10)
            st = d.status()
            if not st or "dps" not in st: raise RuntimeError(st)
            log("connected to alarm, mode", st["dps"].get(DP_MODE))
            connected = True
            beat = time.time()
            while True:
                m = d.receive()
                if m and "Err" in m and m.get("Err") not in ("904",): raise RuntimeError(m)
                if m and m.get("dps"): on_dps(m["dps"])
                if time.time() - beat > 9:
                    d.heartbeat(nowait=True); beat = time.time()
        except Exception as e:
            connected = False
            log("connection lost:", e, "- retrying in 10s")
            time.sleep(10)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        settings.update(fetch_settings() if "--remote" in sys.argv else {})
        ring(True)
        time.sleep(10)  # let the notification thread finish
    else:
        main()
