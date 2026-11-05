"""实验：当前台是别的程序时，_activate 能不能把 DSH 切上来；SwitchToThisWindow 能否兜底。"""
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import winfocus  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
user32 = ctypes.windll.user32
user32.SwitchToThisWindow.argtypes = (wintypes.HWND, wintypes.BOOL)
user32.SwitchToThisWindow.restype = None


def fg():
    return int(user32.GetForegroundWindow() or 0), winfocus._title(user32.GetForegroundWindow())


def find(part):
    hits = []

    def visit(hwnd, _):
        if user32.IsWindowVisible(hwnd) and part in winfocus._title(hwnd):
            hits.append(hwnd)
        return True

    user32.EnumWindows(winfocus.WNDENUMPROC(visit), 0)
    return hits[0] if hits else None


print("before:", fg())
word = find(".doc")
print("word hwnd", word, winfocus._title(word) if word else None)
if word:
    user32.SetForegroundWindow(word)
    time.sleep(0.6)
    print("after SetForegroundWindow(word):", fg())

dsh, title = winfocus.find_dsh_window()
print("dsh:", dsh, title)
t0 = time.time()
ok = winfocus._activate(dsh)
print("_activate ok =", ok, "in", round(time.time() - t0, 3), "fg now", fg())
if not ok:
    user32.SwitchToThisWindow(dsh, True)
    time.sleep(0.4)
    print("after SwitchToThisWindow:", fg())
