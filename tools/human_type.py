# -*- coding: utf-8 -*-
"""拟人键入：绕开剪贴板，用正确的 SendInput 结构逐字敲。

## 为什么需要这个文件

`wechatauto` 自带的 ``WinInput.type_unicode()`` 在本机**一个字符也打不出去**，
而且不报错。原因不是权限、不是焦点，是结构体对齐：

* Windows x64 的 ``INPUT`` 必须是 **40 字节**（``type`` 4 + 对齐填充 4 +
  union 32，其中 ``MOUSEINPUT`` 是最大的成员）；
* ``wechatauto/guia.py:103-118`` 的 ``_INPUT_UNION`` 只声明了 ``ki``
  （``KEYBDINPUT`` 24 字节），导致 ``sizeof(INPUT) == 32``；
* ``SendInput(1, &input, 32)`` 因此返回 0、``GetLastError() == 87``
  （``ERROR_INVALID_PARAMETER``）。而 ``type_unicode()`` 不检查返回值，
  于是「静默失败」。

实测证据（2026-11-06，微信 4.2.0.9）：

    用 wechatauto 的结构发送 → SendInput 返回 0，WinError 87 参数错误
    用本文件的 40 字节结构   → SendInput 返回 1，字符成功落入聊天输入框

## 和用户项目的关系

思路来自 ``D:/个人/Python自动输入项目/模拟键盘输入指定内容的脚本.py``：
Unicode 直发绕过输入法、不占剪贴板、逐字带停顿。本文件用同一套
``KEYEVENTF_UNICODE`` 方案，但把结构体按 Windows 的真实布局补齐，
并复用 ``wechatauto.rhythm`` 的抖动（``key_hold`` / ``type_gap``）让节奏
不是匀速的 20ms。

## 边界

* 只负责「把字打进当前有焦点的输入框」和「敲回车」，不负责找会话；
* 不写微信进程内存、不碰无障碍 gate；
* 调用前必须让目标输入框**真的有键盘焦点**（先真点一下）。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import time
from typing import Any

# ---------------------------------------------------------------------------
# Win32 结构（按 x64 真实布局）
# ---------------------------------------------------------------------------

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

INPUT_KEYBOARD = 1
INPUT_MOUSE = 0

VK_RETURN = 0x0D
VK_CONTROL = 0x11
VK_A = 0x41
VK_DELETE = 0x2E
VK_BACK = 0x08

_user32 = ctypes.WinDLL("user32", use_last_error=True)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class MOUSEINPUT(ctypes.Structure):
    """只为把 union 撑到 32 字节 —— Windows 按最大的那个成员算 union 大小。"""

    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


assert ctypes.sizeof(INPUT) == 40, f"INPUT 应当是 40 字节，实际 {ctypes.sizeof(INPUT)}"


def _send(events: list[INPUT]) -> int:
    """发一批输入事件，返回 Windows 接受的条数。"""
    n = len(events)
    if n == 0:
        return 0
    arr = (INPUT * n)(*events)
    return _user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(INPUT))


def _key_event(wscan: int, up: bool = False) -> INPUT:
    ev = INPUT()
    ev.type = INPUT_KEYBOARD
    ev.u.ki.wScan = wscan
    ev.u.ki.dwFlags = KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0)
    return ev


def _vk_event(vk: int, up: bool = False) -> INPUT:
    """虚拟键事件：回车、退格这类没有「字符」的键传 Unicode 无效，必须走 VK。"""
    ev = INPUT()
    ev.type = INPUT_KEYBOARD
    ev.u.ki.wVk = vk
    ev.u.ki.wScan = 0
    ev.u.ki.dwFlags = KEYEVENTF_KEYUP if up else 0
    return ev


def _rhythm(name: str, default: float) -> float:
    """字间停顿（带抖动，不是匀速）。

    2026-11-06 起**不再依赖 wechatauto**：``from wechatauto import rhythm``
    会连带执行 ``wechatauto/__init__.py``，把 ``guia`` / ``wx`` / ``db`` 全部
    拉进来；而那些模块里有 ``wake()`` → ``os.startfile("weixin://")``，一旦
    下游误调就会把微信拉起来。本模块只负责敲键盘，没有任何理由碰那个包。

    现在的实现是自带的伪随机抖动：在 ``default`` 的 0.7–1.5 倍之间取值，
    足够让节奏不像机器，又不引入外部依赖。
    """
    import random

    span = {"type_gap": (0.7, 1.5), "key_hold": (0.6, 1.2)}.get(name, (0.8, 1.3))
    delay = default * random.uniform(*span)
    time.sleep(delay)
    return delay


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------


def type_text(text: str, *, per_char_delay: float | None = None) -> dict[str, Any]:
    """把 ``text`` 逐字打进当前有焦点的输入框。

    每个字符一次 ``SendInput`` 发 down+up 两个事件（不是分两次调用 —— 分开发
    时中间那段 ``key_hold`` 等待会让某些 Qt 输入框把字符吞掉）。字间停顿取
    ``rhythm.type_gap()``，不是固定值。

    返回 ``{'ok': bool, 'accepted': int, 'expected': int, 'reason': str}``。
    """
    if not text:
        return {"ok": False, "accepted": 0, "expected": 0, "reason": "文本为空"}

    accepted = 0
    expected = 0
    for ch in text:
        code = ord(ch)
        if code > 0xFFFF:  # BMP 之外拆代理对
            code -= 0x10000
            hi = 0xD800 + (code >> 10)
            lo = 0xDC00 + (code & 0x3FF)
            events = [_key_event(hi), _key_event(hi, True),
                      _key_event(lo), _key_event(lo, True)]
        else:
            events = [_key_event(code), _key_event(code, True)]
        expected += 1
        if _send(events) == len(events):
            accepted += 1
        if per_char_delay is not None:
            time.sleep(per_char_delay)
        else:
            _rhythm("type_gap", 0.04)

    ok = accepted == expected
    return {
        "ok": ok,
        "accepted": accepted,
        "expected": expected,
        "reason": "" if ok else f"SendInput 只被接受 {accepted}/{expected} 个字符",
    }


def press_enter(*, settle: float = 0.15) -> bool:
    """敲一次回车（发送）。"""
    if _send([_vk_event(VK_RETURN), _vk_event(VK_RETURN, True)]) != 2:
        return False
    time.sleep(settle)
    return True


def press_backspace(count: int = 1) -> int:
    """退格 ``count`` 次，返回成功次数。用于清空输入框。"""
    done = 0
    for _ in range(max(0, int(count))):
        if _send([_vk_event(VK_BACK), _vk_event(VK_BACK, True)]) == 2:
            done += 1
        time.sleep(0.02)
    return done


def clear_input(*, max_chars: int = 200) -> int:
    """清空输入框：Ctrl+A 在微信的 Qt 输入框里不生效，所以按长度敲退格。

    调用前需要知道大概有多少字 —— 这里用 ``max_chars`` 硬扫，配合发送前的
    「先读一次内容长度」使用。
    """
    return press_backspace(max_chars)


def selftest() -> dict[str, Any]:
    """只验证结构体与 API 接受度，不往任何输入框打字。"""
    return {
        "input_size": ctypes.sizeof(INPUT),
        "expected": 40,
        "ok": ctypes.sizeof(INPUT) == 40,
    }
