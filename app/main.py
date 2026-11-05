"""语音浮窗：全局热键唤起、说话、本地转写、送进 DSH 会话、整段回显回复。

单独进程运行（Qt），与 DSH 只通过 %USERPROFILE%\\.dsh\\voice-copilot 里的文件队列通信。
"""
from __future__ import annotations

import html
import json
import math
import os
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt, QTimer
from PySide6.QtGui import (
    QAction,
    QColor,
    QFont,
    QIcon,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
    QTextDocument,
    QTextOption,
)
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QSystemTrayIcon,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from audiohub import AudioHub
from bridge import Bridge
from stt import DEFAULT_MODEL, DEFAULT_TOKENS, Recognizer, build as build_recognizer
from winfocus import activate_window, find_dsh_window

APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "config.json"

BG = "#14151C"
BG_SOFT = "#1D1F29"
FG = "#ECECF1"
MUTED = "#8B8F9E"
ACCENT = "#7C9CFF"
USER = "#9BB7FF"

# 和 index.js 里的 CONTEXT_MARKERS 保持一致。DSH 每一轮都会往会话里写「运行时上下文 /
# 时间上下文 / 记忆快照」这种不是人说的话，它们也会以 user/message 的形式出现，
# 不去掉的话浮窗里就会冒出一大段提示词。插件那边已经按 source.kind 滤了一道，
# 但那道万一漏了（老版本插件、kind 缺失），这边按正文特征再兜一层。
CONTEXT_MARKERS = (
    "Current runtime context",
    "This snapshot supersedes earlier runtime-context snapshots",
    "Current working directory:",
    "Current DSH file policy:",
    "Approval prompts are disabled in this session",
    "Current DeepSeek Harness implementation checkout",
    "Current DeepSeek Harness Web GUI URL",
    "You are the Team Lead",
    "Time sampled while preparing turn",
    "Browser time zone for this request",
    "Elapsed since the preceding model-visible message",
    "<runtime-memory-file",
    "MNEMON RUNTIME MEMORY SNAPSHOT",
    "[MNEMON]",
    "<environment_context",
    "<user_instructions",
    "<system-reminder>",
)


def looks_like_context(text: str) -> bool:
    return any(marker in (text or "") for marker in CONTEXT_MARKERS)


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        cfg = {}
    return {
        "hotkey": cfg.get("hotkey", "ctrl+alt+j"),
        "data_dir": cfg.get("data_dir", str(Path.home() / ".dsh" / "voice-copilot")),
        "model": cfg.get("model", ""),
        "tokens": cfg.get("tokens", ""),
        "language": cfg.get("language", "zh"),
        "stt_engine": cfg.get("stt_engine", "sensevoice"),
        "stt_shadow": bool(cfg.get("stt_shadow", False)),
        "stt_shadow_engine": cfg.get("stt_shadow_engine", "firered"),
        "stt_threads": int(cfg.get("stt_threads", 4)),
        "stt_provider": cfg.get("stt_provider", "cpu"),
        "firered_model_dir": cfg.get("firered_model_dir", ""),
        "max_seconds": float(cfg.get("max_seconds", 20)),
        "wake": bool(cfg.get("wake", True)),
        "pos": cfg.get("pos"),
        "margin": int(cfg.get("margin", 24)),
        "wake_words": list(cfg.get("wake_words") or ["小印", "小音", "小因", "小应", "小银", "晓印", "肖印"]),
    }


# ---------------------------------------------------------------- 全局热键


MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_WIN = 0x0001, 0x0002, 0x0004, 0x0008


def parse_hotkey(spec: str) -> tuple[int, int]:
    mods, vk = 0, 0
    for part in spec.lower().replace(" ", "").split("+"):
        if part in ("ctrl", "control"):
            mods |= MOD_CTRL
        elif part == "alt":
            mods |= MOD_ALT
        elif part == "shift":
            mods |= MOD_SHIFT
        elif part in ("win", "meta", "super"):
            mods |= MOD_WIN
        elif len(part) == 1 and part.isalnum():
            vk = ord(part.upper())
    return mods, vk


class HotkeyThread(threading.Thread):
    """RegisterHotKey 到本线程消息队列，收到 WM_HOTKEY 就置位一个 Event。"""

    def __init__(self, spec: str) -> None:
        super().__init__(daemon=True)
        self.spec = spec
        self.pressed = threading.Event()
        self.ok = False
        self.error = ""

    def run(self) -> None:
        import ctypes
        import ctypes.wintypes as wt

        class MSG(ctypes.Structure):
            _fields_ = [
                ("hwnd", wt.HWND),
                ("message", wt.UINT),
                ("wParam", wt.WPARAM),
                ("lParam", wt.LPARAM),
                ("time", wt.DWORD),
                ("pt", wt.POINT),
            ]

        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            mods, vk = parse_hotkey(self.spec)
            if not vk:
                self.error = f"看不懂快捷键 {self.spec!r}"
                return
            if not user32.RegisterHotKey(None, 1, mods, vk):
                self.error = f"{self.spec} 注册失败（错误码 {ctypes.get_last_error()}），可能被别的程序占了"
                return
            self.ok = True
            msg = MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == 0x0312:  # WM_HOTKEY
                    self.pressed.set()
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------- 波形


