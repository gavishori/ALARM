# Synthesizes the doorbell tones (original sounds, no samples) into sounds/*.wav
import numpy as np, wave, os
SR = 44100
def bell(freq, dur=1.6, decay=2.8, partials=((1, 1), (2.0, .45), (3.01, .25), (4.2, .12), (5.4, .06))):
    t = np.arange(int(SR * dur)) / SR
    y = sum(a * np.sin(2 * np.pi * freq * m * t) * np.exp(-decay * m ** .5 * t) for m, a in partials)
    att = np.minimum(1, t / .005)
    return y * att
def seq(notes, gap):
    total = int(SR * (gap * (len(notes) - 1) + max(kw.get("dur", 1.6) for _, kw in notes) + .1))
    out = np.zeros(total)
    for i, (f, kw) in enumerate(notes):
        s = bell(f, **kw); st = int(SR * gap * i)
        out[st:st + len(s)] += s[: total - st]
    return out
def beep(f, d):
    t = np.arange(int(SR * d)) / SR
    return np.sin(2 * np.pi * f * t) * np.minimum(1, np.minimum(t, d - t) / .01)
N = lambda n: 440 * 2 ** ((n - 69) / 12)  # midi -> Hz
tones = {
    "dingdong":    seq([(N(76), {}), (N(72), {"dur": 2.2})], .55),
    "westminster": seq([(N(n), {"dur": 1.4}) for n in (76, 72, 74, 67, 67, 74, 76, 72)], .45),
    "triad":       seq([(N(n), {"dur": 1.2}) for n in (72, 76, 79, 84)], .18),
    "soft":        seq([(N(81), {"decay": 1.6, "partials": ((1, 1), (2, .2))})], .5),
    "digital":     np.concatenate([np.concatenate([beep(1200, .12), np.zeros(int(SR * .08))]) for _ in range(3)] + [np.zeros(int(SR * .25))]
                                  + [np.concatenate([beep(1500, .12), np.zeros(int(SR * .08))]) for _ in range(3)]),
    "gong":        seq([(N(52), {"dur": 3.5, "decay": .9, "partials": ((1, 1), (1.48, .5), (2.3, .35), (3.1, .2), (4.7, .1))})], .5),
}
os.makedirs("sounds", exist_ok=True)
for name, y in tones.items():
    y = y / np.max(np.abs(y)) * .9
    with wave.open(f"sounds/{name}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())
    print(name, round(len(y) / SR, 1), "s")
