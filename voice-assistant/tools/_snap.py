import time, ctypes
ctypes.windll.shcore.SetProcessDpiAwareness(2)
from ctypes import wintypes
from PIL import ImageGrab
import win32gui, win32con

user32 = ctypes.windll.user32
VK_CONTROL, VK_MENU = 0x11, 0x12
VK_J = 0x4A

def key(vk, up=False):
    user32.keybd_event(vk, 0, 2 if up else 0, 0)

def hotkey():
    key(VK_CONTROL); key(VK_MENU); key(VK_J)
    key(VK_J, True); key(VK_MENU, True); key(VK_CONTROL, True)

hotkey()
time.sleep(1.5)

hwnd = 0
def cb(h, _):
    global hwnd
    t = win32gui.GetWindowText(h)
    if t == "语音浮窗":
        hwnd = h
    return True
win32gui.EnumWindows(cb, None)
print("hwnd", hwnd, "title", win32gui.GetWindowText(hwnd) if hwnd else None)
if hwnd:
    r = win32gui.GetWindowRect(hwnd)
    print("rect", r, "w", r[2]-r[0], "h", r[3]-r[1], "visible", win32gui.IsWindowVisible(hwnd))
    img = ImageGrab.grab()
    print("screen", img.size)
    x0, y0 = max(0, r[0]-20), max(0, r[1]-20)
    x1, y1 = min(img.size[0], r[2]+20), min(img.size[1], r[3]+20)
    img.crop((x0, y0, x1, y1)).save("tools/_popup_now.png")
    print("saved", (x0,y0,x1,y1))
else:
    ImageGrab.grab().save("tools/_full_now.png")
hotkey()
