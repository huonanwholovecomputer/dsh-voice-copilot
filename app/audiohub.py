"""常驻麦克风：一路采集，两用——平时听唤醒词，需要时录一条命令。

只开一个 QAudioSource，所以从「听到唤醒词」到「开始录命令」之间不会因为
重新开麦丢掉开头半句；命令音频能往前多带几秒（检测耗时正好被这段补掉）。
"""
from __future__ import annotations

from collections import deque

import numpy as np
from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSource, QMediaDevices

SAMPLE_RATE = 16000
SPEECH_RMS = 0.012      # 判定「在说话」
MIN_SEGMENT_S = 0.25    # 太短的不送识别
MAX_SEGMENT_S = 6.0
SEGMENT_SILENCE_S = 0.5  # 唤醒词片段收尾静音
COMMAND_SILENCE_S = 1.0  # 命令录完的静音
COMMAND_MAX_S = 25.0
KEEP_SECONDS = 30.0      # 内存里最多留多少音频


class AudioHub(QObject):
    level = Signal(float)
    segment = Signal(object)        # monitor：一段语音（np.float32）
    wake = Signal(str)              # 流式唤醒词命中
    command_done = Signal(object)   # command：一条命令音频
    failed = Signal(str)
    mode_changed = Signal(str)      # idle | monitor | command

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._source: QAudioSource | None = None
        self._io = None
        self._all = bytearray()     # 最近 KEEP_SECONDS 秒的原始 PCM
        self._spotter = None
        self._fed = 0               # 已经喂给唤醒词的字节位置
        self._mode = "idle"
        self._speaking = False
        self._silence = 0.0
        self._speech = 0.0
        self._seg_start = 0         # 当前片段在 _all 里的起点
        self._cmd_start = 0
        self._cmd_elapsed = 0.0
        self._tick = QTimer(self)
        self._tick.setInterval(50)
        self._tick.timeout.connect(self._on_tick)

    # -- 生命周期 -----------------------------------------------------

    @property
    def mode(self) -> str:
        return self._mode

    def set_spotter(self, spotter) -> None:
        self._spotter = spotter
        self._fed = len(self._all)

    def start(self, monitor: bool = True) -> bool:
        if self._source is not None:
            if monitor and self._mode == "idle":
                self._set_mode("monitor")
            return True
        device = QMediaDevices.defaultAudioInput()
        if device.isNull():
            self.failed.emit("找不到麦克风")
            return False
        fmt = QAudioFormat()
        fmt.setSampleRate(SAMPLE_RATE)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        if not device.isFormatSupported(fmt):
            fmt = device.preferredFormat()
        try:
            self._source = QAudioSource(device, fmt)
            self._io = self._source.start()
            if self._io is None:
                raise RuntimeError("麦克风打不开")
            self._io.readyRead.connect(self._drain)
            self._tick.start()
            self._set_mode("monitor" if monitor else "idle")
            return True
        except Exception as exc:
            self.failed.emit(f"{type(exc).__name__}: {exc}")
            self._stop_source()
            return False

    def _stop_source(self) -> None:
        self._tick.stop()
        if self._io is not None:
            try:
                self._io.readyRead.disconnect(self._drain)
            except Exception:
                pass
        if self._source is not None:
            try:
                self._source.stop()
            except Exception:
                pass
        self._io = None
        self._source = None
        self._set_mode("idle")

    def _set_mode(self, mode: str) -> None:
        if mode == self._mode:
            return
        self._mode = mode
        self.mode_changed.emit(mode)

    # -- 模式切换 -----------------------------------------------------

    def enable_monitor(self, on: bool) -> None:
        if on and self._source is None:
            self.start(monitor=True)
        elif on:
            if self._mode != "command":
                self._set_mode("monitor")
        else:
            if self._mode == "monitor":
                self._set_mode("idle")

    def begin_command(self, pre_roll: float = 5.0) -> None:
        if self._source is None and not self.start(monitor=False):
            return
        seconds = len(self._all) / 2 / SAMPLE_RATE
        back = int(min(pre_roll, seconds) * SAMPLE_RATE) * 2
        self._cmd_start = max(0, len(self._all) - back)
        self._cmd_elapsed = 0.0
        self._speaking = True          # 命令模式下不用等音量判定，一直收
        self._silence = 0.0
        self._set_mode("command")

    def end_command(self) -> None:
        if self._mode != "command":
            return
        self._finish_command()

    def cancel_command(self) -> None:
        if self._mode == "command":
            self._set_mode("monitor")
            self._speaking = False
            self._fed = len(self._all)
            if self._spotter is not None:
                try:
                    self._spotter.reset()
                except Exception:
                    pass

    # -- 采集 ---------------------------------------------------------

    def _drain(self) -> None:
        if self._io is None:
            return
        chunk = self._io.readAll()
        if chunk:
            self._all.extend(bytes(chunk))
            limit = int(KEEP_SECONDS * SAMPLE_RATE) * 2
            if len(self._all) > limit * 2:
                drop = len(self._all) - limit
                drop -= drop % 2
                del self._all[:drop]
                self._seg_start = max(0, self._seg_start - drop)
                self._cmd_start = max(0, self._cmd_start - drop)
                self._fed = max(0, self._fed - drop)

    def _chunk_rms(self) -> float:
        tail = self._all[-int(SAMPLE_RATE * 0.05) * 2:]
        if len(tail) < 2:
            return 0.0
        arr = np.frombuffer(bytes(tail), dtype="<i2").astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(np.square(arr)))) if arr.size else 0.0

    def _on_tick(self) -> None:
        step = self._tick.interval() / 1000.0
        rms = self._chunk_rms()
        self.level.emit(rms)

        if self._mode == "monitor":
            self._feed_spotter()

        if self._mode == "command":
            self._cmd_elapsed += step
            if rms >= SPEECH_RMS:
                self._silence = 0.0
                self._speech += step
            else:
                self._silence += step
            if (self._silence >= COMMAND_SILENCE_S and self._speech >= 0.3) or self._cmd_elapsed >= COMMAND_MAX_S:
                self._finish_command()
            return

        if self._mode != "monitor":
            return

        if rms >= SPEECH_RMS:
            if not self._speaking:
                self._speaking = True
                back = int(0.35 * SAMPLE_RATE) * 2
                self._seg_start = max(0, len(self._all) - back)
                self._speech = 0.0
                self._silence = 0.0
            self._silence = 0.0
            self._speech += step
        elif self._speaking:
            self._silence += step
            if self._silence >= SEGMENT_SILENCE_S or self._speech >= MAX_SEGMENT_S:
                if self._speech >= MIN_SEGMENT_S:
                    self.segment.emit(self._slice(self._seg_start, len(self._all)))
                self._speaking = False
                self._speech = 0.0
                self._silence = 0.0

    def _feed_spotter(self) -> None:
        if self._spotter is None:
            return
        end = len(self._all) - (len(self._all) % 2)
        if end <= self._fed:
            return
        raw = bytes(self._all[self._fed:end])
        self._fed = end
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        try:
            hit = self._spotter.feed(samples)
        except Exception:
            return
        if hit:
            self.wake.emit(hit)

    def _slice(self, start: int, end: int) -> np.ndarray:
        raw = bytes(self._all[start:end])
        raw = raw[: len(raw) - (len(raw) % 2)]
        if not raw:
            return np.zeros(0, dtype=np.float32)
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    def _finish_command(self) -> None:
        samples = self._slice(self._cmd_start, len(self._all))
        self._set_mode("monitor")
        self._speaking = False
        self._fed = len(self._all)
        if self._spotter is not None:
            try:
                self._spotter.reset()
            except Exception:
                pass
        self.command_done.emit(samples)
