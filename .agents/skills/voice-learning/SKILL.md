---
name: voice-learning
description: 复盘小印（语音助手）的 learning/ 记录，把实际工作里的卡点转成提示词或工具的改进。当用户提到「看看小印最近表现」「复盘」「失败率高」「它老是绕远」「学习记录」「learning/」，或者在改 presets/* 的人设、改 voice-copilot 的工具后要验证效果时使用。
whenToUse: 需要读 learning/turns、learning/notes 做量化复盘，或据此改 persona/工具时。
---

# 小印学习复盘闭环

`learning/` 是小印每轮工作的原始账本（思考、工具调用、返回、回复），字段定义见
`docs/learning.md`。这个技能只做一件事：**把账本变成一次有对照的改动**。

## 1. 先量化，别先猜

```powershell
python tools/learning_report.py --days 14
python tools/learning_report.py --days 14 --json > .tmp-report.json   # 要算别的再看 JSON
```

读懂四个数就够了：

- **工具失败率**（`toolTable`）：同一个工具 ≥25% 失败且调用 ≥5 次，先看 `learning/turns/*.jsonl`
  里它的 `error` 原文，判断是参数约定问题、权限问题，还是工具本身坏了。
- **重试后仍失败**（`retryFailures`）：同一工具连续调用、后一次失败，通常意味着模型不知道
  失败了该怎么办——错误文案里没写「下一步」，或提示词没给分支。
- **p95 耗时**：某个工具 p95 ≥20s，优先考虑超时/后台 job/减少一次调用的工作量。
- **思考长度 vs 回复长度**：思考很长但回复很短，多半是系统提示里塞了太多流程，该把它挪进工具或脚本。

细节要落到具体轮次：在 `learning/turns/<日期>.jsonl` 里用 `turn` + `startedAt` 找到那一轮，
读 `thinking` 和 `tools[*].args/result`——这是你判断「它当时到底看到了什么」的唯一依据。

## 2. 定位到「改哪里」

| 观察到的症状 | 改哪里 |
| --- | --- |
| 工具参数反复错、名字叫错 | 工具定义（`learning.js` 的 `noteTool()` 同理）的 `description`/`parameters`；错误文案补「下一步」 |
| 工具对但调用多、顺序乱 | presets 里 persona 的判定顺序与「先查再动」约束（`presets/*/cordis.patch.yml`） |
| 用户反复纠正同一件事 | persona「用户偏好」段；或加一条 `voice_note(kind: preference)` 让它在现场记下来 |
| 半轮中断多 | 语音端 `silenceSeconds` / `maxSeconds` / 宿主超时，不是模型问题 |
| 固定流程每次手搓 | 写成一个工具或脚本，persona 里直接说「用 X」 |

## 3. 改动要可对照

- 只改一处，改完重启 DSH（插件代码/配置生效需要重启）。
- 跑同样多的轮次后，用同一个 `--days` 再出报告，比 `failureRate`、`retryFailures`、p95，
  以及 `sessions/<id>.json` 里累计的 `toolFailures`。
- 结论写回 `docs/learning.md` 或提交信息里：「因为 X 数据，改了 Y，观察 Z」。

## 4. 规矩

- `learning/` 只读不改；要清旧数据就按天删文件，别改字段（`tools/learning_report.py` 依赖字段名）。
- 记录里是真实用户原话（已基础脱敏）。往提交、issue、分享材料里放样本前，先人工挑并再检查一遍姓名/地址/业务内容。
- 不要把 `learning/` 提交进 git（`.gitignore` 已挡）；它属于本机运行数据。
