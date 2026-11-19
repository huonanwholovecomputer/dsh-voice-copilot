# 架构：语音壳 + 可打包的智能体

这份文档回答一个问题：**什么东西属于「语音助手」，什么东西属于「某个具体的智能体」**。
P0（本次）已经把这条缝切出来了；P1/P2/P3 的计划也写在这里，免得实现时又长回去。

## 三层

```
┌─ L1 语音壳（voice-assistant/）─────────────────────────┐
│ 唤醒词 / 录音 / STT / 队列 / 热键 / 租约 / 浮窗          │
│ 会话：新建、挂工作区、跟随回复、轮转（P2）              │
│ 只认 agent.js 吐出来的形状，不认识任何业务名词           │
└───────────────┬─────────────────────────────────────────┘
                │  agent.json（绑一个包）
┌───────────────▼─ L2 智能体包（xiaoyin-persona/agents/<id>/）────────────┐
│ agent.json  清单：人设来源、会话预设/目录、业务配置、侧栏 │
│ persona.md  或  persona.kind=preset（指向一个 DSH preset）│
│ voice-notes.md  语音场景的具体示例（人名/单号/标签页）    │
│ sidebar.js  这个智能体自己的宿主路由（可选）              │
│ tools/      工具实现（P1：只允许 MCP 子进程）             │
│ memory/     记忆快照（P1：导入时并入该智能体的独立空间）  │
└───────────────┬─────────────────────────────────────────┘
                │  「编译」，不 fork DSH
┌───────────────▼─ L3 DSH 运行时 ─────────────────────────┐
│ agentPresets.register / tools.register / mnemon 记忆空间 │
└──────────────────────────────────────────────────────────┘
```

**不引入新运行时**是硬约束：包最终变成 DSH 已有的东西（preset + 工具注册 + 记忆空间），
这样 DSH 升级、设置页、侧栏、KV 前缀缓存机制全部继续有效。

## P0 已经落地的东西

| 文件 | 作用 |
| --- | --- |
| `agent.js` | 包加载器。纯 I/O + 校验，不依赖 DSH，可单测；`normalizeAgent()` 同时给 P1 的导入校验复用 |
| `xiaoyin-persona/agents/xiaoyin/agent.json` | 小印的清单：称呼、`session.agentPreset`/`cwd`、`ledgerDb`、侧栏模块 |
| `xiaoyin-persona/agents/xiaoyin/voice-notes.md` | 「怎么说话」里那条带人名/单号的例子——壳里不再出现具体人名，示例统一用化名 |
| `xiaoyin-persona/agents/xiaoyin/sidebar.js` | 台账白名单 5 条宿主路由，壳只负责 import 并递 web 上下文 |
| `xiaoyin-persona/agents/xiaoyin/lib/ledger-groups.js`、`lib/whitelist-policy.js` | 原来在仓库根目录，现在跟着包走 |

优先级（P0 过渡期）：**插件配置里显式填的值 > agent.json > 内置兜底**。
本机现有 `cordis.patch.yml` 一个字没改，所以行为完全不变；P1 把设置面板迁进包里之后，
`prompt / agentPreset / cwd / ledgerDb / printerLogDir` 这几个旧字段就可以删了。

壳里**只剩**输出通道的规则（短、口语、不念 Markdown、不报工具名），因为那是「语音」而不是「业务」。

## P1：打包与导入（`.dshagent`）

包里放的是一份目录，分发时压成 `.dshagent`（zip + 校验和）。`agent.json` 会长成：

```json
{
  "schemaVersion": 1,
  "id": "xiaoyin",
  "name": "小印",
  "version": "0.1.0",
  "persona": { "kind": "markdown", "file": "persona.md" },
  "session": { "agentPreset": "private-print-assistant", "cwd": "${HOME}" },
  "tools": [
    { "kind": "mcp-stdio", "name": "wechat-print",
      "command": "python", "args": ["tools/mcp_server.py"],
      "env": { "WXCHAT_API_BASE": "$ask:打印服务地址" },
      "requires": ["python>=3.12"] }
  ],
  "memory": { "mode": "snapshot", "files": ["memory/seed.md"] },
  "permissions": { "fs": ["${DSH_HOME}"], "network": true }
}
```

已经拍板的三个决定：

1. **第三方包的 tools 只允许 MCP 子进程**（独立进程、权限可列、跨语言）。
   进程内 JS 工具只留给「本地自己写的」包，因为它等于在宿主进程里执行。
2. **记忆用包内快照**（`mode: "snapshot"`），导入时并入该智能体的独立记忆空间，
   不写进全局记忆，也不覆盖本机已有记忆。
3. **路径用占位符**（`${HOME}` / `${DSH_HOME}`），密钥只写 `$ask:` 引用名，
   导入时在预检页让人填，绝不写进包。

导出走现成零件：`agentPresets.readDocument()` 反编译 preset、`compositionInventory()`
找工具来源、资产按清单收集。导入先跑预检（缺 python 包 / 缺目录 / 缺密钥逐条列），
人确认后才落盘到 `~/.dsh/voice-agents/<id>/` 并激活。

没做：包的签名与版本升级、Agent 侧栏页随包分发（现在 `client.js` 里还留着
`GroupManagerPage`，P1 一起搬）。

## P2：会话轮转（防单会话过长）

现在是「用户说一句『开个新话题』」才换段（`voice_new_session` → `pendingFresh`）。
目标换成策略 `session-policy.js`，三条触发任一命中：

| 触发 | 判据 |
| --- | --- |
| 上下文压力 | `tokenMeter.contextPressure(session)` 超过阈值（初值 65%） |
| 时长 | 单会话超过 6 小时 |
| 空闲 | 距上一条超过 30 分钟 |

轮转前生成「交接摘要」（5–8 条要点：谁、在办什么、未完成的），存
`xiaoyin-persona/agents/<id>/state/handoff.md`，新会话第一句前作为 developer message 注入；
旧会话按「首句主题 + 日期」改名，而不是现在的「语音浮窗 · 截至 11-05 22:30」。

## P3：语音服务常驻化

现在唤醒词监听跑在 Electron 窗口进程里：关掉浮窗就没有监听，这与「随 DSH 启动、
后台监听」不完全一致。目标是语音服务独立进程（托盘常驻、无窗口可跑），
浮窗退化成可选的显示器；顺带把 0.7–0.8 GB 的 Electron 五进程压下去。

## 验收

- `npm test`：`agent.js` 的加载/校验/回退、小印包的字段、侧栏 5 条路由路径不变。
- 手工：重启 DSH 后小印仍能被叫醒、仍能查台账白名单页——即「行为不变」。