class Waveform(QWidget):
    """一条会呼吸的声纹：平滑的带状波，跟随音量起落，空闲时自己缓缓流动。"""

    BARS = 88

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._target = [0.0] * self.BARS
        self._value = [0.0] * self.BARS
        self._phase = 0.0
        self.active = False
        self.setFixedHeight(26)
        self._timer = QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._animate)
        self._timer.start()

    def push(self, value: float) -> None:
        self._target.pop(0)
        self._target.append(max(0.0, min(1.0, value * 22.0)))

    def reset(self) -> None:
        self._target = [0.0] * self.BARS

    def _animate(self) -> None:
        self._phase += 0.085
        for i, (target, current) in enumerate(zip(self._target, self._value)):
            k = 0.62 if target > current else 0.16   # 起得快、落得慢
            self._value[i] = current + (target - current) * k
        self.update()

    @staticmethod
    def _curve(points: list[QPointF]) -> QPainterPath:
        path = QPainterPath(points[0])
        for i in range(1, len(points) - 1):
            mid = QPointF((points[i].x() + points[i + 1].x()) / 2,
                          (points[i].y() + points[i + 1].y()) / 2)
            path.quadTo(points[i], mid)
        path.lineTo(points[-1])
        return path

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(Qt.NoPen)

        half = self.height() / 2.0 - 1.5
        values = []
        for i, value in enumerate(self._value):
            if not self.active:
                # 空闲：一条缓慢流动的波纹，不至于像一排死柱子
                value = max(value, 0.24 + 0.10 * (0.5 + 0.5 * math.sin(self._phase + i * 0.30)))
            else:
                value = max(value, 0.06)
            values.append(min(1.0, value))
        n = len(values)
        # 两端收口，别让波形像被刀切了一刀
        edge = 10
        for i in range(n):
            fade = min(1.0, (i + 1) / edge, (n - i) / edge)
            values[i] *= 0.15 + 0.85 * fade * fade
        smooth = [(values[max(0, i - 1)] + values[i] * 2 + values[min(n - 1, i + 1)]) / 4.0
                  for i in range(n)]

        step = self.width() / (n - 1)
        pts = [QPointF(i * step, half - s * half) for i, s in enumerate(smooth)]
        top = self._curve(pts)

        band = QPainterPath(top)
        band.lineTo(pts[-1].x(), 2 * half - pts[-1].y())
        for i in range(n - 1, -1, -1):
            band.lineTo(pts[i].x(), 2 * half - pts[i].y())
        band.closeSubpath()

        gradient = QLinearGradient(0, 0, self.width(), 0)
        base = QColor(ACCENT) if self.active else QColor("#7C9CFF")
        edge = QColor(base)
        edge.setAlphaF(0.03)
        core = QColor(base)
        core.setAlphaF(0.34 if self.active else 0.14)
        gradient.setColorAt(0.0, edge)
        gradient.setColorAt(0.5, core)
        gradient.setColorAt(1.0, edge)
        painter.setBrush(gradient)
        painter.drawPath(band)

        stroke = QColor(ACCENT) if self.active else QColor("#6C7186")
        glow = QColor(stroke)
        glow.setAlphaF(0.22)
        pen = QPen(glow)
        pen.setWidthF(4.0)
        pen.setCapStyle(Qt.RoundCap)
        painter.setPen(pen)
        painter.drawPath(top)

        stroke.setAlphaF(0.95 if self.active else 0.75)
        pen = QPen(stroke)
        pen.setWidthF(1.6)
        pen.setCapStyle(Qt.RoundCap)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawPath(top)


# ---------------------------------------------------------------- 主窗


