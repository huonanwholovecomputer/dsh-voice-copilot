# -*- coding: utf-8 -*-
"""纯键盘发送：只用快捷键，不碰任何窗口 z-order、不 import wechatauto。

## 为什么是「纯键盘」

店主平时自己就是这么发的：

    本地打印工具里复制价格 → Ctrl+Alt+W（唤起微信）→ Ctrl+F → 打全名
    → Enter（第一个候选就是目标会话）→ Ctrl+V → Enter

这套流程里唯一有技术含量的只有两点：**搜索候选选谁**、**每一步到底成没成**。
前者靠「打全名，不打死缩写」解决（店主原话：准确的全名就没有问题），
后者靠**每按一步截一张图**解决。

## 为什么不用 wechatauto

2026-11-06 的教训：``wechatauto.uia_driver.WeChatUIA.wake()`` 会
``os.startfile("weixin://")``，而 ``ensure_window()`` 在找不到主窗时会走到它
—— 也就是说「读一下控件树」这个动作可能**把已经退出的微信拉起来**。更糟的是
它还会 ``_force_foreground()`` 抢前台、``_wake_accessibility()`` 写微信进程
内存。店主为此重启过两次微信。

所以本模块的纪律是：

* 不 import ``wechatauto``（任何子模块都不行，``__init__.py`` 会连带拉进 guia）；
* 不调用 ``ShowWindow`` / ``SetWindowPos`` / ``SetForegroundWindow`` / ``AttachThreadInput``；
* 不改窗口大小、不最小化、不置顶、不 post 消息；
* 只做三件事：**截图**、**SendInput 敲键**、**HTTP 只读查消息**。

唤起微信也只走店主自己的快捷键 Ctrl+Alt+W，而不是程序去操作窗口。

## 用法

    python tools/kbd_send.py --to 文件传输助手 --text "你好" --dry-run
    python tools/kbd_send.py --to 文件传输助手 --text "你好"

``--dry-run`` 走到「粘贴完、还没按发送」就停，可以人工看一眼输入框里的字。
每一步的截图落在 ``.tmp-analysis/kbd/<时间戳>-<序号>-<步骤>.png``。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# SendInput：40 字节的 INPUT（x64）
# ---------------------------------------------------------------------------

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
INPUT_KEYBOARD = 1

VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
VK_BACK = 0x08
VK_A = 0x41
VK_W = 0x57
VK_F = 0x46
VK_V = 0x56

_user32 = ctypes.WinDLL("user32", use_last_error=True)


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _MOUSEINPUT(ctypes.Structure):
    """只为把 union 撑到 32 字节（INPUT 必须 40 字节）。"""

    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT), ("hi", _HARDWAREINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


assert ctypes.sizeof(_INPUT) == 40, "INPUT 必须是 40 字节（x64）"

_user32.SendInput.argtypes = (
    wintypes.UINT,
    ctypes.POINTER(_INPUT),
    ctypes.c_int,
)
_user32.SendInput.restype = wintypes.UINT


def _ev(vk: int = 0, scan: int = 0, up: bool = False,
        unicode_mode: bool = False) -> _INPUT:
    """构造一个键盘事件。

    ``unicode_mode=True`` 时 ``scan`` 是字符码点，``dwFlags`` 必须带
    ``KEYEVENTF_UNICODE``；**松开事件也必须带**，只带 KEYUP 的「松开」不会
    被 Qt 输入框认成同一个字符的抬起，结果是整对事件被丢弃（实测：SendInput
    返回成功、屏幕上却一个字都不出现）。
    """
    ev = _INPUT()
    ev.type = INPUT_KEYBOARD
    ev.u.ki.wVk = vk
    ev.u.ki.wScan = scan
    flags = 0
    if unicode_mode:
        flags |= KEYEVENTF_UNICODE
    if up:
        flags |= KEYEVENTF_KEYUP
    ev.u.ki.dwFlags = flags
    return ev


def _send(events: list[_INPUT]) -> int:
    arr = (_INPUT * len(events))(*events)
    return int(_user32.SendInput(len(events), arr, ctypes.sizeof(_INPUT)))


def chord(*vks: int, hold: float = 0.06) -> bool:
    """按一次组合键：全部按下、再逆序全部松开，一次 SendInput 投递。

    顺序必须是「全 down → 全 up」，不能每个键 down/up 交替 —— 交替的话修饰键
    在按主键之前就已经松开，组合键不成立。
    """
    downs = [_ev(vk=vk) for vk in vks]
    ups = [_ev(vk=vk, up=True) for vk in reversed(vks)]
    if _send(downs + ups) != len(downs) + len(ups):
        return False
    time.sleep(hold)
    return True


def key(vk: int, hold: float = 0.08) -> bool:
    return _send([_ev(vk=vk), _ev(vk=vk, up=True)]) == 2


def _window_rect_for_shot() -> tuple[int, int, int, int] | None:
    """只读拿微信主窗矩形（EnumWindows + GetWindowRect，不改任何窗口状态）。"""
    try:
        import win32gui

        found = []

        def _cb(h, _):
            try:
                cls = win32gui.GetClassName(h) or ""
                title = win32gui.GetWindowText(h) or ""
                if cls.startswith("Qt51514") and "微信" in title and win32gui.IsWindowVisible(h):
                    found.append(win32gui.GetWindowRect(h))
            except Exception:
                pass
            return True

        win32gui.EnumWindows(_cb, None)
        return found[0] if found else None
    except Exception:
        return None


def _grab_left_pane():
    """抓微信窗口左上块（搜索框 + 下拉候选所占的那片），返回 numpy 数组或 None。

    这块区域在「搜索下拉开着」和「下拉关掉、回到会话列表」两种状态下差异极大，
    用它做差分判断「回车到底有没有打开会话」——这是 2026-11-06 验证过的判据：
    画面差分是唯一可信的，控件树/标题都可能是假的。
    """
    rect = _window_rect_for_shot()
    if not rect:
        return None
    l, t, r, b = rect
    box = (l + 20, t + 30, l + int((r - l) * 0.42), t + int((b - t) * 0.55))
    try:
        import numpy as np
        from PIL import ImageGrab

        return np.asarray(ImageGrab.grab(bbox=box).convert("RGB"), dtype=np.int16)
    except Exception:
        return None


def _diff_ratio(a, b) -> float | None:
    """两张同尺寸图的差异像素占比（0–1）。任一为 None 返回 None。"""
    if a is None or b is None or a.shape != b.shape:
        return None
    try:
        import numpy as np

        changed = (np.abs(a - b).sum(axis=2) > 30).sum()
        return float(changed) / float(a.shape[0] * a.shape[1])
    except Exception:
        return None


def type_unicode(text: str, *, delay: float = 0.03) -> tuple[int, int]:
    """逐字 Unicode 直发（绕过输入法），返回 (成功字符数, 总字符数)。"""
    ok = 0
    for ch in text:
        code = ord(ch)
        if code > 0xFFFF:
            code -= 0x10000
            hi = 0xD800 + (code >> 10)
            lo = 0xDC00 + (code & 0x3FF)
            evs = [_ev(scan=hi, unicode_mode=True),
                   _ev(scan=hi, up=True, unicode_mode=True),
                   _ev(scan=lo, unicode_mode=True),
                   _ev(scan=lo, up=True, unicode_mode=True)]
        else:
            evs = [_ev(scan=code, unicode_mode=True),
                   _ev(scan=code, up=True, unicode_mode=True)]
        if _send(evs) == len(evs):
            ok += 1
        time.sleep(delay)
    return ok, len(text)


# ---------------------------------------------------------------------------
# 剪贴板（纯 ctypes，不依赖 pyperclip）
# ---------------------------------------------------------------------------

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
_kernel32.GlobalAlloc.argtypes = (wintypes.UINT, ctypes.c_size_t)
_kernel32.GlobalLock.restype = ctypes.c_void_p
_kernel32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
_kernel32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)

_user32.OpenClipboard.argtypes = (wintypes.HWND,)
_user32.OpenClipboard.restype = wintypes.BOOL
_user32.EmptyClipboard.restype = wintypes.BOOL
_user32.SetClipboardData.argtypes = (wintypes.UINT, wintypes.HANDLE)
_user32.SetClipboardData.restype = wintypes.HANDLE
_user32.CloseClipboard.restype = wintypes.BOOL


def set_clipboard(text: str) -> bool:
    """把 ``text`` 放进剪贴板（Unicode 文本）。"""
    for _ in range(10):
        if _user32.OpenClipboard(None):
            break
        time.sleep(0.08)
    else:
        return False
    try:
        _user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        h = _kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            return False
        ptr = _kernel32.GlobalLock(h)
        if not ptr:
            return False
        try:
            ctypes.memmove(ptr, data, len(data))
        finally:
            _kernel32.GlobalUnlock(h)
        if not _user32.SetClipboardData(CF_UNICODETEXT, wintypes.HANDLE(h)):
            return False
        return True
    finally:
        _user32.CloseClipboard()


# ---------------------------------------------------------------------------
# 截图
# ---------------------------------------------------------------------------

SHOT_DIR = Path(__file__).resolve().parent.parent / ".tmp-analysis" / "kbd"


def grab(tag: str) -> str:
    """全屏截图，返回文件路径。失败返回空串。"""
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%H%M%S")
    sec = len(list(SHOT_DIR.glob(f"*-{stamp}-*")))
    path = SHOT_DIR / f"{stamp}-{sec:02d}-{tag}.png"
    try:
        from PIL import ImageGrab

        img = ImageGrab.grab()
        img.save(path)
        return str(path)
    except Exception as exc:  # 截图失败不该让整个流程挂掉
        print(f"[warn] 截图失败：{exc}", file=sys.stderr)
        return ""


# ---------------------------------------------------------------------------
# 只读核验（走 bridge HTTP，不 import wechatauto）
# ---------------------------------------------------------------------------

API_BASE = os.environ.get("WXCHAT_API_BASE", "http://127.0.0.1:10392")


def recent_messages(who: str, limit: int = 5) -> list[dict]:
    """读最近几条消息（只读）。失败返回空列表。"""
    qs = urllib.parse.urlencode({"username": who, "limit": limit, "order": "desc"})
    try:
        with urllib.request.urlopen(f"{API_BASE}/api/chat/messages?{qs}", timeout=15) as r:
            payload = json.loads(r.read().decode("utf-8"))
        return list(payload.get("messages") or [])
    except Exception:
        return []


def watermark(who: str) -> int:
    rows = recent_messages(who, limit=1)
    return int(rows[0].get("localId") or 0) if rows else 0


def find_sent(who: str, text: str, after_id: int, *, timeout: float = 20.0) -> dict:
    """轮询数据库确认某条消息真的发出去了。返回 {'state','confirmed'}。"""
    norm = lambda s: "".join((s or "").split())
    want = norm(text)
    attempts = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        attempts += 1
        for row in recent_messages(who, limit=10):
            lid = int(row.get("localId") or 0)
            if lid <= after_id:
                continue
            if want and want in norm(row.get("content") or ""):
                return {
                    "state": "sent",
                    "confirmed": {"localId": lid, "createTime": row.get("createTime")},
                    "attempts": attempts,
                }
        time.sleep(1.2)
    return {"state": "maybe", "attempts": attempts}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _foreground_title() -> str:
    """读前台窗口标题（只读，不改任何东西）。"""
    try:
        import win32gui

        h = win32gui.GetForegroundWindow()
        return (win32gui.GetWindowText(h) or "").strip()
    except Exception:
        return ""


def _foreground_is_wechat() -> tuple[bool, str]:
    """前台窗口是不是微信**进程**的窗口。

    只看标题里有没有「微信」是不够的：别的程序（浏览器、编辑器）标题里也可能
    带这两个字，而更常见的是标题为空。2026-11-06 实测踩过——前台其实是另一个
    应用，我按下的 Ctrl+F 和正文全被它接走了，微信一个像素没动。

    这里按「前台窗口 → 进程名 → 是否 Weixin.exe」判断，纯只读。
    """
    try:
        import psutil
        import win32gui
        import win32process

        h = win32gui.GetForegroundWindow()
        if not h:
            return False, ""
        _, pid = win32process.GetWindowThreadProcessId(h)
        try:
            name = (psutil.Process(pid).name() or "").lower()
        except Exception:
            name = ""
        title = (win32gui.GetWindowText(h) or "").strip()
        return name == "weixin.exe", f"{name}|{title}"
    except Exception as exc:
        return False, f"探测失败：{exc}"


def _ensure_wechat_front(*, tries: int = 3, wait: float = 1.3) -> tuple[bool, str]:
    """确保微信在前台：不在就按店主自己的 Ctrl+Alt+W，再复查进程名。

    绝不调用 SetForegroundWindow / AttachThreadInput —— 那些会让店主正在做的事
    闪断，也可能把窗口弄到别的状态。只用他自己平时按的那个快捷键。
    """
    ok, info = _foreground_is_wechat()
    if ok:
        return True, f"已在前台（{info}）"
    for i in range(tries):
        chord(VK_CONTROL, VK_MENU, VK_W)
        time.sleep(wait)
        ok, info = _foreground_is_wechat()
        if ok:
            return True, f"第 {i + 1} 次 Ctrl+Alt+W 后到前台（{info}）"
    return False, f"按了 {tries} 次 Ctrl+Alt+W 微信仍不在前台（当前：{info}）"


def _open_chat_core(to: str, mark, result: dict) -> bool:
    """0–3 步：唤前台 → Ctrl+F → 清空 → 打全名 → Enter → 左侧画面差分确认。

    只「打开会话」，不粘贴、不发送。send_text 与 open_chat 共用这一段，
    保证「打开会话」的判据只有一处（2026-11-06 实测：画面差分是唯一可信的）。
    失败时把 state/reason 写进 ``result`` 并返回 False。
    """
    # 0. 唤起微信：只按店主自己的 Ctrl+Alt+W，并**验证前台确实是微信进程**
    front_ok, front_info = _ensure_wechat_front()
    mark("0-ensure-front", {"ok": front_ok, "detail": front_info})
    if not front_ok:
        result.update(state="failed",
                      reason=f"微信没能到前台，后续按键会被别的窗口接走：{front_info}")
        return False

    # 1. Ctrl+F 打开搜索（打开后先清空残留：微信会记住上次搜过的词）
    chord(VK_CONTROL, VK_F)
    time.sleep(0.6)
    chord(VK_CONTROL, VK_A)          # 选中残留
    time.sleep(0.15)
    key(VK_BACK)                      # 删掉
    time.sleep(0.3)
    mark("1-ctrl-f")

    # 2. 打全名（Unicode 直发，绕过输入法）
    typed, total = type_unicode(to)
    time.sleep(0.9)
    mark("2-typed-name", {"typed": f"{typed}/{total}"})
    if typed != total:
        result.update(state="failed", reason=f"名字只打进 {typed}/{total} 个字符")
        return False

    # 3. 回车，打开第一个候选 —— 必须确认搜索面板真的关了才继续，
    #    否则下一段 Ctrl+V 会把正文粘进搜索框（2026-11-06 踩过）。
    before_pane = _grab_left_pane()
    key(VK_RETURN)
    time.sleep(1.4)
    after_pane = _grab_left_pane()
    change = _diff_ratio(before_pane, after_pane)
    opened = change is not None and change > 0.05
    mark("3-enter-opened-chat",
         {"left_pane_change": None if change is None else round(change, 3),
          "opened": opened})
    if change is not None and not opened:
        # 再给一次机会：可能只是搜索还在加载
        time.sleep(1.2)
        after2 = _grab_left_pane()
        change2 = _diff_ratio(before_pane, after2)
        if change2 is not None and change2 > 0.05:
            opened = True
            mark("3b-retry-opened", {"left_pane_change": round(change2, 3)})
    if not opened:
        result.update(
            state="failed",
            reason="回车后搜索面板没有关闭（左侧画面几乎没变），会话可能没打开 —— 没有继续粘贴，避免把正文粘进搜索框",
        )
        return False

    return True


def send_text(to: str, text: str, *, dry_run: bool = False,
              shot: bool = True) -> dict:
    """按店主的快捷键流程发一条文字。

    步骤：Ctrl+Alt+W → Ctrl+F → 打全名 → Enter → Ctrl+V → Enter
    每一步（可选）截图，返回所有截图路径供人工核对。
    """
    steps: list[dict] = []

    def mark(name: str, extra: dict | None = None) -> None:
        row = {"step": name, "at": datetime.now().strftime("%H:%M:%S")}
        if shot:
            row["shot"] = grab(name)
        if extra:
            row.update(extra)
        steps.append(row)

    result: dict = {"to": to, "text": text, "steps": steps}

    if not _open_chat_core(to, mark, result):
        return result

    # 4. 写剪贴板 + Ctrl+V
    if not set_clipboard(text):
        result.update(state="failed", reason="写剪贴板失败")
        return result
    chord(VK_CONTROL, VK_V)
    time.sleep(0.9)
    mark("4-pasted")

    if dry_run:
        result.update(state="dry-run",
                      reason="已按到「粘贴完、还没发送」，请人工看一眼输入框里的字")
        return result

    # 5. 回车发送
    before = watermark(_resolve_username(to))
    key(VK_RETURN)
    time.sleep(1.0)
    mark("5-enter-sent")

    # 6. 发送后核对（2026-11-10 店主原话：「不用数据库读这个步骤」）
    #    按键链路走完就算发出：数据库只做一次很短的顺手核对，
    #    读不到也不改判定，不再返回 maybe 让店主盯着窗口等落库。
    confirmed = find_sent(_resolve_username(to), text, before, timeout=3.0)
    mark("6-confirmed", confirmed)
    result.update(
        state="sent",
        db_confirmed=confirmed.get("state") == "sent",
        confirm_detail=confirmed,
    )
    return result


def open_chat(to: str, *, shot: bool = True) -> dict:
    """把微信切到 ``to`` 的会话，只打开、不发任何东西。

    店主 2026-11-11 的用法：「帮我将微信聊天框转到某某的对话框」。
    复用 send_text 的前四步（唤前台 → Ctrl+F → 打全名 → Enter → 画面差分确认），
    确认会话真的打开就停；不写剪贴板、不按发送。
    """
    steps: list[dict] = []

    def mark(name: str, extra: dict | None = None) -> None:
        row = {"step": name, "at": datetime.now().strftime("%H:%M:%S")}
        if shot:
            row["shot"] = grab(name)
        if extra:
            row.update(extra)
        steps.append(row)

    result: dict = {"to": to, "steps": steps, "mode": "kbd-open-chat"}
    if not _open_chat_core(to, mark, result):
        return result

    result.update(
        state="opened",
        hint=f"微信已切到「{to}」的会话（左侧画面已变化、搜索面板已关闭）。没有发任何消息。",
    )
    return result


def _resolve_username(who: str) -> str:
    """界面名 → 会话 username。filehelper 原样返回。"""
    if who in ("filehelper", "文件传输助手"):
        return "filehelper"
    if who.startswith(("wxid_", "@chatroom")):
        return who
    qs = urllib.parse.urlencode({"q": who, "limit": 20})
    try:
        with urllib.request.urlopen(f"{API_BASE}/api/chat/search?{qs}", timeout=15) as r:
            payload = json.loads(r.read().decode("utf-8"))
        for hit in payload.get("hits") or []:
            if (hit.get("name") or "").strip() == who:
                return str(hit.get("username") or who)
    except Exception:
        pass
    return who


def preflight() -> dict:
    """能不能发：只做只读检查，不按任何键、不碰窗口状态。

    纯键盘链路没有「控件树」这个概念，只关心三件事：
    微信进程在不在、能不能读到它的窗口矩形（截图要用）、只读接口通不通。
    """
    checks: dict = {}
    reasons: list[str] = []

    # 1. 微信进程
    try:
        import psutil

        pids = [
            p.info["pid"]
            for p in psutil.process_iter(["pid", "name"])
            if (p.info.get("name") or "").lower() == "weixin.exe"
        ]
        checks["weixin_pids"] = pids
        if not pids:
            reasons.append("微信进程不在（Weixin.exe 一个都没有）")
    except Exception as exc:
        checks["weixin_pids"] = f"探测失败：{exc}"
        reasons.append(f"进程探测失败：{exc}")

    # 2. 窗口矩形（截图要靠它；读不到说明微信窗口不在正常状态）
    rect = _window_rect_for_shot()
    checks["window_rect"] = list(rect) if rect else None
    if not rect:
        reasons.append("读不到微信窗口矩形（窗口可能被隐藏）")

    # 3. 只读接口
    try:
        with urllib.request.urlopen(f"{API_BASE}/api/health", timeout=8) as r:
            health = json.loads(r.read().decode("utf-8"))
        checks["api"] = health.get("status")
        if health.get("status") != "healthy":
            reasons.append(f"微信后端不健康：{health}")
    except Exception as exc:
        checks["api"] = f"不通：{exc}"
        reasons.append(f"微信后端连不上（{API_BASE}）：{exc}")

    # 4. 前台情况（不是错误，只是提示：发送时脚本会自己按 Ctrl+Alt+W）
    try:
        import win32gui

        h = win32gui.GetForegroundWindow()
        checks["foreground"] = {
            "hwnd": h,
            "title": (win32gui.GetWindowText(h) or "").strip(),
        }
        checks["wechat_in_front"] = _foreground_is_wechat()[0]
    except Exception as exc:
        checks["foreground"] = f"探测失败：{exc}"

    return {
        "ok": not reasons,
        "checks": checks,
        "reason": "；".join(reasons),
        "available": True,
        "mode": "kbd",
        "hint": "发送时脚本会按 Ctrl+Alt+W 把微信叫到前台，不需要你提前打开。",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="纯键盘发消息（Ctrl+Alt+W → Ctrl+F → 全名 → Enter → Ctrl+V → Enter）")
    ap.add_argument("--to", help="会话显示名（打全名最稳）")
    ap.add_argument("--text", help="要发的正文")
    ap.add_argument("--dry-run", action="store_true", help="粘贴完就停，不按发送")
    ap.add_argument("--no-shot", action="store_true", help="不截图")
    ap.add_argument("--preflight", action="store_true", help="只检查能不能发，不发送")
    ap.add_argument("--open-chat", action="store_true", help="只打开会话，不发消息（配 --to）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.preflight:
        out = preflight()
        print(json.dumps(out, ensure_ascii=False, indent=2) if args.json else
              f"能不能发：{'可以' if out['ok'] else '不行'}\n{json.dumps(out['checks'], ensure_ascii=False, indent=2)}"
              + (f"\n原因：{out['reason']}" if out["reason"] else ""))
        return 0 if out["ok"] else 1

    if args.open_chat:
        if not args.to:
            ap.error("--open-chat 需要 --to")
        out = open_chat(args.to, shot=not args.no_shot)
        print(json.dumps(out, ensure_ascii=False, indent=2) if args.json else
              f"状态：{'已打开会话' if out.get('state') == 'opened' else '没打开'}"
              + (f"\n说明：{out['reason']}" if out.get("reason") else ""))
        return 0 if out.get("state") == "opened" else 1

    if not args.to or not args.text:
        ap.error("--to 与 --text 必填（除非用 --preflight / --open-chat）")

    out = send_text(args.to, args.text, dry_run=args.dry_run, shot=not args.no_shot)

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        state = out.get("state", "?")
        cn = {"sent": "已发出（数据库确认）",
              "maybe": "操作了但没确认——先看微信窗口，别急着重发",
              "failed": "没发出去",
              "dry-run": "已粘贴，等你确认"}.get(state, state)
        print(f"状态：{cn}")
        if out.get("reason"):
            print(f"说明：{out['reason']}")
        for st in out.get("steps") or []:
            extra = ""
            if st.get("typed"):
                extra = f"  打进 {st['typed']}"
            if st.get("foreground_after"):
                extra = f"  前台 → {st['foreground_after']}"
            print(f"  {st['at']}  {st['step']}{extra}")
            if st.get("shot"):
                print(f"       {st['shot']}")
    return 0 if out.get("state") in ("sent", "dry-run") else 1

if __name__ == "__main__":
    raise SystemExit(main())
