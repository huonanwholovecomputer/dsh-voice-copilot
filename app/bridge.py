r"""与 DSH Host 插件的文件队列桥。

约定（与仓库根目录的 index.js 保持一致）：
  queue/<id>.json  ->  {kind: text|voice|cancel|ping, ...}
  events/*.json    <-  {type: ready|pong|transcript|prompt|reply-start|assistant-message|done|turn-end|error, ...}

不监听端口、不碰 DSH 的 HTTP 鉴权，双方只靠这一个目录说话。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Bridge:
    data_dir: Path
    _seen: set[str] = field(default_factory=set)
    _queue_mark: dict[str, float] = field(default_factory=dict)

    @property
    def queue_dir(self) -> Path:
        return self.data_dir / "queue"

    @property
    def events_dir(self) -> Path:
        return self.data_dir / "events"

    def ensure(self) -> None:
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        self.events_dir.mkdir(parents=True, exist_ok=True)

    # -- 发 ---------------------------------------------------------------

    def _enqueue(self, payload: dict) -> str:
        self.ensure()
        item_id = payload.get("id") or uuid.uuid4().hex[:12]
        payload["id"] = item_id
        target = self.queue_dir / f"{item_id}.json"
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
        return item_id

    def submit_text(self, text: str) -> str:
        return self._enqueue({"kind": "text", "text": text, "at": time.time()})

    def submit_voice(self, wav: str, language: str = "zh") -> str:
        return self._enqueue({"kind": "voice", "wav": wav, "language": language, "at": time.time()})

    def cancel(self) -> str:
        return self._enqueue({"kind": "cancel"})

    def ping(self) -> str:
        return self._enqueue({"kind": "ping"})

    def sync(self) -> str:
        """让插件把最近的对话再铺一遍（浮窗开晚了也不会空着）。"""
        return self._enqueue({"kind": "ping", "history": True})

    # -- 收 ---------------------------------------------------------------

    def skip_history(self) -> None:
        """启动时把已经存在的事件当成读过的，免得旧对话被重放一遍。"""
        if self.events_dir.is_dir():
            self._seen = {n for n in os.listdir(self.events_dir) if n.endswith(".json")}

    def poll(self) -> list[dict]:
        """返回上次调用之后新产生的事件（顺序按文件名，即时间序）。"""
        if not self.events_dir.is_dir():
            return []
        names = sorted(n for n in os.listdir(self.events_dir) if n.endswith(".json"))
        fresh: list[dict] = []
        for name in names:
            if name in self._seen:
                continue
            self._seen.add(name)
            try:
                fresh.append(json.loads((self.events_dir / name).read_text(encoding="utf-8")))
            except Exception:
                continue
        if len(self._seen) > 4000:  # 别让内存无限长
            self._seen = set(names[-1000:])
        return fresh

    def wait_for(self, kind: str, timeout: float = 3.0) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for event in self.poll():
                if event.get("type") == kind:
                    return event
            time.sleep(0.05)
        return None
