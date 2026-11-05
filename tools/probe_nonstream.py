"""离屏回归：不流式、思考中、去红字、过滤运行时上下文、回到会话不收起。

用法：python tools/probe_nonstream.py
不开麦克风、不连 DSH：往临时 data_dir 里写假事件，再手动调 _drain_events()。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

APP_DIR = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP_DIR))

import main as app_main  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

FAILED: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + (f"   [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILED.append(name)


def feed(window, events_dir: Path, *events) -> None:
    for event in events:
        name = f"{int(time.time() * 1_000_000):020d}-{len(os.listdir(events_dir)):04d}.json"
        (events_dir / name).write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
        time.sleep(0.002)
    window._drain_events()


def body(window) -> str:
    return window.view.toPlainText()


def roles(window) -> list[tuple[str, str]]:
    return list(window._turns)


def main() -> int:
    data_dir = Path(tempfile.mkdtemp(prefix="voice-probe-"))
    cfg = app_main.load_config()
    cfg.update({"data_dir": str(data_dir), "wake": False, "stt_shadow": False})

    qt = QApplication([])
    window = app_main.VoiceWindow(cfg)
    window.show()
    events = data_dir / "events"

    print("1. history 里混进的运行时上下文要被筛掉")
    feed(window, events, {
        "type": "history",
        "turns": [
            {"role": "user", "text": "Current runtime context. Current working directory: D:\\x"},
            {"role": "user", "text": "Time sampled while preparing turn 1, step 1: 2026-11-05"},
            {"role": "user", "text": "[MNEMON] Use mnemon_view_route only when relevant"},
            {"role": "user", "text": "上午的会议纪要整理好了吗"},
            {"role": "assistant", "text": "整理好了，就是那份。"},
        ],
    })
    check("history 只剩真实两轮", roles(window) == [
        ("user", "上午的会议纪要整理好了吗"),
        ("assistant", "整理好了，就是那份。"),
    ], repr(roles(window)))
    check("正文里没有提示词", "Time sampled" not in body(window) and "MNEMON" not in body(window))

    print("2. 提交后没有「…」占位，状态是「思考中」")
    window._submit("把第 2 页空白去掉再整理一份")
    check("用户那句话进正文", "把第 2 页空白去掉再整理一份" in body(window))
    check("没有省略号占位", "…" not in [t for _, t in roles(window)][-1:], repr(roles(window)[-1:]))
    check("状态=思考中", window.status.text() == "思考中", window.status.text())

    print("3. 上下文 user-message / delta 都不该出现")
    feed(window, events,
         {"type": "user-message", "text": "Time sampled while preparing turn 2, step 1: 2026-11-05"},
         {"type": "user-message", "text": "把第 2 页空白去掉再整理一份"},  # 自己那句的回声
         {"type": "reply-start"},
         {"type": "delta", "text": "没"},
         {"type": "delta", "text": "听清"})
    check("没有多出气泡", len(roles(window)) == 3, repr(roles(window)))
    check("流式片段没进正文", "没听清" not in body(window))
    check("状态仍是思考中", window.status.text() == "思考中", window.status.text())

    print("4. 中间步（工具调用前的半句）不显示，只显示整轮最后一段")
    feed(window, events,
         {"type": "assistant-message", "text": "我先看一下任务队列。"},
         {"type": "done"})
    check("中间半句没贴出来", "我先看一下任务队列" not in body(window))
    check("done 之后还在思考", window.status.text() == "思考中", window.status.text())
    feed(window, events, {"type": "reply-start"})
    check("下一步开始清掉上一步文字", window._pending_reply == "", repr(window._pending_reply))
    feed(window, events,
         {"type": "assistant-message", "text": "没听清，先不动这个。刚才那个问题还在：第2页是空白的，去掉它还是照原样？"},
         {"type": "done"})
    check("整轮结束前不显示", "第2页是空白的" not in body(window))
    feed(window, events, {"type": "turn-end", "reason": {"kind": "completed"}})
    final = "没听清，先不动这个。刚才那个问题还在：第2页是空白的，去掉它还是照原样？"
    check("turn-end 一次性显示整段", body(window).count("第2页是空白的") == 1, body(window))
    check("内容完全一致", roles(window)[-1] == ("assistant", final), repr(roles(window)[-1]))
    check("状态回到空闲", window.status.text() == window._idle_hint(), window.status.text())

    print("5. 这一轮模型没有文字：不加任何红色文案")
    before = len(roles(window))
    feed(window, events, {"type": "reply-start"}, {"type": "done"}, {"type": "turn-end"})
    check("没有新增气泡", len(roles(window)) == before, repr(roles(window)[before:]))
    check("没有红字错误", not any(r == "error" for r, _ in roles(window)), repr(roles(window)))
    check("没有「这一轮没有文字回复」", "没有文字" not in body(window))

    print("6. 在 DSH 里打字发问也会进「思考中」并整段回来")
    feed(window, events, {"type": "user-message", "text": "等一下，2.6 是最终价吗"})
    check("外部提问进来了", roles(window)[-1] == ("user", "等一下，2.6 是最终价吗"), repr(roles(window)[-1]))
    check("外部提问也显示思考中", window.status.text() == "思考中", window.status.text())
    feed(window, events,
         {"type": "reply-start"},
         {"type": "assistant-message", "text": "是最终价，含打包费。"},
         {"type": "turn-end", "reason": {"kind": "completed"}})
    check("外部提问的答复整段回来", roles(window)[-1] == ("assistant", "是最终价，含打包费。"), repr(roles(window)[-1]))

    print("7. 点「回到会话」不收起浮窗，只把 DSH 拉到前台")
    calls = []
    app_main.find_dsh_window = lambda: (12345, "启动小印 — DeepSeek Harness")
    app_main.activate_window = lambda hwnd: (calls.append(hwnd) or True)
    window._back_to_session()
    check("按 hwnd 调了 activate_window", calls == [12345], repr(calls))
    check("浮窗仍然可见", window.isVisible())
    check("状态回到空闲提示", window.status.text() == window._idle_hint(), window.status.text())

    print("8. 找不到 DSH 时也不收起，只提示")
    app_main.find_dsh_window = lambda: (None, "")
    app_main.activate_window = lambda hwnd: True
    window._back_to_session()
    check("仍然可见", window.isVisible())
    check("提示没找到 DSH", "没找到" in window.status.text(), window.status.text())

    print("9. DSH 在但抢不到前台时，浮窗不收起且提示可重试")
    app_main.find_dsh_window = lambda: (12345, "DeepSeek Harness")
    app_main.activate_window = lambda hwnd: False
    window._back_to_session()
    check("仍然可见", window.isVisible())
    check("提示没能切到前台", "没能切到前台" in window.status.text(), window.status.text())
    check("不再误报没找到", "没找到" not in window.status.text(), window.status.text())

    window.close()
    qt.quit()
    print()
    if FAILED:
        print(f"FAILED {len(FAILED)}: {FAILED}")
        return 1
    print("ALL OK")
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
