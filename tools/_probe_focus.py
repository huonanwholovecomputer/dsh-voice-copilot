"""诊断：为什么 focus_dsh_window() 说找不到 DSH 窗口。"""
import ctypes
import sys
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import winfocus  # noqa: E402

user32 = ctypes.windll.user32

print("process_path(15836) =", repr(winfocus.process_path(15836)))
print("find_dsh_window() =", winfocus.find_dsh_window())
print("focus_dsh_window() =", winfocus.focus_dsh_window())
print("foreground =", user32.GetForegroundWindow())

print("\n--- 所有可见顶层窗口（pid, 标题, 进程路径尾段）")
rows = []


def visit(hwnd, _):
    if not user32.IsWindowVisible(hwnd):
        return True
    title = winfocus._title(hwnd)
    if not title:
        return True
    pid = winfocus._pid(hwnd)
    path = winfocus.process_path(pid)
    rows.append((pid, title[:50], path.split("\\")[-1]))
    return True


user32.EnumWindows(winfocus.WNDENUMPROC(visit), 0)
for row in rows:
    print(row)
