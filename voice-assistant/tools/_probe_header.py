"""定位浮窗顶栏按钮：显示窗口后按 x 扫一遍，看哪个 x 会触发「收起」或「回到会话」。"""
import ctypes
import time
from pathlib import Path

ctypes.windll.shcore.SetProcessDpiAwareness(2)
import win32gui  # noqa: E402

user32 = ctypes.windll.user32
DATA = Path.home() / ".dsh" / "voice-copilot"


def find() -> int:
    hwnd = 0

    def cb(h, _):
        nonlocal hwnd
        if win32gui.GetWindowText(h) == "语音浮窗":
            hwnd = h
        return True

    win32gui.EnumWindows(cb, None)
    return hwnd


def click(x, y):
    user32.SetCursorPos(x, y)
    time.sleep(0.1)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.04)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.45)


def show():
    (DATA / "show.request").write_text("1", encoding="utf-8")
    time.sleep(1.2)


if not find() or not win32gui.IsWindowVisible(find()):
    show()
hwnd = find()
print("hwnd", hwnd, "visible", win32gui.IsWindowVisible(hwnd), "rect", win32gui.GetWindowRect(hwnd))
r = win32gui.GetWindowRect(hwnd)
y = r[1] + 59
for x in range(r[0] + 760, r[0] + 940, 20):
    click(x, y)
    vis = win32gui.IsWindowVisible(find())
    print(f"x={x} y={y} visible={vis} fg={win32gui.GetWindowText(win32gui.GetForegroundWindow())!r}")
    if not vis:
        print("hidden by this x")
        break
print("--- wake.log tail")
print("\n".join((DATA / "wake.log").read_text(encoding="utf-8").splitlines()[-6:]))
