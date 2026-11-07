# One-time Telegram setup.
#   python setup_telegram.py          -> the door bot (door-opened messages)
#   python setup_telegram.py --alarm  -> a separate alarm bot (repeating loud alerts + stop button)
# Takes the bot token from the clipboard (or hidden input), finds your chat, saves both locally
# (config.local.json, not in git) and as Cloudflare Worker secrets, then sends a test message.
import getpass, json, os, re, subprocess, sys, urllib.error, urllib.request

ALARM = "--alarm" in sys.argv
TOK_KEY, CHAT_KEY = ("tg_alarm_token", "tg_alarm_chat") if ALARM else ("tg_token", "tg_chat")
SEC_TOK, SEC_CHAT = ("TG_ALARM_TOKEN", "TG_ALARM_CHAT") if ALARM else ("TG_TOKEN", "TG_CHAT")
HOOK_URL = "https://alarm-tuya.gavishori.workers.dev/tg-hook"
HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "config.local.json")
WORKER_DIR = os.path.join(HERE, "..", "worker")
TOKEN_RE = re.compile(r"\d{6,}:[A-Za-z0-9_-]{30,}")


def tg(token, method, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload else None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=40))
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": e.code}


def clipboard():
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Clipboard"], capture_output=True, text=True).stdout
        m = TOKEN_RE.search(out or "")
        return m.group(0) if m else ""
    except Exception:
        return ""


cfg = json.load(open(CFG_PATH, encoding="utf-8"))
print("Setting up the", "ALARM bot" if ALARM else "door bot")
token = clipboard()
if not token or (ALARM and token == cfg.get("tg_token")):
    input("Copy the NEW bot's token from BotFather, then press Enter here...")
    token = clipboard()
if not token:
    raw = getpass.getpass("Or paste the token here (hidden) and press Enter: ")
    m = TOKEN_RE.search(raw)
    token = m.group(0) if m else ""
if not token:
    sys.exit("No bot token found. Copy the token from BotFather (123456789:AAH...) and run again.")
if ALARM and token == cfg.get("tg_token"):
    sys.exit("That is the door bot's token. Create a NEW bot in BotFather for the alarm and copy its token.")
print("Token:", token[:6] + "..." + token[-4:])
me = tg(token, "getMe")
if not me.get("ok"):
    sys.exit("Telegram did not accept this token. Copy it again from BotFather and rerun.")
name = me["result"]["username"]
print(f"\nBot OK: @{name}")

tg(token, "deleteWebhook")  # getUpdates only works without a webhook
print(f"Now open Telegram, search @{name}, press START (or send any message). Waiting...")
chat, offset = None, 0
for _ in range(60):
    upd = tg(token, "getUpdates", {"timeout": 25, "offset": offset})
    for u in upd.get("result", []):
        offset = u["update_id"] + 1
        msg = u.get("message") or {}
        if msg.get("chat", {}).get("id"):
            chat = msg["chat"]["id"]
    if chat:
        break
if not chat:
    sys.exit("No message received from you. Run this again.")
tg(token, "getUpdates", {"offset": offset})
print("Chat found.")

cfg[TOK_KEY], cfg[CHAT_KEY] = token, chat
json.dump(cfg, open(CFG_PATH, "w", encoding="utf-8"), indent=1)
print("Saved locally.")
for key, val in ((SEC_TOK, token), (SEC_CHAT, str(chat))):
    r = subprocess.run("npx wrangler secret put " + key, input=val, text=True, cwd=WORKER_DIR,
                       shell=True, capture_output=True, encoding="utf-8", errors="replace")
    print(key, "-> Worker:", "ok" if r.returncode == 0 else r.stderr[-300:])

# Button presses (stop the repeating alarm) reach the Worker through a webhook.
hook = tg(token, "setWebhook", {"url": HOOK_URL, "secret_token": cfg["tg_hook_secret"], "allowed_updates": ["callback_query"]})
print("Button webhook:", "ok" if hook.get("ok") else hook)

text = ("<b>🚨 בוט האזעקה מחובר</b>\nכאן יגיעו התראות אזעקה, כל 10 שניות עד נטרול. בחר לשיחה הזו צליל צופר."
        if ALARM else "<b>🔔 הבוט מחובר</b>\nמכאן יגיעו התראות הדלת.")
tg(token, "sendMessage", {"chat_id": chat, "parse_mode": "HTML", "text": text})
print("\nDone. A test message was sent to Telegram. You can close this window.")
