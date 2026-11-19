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


def _millis(name: str) -> str:
    """事件名前 14 位是零填充的毫秒时间戳（index.js 那边 padStart(14, '0')），字典序＝时间序。"""
    return name[:14]


@dataclass
class Bridge:
    data_dir: Path
    _seen: set[str] = field(default_factory=set)
    _queue_mark: dict[str, float] = field(default_factory=dict)
    # 已经消费到哪一毫秒。只增不减：以前这里靠「最多记住 4000 个名字」去重，超了就把更老的
    # 名字忘掉，下一轮又当新事件重放一遍——历史被反复重建、列表疯狂滚动就是这么来的。
    _watermark: str = ""

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

    def _event_names(self) -> list[str]:
        if not self.events_dir.is_dir():
            return []
        return sorted(n for n in os.listdir(self.events_dir) if n.endswith(".json"))

    def skip_history(self) -> None:
        """启动时把已经存在的事件当成读过的，免得旧对话被重放一遍。

        只「记成读过」不够：这些文件谁都不删，攒到几千个之后，任何「只记住最近 N 个名字」的
        剪枝都会把更老的名字忘掉，下一轮又当新事件重放一遍。所以启动时直接把旧事件清掉。
        """
        names = self._event_names()
        if names:
            self._watermark = _millis(names[-1])
        self.prune_consumed()

    def prune_consumed(self) -> int:
        """删掉水位线及以前的旧事件（已经消费过，或启动时按设计跳过的）。返回删了几个。"""
        if not self._watermark:
            return 0
        removed = 0
        for name in self._event_names():
            if _millis(name) > self._watermark:
                continue
            try:
                (self.events_dir / name).unlink()
                removed += 1
            except OSError:
                pass
        return removed

    def poll(self) -> list[dict]:
        """返回上次调用之后新产生的事件（顺序按文件名，即时间序），读过的顺手删掉。"""
        fresh: list[dict] = []
        for name in self._event_names():
            ms = _millis(name)
            target = self.events_dir / name
            if self._watermark and ms < self._watermark:
                # 水位线以下：老事件，或上一轮读过却没删掉的。只补删，不再往外吐。
                try:
                    target.unlink()
                except OSError:
                    pass
                continue
            if name in self._seen:
                try:
                    target.unlink()
                except OSError:
                    pass
                continue
            if ms > self._watermark:
                self._watermark = ms
                self._seen.clear()
            self._seen.add(name)
            try:
                fresh.append(json.loads(target.read_text(encoding="utf-8")))
            except Exception:
                pass
            try:
                target.unlink()
                self._seen.discard(name)
            except OSError:
                pass
        return fresh

    def wait_for(self, kind: str, timeout: float = 3.0) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for event in self.poll():
                if event.get("type") == kind:
                    return event
            time.sleep(0.05)
        return None
