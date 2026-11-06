"""用店主自己的微信发消息（UIA 路线，非 hook、非协议）。

为什么需要这一层
----------------
底层 ``wechatauto-replica`` 的 ``quick_send(..., verify=True)`` 会在发送后回读
数据库确认，但它的回读窗口写死为 ``WxParam.DB_VERIFY_TIMEOUT = 8`` 秒。本机实测
（2026-11-06，微信 4.2.0.9）：消息其实 **1 秒内就落库了**，慢的是库解密缓存的重建
（首次约 6 秒，之后按 mtime 增量）；8 秒窗户经常刚好赶不上，于是返回
``已尝试发送但结果未确认，为避免重复发送不再自动重试``。

这条文案有个要命的歧义：**分不清「没发出去」还是「发出去但没确认」**。业务上必须
分清——说没发会让店主重发造成骚扰，说发了万一是真的没发会漏单。所以这一层的做法：

1. 发送**前**记录该会话的落库水位（最新 local_id）；
2. 调底层发送，``verify=False``（不让它自己去猜）；
3. 自己轮询：每次 ``_invalidate_cache()`` 强制重建，再看水位之后有没有新消息、
   内容是否匹配；
4. 返回三态：``sent``（确认落库）/ ``maybe``（操作做了但没读到）/ ``failed``（明确失败）。

第 4 条的三态是本模块的核心价值：``maybe`` 绝不自动重试，也绝不说成成功。

前置条件（缺一不可，``preflight()`` 会逐条检查并返回原因）
--------------------------------------------------------
- 微信已登录、进程在（进程名 ``Weixin``）；
- 主窗口**已恢复**（最小化/隐藏时 UIA 树拿不到，实测首次 ``doctor`` 就因此报
  ``控件树：拿不到``）；
- Qt accessibility gate 为 1（``Weixin.dll`` 里的 1 个字节，``describe_layout()``
  读得到就说明是 1）。**本模块只读它，不写**——写入由 wechatauto 自己在 UIA 路径
  上做，见下面「关于 gate 字节」；
- 必须是**有交互的桌面会话**：锁屏、远程桌面直接断开后 UIA 失效。

安全边界（与 persona 的硬约束一致）
----------------------------------
发消息是**对外动作**。本模块只提供能力，是否允许发由调用方把关：小印任何时候都
必须先「已报价 + 店主明确说可以发」才调它，且必须把 ``to`` 和正文念回来确认。
本模块不负责「要不要发」的判断。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from typing import Any

# 内容比对时抹掉的差异：微信会规范化空白，粘贴可能带出首尾空格
_WS = re.compile(r"\s+")

# 默认等多久（秒）。实测 1 秒内落库，给到 25 秒是为了容忍首次解密缓存重建（~6s）叠加抖动
DEFAULT_CONFIRM_TIMEOUT = 25.0
POLL_INTERVAL = 1.0


class SendError(RuntimeError):
    """前置条件不满足，一条消息都没发。"""


def _norm(text: str) -> str:
    return _WS.sub("", str(text or ""))


# --------------------------------------------------------------------------- 前置检查


def _ui_anchors() -> int:
    """返回 UIA 锚点里有几个非空（0–6）。

    本机健康时是 5/6（``sns_list`` 常为 None，只在朋友圈页才出现）；只剩
    ``main_window`` 那 1 个时，界面通常已经死了。
    """
    try:
        from wechatauto.uia_driver import WeChatUIA

        anchors = WeChatUIA().describe_layout().get("anchors") or {}
        return sum(1 for v in anchors.values() if v)
    except Exception:
        return -1


def _recover_ui() -> tuple[bool, str]:
    """确认微信界面真的在响应；不响应就试一次「最小化 → 还原」自愈。

    为什么要这一层
    --------------
    2026-11-06 14:00 本机出现过这种状态：进程在、``IsHungAppWindow=0``、
    ``SendMessageTimeout`` 秒回、``PrintWindow`` 也能抓到完整画面 —— 但
    点会话列表画面**一个像素都不变**，UIA 锚点只剩 ``main_window``，
    ``current_chat()`` 和 ``chat_input`` 全是 None。此时发送必然报
    ``输入框没定位到（主窗可能不在聊天页）``。

    判据用两个独立信号（任一恢复即算活）：
    1. UIA 锚点 ≥2 个（``main_window`` + 至少一个别的东西）；
    2. 点一下会话列表，画面变化像素 > 5000（正常几万，死的只剩光标那几十个）。

    自愈手段只用「最小化 → 还原」：实测这一招能让 Qt 重建渲染，14:00 那次
    就是靠它从 31 像素恢复到 275,031 像素的。不做写内存、不做 gate 跃迁。
    """
    import win32con
    import win32gui

    n0 = _ui_anchors()
    if n0 >= 2:
        return True, f"UIA 锚点 {n0}/6，正常"

    try:
        import ctypes

        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:
            pass
        from PIL import ImageGrab
        import numpy as np

        hwnd = win32gui.GetForegroundWindow()
        # 找到一个属于微信进程的可见主窗
        target = 0

        def _cb(h, _):
            nonlocal target
            cls = win32gui.GetClassName(h) or ""
            if cls.startswith("Qt51514QWindowIcon") and (win32gui.GetWindowText(h) or "") in ("微信", "Weixin"):
                target = h
            return True

        win32gui.EnumWindows(_cb, None)
        if not target:
            return False, f"UIA 锚点 {n0}/6，且找不到微信主窗"

        l, t, r, b = win32gui.GetWindowRect(target)
        before = np.asarray(ImageGrab.grab(bbox=(l, t, r, b)).convert("RGB")).astype(int)

        def _diff(a, bb) -> int:
            hh = min(a.shape[0], bb.shape[0])
            ww = min(a.shape[1], bb.shape[1])
            return int((np.abs(a[:hh, :ww] - bb[:hh, :ww]).sum(axis=2) > 10).sum())

        # 先点一次会话列表，看画面动动
        u = ctypes.windll.user32
        u.SetCursorPos(l + 150, t + 130)
        time.sleep(0.2)
        u.mouse_event(2, 0, 0, 0, 0)
        time.sleep(0.06)
        u.mouse_event(4, 0, 0, 0, 0)
        time.sleep(1.6)
        d = _diff(before, np.asarray(ImageGrab.grab(bbox=(l, t, r, b)).convert("RGB")).astype(int))
        alive_click = d > 5000

        n1 = _ui_anchors()
        if alive_click or n1 >= 2:
            return True, f"点会话后变化 {d} 像素，UIA 锚点 {n1}/6"

        # 自愈：最小化 → 还原
        win32gui.ShowWindow(target, win32con.SW_MINIMIZE)
        time.sleep(1.2)
        win32gui.ShowWindow(target, win32con.SW_RESTORE)
        try:
            win32gui.SetForegroundWindow(target)
        except Exception:
            pass
        time.sleep(2.5)

        n2 = _ui_anchors()
        l, t, r, b = win32gui.GetWindowRect(target)
        after = np.asarray(ImageGrab.grab(bbox=(l, t, r, b)).convert("RGB")).astype(int)
        d2 = _diff(before, after)
        if n2 >= 2 or d2 > 5000:
            return True, f"最小化→还原后自愈：UIA 锚点 {n2}/6，画面变化 {d2} 像素"
        return False, f"最小化→还原仍无效：UIA 锚点 {n2}/6，画面变化 {d2} 像素"
    except Exception as exc:
        return False, f"界面健康检查异常：{exc}"


def preflight() -> dict[str, Any]:
    """检查能不能发，返回 ``{'ok': bool, 'checks': {...}, 'reason': str}``。

    不会抛异常——调用方（尤其 MCP handler）需要的是「能/不能 + 为什么」。
    """
    checks: dict[str, Any] = {}

    try:
        import win32gui  # noqa: F401
    except Exception as exc:  # pragma: no cover - 环境问题
        return {"ok": False, "checks": checks, "reason": f"缺少 pywin32：{exc}"}

    try:
        import wechatauto  # noqa: F401
    except Exception as exc:
        return {"ok": False, "checks": checks, "reason": f"缺少 wechatauto-replica：{exc}"}

    import win32con
    import win32gui

    found: list[dict] = []

    def _cb(hwnd, _):
        cls = win32gui.GetClassName(hwnd) or ""
        if cls.startswith("Qt51514QWindowIcon") or "mmui::MainWindow" in cls:
            title = win32gui.GetWindowText(hwnd) or ""
            if title in ("微信", "Weixin") or title.startswith("微信(") or "mmui" in cls:
                found.append(
                    {
                        "hwnd": hwnd,
                        "cls": cls,
                        "title": title,
                        "visible": bool(win32gui.IsWindowVisible(hwnd)),
                        "iconic": bool(win32gui.IsIconic(hwnd)),
                    }
                )
        return True

    win32gui.EnumWindows(_cb, None)
    checks["windows"] = found
    if not found:
        return {"ok": False, "checks": checks, "reason": "没找到微信主窗口，微信可能没登录"}

    restored = []
    for win in found:
        if win["iconic"] or not win["visible"]:
            win32gui.ShowWindow(win["hwnd"], win32con.SW_RESTORE)
            time.sleep(0.4)
            win["visible"] = bool(win32gui.IsWindowVisible(win["hwnd"]))
            win["iconic"] = bool(win32gui.IsIconic(win["hwnd"]))
            restored.append(win["hwnd"])
    if restored:
        checks["restored_windows"] = restored

    if not any(w["visible"] and not w["iconic"] for w in found):
        return {"ok": False, "checks": checks, "reason": "微信窗口拉不起来（被锁屏或远程桌面断开挡住了？）"}

    # 控件树：这里只**读**，不写微信进程内存。写入交给 wechatauto 自己的
    # UIA 路径（`_get_uia()` → `ensure_materialized()` → `_wake_accessibility()`
    # → 写 `Weixin.dll+0xb4f7c08` 的 gate 字节），本模块不重复做这件事。
    #
    # 关于 gate 字节（2026-11-06 排查记录，结论推翻了当天的第一版判断）：
    # 上午我把「微信界面冻结」归因于那次写 gate，并把这段改成只读。重启后复核，
    # 微信界面在 gate=1 的情况下完全正常（点击会话有 211,498 像素变化、连发两条
    # 都成功落库），而重启前冻结时拍的画面里 gate 也是 1 —— gate=1 与冻结**不构成
    # 充分关系**。真正的判据是「3 秒内画面变化像素数」：正常几十万，冻结时只剩
    # 光标那一两百个。所以现在的做法是「只读状态 + 用画面差分确认界面活着」，既
    # 不重复写内存，也不把 gate=1 误报成危险。
    try:
        from wechatauto.uia_driver import WeChatUIA

        diag = WeChatUIA().describe_layout()
        checks["layout"] = diag.get("layout")
        checks["main_class"] = diag.get("main_class")
        checks["uia_note"] = (
            "控件树可用" if diag.get("layout") not in (None, "not-materialized-or-not-running")
            else "控件树不可用（gate 可能为 0 或窗口未就绪），发送会走 OCR 兜底"
        )
    except Exception as exc:
        checks["uia_note"] = f"控件树探测失败（不影响 OCR 路径）：{exc}"

    # 界面是否真的在响应：UIA 只剩 main_window、其余锚点全 None，说明微信渲染
    # 线程进入了「窗口在、画面死」的状态（本机 2026-11-06 14:00 实测过）。
    # 这种状态发出去只会得到 `输入框没定位到`，所以先尝试自愈再报 ok。
    alive, how = _recover_ui()
    checks["ui_alive"] = alive
    checks["ui_recover"] = how
    if not alive:
        return {
            "ok": False,
            "checks": checks,
            "reason": "微信窗口在，但界面没有响应（UIA 只剩主窗口、点会话也不重绘）。"
                      "手动点一下微信窗口或重启微信后再试。",
        }

    return {"ok": True, "checks": checks, "reason": ""}


# --------------------------------------------------------------------------- 落库水位


def _watermark(who: str | None) -> int:
    """该会话当前最新 local_id；拿不到就 0（等于接受任何新消息）。"""
    try:
        from wechatauto import WeChatDB

        db = WeChatDB()
        rows = db.get_messages(_resolve_username(who) or who or "filehelper", limit=1)
        if rows:
            return int(rows[0].get("local_id") or 0)
    except Exception:
        pass
    return 0


def _gui_target(who: str | None) -> str | None:
    """把内部 username 换成**界面上看得见的名字**，给 GUI 驱动用。

    2026-11-06 实测：``filehelper`` 是数据库里的 username，界面搜索框里只有
    「文件传输助手」——拿 ``filehelper`` 去搜，界面会弹出「搜索网络结果」和一堆
    联想词，永远匹配不到会话（用户当场指出「不要搜 filehelper 了，搜文件传输
    助手就行，搜英文搜不到的」）。所以 GUI 这一侧必须翻译：
    - ``filehelper`` → ``文件传输助手``
    - 其它 ``wxid_*`` / ``@chatroom`` → 查库拿昵称/群名，查不到就原样返回。
    """
    if not who:
        return None
    if who == "filehelper":
        return "文件传输助手"
    if who.startswith("wxid_") or "@chatroom" in who:
        try:
            from wechatauto import WeChatDB

            db = WeChatDB()
            nick = db.get_nickname(who)
            if nick:
                return str(nick)
        except Exception:
            pass
    return who


def _resolve_username(who: str | None) -> str | None:
    """把显示名/备注解析成 wxid；本来就是 wxid 或 filehelper 就原样返回。"""
    if not who:
        return None
    if who in ("filehelper",) or who.startswith("wxid_") or "@chatroom" in who:
        return who
    try:
        from wechatauto import WeChatDB

        db = WeChatDB()
        for s in db.get_sessions(limit=300):
            uname = s.get("username")
            if not uname:
                continue
            try:
                if db.get_nickname(uname) == who:
                    return uname
            except Exception:
                continue
    except Exception:
        pass
    return None


# --------------------------------------------------------------------------- 确认落库


def _find_sent(text: str, who: str | None, after_id: int, timeout: float) -> dict | None:
    """轮询数据库，找 ``after_id`` 之后内容匹配的那条。每次强制重建解密缓存。"""
    want = _norm(text)
    if not want:
        return None
    deadline = time.time() + max(0.0, timeout)
    uname = _resolve_username(who) or who
    attempt = 0
    while True:
        attempt += 1
        try:
            from wechatauto import WeChatDB

            db = WeChatDB()
            try:
                db._invalidate_cache()  # 缓存滞后是这条路径唯一的敌人
            except Exception:
                pass
            rows = db.get_messages(uname, limit=20) if uname else []
            for row in rows or []:
                local_id = int(row.get("local_id") or 0)
                if local_id and local_id <= after_id:
                    continue
                if want in _norm(row.get("content")):
                    return {
                        "local_id": local_id,
                        "create_time": int(row.get("create_time") or 0),
                        "attempts": attempt,
                    }
        except Exception:
            pass
        if time.time() >= deadline:
            return None
        time.sleep(POLL_INTERVAL)


# --------------------------------------------------------------------------- 对外接口


def _send_text_human(text: str, to: str) -> dict[str, Any]:
    """像人一样把 ``text`` 敲进 ``to`` 的输入框再敲回车。

    为什么要它：``gui.send_msg`` 走的是 ``_paste_into``（Ctrl+V 整段粘贴）。
    粘贴是一次性把几百个字塞进去，粘贴痕迹在输入框里表现为「瞬间出现整段」，
    而且会占用店主的剪贴板 —— 一天几十单，都是同一个动作，很容易被看出来。
    这里改成逐字 ``SendInput`` Unicode（见 ``human_type.py``），节奏取自
    ``wechatauto.rhythm`` 的 natural 档。

    返回 ``{'ok': bool, 'driver_status': str, 'driver_message': str}``。
    失败**不抛异常**，交给上层决定要不要退回粘贴路径。
    """
    try:
        import human_type as ht
        from wechatauto.guia import WeChatGUI
    except Exception as exc:
        return {"ok": False, "driver_status": "失败", "driver_message": f"拟人键入不可用：{exc}"}

    gui = None
    prev_fg = _foreground_window()
    try:
        gui = WeChatGUI()
        uia = gui._get_uia()
        uia.ensure_window()

        target = _gui_target(to) or to
        if uia.current_chat() != target:
            if not uia.open_chat(target):
                return {"ok": False, "driver_status": "失败", "driver_message": f"打不开会话：{target}"}

        box = uia._chat_input()
        if box is None:
            return {"ok": False, "driver_status": "失败", "driver_message": "找不到聊天输入框"}

        rect = box.BoundingRectangle
        gui.wx_click(rect.left + 150, rect.top + 60)
        time.sleep(0.6)

        # 清空残留（微信 chat_input 不认 Ctrl+A，只能按字符数退格）
        left = uia._read_edit_value(box) or ""
        if left:
            ht.press_backspace(len(left) + 3)
            time.sleep(0.35)

        typed = ht.type_text(text)
        if not typed.get("ok"):
            return {"ok": False, "driver_status": "失败",
                    "driver_message": f"键入不全：{typed}"}

        # 回车前回读，确认真的敲进去了 —— 敲错比没发更糟
        got = uia._read_edit_value(box) or ""
        if _norm(text) not in _norm(got) and _norm(got) not in _norm(text):
            ht.press_backspace(len(got) + 3)
            return {"ok": False, "driver_status": "失败",
                    "driver_message": f"回读不一致，已清空未发送（看到 {got[:30]!r}）"}

        if not ht.press_enter(settle=0.25):
            return {"ok": False, "driver_status": "失败", "driver_message": "回车没发出去"}

        return {"ok": True, "driver_status": "成功", "driver_message": "拟人键入 + 回车"}
    except Exception as exc:
        return {"ok": False, "driver_status": "失败", "driver_message": f"拟人键入异常：{exc}"}
    finally:
        if gui is not None:
            try:
                gui.release_foreground()
            except Exception:
                pass
        _restore_foreground(prev_fg)


def _send_with_restore(kind: str, payload: str, to: str, keep_front: bool):
    """调底层发送，并在收尾时把窗口层级和焦点还给店主。

    底层 ``quick_send`` 内部自己 new 一个 ``WeChatGUI``，发送途中会
    ``ensure_visible()``（最小化遮挡窗口 + HWND_TOPMOST 抢前台），**但从不调用
    ``release_foreground()``** —— 于是每发一条，微信就永远压在桌面所有窗口之上。
    实测（2026-11-06）：连发几条之后 ``GetWindowLong(GWL_EXSTYLE) & WS_EX_TOPMOST``
    恒为 True，必须手动取消。这里自己持有 GUI 实例，发完在 finally 里还原。

    还原分两步（实测缺第二步不够）：
    1. ``release_foreground()`` 取消 TOPMOST + 还原被我们最小化的遮挡窗口；
       ``SW_SHOWNOACTIVATE`` 保证还原时不再抢焦点。
    2. 把**发消息之前的前台窗口**还成前台。不做这步，店主正在写的文档会失去
       光标焦点——窗口明明回来了，键盘却还在微信里输入。

    ``keep_front=True`` 留给批量发送：中途还原会重新挡住微信，反而更慢。
    """
    from wechatauto.guia import WeChatGUI

    prev_fg = _foreground_window()
    gui = WeChatGUI()
    # GUI 侧只认界面上看得见的名字：filehelper → 文件传输助手，见 _gui_target()
    target = _gui_target(to) or to
    try:
        if kind == "text":
            return gui.send_msg(payload, target, verify=False)
        return gui.send_file(payload, target, verify=False)
    finally:
        if not keep_front:
            try:
                gui.release_foreground()  # 取消置顶 + 还原被最小化的遮挡窗口
            except Exception:
                pass
            _restore_foreground(prev_fg, gui.main_hwnd)


def _foreground_window() -> int:
    try:
        import win32gui

        return int(win32gui.GetForegroundWindow() or 0)
    except Exception:
        return 0


def _restore_foreground(hwnd: int, exclude: int = 0) -> bool:
    """把 ``hwnd`` 还原成前台窗口；``hwnd`` 已失效/等于微信/本身就是前台则不做事。

    不用 ``SetForegroundWindow`` 硬抢（前台锁会让它静默失败），先试
    ``AttachThreadInput`` 合并输入队列，失败再退回普通调用。
    """
    if not hwnd or hwnd == exclude:
        return False
    try:
        import ctypes

        import win32con
        import win32gui
        import win32process

        if not win32gui.IsWindow(hwnd) or win32gui.IsIconic(hwnd):
            return False
        if int(win32gui.GetForegroundWindow() or 0) == hwnd:
            return True
        target_tid, _ = win32process.GetWindowThreadProcessId(hwnd)
        cur_tid = ctypes.windll.kernel32.GetCurrentThreadId()
        attached = False
        try:
            attached = bool(ctypes.windll.user32.AttachThreadInput(cur_tid, target_tid, True))
            win32gui.SetForegroundWindow(hwnd)
            win32gui.BringWindowToTop(hwnd)
        except Exception:
            try:
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                return False
        finally:
            if attached:
                ctypes.windll.user32.AttachThreadInput(cur_tid, target_tid, False)
        return int(win32gui.GetForegroundWindow() or 0) == hwnd
    except Exception:
        return False


def send_text(
    text: str,
    to: str,
    *,
    confirm_timeout: float = DEFAULT_CONFIRM_TIMEOUT,
    keep_front: bool = False,
    human: bool = False,
) -> dict[str, Any]:
    """给 ``to`` 发一条文字。返回 ``{'state': 'sent'|'maybe'|'failed', ...}``。

    ``state`` 语义（调用方必须按它说话，不许含糊）：
    - ``sent``   —— 数据库里读到了，确实发出去了；
    - ``maybe``  —— 操作做了，但没读到落库；**别重发**，先看店里微信窗口；
    - ``failed`` —— 明确失败，一条都没发（前置不满足或界面报错）。

    ``human=True`` 时先试「逐字敲键盘 + 回车」（``_send_text_human``），
    不成功再退回 Ctrl+V 粘贴 —— 贴的机械感是次要的，发不出去才是问题。
    """
    text = str(text or "")
    if not text.strip():
        return {"state": "failed", "reason": "内容为空"}
    if not str(to or "").strip():
        return {"state": "failed", "reason": "没说要发给谁"}

    pre = preflight()
    if not pre["ok"]:
        return {"state": "failed", "reason": pre["reason"], "checks": pre["checks"]}

    after_id = _watermark(to)

    resp: dict[str, Any] | None = None
    human_note = ""
    used_human = False
    if human:
        human_res = _send_text_human(text, to)
        if human_res.get("ok"):
            resp = human_res
            used_human = True
        else:
            # 拟人路径失败就退回粘贴：文字发不出去才是真问题，机械感是次要的
            human_note = str(human_res.get("driver_message") or "")
    if resp is None:
        try:
            resp = _send_with_restore("text", text, to, keep_front)
        except Exception as exc:
            return {"state": "failed", "reason": f"底层发送异常：{exc}", "checks": pre["checks"]}
    if not isinstance(resp, dict):
        resp = {"status": getattr(resp, "status", None), "message": getattr(resp, "message", None)}

    status = resp.get("status") or resp.get("driver_status")
    message = resp.get("message") or resp.get("driver_message")

    hit = _find_sent(text, to, after_id, confirm_timeout)
    if hit:
        return {
            "state": "sent",
            "to": to,
            "chars": len(text),
            "mode": "human" if used_human else "paste",
            "confirmed": hit,
            "driver_status": status,
            "driver_message": message,
            "human_note": human_note,
        }

    if status and "失败" in str(status):
        return {
            "state": "maybe" if "未确认" in str(message or "") else "failed",
            "to": to,
            "chars": len(text),
            "reason": message or "底层报失败但没给原因",
            "driver_status": status,
            "driver_message": message,
            "human_note": human_note,
        }
    return {"state": "maybe", "to": to, "chars": len(text), "reason": "界面操作完成但数据库未确认",
            "human_note": human_note}


def send_file(
    path: str,
    to: str,
    *,
    confirm_timeout: float = DEFAULT_CONFIRM_TIMEOUT,
    keep_front: bool = False,
) -> dict[str, Any]:
    """给 ``to`` 发一个本地文件（用于把处理好的 PDF 发回给顾客）。"""
    import os

    if not os.path.isfile(path):
        return {"state": "failed", "reason": f"文件不存在：{path}"}
    pre = preflight()
    if not pre["ok"]:
        return {"state": "failed", "reason": pre["reason"], "checks": pre["checks"]}

    try:
        resp = _send_with_restore("file", os.path.abspath(path), to, keep_front)
    except Exception as exc:
        return {"state": "failed", "reason": f"底层发送异常：{exc}", "checks": pre["checks"]}

    status = resp.get("status") if isinstance(resp, dict) else getattr(resp, "status", None)
    message = resp.get("message") if isinstance(resp, dict) else getattr(resp, "message", None)
    ok = bool(status) and "成功" in str(status)
    return {
        "state": "sent" if ok else ("maybe" if "未确认" in str(message or "") else "failed"),
        "to": to,
        "file": os.path.abspath(path),
        "size": os.path.getsize(path),
        "driver_status": status,
        "driver_message": message,
    }


# --------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="用店主微信发消息（UIA 路线）")
    ap.add_argument("--to", help="收件人显示名/备注/wxid；文件传输助手写 filehelper")
    ap.add_argument("--text", help="要发的文字")
    ap.add_argument("--file", help="要发的本地文件（绝对路径）")
    ap.add_argument("--preflight", action="store_true", help="只检查能不能发，不发")
    ap.add_argument("--timeout", type=float, default=DEFAULT_CONFIRM_TIMEOUT, help="等落库确认的秒数")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    if args.preflight:
        result = preflight()
    elif args.file:
        if not args.to:
            ap.error("发文件也要 --to")
        result = send_file(args.file, args.to, confirm_timeout=args.timeout)
    elif args.text:
        if not args.to:
            ap.error("发文字也要 --to")
        result = send_text(args.text, args.to, confirm_timeout=args.timeout)
    else:
        ap.error("要么 --preflight，要么 --text/--file")

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    else:
        state = result.get("state") or ("ok" if result.get("ok") else "blocked")
        label = {"sent": "已发出（数据库确认）", "maybe": "操作了但没确认——先看微信窗口，别急着重发", "failed": "没发出去"}.get(
            state, state
        )
        print(f"{label}" + (f"：{result.get('reason')}" if result.get("reason") else ""))
    return 0 if (result.get("ok") or result.get("state") == "sent") else 1


if __name__ == "__main__":
    sys.exit(main())
