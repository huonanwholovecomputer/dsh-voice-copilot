# voice-assistant · DSH 语音助手插件本体

bundle 名 `@local/dsh-voice-copilot`，DSH profile 里以 `link:` 指向仓库根安装，所以这个目录里改代码，重启桌面端就生效。

它是「语音壳」：负责把浮窗送来的文字变成会话里的一句话，再把回答送回去；不负责听（那是 [tray-app/](../tray-app/README.md) 的事），也不负责人设（那是 [xiaoyin-persona/](../xiaoyin-persona/README.md) 的事）。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边。轮询 `queue/`，把任务送进固定会话，写事件文件；注册 `voice_*` 工具与 `/__dsh-voice-copilot/*` 回环路由；管租约、自启、配置 schema |
| `client.js` | 浏览器半边。插件配置页、「小印」侧栏页（群白名单）、「回到会话」时真的切会话 |
| `agent.js` | 智能体包加载器：默认读 `<仓库>/xiaoyin-persona/agents/<id>/agent.json`，有插件配置覆盖时以配置为准 |
| `autostart.js` | 拉起/停止浮窗（找 Electron、清 `ELECTRON_RUN_AS_NODE`、写 `app.pid`、`autoStart` 开关） |
| `lease.js` | 两个 DSH 安装争「谁持有小印」时的租约（`lease.lock` 原子创建、5 s 心跳、20 s 过期） |
| `learning.js` | 学习记录落盘（`learning/turns/YYYY-MM-DD.jsonl`），按 `seq` 去重，卸载时把半轮标 `interrupted` |
| `courses.js` | `voice_courses`：调本机 `kbmon` 查课表，日期/时段解析在 JS 侧 |
| `name-resolver.js` / `pinyin-match.js` | `voice_who`：把听错的汉字按拼音定位到人 |
| `locale/{en,zh}.json`、`icon.svg` | 插件页文案与图标 |
| `test/` | `node --test` 用的 9 个 `.mjs` |
| `tools/` | 语音调试脚本（`probe_*.py`、`_snap*.py`、`who_bench.mjs`），不属于运行时 |

## 一次语音请求怎么走

1. 浮窗把 `{"kind":"voice","wav":"…\\audio\\<ts>.wav","text":"昨天是monday。","language":"zh"}` 写进 `<dataDir>/queue/`。
2. `index.js` 看到有 `text` 就直接用（本机 `speechToText` 服务是空的，不碰它），否则才走宿主的转写。
3. 会话由 `agentPreset` + `cwd` 决定；`state.json` 记着当前语音会话 id，没有就按标题「语音浮窗」找/建。
4. 每轮的流式片段、整段回复、状态变化都写成事件文件；浮窗轮询后贴进窗里。
5. 「回到会话」时浮窗写一张 `{kind:'open'}` 条子，宿主挂到 `/__dsh-voice-copilot/open-session`，`client.js` 轮询取走后调 `uiWorkspace.openSession()` 真正切过去（切会话只能页面侧做）。

用户填的「提示词 / 人设」会注册成这个语音会话的系统提示段（`{{name}}` 替换成称呼），只在该会话的 Agent 上生效，不污染主界面其他会话。

## 配置项

打开 **插件 → 已安装 → DSH 语音助手 → 配置**，保存后浮窗约 1 秒同步：

| 字段 | 作用 |
| --- | --- |
| 称呼 / 唤醒名 | 显示名，同时是默认唤醒词；自动派生「称呼」「嘿称呼」「称呼称呼」 |
| 额外唤醒词 | 逗号分隔；留空用自动派生，填了就以填的为准 |
| 提示词 / 人设 | 注入语音会话的开发者消息，`{{name}}` 替换成称呼 |
| 全局热键 | 如 `Ctrl+Alt+J`，改完立即重注册 |
| 监听唤醒词 / 关唤醒词时释放麦克风 | 前者只关 KWS 解码；勾后者连采音流一起放掉（任务栏麦克风图标灭），按热键才临时开麦，代价是没有 600 ms 预录 |
| 声纹 / 声纹阈值 | 只认机主，阈值默认 `0.5`，越高越严 |
| 语音会话预设 / 工作区目录 | 留空就用 `agent.json` 里声明的值（过渡期覆盖项） |
| 静音判定 / 最长录音 / 识别语言 | 端点与 SenseVoice 参数 |
| 学习记录开关 / 目录 | 默认开，记到 `<dataDir>/learning`；本机指到 `xiaoyin-persona/learning/` |
| 记录截断（思考/参数/返回） | 默认 4000 / 2000 / 1500 字符，超出截断但保留原长 |
| 落盘脱敏 | 默认开：手机号、身份证、`wxid_` 打码 |
| 教务监视器目录 / python 解释器 | `voice_courses` 用；目录留空用 `agent.json` 的 `settings.kbmonDir` |
| `voiceHost` | `auto` / `stable` / `next`，见根 README「两个桌面端同时开着」 |

