"""验「听见唤醒词 → 弹窗 → 开始录命令」这条支路（不真说话，直接喂识别结果）。"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
sys.path.insert(0, APP_DIR)
os.chdir(APP_DIR)

from PySide6.QtWidgets import QApplication

import main

app = QApplication([])
w = main.VoiceWindow(main.load_config())
w.hide()
app.processEvents()

checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("  ok  " if cond else " FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


# 不相干的句子：不许弹
w._after_wake_check("今天下午三点开会")
app.processEvents()
check("非唤醒词不弹窗", not w.isVisible())

# 唤醒词：开窗 + 进入命令录音
w._after_wake_check("小印，今天有什么安排")
app.processEvents()
check("唤醒词弹窗", w.isVisible())
check("进入命令录音", w.hub.mode == "command", w.hub.mode)
check("状态行提示", "小印" in w.status.text(), w.status.text())

# 再听到一次唤醒词，正在录命令时不该重开
w._after_wake_check("小印小印")
app.processEvents()
check("录音中不重复触发", w.hub.mode == "command")

# Esc 收工
w.hub.cancel_command()
w.hide()
app.processEvents()
check("取消后回到监听", w.hub.mode in ("monitor", "idle"), w.hub.mode)

# 已经弹着窗时，唤醒词只把它提到前面，不打断输入
w.show()
w._after_wake_check("小印")
app.processEvents()
check("已可见时仍可用", w.isVisible())

bad = [c for c in checks if not c[1]]
print("\n结果:", "✅ 唤醒支路正常" if not bad else f"❌ {len(bad)} 项失败")
raise SystemExit(0 if not bad else 1)
