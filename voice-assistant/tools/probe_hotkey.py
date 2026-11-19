"""验一下全局热键能不能注册上（只在 Windows 有效，不弹界面）。"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

from main import HotkeyThread

for spec in ("ctrl+alt+j", "ctrl+alt+shift+j"):
    thread = HotkeyThread(spec)
    thread.start()
    time.sleep(0.6)
    print(f"{spec}: ok={thread.ok} error={thread.error or '-'}")
