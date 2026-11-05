"""验唤醒链路的分段逻辑：一段「说话」+ 静音，应该切出一个片段。"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import numpy as np
from PySide6.QtWidgets import QApplication

from audiohub import AudioHub, SAMPLE_RATE

app = QApplication([])

segments = []
commands = []
hub = AudioHub()
hub.segment.connect(lambda s: segments.append(len(s) / SAMPLE_RATE))
hub.command_done.connect(lambda s: commands.append(len(s) / SAMPLE_RATE))


def pcm(seconds: float, amp: float) -> bytes:
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    wave = (np.sin(2 * np.pi * 220 * t) * amp * 32767).astype("<i2")
    return wave.tobytes()


hub._mode = "monitor"
hub._all.extend(pcm(0.8, 0.25))
for _ in range(16):          # 16 × 50ms = 0.8s 有声
    hub._on_tick()
hub._all.extend(pcm(0.7, 0.0))
for _ in range(14):          # 0.7s 静音，够收尾
    hub._on_tick()

print("segments:", [round(s, 2) for s in segments])

# 命令模式：喂 1.2s 音频后停，应该吐一条完整命令
hub._mode = "idle"
hub._all.clear()
hub.begin_command(pre_roll=0.0)
hub._all.extend(pcm(1.2, 0.25))
hub._speech = 1.2
for _ in range(24):
    hub._on_tick()
hub._all.extend(pcm(1.2, 0.0))
for _ in range(24):
    hub._on_tick()
print("commands:", [round(c, 2) for c in commands])

ok = bool(segments) and segments[0] > 0.6 and bool(commands) and commands[0] > 1.0
print("结果:", "✅ 分段与命令都正常" if ok else "❌ 不符合预期")
raise SystemExit(0 if ok else 1)
