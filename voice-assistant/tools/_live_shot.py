"""截图浮窗（不按热键、不抢焦点），用来人工核对渲染结果。"""
import ctypes
import time

ctypes.windll.shcore.SetProcessDpiAwareness(2)
import win32gui  # noqa: E402
from PIL import ImageGrab  # noqa: E402

hwnd = 0


def cb(h, _):
    global hwnd
    if win32gui.GetWindowText(h) == "语音浮窗" and win32gui.IsWindowVisible(h):
        hwnd = h
    return True


win32gui.EnumWindows(cb, None)
if not hwnd:
    print("NO_WINDOW")
    raise SystemExit(1)
print("hwnd", hwnd, "visible", win32gui.IsWindowVisible(hwnd))
r = win32gui.GetWindowRect(hwnd)
print("rect", r)
time.sleep(0.3)
img = ImageGrab.grab()
x0, y0 = max(0, r[0] - 12), max(0, r[1] - 12)
x1, y1 = min(img.size[0], r[2] + 12), min(img.size[1], r[3] + 12)
out = "tools/_live_now.png"
img.crop((x0, y0, x1, y1)).save(out)
print("saved", out, (x0, y0, x1, y1))