这些值写回 profile 的 `cordis.patch.yml`；标了 `.volatile()` 的即时生效，`dataDir` 和 `autoStart` 是安装级设置，要重启 DSH。设置页里的「当前预设人设（只读）」从 `agentPreset` 读 `persona.prefix` 展开显示，不写回预设。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `voice_note` | 小印自己记一条复盘笔记到 `learning/notes/` |
| `voice_who` | 听错的名字一步定位到人（见下） |
| `voice_pinyin` | 手动/兜底：给一份候选名单，按拼音排序 |
| `voice_courses` | 问某天/某时段的课表（调 `kbmon`） |
| `voice_new_session` | 登记「下一句开新话题」，当前轮照常收尾 |

### 声纹（只认机主）

浮窗右下角「声纹」按钮：点「录制 3 句」连着说三句两三秒的话，样本落到 `<dataDir>/voiceprints/owner.json`（三句向量的 192 维平均 + 自检分）。之后唤醒先算相似度，低于阈值就停住问「仍然发送 / 丢弃」。底层是 sherpa-onnx 的 `SpeakerEmbeddingExtractor`，和唤醒词共用同一份运行时，没有额外进程。模型在 `tray-app/models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`，不在时按钮提示不可用、其余照常。

这是便利性过滤，不是安全认证：放录音、哑嗓、换麦克风都可能混过去或过不去。

### 群白名单（侧栏「小印」页）

- 勾选 = 小印会去这个群找文件；取消 = 写 `chats.excluded = 1`，台账搜索、微信搜索、新消息都不再出现它，记录不删，随时勾回来。
- 直接读本机 `ledger.db` 的 `chats` 表，不依赖台账网页服务（127.0.0.1:47612）是否开着。
- 台账路径来自 `ledgerDb` 配置；没配时页面提示去填。
- 群聊只用来检索文件：`wechat_send_text` / `wechat_send_file` 目标解析成群聊会直接 `refused`，报价、订单、金额一律走私聊。
- 改了 `index.js`（宿主路由）或 `client.js`（页面）后要**完全重启桌面端**。

### 学习记录

每轮把思考、每次工具调用与返回、最终回复记成一行 JSON，落到 `learning/turns/YYYY-MM-DD.jsonl`；卡点用 `voice_note` 记到 `learning/notes/`。用法：

```bash
python xiaoyin-persona/tools/learning_report.py --days 14
```

出摘要（工具失败率、重试、耗时 p50/p95、思考长度、最慢轮次、自记问题、可动手建议），照着改 persona 或工具，再用同一批数据对比。字段定义、脱敏规则、症状 → 改哪里的对照表在 [docs/learning.md](docs/learning.md)，闭环写成了技能 `.agents/skills/voice-learning/SKILL.md`。

它不改权重、不做在线学习，只是把工作现场留成可分析的账本。

### `voice_who`：听错的名字

「张山」被转成「张三」避不开，靠模型硬猜又容易张冠李戴。`voice_pinyin` 要求模型先取候选名单，而它经常没做就直接反问——2026-11-18 实机：「帮我打一下拓亦乐的这个东西」转写成「他一乐」，小印回「没听清是谁的东西」，用户只能再补一句。

所以主路径是 `voice_who`，一次调用走完整条链：

```
voice_who({ action: "resolve", heard: "他一乐", context: "帮我打一下他这个东西" })
→ 「他一乐」→ ta yi le（tyl）
  结论：软工2301 拓亦乐（0.858）  可以说：是软工2301 拓亦乐吧？他 12 分钟前还说过话。
```

- **取人**：WeChatDataAnalysis 的实时联系人 + 会话列表（`DSH_XIAOYIN_CONTACTS_URL` / `DSH_XIAOYIN_SESSIONS_URL` 可改），再用 `ledger.db` 会话名和 `name_aliases.json` 补；任一环缺了都不报错，只是候选池小一点。
- **比拼音**：拆声母/韵母做滑动窗口；混淆类（`z/zh/j`、`c/ch/q`、`s/sh/x`、`n/l`、`f/h`、`r/l`；`an/ang`、`en/eng`、`in/ing`、`ian/iang`、`uan/uang`、`eng/ong`、`o/uo`、`ei/ie`）同类给高分，跨类退回编辑距离。所以「他一乐 → 拓亦乐」0.833、「黄虎 → 皇甫韩心」0.93、「马洪陶 → 马宏涛」1.0。
- **定人**：`0.85 × 拼音 + 0.15 × 近期活跃`（≤1h 满分、≤6h 0.85、≤24h 0.7、≤3d 0.45、≤7d 0.25、更久 0.05）；说「文件/作业/东西」且这人 7 天内真发过文件再加 0.03。
- **给结论**：拼音 ≥ 0.78、综合 ≥ 0.80、且领先第二名 ≥ 0.05 才 `confident`，否则 `ask` 给 1–2 个候选，都不像就 `none`。0.55 以下的候选不出现。默认只比人，用户真说群名时结果提示带 `includeGroups=true` 再试。
- **记住**：`action=confirm` 把听错的写法写进 `name_aliases.json`（和台账网页共用，格式不变），下次字面命中、拼音记 1.0。

