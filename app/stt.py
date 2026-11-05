"""本地语音识别：SenseVoice（默认）或 FireRedASR2-AED，都走 sherpa-onnx，不联网。

两个引擎对上层暴露同一套：`load()` / `ready` / `load_error` / `transcribe(samples, sample_rate)`。
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np

# 默认模型放在常见位置（%APPDATA%/WeQ 的模型目录、仓库自己的 models/），
# 找不到就在 config.json 里用 model / tokens / firered_* 显式指定。
_MODELS_ROOT = Path(__file__).resolve().parent.parent / "models"
_APP_MODELS = Path(os.environ.get("APPDATA") or Path.home()) / "WeQ" / "models" / "sensevoice"

DEFAULT_MODEL = str(_APP_MODELS / "model.int8.onnx")
DEFAULT_TOKENS = str(_APP_MODELS / "tokens.txt")
DEFAULT_FIRERED_DIR = str(_MODELS_ROOT / "fire-red-asr2-int8")
DEFAULT_FIRERED_CTC_DIR = str(_MODELS_ROOT / "fire-red-asr2-ctc-int8")


def _resample(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sample_rate != 16000:  # 两个模型都要 16k，简单线性重采样够用
        ratio = 16000 / float(sample_rate)
        idx = np.arange(int(len(audio) * ratio)) / ratio
        audio = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    return audio


class Recognizer:
    """SenseVoice：228 MB，纯 CPU 也能跑，带标点。"""

    name = "sensevoice"

    def __init__(self, model: str = DEFAULT_MODEL, tokens: str = DEFAULT_TOKENS,
                 language: str = "zh", threads: int = 4) -> None:
        self.model = model
        self.tokens = tokens
        self.language = language
        self.threads = threads
        self._rec = None
        self._lock = threading.Lock()
        self.load_error: str | None = None

    def load(self) -> None:
        try:
            import sherpa_onnx

            self._rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=self.model,
                tokens=self.tokens,
                num_threads=self.threads,
                use_itn=True,
                language=self.language,
                debug=False,
            )
        except Exception as exc:  # 模型缺失/onnx 运行时问题都收在这里
            self.load_error = f"{type(exc).__name__}: {exc}"

    @property
    def ready(self) -> bool:
        return self._rec is not None

    def transcribe(self, samples: np.ndarray, sample_rate: int = 16000) -> str:
        if self._rec is None:
            raise RuntimeError(self.load_error or "识别模型还没加载好")
        audio = _resample(samples, sample_rate)
        with self._lock:
            stream = self._rec.create_stream()
            stream.accept_waveform(16000, audio)
            self._rec.decode_stream(stream)
            text = stream.result.text or ""
        return text.strip()


class FireRedRecognizer(Recognizer):
    """FireRedASR2-AED（1B+，int8 ONNX）：普通话更准，不带标点，单段上限 60 秒。"""

    name = "firered"

    def __init__(self, model_dir: str = DEFAULT_FIRERED_DIR, threads: int = 4,
                 provider: str = "cpu") -> None:
        self.model_dir = Path(model_dir)
        self.threads = threads
        self.provider = provider
        self._rec = None
        self._lock = threading.Lock()
        self.load_error: str | None = None

    @property
    def encoder(self) -> Path:
        return self.model_dir / "encoder.int8.onnx"

    @property
    def decoder(self) -> Path:
        return self.model_dir / "decoder.int8.onnx"

    @property
    def tokens(self) -> Path:
        return self.model_dir / "tokens.txt"

    def load(self) -> None:
        try:
            import sherpa_onnx

            self._rec = sherpa_onnx.OfflineRecognizer.from_fire_red_asr(
                encoder=str(self.encoder),
                decoder=str(self.decoder),
                tokens=str(self.tokens),
                num_threads=self.threads,
                decoding_method="greedy_search",
                provider=self.provider,
                debug=False,
            )
        except Exception as exc:
            self.load_error = f"{type(exc).__name__}: {exc}"


class FireRedCtcRecognizer(Recognizer):
    """FireRedASR2-CTC（int8 ONNX）：单趟前向，CPU 上比 AED 快一个量级，不带标点。"""

    name = "firered-ctc"

    def __init__(self, model_dir: str = DEFAULT_FIRERED_CTC_DIR, threads: int = 4,
                 provider: str = "cpu") -> None:
        self.model_dir = Path(model_dir)
        self.threads = threads
        self.provider = provider
        self._rec = None
        self._lock = threading.Lock()
        self.load_error: str | None = None

    @property
    def model(self) -> Path:
        return self.model_dir / "model.int8.onnx"

    @property
    def tokens(self) -> Path:
        return self.model_dir / "tokens.txt"

    def load(self) -> None:
        try:
            import sherpa_onnx

            self._rec = sherpa_onnx.OfflineRecognizer.from_fire_red_asr_ctc(
                model=str(self.model),
                tokens=str(self.tokens),
                num_threads=self.threads,
                decoding_method="greedy_search",
                provider=self.provider,
                debug=False,
            )
        except Exception as exc:
            self.load_error = f"{type(exc).__name__}: {exc}"


def build(cfg: dict) -> Recognizer:
    """按 config 里的 stt_engine 选一个识别器（不在这里加载模型）。"""
    engine = (cfg.get("stt_engine") or "sensevoice").lower()
    threads = int(cfg.get("stt_threads") or 4)
    if engine in ("firered", "firered-aed"):
        return FireRedRecognizer(
            model_dir=cfg.get("firered_model_dir") or DEFAULT_FIRERED_DIR,
            threads=threads,
            provider=cfg.get("stt_provider") or "cpu",
        )
    if engine in ("firered-ctc", "firered_ctc", "ctc"):
        return FireRedCtcRecognizer(
            model_dir=cfg.get("firered_ctc_model_dir") or DEFAULT_FIRERED_CTC_DIR,
            threads=threads,
            provider=cfg.get("stt_provider") or "cpu",
        )
    return Recognizer(
        model=cfg.get("model") or DEFAULT_MODEL,
        tokens=cfg.get("tokens") or DEFAULT_TOKENS,
        language=cfg.get("language") or "zh",
        threads=threads,
    )
