"""验浮窗位置：默认右下角、可拖动、挪完记住、越界拉回。"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
sys.path.insert(0, APP_DIR)
os.chdir(APP_DIR)

import json

from PySide6.QtCore import QEvent, QPoint, QPointF, Qt
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import QApplication

import main

app = QApplication([])
cfg = main.load_config()
cfg["pos"] = None
w = main.VoiceWindow(cfg)
w.show()
app.processEvents()

checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("  ok  " if cond else " FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


geo = QApplication.primaryScreen().availableGeometry()
m = cfg.get("margin", 24)
w.place()
app.processEvents()
check(
    "默认在右下角",
    abs(w.x() - (geo.right() - w.width() - m + 1)) <= 2 and abs(w.y() - (geo.bottom() - w.height() - m + 1)) <= 2,
    f"{w.pos()} vs 期望 ({geo.right() - w.width() - m + 1},{geo.bottom() - w.height() - m + 1})",
)


def mouse(kind, local: QPoint, glob: QPoint, buttons) -> QMouseEvent:
    return QMouseEvent(kind, QPointF(local), QPointF(glob), Qt.LeftButton, buttons, Qt.NoModifier)


start = w.pos()
press_at = QPoint(60, 40)
w.mousePressEvent(mouse(QEvent.MouseButtonPress, press_at, start + press_at, Qt.LeftButton))
w.mouseMoveEvent(mouse(QEvent.MouseMove, press_at, start + press_at + QPoint(-200, -150), Qt.LeftButton))
app.processEvents()
moved = w.pos()
check("能拖动", moved != start and moved == start + QPoint(-200, -150), f"{start} -> {moved}")

w.mouseReleaseEvent(mouse(QEvent.MouseButtonRelease, press_at, moved + press_at, Qt.NoButton))
app.processEvents()
saved = json.loads(main.CONFIG_PATH.read_text(encoding="utf-8")).get("pos")
check("松开后位置写进 config.json", saved == [moved.x(), moved.y()], f"{saved} vs {[moved.x(), moved.y()]}")

w._drag_offset = None
check("越界会被拉回", w._clamp(QPoint(-5000, 99999)) != QPoint(-5000, 99999), str(w._clamp(QPoint(-5000, 99999))))

w.reset_position()
app.processEvents()
check(
    "「回到右下角」可用",
    abs(w.x() - (geo.right() - w.width() - m + 1)) <= 2,
    f"{w.pos()}",
)
check("重置后 config 里是 null", json.loads(main.CONFIG_PATH.read_text(encoding="utf-8")).get("pos") is None)

w.close()
bad = [c for c in checks if not c[1]]
print("\n结果:", "✅ 位置与拖动正常" if not bad else f"❌ {len(bad)} 项失败")
raise SystemExit(0 if not bad else 1)
