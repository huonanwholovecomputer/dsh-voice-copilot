# xiaoyin-persona · 小印这个人

[voice-assistant/](../voice-assistant/README.md) 是壳，这里装的是「谁在说话」：智能体包（称呼、人设、会话预设/目录、侧栏页）、agent preset、复盘记录，以及围着本地打印业务转的脚本。

本机的小印是本地打印项目（打印机接单 + 微信台账）的附属入口：接单、出纸、记台账是主线，小印只把「这份文件是谁发的、这个群该不该查」搬进语音。台账 `ledger.db` 与打印机日志都是打印项目那边的产物，这里一律**只读不写**。主线仓库在 <https://github.com/huonanwholovecomputer/h_n-printer>。

## 目录

| 目录 | 是什么 |
| --- | --- |
| `agents/xiaoyin/` | 小印的智能体包：`agent.json` + 侧栏页 + 台账分组/白名单逻辑 |
| `presets/` | agent preset：`example-assistant/`（可公开的最小示例）、`private-print-assistant/`（本机私有，已 gitignore） |
| `learning/` | 真实对话记录（`turns/` 每轮一行、`sessions/` 每段一份、`notes/` 小印自记），不进仓库 |
| `tools/` | 业务脚本：台账检索、样本与评测、学习闭环、微信/键盘发送、身份判定 |
| `docs/` | 复盘与业务口径（见文末索引） |

## `agents/xiaoyin/`

`agent.json` 是清单：`id` / `name` / `persona` / `session`（`cwd`、`agentPreset`）/ `settings`（`ledgerDb`、`kbmonDir`）/ `sidebar.module` / `tools`。本机 `session.cwd` 与 `agentPreset` 指向 `presets/private-print-assistant`；`settings` 里的 `ledgerDb` / `kbmonDir` 这类本机路径**不写进仓库**，留空，由插件配置里同名两项（或环境变量 `DSH_VOICE_COPILOT_LEDGER_DB` / `DSH_VOICE_COPILOT_KBmon_DIR`）注入。

- `sidebar.js`：侧栏「小印」页（群白名单、台账分组），由 `client.js` 在浏览器半侧挂载。
- `lib/whitelist-policy.js`：白名单口径（按订单来源算 `chats.excluded`）。
- `lib/ledger-groups.js`：台账会话分组。
- `voice-notes.md`：给小印看的现场笔记（已发生过的坑、口径）。

加载器在 `voice-assistant/agent.js`：默认读 `<仓库>/xiaoyin-persona/agents/<id>/agent.json`；插件配置里显式填的 `agentPreset` / `cwd` 优先（过渡期，P1 会全部迁进包）。

## `presets/`

agent preset 不是插件：一条 `- insert:` 声明 + `@deepseek-ai/dsh-agent-preset` 的 `config`，里面挂人设（`@deepseek-ai/dsh-persona`）、工具与按需的 MCP 行。

- **`example-assistant/`**：可公开的骨架（`@local/dsh-preset-example`）。装好之后把插件页「语音会话预设」填 `example-assistant`，语音会话就跑在这个模式里。改 id / 人设 / `plugins` 行就是自己的会话模式。
- **`private-print-assistant/`**：本机私有（`@local/dsh-private-print-assistant`，gitignore）。persona 里写死了「你的家在 `<preset 目录绝对路径>`」、`EXPERIENCE.md` 路径与全部 `mcp__wechat-print-bridge__*` 工具；`EXPERIENCE.md` 是长期积累的业务经验（检索漏斗、身份判定、排错），`tests/acceptance.md` 是验收清单。

安装（两个都一样）：

```text
plugin_manager install_bundle(target: <preset 目录绝对路径>)
```

然后**完全退出**桌面端再开。生效范围：只影响安装之后**新建**、且在会话里**显式选择**该 preset 的会话；已有会话与其他预设不受影响。

搬动目录后要改三处：preset 自己 `cordis.patch.yml` 里的绝对路径、profile 的 `package.json` 里 `link:<仓库>/xiaoyin-persona/presets/private-print-assistant`、以及 profile `node_modules/@local/...` 的 junction 重建。

## `learning/`

- `turns/YYYY-MM-DD.jsonl`：每轮一行（思考、工具调用与返回、回复、耗时、失败标记），由 `voice-assistant/learning.js` 落盘，按 `seq` 去重，插件卸载时把半轮标 `interrupted: true`。
- `sessions/<id>.json`：每段会话的元信息。
- `notes/YYYY-MM-DD.jsonl`：小印用 `voice_note` 自己记的卡点。

出摘要：

```bash
python xiaoyin-persona/tools/learning_report.py --days 14
```

工具失败率、重试、耗时 p50/p95、思考长度、最慢轮次、自记问题、可动手建议——照着改 persona 或工具，再用同一批数据对比。字段与脱敏规则见 [../voice-assistant/docs/learning.md](../voice-assistant/docs/learning.md)，闭环是技能 `.agents/skills/voice-learning/SKILL.md`。

真实姓名、真实群名、本机路径都走 `tools/local_config.py`（gitignore），`learning/` 整个不进仓库。

## `tools/`

| 脚本 | 干什么 |
| --- | --- |
| `funnel.py` | 检索层本体（已接进打印项目的 MCP）：Step 0 分流 + 整串→拆词→加权 + `apply_scope()` 身份闸 |
| `identity.py` | 身份判定（专业/班级/学号），`resolve_person()` / `file_scope()` / `check_scope()` |
| `order_labels.py` | 从打印机日志 ⨯ 台账自动对齐出评测样本 |
| `eval_funnel.py` | 端到端评测：`--topk 3` 出 top1/top3/整批召回 |
| `learn_loop.py` | 一键闭环 + 基线留存（`--refresh` / `--rebuild-samples` / `--history`），写 `learn_state.json` |
| `learn_vocab.py` | 从真实订单里学新词（`--source orders`） |
| `learning_report.py` | 复盘摘要（读 `learning/`） |
| `wechat_send.py` / `kbd_send.py` / `human_type.py` | 发微信、模拟键盘、拟人输入 |
| `whitelist-strategy.mjs` | 白名单口径演算 |
| `order-samples.jsonl` | 救回来的评测样本（84 条真实出单） |

打印项目的 bridge 通过 `<台账项目>/bridge/config.py` 的 `funnel_tools_dir` 找到这个目录；搬动后要改那一行并重启 MCP 进程。

`local_config.example.py` 是模板，`local_config.py` 放真实路径，两者都在 gitignore/示例的位置上——新机器先复制再填。

## docs

| 文档 | 讲什么 |
| --- | --- |
| [docs/小印复盘_2026-11-10.md](docs/小印复盘_2026-11-10.md) | 10 次工具失败 → 提示词与工具改动 |
| [docs/小印复盘_2026-11-11.md](docs/小印复盘_2026-11-11.md)、[docs/小印复盘_2026-11-16.md](docs/小印复盘_2026-11-16.md) | 同口径后续复盘 |
| [docs/小印生活域扩展_2026-11-11.md](docs/小印生活域扩展_2026-11-11.md) | 把打印助手扩成「打印主业 + 生活杂事」，preset id 仍叫 `private-print-assistant` |
| [docs/白名单策略.md](docs/白名单策略.md) | 按订单来源算 `chats.excluded` 的口径 |
| [docs/订单文件来源_2026-10-28至11-06.md](docs/订单文件来源_2026-10-28至11-06.md) | 一批真实订单文件的统计（本机数据，gitignore） |
