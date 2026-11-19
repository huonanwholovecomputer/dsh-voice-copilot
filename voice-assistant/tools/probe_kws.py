"""量唤醒词的灵敏度：命中率、延迟、误触发。"""
import os
import sys
import tempfile
import time
import wave

sys.path.insert(0, "app")

import numpy as np

from kws import Spotter


def load(path: str) -> np.ndarray:
    with wave.open(path, "rb") as f:
        raw = f.readframes(f.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def run(spotter: Spotter, audio: np.ndarray, chunk: int = 1600):
    spotter.reset()
    hits, first_at = [], None
    pos = 0
    while pos < audio.size:
        piece = audio[pos:pos + chunk]
        hit = spotter.feed(piece)
        pos += chunk
        if hit:
            hits.append(hit)
            if first_at is None:
                first_at = pos / 16000
    return hits, first_at


spotter = Spotter()
print("model ready")

TEMP = tempfile.gettempdir()
wake = load(os.path.join(TEMP, "wake_say.wav"))   # 小印，今天有什么安排
neutral = load(os.path.join(TEMP, "wake_neutral.wav"))  # 今天下午三点开会

for name, audio in (("唤醒句", wake), ("干扰句", neutral)):
    t0 = time.time()
    hits, first_at = run(spotter, audio)
    cost = time.time() - t0
    print(f"{name}: 时长 {audio.size/16000:.2f}s 命中 {hits} 首个命中于 {first_at and round(first_at,2)}s 处理耗时 {cost:.3f}s")

# 一串短促单说，看多短还能认
ok = bool(run(spotter, wake)[0]) and not run(spotter, neutral)[0]
print("结果:", "✅ 唤醒命中、干扰不误触" if ok else "❌ 不符合预期")
raise SystemExit(0 if ok else 1)
