# One-time Telegram setup: asks for the bot token (hidden input), finds your chat,
# saves both locally (config.local.json, not in git) and as Cloudflare Worker secrets,
# then sends a test message.
import getpass, json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "config.local.json")
WORKER_DIR = os.path.join(HERE, "..", "worker")


def tg(token, method, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload else None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=40))


token = getpass.getpass("Paste the bot token from BotFather (hidden) and press Enter: ").strip()
me = tg(token, "getMe")
if not me.get("ok"):
    sys.exit("Token was not accepted by Telegram.")
name = me["result"]["username"]
print(f"\nBot OK: @{name}")
print(f"Now open Telegram, search @{name}, press START (or send any message). Waiting...")

chat = None
offset = 0
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
tg(token, "getUpdates", {"offset": offset})  # clear the queue
print("Chat found.")

cfg = json.load(open(CFG_PATH, encoding="utf-8"))
cfg["tg_token"], cfg["tg_chat"] = token, chat
json.dump(cfg, open(CFG_PATH, "w", encoding="utf-8"), indent=1)
print("Saved locally.")

for key, val in (("TG_TOKEN", token), ("TG_CHAT", str(chat))):
    r = subprocess.run("npx wrangler secret put " + key, input=val, text=True, cwd=WORKER_DIR,
                       shell=True, capture_output=True)
    print(key, "-> Worker:", "ok" if r.returncode == 0 else r.stderr[-300:])

tg(token, "sendMessage", {"chat_id": chat, "parse_mode": "HTML",
                          "text": "<b>🔔 הפעמון מחובר</b>\nמכאן יגיעו התראות הפעמון והאזעקה."})
print("\nDone. A test message was sent to Telegram. You can close this window.")
