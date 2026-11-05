"""看一眼浮窗长什么样：塞几轮对话，渲染成 PNG（用真实字体，不加载模型）。

用法：
    python tools/probe_look.py [输出路径]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

from PySide6.QtWidgets import QApplication  # noqa: E402

import main  # noqa: E402


class _StubRecognizer:
    """只占位：截图不需要真的加载 240 MB 识别模型。"""

    def __init__(self, *args, **kwargs) -> None:
        self.ready = False
        self.load_error = "预览模式"

    def load(self) -> None:
        pass

    def transcribe(self, samples, sample_rate=16000) -> str:
        return ""


TURNS = [
    ("user", "今天下午还有什么事？"),
    (
        "assistant",
        "今天下午还剩一件：那份 18 页的表格要按双面出，已经确认过了。\n"
        "另外 3 点那件已经处理完，不用再排。要我把它加进当前任务吗？",
    ),
    ("user", "加吧，再备注一下是最后一次"),
    ("info", "正在把文件加进任务里…"),
    ("assistant", "加好了，当前任务 1 个文件、18 页。你说「开始」我就动手。"),
]


def run() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    app = QApplication.instance() or QApplication([])
    main.Recognizer = _StubRecognizer
    main.VoiceWindow._load_spotter = lambda self: None
    window = main.VoiceWindow(main.load_config())
    window._turns = list(TURNS)
    window._render()
    window.show()
    for _ in range(8):
        app.processEvents()

    if "--active" in sys.argv:
        import math
        import random

        window.wave.active = True
        for i in range(160):
            envelope = abs(math.sin(i * 0.31)) * (0.45 + 0.55 * random.random())
            window.wave.push(0.004 + 0.05 * envelope)
        for _ in range(3):
            window.wave._animate()
        window._set_status("在听…（说完自动停，Esc 取消）")
        app.processEvents()

    window._fit_height()
    app.processEvents()

    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "_look.png")
    pixmap = window.grab()
    pixmap.save(str(out))
    print(f"size={window.width()}x{window.height()} dpr={window.devicePixelRatioF()}")
    print(f"saved {out} ({pixmap.width()}x{pixmap.height()})")
    window.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
