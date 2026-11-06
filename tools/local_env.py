# -*- coding: utf-8 -*-
"""把「本机路径从哪来」收敛成一处：环境变量 > tools/local_config.py > 没有。

`tools/local_config.py` 不进仓库（模板见 `local_config.example.py`），所以每个脚本
都必须能在**没有那份配置**的机器上跑起来：拿不到默认路径就返回 None，由调用方
提示用命令行参数或环境变量显式指定，而不是悄悄退到当前目录去读一堆文件。
"""
from __future__ import annotations

import os
from pathlib import Path

try:  # 本机私有配置；不存在是正常情况（新克隆的仓库、CI 都没有）
    import local_config as _local
except Exception:  # pragma: no cover - 只在本机配置缺失/写坏时触发
    _local = None


def path_from(env_name: str, attr: str) -> Path | None:
    """取一个本机路径：环境变量优先，其次 local_config 的同名常量，都没有则 None。

    env_name  e.g. 'WECHAT_LEDGER'
    attr      local_config 里的属性名，e.g. 'LEDGER_DB'
    """
    raw = (os.environ.get(env_name) or '').strip()
    if not raw:
        raw = str(getattr(_local, attr, '') or '').strip()
    if not raw:
        return None
    return Path(raw)


def describe_missing(env_name: str, attr: str) -> str:
    """拿不到路径时给用户的一句提示。"""
    return (f'没配置本机路径：请设环境变量 {env_name}，'
            f'或在 tools/local_config.py 里填 {attr}'
            f'（模板见 tools/local_config.example.py）')