class VoiceWindow(QWidget):
    WIDTH = 640
    MIN_H = 268
    MAX_H = 860
    # 浮窗正文最多露 10 行，再长就只给个头，剩下的回会话里看
    MAX_BODY_LINES = 10

    def __init__(self, cfg: dict) -> None:
        super().__init__()
        self.cfg = cfg
        self.bridge = Bridge(Path(cfg["data_dir"]))
        self.bridge.ensure()
        self.bridge.skip_history()
        self.hub = AudioHub(self)
        self.hub.level.connect(self._on_level)
        self.hub.segment.connect(self._on_segment)
        self.hub.wake.connect(self._wake_hit)
        self.hub.command_done.connect(self._on_audio)
        self.hub.failed.connect(lambda msg: self._set_status(f"麦克风：{msg}", error=True))
        self.hub.mode_changed.connect(self._on_mode)
        self.wake_words = cfg["wake_words"]
        self.wake_enabled = bool(cfg["wake"])
        self._wake_checking = False
        self._spotter = None
        self._load_spotter()

        self.recognizer = build_recognizer(cfg)
        if not getattr(self.recognizer, "name", ""):
            self.recognizer.name = "sensevoice"
        self._pool = ThreadPoolExecutor(max_workers=1)
        self._shadow = None
        self._shadow_pool = None
        if cfg.get("stt_shadow") and self.recognizer.name == "sensevoice":
            self._shadow = build_recognizer({"stt_engine": cfg.get("stt_shadow_engine") or "firered"})
            self._shadow_pool = ThreadPoolExecutor(max_workers=1)
            threading.Thread(target=self._load_shadow, daemon=True).start()
        self._stt_ready = False
        self._stt_error = ""
        self._busy = False
        self._bridge_seen = False
        self._turns: list[tuple[str, str]] = []  # (role, text)
        # 不做流式：助手这一轮的文字先扣在这儿，等 turn-end 再一次性贴出来。
        self._pending_reply = ""

        self._build()
        threading.Thread(target=self._load_model, daemon=True).start()

        self._poll = QTimer(self)
        self._poll.setInterval(90)
        self._poll.timeout.connect(self._drain_events)
        self._poll.start()

        self._ping_timer = QTimer(self)
        self._ping_timer.setSingleShot(True)
        self._ping_timer.timeout.connect(self._check_bridge)
        self._ping_timer.start(2600)
        self.bridge.ping()
        self.bridge.sync()

    # -- 界面 ---------------------------------------------------------

    def _build(self) -> None:
        self.setWindowTitle("语音浮窗")
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setFixedWidth(self.WIDTH)
        self.setFixedHeight(self.MIN_H)
        self.setWindowIcon(make_icon())

        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 14, 14, 14)

        self.card = QWidget(self)
        self.card.setObjectName("card")
        self.card.setStyleSheet(
            f"""
            #card {{ background: {BG}; border-radius: 18px; border: 1px solid rgba(255,255,255,0.09); }}
            #card QLabel {{ color: {FG}; }}
            QTextBrowser {{ background: transparent; border: none; padding: 0; color: {FG}; font-size: 14px; }}
            QLineEdit {{ background: {BG_SOFT}; border: 1px solid rgba(255,255,255,0.08);
                         border-radius: 10px; padding: 7px 12px; color: {FG}; font-size: 14px; }}
            QLineEdit:focus {{ border: 1px solid rgba(124,156,255,0.65); }}
            """
        )
        outer.addWidget(self.card)

        box = QVBoxLayout(self.card)
        box.setContentsMargins(18, 14, 18, 14)
        box.setSpacing(8)

        head = QHBoxLayout()
        head.setSpacing(8)
        self.dot = QLabel("●")
        self.dot.setStyleSheet(f"color: {ACCENT}; font-size: 11px;")
        self.title = QLabel("语音浮窗")
        self.title.setStyleSheet(f"color: {MUTED}; font-size: 12px; letter-spacing: 1px;")
        self.status = QLabel("按 Ctrl+Alt+J 开始")
        self.status.setStyleSheet(f"color: {MUTED}; font-size: 12px;")
        self.back_btn = QPushButton("回到会话")
        self.back_btn.setFixedHeight(22)
        self.back_btn.setCursor(Qt.PointingHandCursor)
        self.back_btn.setToolTip("切回 DSH 里这个语音会话（太长没显示完的，都在这边）")
        self.back_btn.setStyleSheet(
            f"QPushButton{{color:{ACCENT};border:1px solid rgba(124,156,255,0.35);"
            f"background:rgba(124,156,255,0.10);border-radius:8px;font-size:11px;padding:0 9px;}}"
            f"QPushButton:hover{{background:rgba(124,156,255,0.22);color:#DCE6FF;}}"
            f"QPushButton:pressed{{background:rgba(124,156,255,0.30);}}"
        )
        self.back_btn.clicked.connect(self._back_to_session)
        close_btn = QPushButton("✕")
        close_btn.setFixedSize(22, 22)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.setStyleSheet("QPushButton{color:#7A7E8C;border:none;background:transparent;font-size:13px;}"
                                "QPushButton:hover{color:#FFFFFF;}")
        close_btn.clicked.connect(self.hide)
        head.addWidget(self.dot)
        head.addWidget(self.title)
        head.addStretch(1)
        head.addWidget(self.status)
        head.addSpacing(6)
        head.addWidget(self.back_btn)
        head.addWidget(close_btn)
        box.addLayout(head)

        self.wave = Waveform(self.card)
        box.addWidget(self.wave)

        self.view = QTextBrowser(self.card)
        self.view.setOpenExternalLinks(True)
        self.view.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        # 文件路径这类长单词没有空格，按词换行会横向切掉，改成任意处可断
        option = self.view.document().defaultTextOption()
        option.setWrapMode(QTextOption.WrapAtWordBoundaryOrAnywhere)
        self.view.document().setDefaultTextOption(option)
        box.addWidget(self.view, 1)

        self.input = QLineEdit(self.card)
        self.input.setPlaceholderText("也可以直接打字，回车发送")
        self.input.returnPressed.connect(self._send_typed)
        box.addWidget(self.input)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(0, 0, 0, 70))
        painter.drawRoundedRect(QRectF(10, 12, self.width() - 20, self.height() - 20), 20, 20)

    # -- 状态 ---------------------------------------------------------

    def _set_status(self, text: str, error: bool = False, accent: bool = False) -> None:
        self.status.setText(text)
        color = "#FF8A8A" if error else (ACCENT if accent else MUTED)
        self.status.setStyleSheet(f"color: {color}; font-size: 12px;")

    def _idle_hint(self) -> str:
        if self.wake_enabled:
            return "说「小印」就能叫出来，或按 Ctrl+Alt+J"
        return f"按 {self.cfg['hotkey'].upper()} 开始"

    def _log(self, line: str) -> None:
        try:
            path = Path(self.cfg["data_dir"]) / "wake.log"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(f"{time.strftime('%H:%M:%S')} {line}\n")
        except Exception:
            pass

    def _clip(self, text: str) -> str:
        """单条极端长的文本先砍个头，剩下的交给 10 行预算处理。"""
        text = text or ""
        if len(text) <= 4000:
            return text
        return text[:4000].rstrip()

    # -- 渲染（最多 10 行） -------------------------------------------

    def _line_height_px(self, width: int) -> int:
        doc = QTextDocument()
        self._prep_doc(doc, width)
        doc.setHtml('<div style="font-size:14px;line-height:150%;">国</div>')
        return max(14, int(math.ceil(doc.size().height())))

    def _measure_html(self, body: str, width: int) -> int:
        doc = QTextDocument()
        self._prep_doc(doc, width)
        doc.setHtml(body)
        return int(math.ceil(doc.size().height()))

    @staticmethod
    def _prep_doc(doc: QTextDocument, width: int) -> None:
        doc.setTextWidth(max(200, width))
        option = doc.defaultTextOption()
        option.setWrapMode(QTextOption.WrapAtWordBoundaryOrAnywhere)
        doc.setDefaultTextOption(option)

    def _html_for(self, turns) -> str:
        parts = []
        for role, text in turns:
            shown = self._clip(text) if role in ("user", "assistant") else text
            if role == "user":
                parts.append(
                    f'<div style="margin:10px 0 1px 0;color:{USER};font-size:11px;letter-spacing:1px;">我</div>'
                    f'<div style="margin:0;color:{FG};font-size:14px;line-height:145%;">'
                    f"{html.escape(shown).replace(chr(10), '<br>')}</div>"
                )
            elif role == "assistant":
                parts.append(
                    f'<div style="margin:12px 0 1px 0;color:{MUTED};font-size:11px;letter-spacing:1px;">助手</div>'
                    f'<div style="margin:0;color:{FG};font-size:14px;line-height:150%;">'
                    f"{html.escape(shown).replace(chr(10), '<br>')}</div>"
                )
            elif role == "info":
                parts.append(
                    f'<div style="margin:6px 0 1px 0;color:{ACCENT};font-size:11px;">{html.escape(text)}</div>'
                )
            else:  # error
                parts.append(
                    f'<div style="margin:6px 0;color:#FF8A8A;font-size:12px;">{html.escape(text)}</div>'
                )
        return "".join(parts)

    def _apply_wrap(self) -> None:
        """setHtml 会把文档的默认文本选项重置，换行模式得每次重设。"""
        option = self.view.document().defaultTextOption()
        option.setWrapMode(QTextOption.WrapAtWordBoundaryOrAnywhere)
        self.view.document().setDefaultTextOption(option)

    def _render(self) -> None:
        width = max(200, self.view.viewport().width())
        line_h = self._line_height_px(width)
        budget = line_h * self.MAX_BODY_LINES
        full_html = self._html_for(self._turns)
        if not full_html:
            self.view.setHtml(
                f'<div style="color:{MUTED};font-size:13px;">说一句话，或者打一行字。</div>'
            )
            self._apply_wrap()
            QTimer.singleShot(0, self._fit_height)
            return

        full_h = self._measure_html(full_html, width)
        turns = list(self._turns)
        hint = ""
        if full_h > budget:
            # 先整轮丢旧的，再砍最后一条的尾巴——保证露出来的是最新的开头
            content_budget = max(line_h, budget - line_h - line_h // 2)
            while len(turns) > 1 and self._measure_html(self._html_for(turns), width) > content_budget:
                turns = turns[1:]
            if self._measure_html(self._html_for(turns), width) > content_budget:
                role, text = turns[-1]
                base = turns[:-1]
                # 先按比例估，再二分逼近，别浪费在 1 行 1 行往上凑
                ratio = content_budget / max(1.0, float(self._measure_html(self._html_for(turns), width)))
                guess = max(0, min(len(text), int(len(text) * ratio)))
                lo, hi = 0, len(text)
                if self._measure_html(self._html_for(base + [(role, text[:guess])]), width) <= content_budget:
                    lo = guess
                else:
                    hi = guess
                for _ in range(5):
                    mid = (lo + hi) // 2
                    if mid <= lo or mid >= hi:
                        break
                    if self._measure_html(self._html_for(base + [(role, text[:mid])]), width) <= content_budget:
                        lo = mid
                    else:
                        hi = mid
                cut = lo
                if 0 < cut < len(text):
                    # 尽量切在换行或空格上，别把一行、一个路径劈成两半
                    piece = text[:cut]
                    nl = piece.rfind("\n")
                    if nl > cut * 0.55:
                        cut = nl
                    else:
                        sp = max(piece.rfind(" "), piece.rfind("　"))
                        if sp > cut * 0.85:
                            cut = sp
                tail = text[:cut].rstrip()
                if cut < len(text):
                    tail += "…"
                turns = base + [(role, tail)]
            shown_h = self._measure_html(self._html_for(turns), width)
            hidden = max(1, int(round((full_h - shown_h) / max(1, line_h))))
            hint = (
                f'<div style="margin:8px 0 0 0;color:{MUTED};font-size:11px;">'
                f'…另有约 {hidden} 行在 DSH 里，点右上角「回到会话」看全文</div>'
            )

        self.view.setHtml(self._html_for(turns) + hint)
        self._apply_wrap()
        bar = self.view.verticalScrollBar()
        bar.setValue(bar.maximum())
        QTimer.singleShot(0, self._fit_height)

    def _screen_geo(self):
        screen = QApplication.screenAt(self.frameGeometry().center()) or QApplication.primaryScreen()
        return screen.availableGeometry()

    def _fit_height(self) -> None:
        """窗口高度跟着内容走：少一句话就矮一点，省掉大片空白；底边保持不动。"""
        geo = self._screen_geo()
        m = int(self.cfg.get("margin", 24))
        doc = self.view.document()
        doc.setTextWidth(max(200, self.view.viewport().width()))
        content = doc.size().height()
        chrome = self.height() - self.view.viewport().height()
        limit = max(self.MIN_H, min(self.MAX_H, geo.height() - 2 * m))
        height = int(content + chrome + 4)
        height = max(self.MIN_H, min(limit, height))
        if abs(height - self.height()) < 2:
            return
        bottom = self.geometry().bottom()
        top = bottom - height + 1
        top = max(geo.top() + m, min(top, geo.bottom() - m - height + 1))
        self.setFixedHeight(height)
        self.move(self.x(), top)

    # -- 回到会话 -----------------------------------------------------

    def _back_to_session(self) -> None:
        """把 DSH 桌面端拉到前台；浮窗留在原位不收起（它还是置顶的，随时能接着用）。"""
        hwnd, title = find_dsh_window()
        if not hwnd:
            self._set_status("没找到 DSH 窗口，先打开桌面端", error=True)
            self._log("back-to-session failed: no DSH window")
            return
        if activate_window(hwnd):
            self._set_status(self._idle_hint())
            self._log(f"back-to-session ok title={title!r}")
            return
        # 窗口在，只是被 Windows 的前台锁挡住没抢到焦点：让用户再点一次就好。
        self._set_status("DSH 窗口在，但没能切到前台，再点一次", error=True)
        self._log(f"back-to-session blocked title={title!r}")

    # -- 模型 ---------------------------------------------------------

    def _load_model(self) -> None:
        started = time.time()
        self.recognizer.load()
        elapsed = time.time() - started
        if self.recognizer.ready:
            self._stt_ready = True
            self._log(f"stt ready engine={self.recognizer.name} in {elapsed:.1f}s")
            print(f"[stt] ready ({self.recognizer.name}) in {elapsed:.1f}s")
        else:
            self._stt_error = self.recognizer.load_error or "未知原因"
            self._log(f"stt failed engine={self.recognizer.name}: {self._stt_error}")
            print(f"[stt] failed: {self._stt_error}")

    # -- 录音 ---------------------------------------------------------

    def _on_level(self, value: float) -> None:
        self.wave.active = self.hub.mode == "command"
        if self.hub.mode == "command":
            self.wave.push(value)

    def _on_mode(self, mode: str) -> None:
        if mode == "command":
            self.wave.active = True
            self.wave.reset()

    def listen(self) -> None:
        if not self._stt_ready:
            if self._stt_error:
                self._set_status(f"识别模型不可用：{self._stt_error}", error=True)
            else:
                self._set_status("识别模型还在加载…")
            return
        self.wave.active = True
        self.wave.reset()
        self.hub.begin_command(pre_roll=1.0)
        self._set_status("在听…（说完自动停，Esc 取消）")

    # -- 唤醒词 -------------------------------------------------------

    def _load_spotter(self) -> None:
        """流式唤醒词模型（3.3M），放后台线程加载；失败就退回断句+ASR 的老办法。"""

        def work() -> None:
            try:
                from kws import Spotter

                spotter = Spotter()
            except Exception as exc:  # 模型没下、依赖缺失等
                self._log(f"kws 不可用，退回断句识别：{type(exc).__name__}: {exc}")
                return
            self._spotter = spotter
            self.hub.set_spotter(spotter)
            self._log("kws ready")

        threading.Thread(target=work, daemon=True).start()

    def _on_segment(self, samples) -> None:
        """monitor 模式下听到一段话：交给识别，看看里面有没有唤醒词。"""
        if self._spotter is not None:      # 有流式唤醒词就不用这套兜底了
            return
        if not self.wake_enabled or self.hub.mode == "command" or self._wake_checking:
            return
        if not self._stt_ready or len(samples) < 3200:
            return
        self._wake_checking = True
        future = self._pool.submit(self.recognizer.transcribe, samples)
        self._await_future(future, self._after_wake_check, what="唤醒检测")

    def _after_wake_check(self, text: str) -> None:
        self._wake_checking = False
        heard = (text or "").replace(" ", "")
        hit = next((w for w in self.wake_words if w in heard), None)
        self._log(f"wake-check heard={heard!r} hit={hit!r}")
        if not hit:
            return
        if self.hub.mode == "command":
            return
        self._wake_hit(hit)

    def _wake_hit(self, word: str) -> None:
        if not self.isVisible():
            self._turns.append(("info", f"听到「{word}」"))
            self._render()
            self.place()
            self.show()
        self.raise_()
        self.activateWindow()
        if self.hub.mode != "command":
            self.hub.begin_command(pre_roll=5.0)
        self._set_status(f"听到「{word}」，说吧…", accent=True)

    def _on_audio(self, samples) -> None:
        self.wave.active = False
        self.wave.reset()
        seconds = 0.0 if samples is None else len(samples) / 16000.0
        if samples is None or seconds < 0.25:
            self._set_status("没听到声音")
            return
        self._set_status("在转写…")
        future = self._pool.submit(self.recognizer.transcribe, samples)
        self._await_future(future, self._after_transcribe, what="转写")
        if self._shadow is not None and self._shadow.ready and self._shadow_pool is not None:
            self._shadow_pool.submit(self._shadow_run, samples)

    def _load_shadow(self) -> None:
        started = time.time()
        self._shadow.load()
        self._log(
            f"shadow ready engine={self._shadow.name} ok={self._shadow.ready} "
            f"in {time.time() - started:.1f}s err={self._shadow.load_error or ''}"
        )

    def _shadow_run(self, samples) -> None:
        """后台用另一个引擎再认一遍，只写日志，不改界面。"""
        started = time.time()
        try:
            text = self._shadow.transcribe(samples)
        except Exception as exc:
            self._log(f"ab shadow failed: {type(exc).__name__}: {exc}")
            return
        self._log(
            f"ab shadow={self._shadow.name} {time.time() - started:.2f}s "
            f"audio={len(samples) / 16000.0:.2f}s text={text!r}"
        )

    def _await_future(self, future, callback, what: str) -> None:
        timer = QTimer(self)
        timer.setInterval(60)

        def check() -> None:
            if not future.done():
                return
            timer.stop()
            timer.deleteLater()
            try:
                callback(future.result())
            except Exception as exc:
                self._set_status(f"{what}失败：{exc}", error=True)

        timer.timeout.connect(check)
        timer.start()

    def _after_transcribe(self, text: str) -> None:
        text = (text or "").strip()
        if self._shadow is not None:
            self._log(f"ab primary={self.recognizer.name} text={text!r}")
        if not text:
            self._set_status("没听清，再说一次？", error=True)
            return
        text = self._strip_wake(text)
        if not text:
            self._set_status("在听…（唤醒词之后没听到内容）", error=True)
            return
        self._set_status(f"听到：{text}")
        self._submit(text)

    def _strip_wake(self, text: str) -> str:
        """命令里常把「小印」一起录进来，送进会话前去掉。"""
        head = text.lstrip(" ，,。.、！!？?")
        for word in sorted(self.wake_words + ["嘿小印", "小印小印"], key=len, reverse=True):
            if head.startswith(word):
                return head[len(word):].lstrip(" ，,。.、！!？?")
        return text

    # -- 发送 ---------------------------------------------------------

    def _send_typed(self) -> None:
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self._submit(text)

    def _submit(self, text: str) -> None:
        self._turns.append(("user", text))
        self._pending_reply = ""
        self._render()
        self.bridge.submit_text(text)
        self._busy = True
        self._set_status("思考中")

    # -- 事件 ---------------------------------------------------------

    def _already_shown(self, text: str) -> bool:
        """刚在浮窗里说过的那句，事件回来时别显示两遍。"""
        for role, shown in reversed(self._turns[-2:]):
            if role == "user" and shown.strip() == text:
                return True
        return False

    def _drain_events(self) -> None:
        for event in self.bridge.poll():
            kind = event.get("type")
            if kind == "pong":
                self._bridge_seen = True
            elif kind == "ready":
                self._bridge_seen = True
            elif kind == "transcript":
                heard = event.get("text") or ""
                if heard:
                    self._set_status(f"听到：{heard}")
            elif kind == "history":
                turns = event.get("turns") or []
                rebuilt: list[tuple[str, str]] = []
                for turn in turns:
                    text = (turn.get("text") or "").strip()
                    if not text:
                        continue
                    role = turn.get("role") if turn.get("role") in ("user", "assistant") else "assistant"
                    # 老插件的快照会把运行时上下文当成 user 文本发过来，这里再筛一遍
                    if role == "user" and looks_like_context(text):
                        continue
                    rebuilt.append((role, text))
                self._turns = rebuilt
                self._render()
                self._log(f"history {len(self._turns)} turns")
            elif kind == "user-message":
                text = (event.get("text") or "").strip()
                if text and not looks_like_context(text) and not self._already_shown(text):
                    self._turns.append(("user", text))
                    self._render()
                    # 在 DSH 界面里打字发问也一样：等答复期间就是「思考中」
                    self._busy = True
                    self._set_status("思考中")
            elif kind == "assistant-message":
                # 不流式：这一步的文字先扣着，等整轮结束再一次性贴出来
                self._pending_reply = (event.get("text") or "").strip()
            elif kind == "prompt":
                if not event.get("accepted"):
                    self._turns.append(("error", "会话没接这条消息。"))
                    self._render()
                    self._busy = False
            elif kind == "reply-start":
                # 新的一步开始：上一步的文字只是过程，丢掉
                self._pending_reply = ""
                self._busy = True
                self._set_status("思考中")
            elif kind == "delta":
                # 老插件还在逐 token 发，忽略；只认最后整段
                continue
            elif kind == "done":
                # 一步结束不代表这一轮结束（中间可能还夹着工具调用），继续等
                self._busy = True
            elif kind == "turn-end":
                self._commit_reply()
            elif kind == "error":
                message = event.get("message") or "未知错误"
                stage = event.get("stage") or ""
                self._turns.append(("error", f"[{stage}] {message}" if stage else message))
                self._render()
                self._busy = False
                self._set_status("出错了", error=True)

    def _commit_reply(self) -> None:
        """这一轮结束：把助手最后那段话一次性贴进浮窗；没有文字就什么都不加。"""
        text, self._pending_reply = self._pending_reply.strip(), ""
        if text and not (self._turns and self._turns[-1] == ("assistant", text)):
            self._turns.append(("assistant", text))
            self._render()
        self._busy = False
        self._set_status("在听…" if self.hub.mode == "command" else self._idle_hint())

    def _check_bridge(self) -> None:
        if not self._bridge_seen:
            self._turns.append(("error", "DSH 语音桥没回话：确认桌面端是开着的、@local/dsh-voice-copilot 插件已启用。"))
            self._render()
            self._set_status("DSH 语音桥没响应", error=True)

    # -- 显示 ---------------------------------------------------------

    # -- 位置与拖动 ---------------------------------------------------

    def _default_pos(self) -> QPoint:
        """没挪过位置时：屏幕右下角留一点边。"""
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry()
        m = int(self.cfg.get("margin", 24))
        return QPoint(geo.right() - self.width() - m + 1, geo.bottom() - self.height() - m + 1)

    def _clamp(self, pos: QPoint) -> QPoint:
        """至少留一截在屏幕里，免得换了分辨率之后找不回来。"""
        screen = QApplication.screenAt(pos) or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = min(max(pos.x(), geo.left() - self.width() + 140), geo.right() - 140)
        m = int(self.cfg.get("margin", 24))
        if self.height() + 2 * m <= geo.height():
            y = min(max(pos.y(), geo.top() + m), geo.bottom() - m - self.height() + 1)
        else:  # 窗口比屏幕还高：允许贴边，至少留个抓手
            y = min(max(pos.y(), geo.top()), geo.bottom() - 48)
        return QPoint(x, y)

    def place(self) -> None:
        self._fit_height()
        saved = self.cfg.get("pos")
        if isinstance(saved, (list, tuple)) and len(saved) == 2:
            pos = self._clamp(QPoint(int(saved[0]), int(saved[1])))
        else:
            pos = self._default_pos()
        self.move(pos)

    def reset_position(self) -> None:
        self._fit_height()
        self.move(self._default_pos())
        self._write_pos(None)

    def _remember_pos(self, pos: QPoint | None = None) -> None:
        point = pos or self.pos()
        self._write_pos([point.x(), point.y()])

    def _write_pos(self, value) -> None:
        self.cfg["pos"] = value
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        data["pos"] = value
        CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self.setCursor(Qt.ClosedHandCursor)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        offset = getattr(self, "_drag_offset", None)
        if offset is not None and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if getattr(self, "_drag_offset", None) is not None:
            self._drag_offset = None
            self.unsetCursor()
            self.move(self._clamp(self.pos()))
            self._remember_pos()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def summon(self) -> None:
        self.place()
        self.show()
        self.raise_()
        self.activateWindow()
        self.input.setFocus()
        QTimer.singleShot(120, self.listen)

    def finish_listening(self) -> None:
        """热键再按一下：停录并发送。"""
        self.hub.end_command()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Escape:
            if self.hub.mode == "command":
                self.hub.cancel_command()
                self._set_status("已取消")
            self.hide()
            return
        super().keyPressEvent(event)

    def closeEvent(self, event) -> None:  # noqa: N802
        event.ignore()
        self.hide()


def make_icon() -> QIcon:
    pix = QPixmap(64, 64)
    pix.fill(Qt.transparent)
    painter = QPainter(pix)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.setBrush(QColor(BG_SOFT))
    painter.setPen(Qt.NoPen)
    painter.drawRoundedRect(QRectF(2, 2, 60, 60), 16, 16)
    painter.setPen(QPen(QColor(ACCENT), 4, Qt.SolidLine, Qt.RoundCap))
    painter.setBrush(Qt.NoBrush)
    path = QPainterPath()
    path.addRoundedRect(QRectF(26, 12, 12, 24), 6, 6)
    painter.drawPath(path)
    painter.drawArc(QRectF(19, 26, 26, 22), 180 * 16, 180 * 16)
    painter.drawLine(QPoint(32, 48), QPoint(32, 54))
    painter.end()
    return QIcon(pix)


# ── 单实例与唤起 ────────────────────────────────────────────────────────────
# DSH 插件会随桌面端启动把本程序拉起来，手动双击 vbs 也可能再来一次。
# 用 Windows 命名互斥量保证只有一个浮窗；后来者写一个 show.request 就退出，
# 已经在跑的那个轮询到文件就把自己唤到前台，所以「再双击一次」= 唤起。

_MUTEX_HANDLES: list[int] = []


def _claim_single_instance(name: str = r"Local\dsh-voice-copilot") -> bool:
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        ctypes.set_last_error(0)
        handle = kernel32.CreateMutexW(None, False, name)
        if not handle:
            return False
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            kernel32.CloseHandle(ctypes.c_void_p(handle))
            return False
        _MUTEX_HANDLES.append(handle)  # 进程不退出就一直持有
        return True
    except Exception:
        return True  # 拿不到互斥量时不拦着人用


def _request_show(data_dir: str) -> None:
    try:
        target = Path(data_dir)
        target.mkdir(parents=True, exist_ok=True)
        (target / "show.request").write_text(str(int(time.time() * 1000)), encoding="utf-8")
    except OSError:
        pass


def _write_pid_file(data_dir: str) -> None:
    """给 DSH 插件看：它用这个 pid 判断浮窗是不是已经起来了。"""
    try:
        target = Path(data_dir)
        target.mkdir(parents=True, exist_ok=True)
        (target / "app.pid").write_text(
            json.dumps({"pid": os.getpid(), "startedAt": int(time.time() * 1000)}),
            encoding="utf-8",
        )
    except OSError:
        pass


def _clear_pid_file(data_dir: str) -> None:
    try:
        path = Path(data_dir) / "app.pid"
        data = json.loads(path.read_text(encoding="utf-8"))
        if int(data.get("pid", 0)) == os.getpid():
            path.unlink()
    except (OSError, ValueError):
        pass


def main() -> int:
    cfg = load_config()
    # 抢不到互斥量 = 已经有一个浮窗在跑：请它出来，自己退场。
    if not _claim_single_instance():
        _request_show(cfg["data_dir"])
        return 0
    _write_pid_file(cfg["data_dir"])

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    window = VoiceWindow(cfg)

    tray = QSystemTrayIcon(make_icon(), app)
    tray.setToolTip("语音浮窗")
    menu = QMenu()
    act_show = QAction(f"唤起（{cfg['hotkey']}）", menu)
    act_show.triggered.connect(window.summon)
    act_wake = QAction("语音唤醒（说「小印」）", menu)
    act_wake.setCheckable(True)
    act_wake.setChecked(window.wake_enabled)

    def toggle_wake(checked: bool) -> None:
        window.wake_enabled = checked
        window.hub.enable_monitor(checked)
        window._set_status(window._idle_hint())

    act_wake.toggled.connect(toggle_wake)
    act_reset = QAction("回到右下角", menu)
    act_reset.triggered.connect(window.reset_position)
    act_quit = QAction("退出", menu)
    act_quit.triggered.connect(app.quit)
    menu.addAction(act_show)
    menu.addAction(act_wake)
    menu.addAction(act_reset)
    menu.addSeparator()
    menu.addAction(act_quit)
    tray.setContextMenu(menu)
    tray.activated.connect(lambda reason: window.summon() if reason == QSystemTrayIcon.Trigger else None)
    tray.show()

    hotkey = HotkeyThread(cfg["hotkey"])
    hotkey.start()

    def watch_hotkey() -> None:
        if hotkey.pressed.is_set():
            hotkey.pressed.clear()
            if window.isVisible() and window.hub.mode == "command":
                window.finish_listening()
            else:
                window.summon()

    hotkey_timer = QTimer()
    hotkey_timer.setInterval(40)
    hotkey_timer.timeout.connect(watch_hotkey)
    hotkey_timer.start()

    # 后来者（DSH 插件或双击 vbs）不会开出第二个窗口，只在这里留一个「唤起」请求。
    def watch_show_request() -> None:
        path = Path(cfg["data_dir"]) / "show.request"
        try:
            if not path.exists():
                return
            path.unlink()
        except OSError:
            return
        window.summon()

    show_timer = QTimer()
    show_timer.setInterval(400)
    show_timer.timeout.connect(watch_show_request)
    show_timer.start()

    app.aboutToQuit.connect(lambda: _clear_pid_file(cfg["data_dir"]))

    window._render()
    window._set_status(window._idle_hint())
    window.place()
    window.show()
    window.hub.start(monitor=window.wake_enabled)
    app.exec()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
