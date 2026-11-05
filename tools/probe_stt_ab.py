"""两个识别引擎 A/B：同一批 wav，谁认得准、谁更快。

用法：
    python tools/probe_stt_ab.py                    # 模型自带测试音
    python tools/probe_stt_ab.py a.wav b.wav        # 自己的录音（16k 单声道 wav）
"""

from __future__ import annotations

import sys
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import stt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WAV_DIR = ROOT / "models" / "fire-red-asr2-int8" / "test_wavs"


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def main_() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if len(sys.argv) > 1:
        wavs = [Path(p) for p in sys.argv[1:]]
    else:
        wavs = sorted(WAV_DIR.glob("*.wav"))
    if not wavs:
        print(f"没有可测的 wav：{WAV_DIR}")
        return 1

    engines = []
    for name, obj in (
        ("sensevoice", stt.Recognizer()),
        ("firered", stt.FireRedRecognizer()),
        ("firered-ctc", stt.FireRedCtcRecognizer()),
    ):
        started = time.time()
        obj.load()
        cost = time.time() - started
        if obj.ready:
            engines.append((name, obj))
            print(f"[load] {name} ok in {cost:.2f}s")
        else:
            print(f"[load] {name} 失败：{obj.load_error}")

    if not engines:
        return 1

    for wav in wavs:
        audio, rate = read_wav(wav)
        seconds = len(audio) / rate
        print(f"\n== {wav.name}  {seconds:.2f}s  {rate}Hz")
        for name, engine in engines:
            started = time.time()
            try:
                text = engine.transcribe(audio, rate)
            except Exception as exc:
                print(f"  {name:10s} 出错：{type(exc).__name__}: {exc}")
                continue
            cost = time.time() - started
            rtf = cost / seconds if seconds else 0.0
            print(f"  {name:10s} {cost:5.2f}s (rtf {rtf:.2f})  {text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main_())