质量基线 `node voice-assistant/tools/who_bench.mjs`（按拼音表反查同音/近音字模拟 ASR 错法）：

| 场景 | top1 | top3 | 直接下结论 | 下结论但认错 |
| --- | --- | --- | --- | --- |
| 原样（169 条） | 95.3% | 95.3% | 84.6% | 0 |
| 同音节换字（161 条） | 97.5% | 97.5% | 86.3% | 0 |
| 声母/韵母混淆（94 条） | 98.9% | 98.9% | 73.4% | 0 |
| 漏听一个字（118 条） | 86.4% | 94.9% | 28.8% | 0 |

最后两列是重点：宁可多问一句，也不许自信地认错人——漏听一个字时它自己把下结论率降到 25%。调完阈值重跑这个脚本，别凭感觉改。

实现无第三方依赖，拼音表是 `tray-app/desktop/data/pinyin.json`；数据源全部只读，不刷索引、不改台账、不动微信数据。

### 课表（问明天有什么课）

本机 `kbmon`（`<本机>\教务系统研究`）常驻盯正方教务，把快照写进自己的 `kbmon/data/monitor.db`；语音这边只把「哪天有什么课」翻译给它：

```
voice_courses({ when: "明天" })            → 明天有 2 门课，上午1-2节 数据结构与算法设计（王老师，A101）…
voice_courses({ when: "今天", part: "下午" })
voice_courses({ when: "周三" })            → 本周最近的那个周三
```

- 接口 `python -m kbmon today [全天|上午|下午|晚上] [--date YYYY-MM-DD] --json`，纯本地推算（第几周由 `term_start` + 课时表算），不联网、不触发检查，实机约 `0.38 s`；结果按「日期+时段」缓存 45 秒。
- 日期解析在 JS 侧：`今天/明天/后天/昨天`、`周三/礼拜天`（最近的那个，今天也算）、`2026-11-27`、`11月20日`（跨年归明年）；不认识就报错，不会悄悄当成今天。「今天下午」自动拆开。
- 时段过滤也在 JS 侧（`kbmon today --json` 只有文本输出按时段收窄，JSON 是全天），问的时段没课时会把当天另外的课带一句。
- 新鲜度看 meta 的 `last_timetable_ok`：超过 20 小时 `stale=true`，口头结论后面带提醒；监视器在跑但课表没变时只注明快照时间，不吓唬人。它只读快照，要刷新让 kbmon 自己跑 `check`。
- `kbmonDir` 空着、目录不在、python 找不到、`kbmon` 没装，都返回 `ok=false` 和一句怎么修，不抛异常打断语音链路。

## 智能体包

`agent.js` 读 `agent.json`：`id` / `name` / `persona` / `session`（`cwd`、`agentPreset`）/ `settings`（`ledgerDb`、`kbmonDir`）/ `sidebar.module` / `tools`。默认目录是 `<仓库>/xiaoyin-persona/agents/`（找不到才退回 `<本包>/agents/`）。本机绑的是 `xiaoyin-persona/agents/xiaoyin/`，里面有 `agent.json`、侧栏模块 `sidebar.js`、`lib/{ledger-groups,whitelist-policy}.js`、`voice-notes.md`。

插件配置里显式填的 `agentPreset` / `cwd` 优先于包，这是过渡期设计；P1 会全部迁进包，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

- `node --test`（仓库根跑）覆盖 agent 加载、桥事件、课表、端点、租约、台账分组、姓名解析、语音闸门、声纹，84 条全过。
- 测试里引用别处的文件用相对路径：`../../tray-app/desktop/lib/*.js`、`../../xiaoyin-persona/agents/xiaoyin/lib/ledger-groups.js`。
- 改 `index.js` / `client.js` 后必须完全重启桌面端（浏览器半边只在页面加载时注入）。
- `package.json` 的 `exports` 指向本目录下的文件，`files` 决定打包白名单；搬文件时两处一起改。
