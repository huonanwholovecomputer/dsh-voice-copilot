# -*- coding: utf-8 -*-
"""本机私有配置的模板。复制成 `tools/local_config.py` 后按自己机器填。

`tools/local_config.py` 已被 .gitignore 挡住，**不会进仓库**：里面放的是
「换台机器就变、且不该公开」的东西——真实姓名、真实群名、本机路径。

    cp tools/local_config.example.py tools/local_config.py     # Windows: copy

不填也能跑：所有读它的地方都有兜底（`funnel.py` 忽略身份闸、
`order_labels.py` 等要求用命令行参数或环境变量显式给路径）。
"""
from __future__ import annotations

# ---------------------------------------------------------------- 身份

# 顾客怎么称呼店主（说出来是在叫店主，不是在指文件主人）。
# 保留通用称呼，把真实姓名加在后面即可。
OWNER_NAMES: frozenset[str] = frozenset({
    '学长', '哥', '兄弟', '哥们', '帅哥', '老师', '老板',
    # '真名', '真名简称',
})

# 只有本班成员才会在的群 → 可据以定班级（T1 证据）。
# 键 = 群里显示的完整群名；值 = (专业规范名, 班号)，不确定的位填 None。
# 专业规范名要与 identity.MAJOR_WORDS 的第二个字段一致（计科/电子/智能/…）。
CLASS_GROUPS: dict[str, tuple[str | None, str | None]] = {
    # '计科2401班级群': ('计科', '2401'),
}

# 全校混编 / 兴趣型群 → 明令禁止用来推专业（T3 证据，只在 evidence 里留痕）。
NEUTRAL_GROUPS: frozenset[str] = frozenset({
    # '数学建模1队', '某社团群',
})


# ---------------------------------------------------------------- 本机路径

# 微信文件台账（WeChatDataAnalysis 的 ledger.db）。
# 也可以改用环境变量 WECHAT_LEDGER，优先级更高。
LEDGER_DB = ''

# 打印机工具写日志的目录（每出一单一段），用于对齐出单与顾客原话。
# 也可以改用环境变量 PRINTER_LOG_DIR。
PRINTER_LOG_DIR = ''

# WeChatDataAnalysis 的 bridge 目录（里面有 ledger.py），只有 learn_loop.py --refresh 用。
# 也可以改用环境变量 WECHAT_BRIDGE_DIR。
WECHAT_BRIDGE_DIR = ''
