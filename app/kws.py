"""流式唤醒词：sherpa-onnx 的 KeywordSpotter（3.3M zipformer，拼音建模）。

跟「先断句再拿 ASR 结果找词」相比，这个是边听边判：说完「小印」当场就能命中，
不用等半秒静音，也不会因为半句话识别成别的字而漏掉。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
KEYWORDS_FILE = Path(__file__).resolve().parent.parent / "models" / "keywords.txt"
SAMPLE_RATE = 16000


def default_keywords() -> str:
    """唤醒词的拼音写法（带声调），一行一个，「@」后面是显示用的词。"""
    return "\n".join(
        [
            "x iǎo y ìn @小印",
            "h ēi x iǎo y ìn @嘿小印",
            "x iǎo y ìn x iǎo y ìn @小印小印",
        ]
    )


def ensure_keywords(path: Path = KEYWORDS_FILE) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(default_keywords() + "\n", encoding="utf-8")
    return path


class Spotter:
    """一次 feed 一小段 16k 单声道 float32，命中就返回关键词。

    threads 保持 1：3.3M 的模型单线程就够快，多线程反而因为每次只喂 50 ms
    而多付线程同步的钱（实测常驻 CPU 从 5% 涨到 33%）。
    """

    def __init__(
        self,
        model_dir: Path = MODEL_DIR,
        keywords_file: Path | None = None,
        threads: int = 1,
        score: float = 1.5,
        threshold: float = 0.25,
    ) -> None:
        import sherpa_onnx

        model_dir = Path(model_dir)
        prefix = model_dir / "encoder-epoch-12-avg-2-chunk-16-left-64"

        self._kws = sherpa_onnx.KeywordSpotter(
            tokens=str(model_dir / "tokens.txt"),
            encoder=str(prefix.with_name(prefix.name + ".int8.onnx")),
            decoder=str(prefix.with_name(prefix.name.replace("encoder", "decoder") + ".int8.onnx")),
            joiner=str(prefix.with_name(prefix.name.replace("encoder", "joiner") + ".int8.onnx")),
            keywords_file=str(ensure_keywords(keywords_file or KEYWORDS_FILE)),
            num_threads=threads,
            sample_rate=SAMPLE_RATE,
            keywords_score=score,
            keywords_threshold=threshold,
            num_trailing_blanks=2,
        )
        self._stream = self._kws.create_stream()

    def feed(self, samples: np.ndarray) -> str | None:
        if samples.size == 0:
            return None
        self._stream.accept_waveform(SAMPLE_RATE, samples)
        while self._kws.is_ready(self._stream):
            self._kws.decode_stream(self._stream)
        result = self._kws.get_result(self._stream)
        if result:
            self._kws.reset_stream(self._stream)
            return str(result).lstrip("@").strip()
        return None

    def reset(self) -> None:
        self._kws.reset_stream(self._stream)
