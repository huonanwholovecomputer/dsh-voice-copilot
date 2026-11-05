"""按屏幕坐标点一下（用于点浮窗里的「回到会话」）。用法：python tools/_click.py X Y"""
import ctypes
import sys
import time

ctypes.windll.shcore.SetProcessDpiAwareness(2)
user32 = ctypes.windll.user32

x, y = int(sys.argv[1]), int(sys.argv[2])
user32.SetCursorPos(x, y)
time.sleep(0.15)
user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
time.sleep(0.05)
user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
time.sleep(0.4)
print("clicked", x, y)

import win32gui  # noqa: E402

print("foreground:", win32gui.GetWindowText(win32gui.GetForegroundWindow()))
hwnd = 0


def cb(h, _):
    global hwnd
    if win32gui.GetWindowText(h) == "语音浮窗":
        hwnd = h
    return True


win32gui.EnumWindows(cb, None)
print("float hwnd", hwnd, "visible", win32gui.IsWindowVisible(hwnd) if hwnd else None)
