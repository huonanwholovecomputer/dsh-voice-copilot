import sys, time, ctypes
from ctypes import wintypes
ctypes.windll.shcore.SetProcessDpiAwareness(2)
import win32gui
from PIL import ImageGrab

TITLE = sys.argv[1] if len(sys.argv) > 1 else "小印"
OUT = sys.argv[2] if len(sys.argv) > 2 else "tools/_live_shot.png"

hwnds = []
def cb(h, _):
    if win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == TITLE:
        hwnds.append(h)
    return True
win32gui.EnumWindows(cb, None)
print("windows:", hwnds)
if not hwnds:
    sys.exit("no window titled " + TITLE)
h = hwnds[0]
r = win32gui.GetWindowRect(h)
print("rect", r)
img = ImageGrab.grab()
x0, y0 = max(0, r[0] - 14), max(0, r[1] - 14)
x1, y1 = min(img.size[0], r[2] + 14), min(img.size[1], r[3] + 14)
img.crop((x0, y0, x1, y1)).save(OUT)
print("saved", OUT, (x1 - x0, y1 - y0))
