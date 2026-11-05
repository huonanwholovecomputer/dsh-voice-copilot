"""把 DSH 桌面端窗口拉到前台。

语音浮窗是置顶的 Tool 窗口，说完话常常挡在会话前面；点「回到会话」时
浮窗留在原位（也仍然置顶），只用 Win32 把 DSH NEXT 的主窗口还原并激活。

DSH 桌面端没有公开的「切到某个会话」入口（app.asar 里只有 dsh:// 内部
origin，没有 /#/session 路由，4732 端口对浏览器也返回 403），所以这里只
负责把窗口带到前台，会话切换由用户在侧栏点。
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9
SW_SHOW = 5

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

user32.EnumWindows.argtypes = (WNDENUMPROC, wintypes.LPARAM)
user32.EnumWindows.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = (wintypes.HWND,)
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsIconic.argtypes = (wintypes.HWND,)
user32.IsIconic.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = (wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int)
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
user32.ShowWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = (wintypes.HWND,)
user32.BringWindowToTop.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.SetFocus.argtypes = (wintypes.HWND,)
user32.SetFocus.restype = wintypes.HWND
user32.GetForegroundWindow.argtypes = ()
user32.GetForegroundWindow.restype = wintypes.HWND
user32.AttachThreadInput.argtypes = (wintypes.DWORD, wintypes.DWORD, wintypes.BOOL)
user32.AttachThreadInput.restype = wintypes.BOOL
# 走 Alt+Tab 那条内部路径：调用者不是前台程序时 SetForegroundWindow 会被前台锁拒掉。
user32.SwitchToThisWindow.argtypes = (wintypes.HWND, wintypes.BOOL)
user32.SwitchToThisWindow.restype = None
user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
user32.GetWindowRect.restype = wintypes.BOOL

kernel32.GetCurrentThreadId.argtypes = ()
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = (
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.c_wchar_p,
    ctypes.POINTER(wintypes.DWORD),
)
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL

# DSH 桌面端的进程映像名（Get-Process 里显示为 "DSH NEXT"）
DSH_PROCESS = "dsh next.exe"
TITLE_HINT = "deepseek harness"


def process_path(pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buffer))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        kernel32.CloseHandle(handle)


def _title(hwnd) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _pid(hwnd) -> int:
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def find_dsh_window():
    """返回 (hwnd, 标题)；找不到返回 (None, "")。优先标题像 DSH 的那个。"""
    fallback = None
    found = []

    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        title = _title(hwnd)
        if not title:
            return True
        if not process_path(_pid(hwnd)).lower().endswith(DSH_PROCESS):
            return True
        nonlocal fallback
        found.append((hwnd, title))
        if TITLE_HINT in title.lower() and fallback is None:
            fallback = (hwnd, title)
        return True

    user32.EnumWindows(WNDENUMPROC(visit), 0)
    if fallback is not None:
        return fallback
    if found:
        return found[0]
    return None, ""


def _activate(hwnd) -> bool:
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    else:
        user32.ShowWindow(hwnd, SW_SHOW)
    user32.BringWindowToTop(hwnd)

    fg = user32.GetForegroundWindow()
    fg_tid = int(user32.GetWindowThreadProcessId(fg, None)) if fg else 0
    target_tid = int(user32.GetWindowThreadProcessId(hwnd, None))
    my_tid = int(kernel32.GetCurrentThreadId())
    attached = []
    for tid in {fg_tid, target_tid}:
        if tid and tid != my_tid and user32.AttachThreadInput(tid, my_tid, True):
            attached.append(tid)
    try:
        user32.SetForegroundWindow(hwnd)
        user32.SetFocus(hwnd)
    finally:
        for tid in attached:
            user32.AttachThreadInput(tid, my_tid, False)
    if int(user32.GetForegroundWindow() or 0) != int(hwnd):
        # 浮窗是 Tool 窗口，点它未必把本进程变成前台程序，SetForegroundWindow
        # 就会被前台锁直接拒掉；SwitchToThisWindow 不挑调用者，能救回来。
        user32.SwitchToThisWindow(hwnd, True)
        user32.SetForegroundWindow(hwnd)
    return int(user32.GetForegroundWindow() or 0) == int(hwnd)


# 给 main.py 用的公开名字
activate_window = _activate


def focus_dsh_window() -> tuple[bool, str]:
    """把 DSH 主窗口还原并切到前台。返回 (是否成功, 窗口标题)。"""
    hwnd, title = find_dsh_window()
    if not hwnd:
        return False, ""
    try:
        ok = _activate(hwnd)
    except Exception:
        return False, title
    return ok, title
