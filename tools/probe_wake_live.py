"""整条链路：把一段真人语音（合成）喂进采集缓冲，应当弹出浮窗并进入命令录音。

只跳过「麦克风把声音收进来」这一步，后面分段、识别、找唤醒词、弹窗、开录全是真的。
用法：python tools/probe_wake_live.py [wav路径]
"""
import os
import sys
import tempfile
import time
import wave

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
sys.path.insert(0, APP_DIR)
os.chdir(APP_DIR)

import numpy as np
from PySide6.QtWidgets import QApplication

import main

WAV = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wake_say.wav")

app = QApplication([])
w = main.VoiceWindow(main.load_config())
w.hide()

checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("  ok  " if cond else " FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def spin(seconds: float) -> None:
    end = time.time() + seconds
    while time.time() < end:
        app.processEvents()
        time.sleep(0.01)


# 等识别模型就绪
deadline = time.time() + 40
while not w._stt_ready and time.time() < deadline:
    spin(0.1)
check("识别模型就绪", w._stt_ready, w._stt_error or "超时")

deadline = time.time() + 15
while w._spotter is None and time.time() < deadline:
    spin(0.1)
check("流式唤醒词模型就绪", w._spotter is not None)

with wave.open(WAV, "rb") as f:
    raw = f.readframes(f.getnframes())
    rate = f.getframerate()
check("测试音频是 16k", rate == 16000, f"{rate}Hz")

w.hub._mode = "monitor"        # 模拟「常驻监听」状态，但不开真麦克风
modes = []
w.hub.mode_changed.connect(modes.append)
samples = np.frombuffer(raw, dtype="<i2")
step = 800                     # 50 ms
for i in range(0, samples.size, step):
    w.hub._all.extend(samples[i:i + step].tobytes())
    w.hub._on_tick()
    app.processEvents()
    time.sleep(0.005)

w.hub._all.extend(b"\x00\x00" * 12800)   # 0.8 秒静音收尾
for _ in range(16):
    w.hub._on_tick()
    app.processEvents()

# 等识别 + 唤醒判定回来
deadline = time.time() + 8
while time.time() < deadline and not w.isVisible():
    spin(0.05)

check("唤醒后弹窗", w.isVisible())
check("进入过命令录音", "command" in modes, f"经历模式 {modes}")
check("命令里去掉唤醒词", w._strip_wake("小印，今天有什么安排") == "今天有什么安排", w._strip_wake("小印，今天有什么安排"))
print("   状态行：", w.status.text())

if w.isVisible() and w.hub.mode == "command":
    w.hub.cancel_command()
w.hide()
spin(0.2)

bad = [c for c in checks if not c[1]]
print("\n结果:", "✅ 唤醒→弹窗→开录 全链路正常" if not bad else f"❌ {len(bad)} 项失败")
raise SystemExit(0 if not bad else 1)
