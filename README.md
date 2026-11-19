# dsh-voice-copilot · DSH 语音助手

一个常驻托盘的语音浮窗（本体是通用的，本机拿它当本地打印项目的语音入口，见「和本地打印项目的关系」）：默认说一句「小印」，或者按一下热键，浮窗从屏幕底下弹出来开始听；本机转成文字，送进 DSH 的一个固定会话，回答贴回来。DSH 桌面端一启动它就在（插件把浮窗拉起来），DSH 关掉它也跟着退出，不用手动开、也不留孤儿进程。

称呼、唤醒词、提示词、热键、静音时长这些都在 **DSH 插件页**里改（插件 → 已安装 → DSH 语音助手 → 配置），改完浮窗自动同步；仓库里的 `app/config.json` 只保留模型路径等本机启动参数。

分两半，靠 `%USERPROFILE%\.dsh\voice-copilot` 里的文件队列通信，不开端口、不碰 DSH 的 HTTP 鉴权。

**架构分层**：这套东西是「语音壳 + 可打包的智能体包」两层（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。壳只管听、说、会话与浮窗；称呼、人设、会话预设/目录、业务配置、侧栏页都归 `agents/<id>/agent.json`。本机绑的是 `agents/xiaoyin/`，插件配置里显式填的值优先于包（P0 过渡期，行为与以前完全一致）。

| 部分 | 位置 | 干什么 |
| --- | --- | --- |
| Host 插件 | `index.js`（bundle `@local/dsh-voice-copilot`） | 把文字作为 prompt 送进会话，把助手每轮的流式 / 整段回复写成事件文件 |
| 智能体包 | `agents/<id>/`（`agent.js` 加载） | 清单 + 语音示例 + 该智能体自己的宿主路由；壳不认识里面的业务 |
| 浮窗程序 | `desktop/`（Electron） | 托盘常驻、全局热键、听唤醒词、录音、本地识别、显示回答 |
| 老浮窗 | `app/`（PySide6，仅回退） | 只有找不到 Electron 时才会用；协议与 `desktop/` 完全一样 |

浮窗这一半是个自带 Electron 的独立进程，但生命周期跟着 DSH 走（宿主退出就结束）：界面是 HTML/CSS，透明无边框、贴屏幕底部，改界面不用重启桌面端；识别用的是 DSH 安装目录里已经带的 `sherpa-onnx-node`，不用再装一套 Python。

语音会话挂的是哪个 DSH 预设由插件配置的 `agentPreset` 决定（留空就走默认预设）：填上一个带工具的预设，随口一句「上次那份材料放哪了」它就能直接去查。用户填的 `prompt` 会注册成这个语音会话的系统提示段（`{{name}}` 会替换成称呼），只在该会话的 Agent 上生效，不污染主界面里的其他会话。

## 和本地打印项目的关系

小印是本地打印项目（打印机接单 + 微信台账）的**附属项目**，不是另起一摊的通用助手：接单、出纸、记台账才是主线，小印只把「这份文件是谁发的、这个群该不该查」搬进语音。台账 `ledger.db` 与打印机日志都是打印项目那边的产物，本仓库一律**只读不写**；`tools/` 里的检索（`funnel.py`）、样本与评测（`order_labels.py` / `eval_funnel.py` / `learn_loop.py`）、侧栏页的白名单（`agents/xiaoyin/lib/whitelist-policy.js`）也都是围着这套数据转的。没有那套数据，小印就退化成一个外接 DSH 会话的语音开麦工具。

主线仓库在 <https://github.com/huonanwholovecomputer/h_n-printer>（客户端、订单/用户管理、出纸流程都在那边，本仓库只消费它产出的台账与日志）。

仓库本身是可公开的骨架：真实姓名、真实群名、本机台账路径都走 `tools/local_config.py`（已被 `.gitignore` 挡住），`learning/` 里的对话记录同样不进仓库。

## 装起来

1. `app/config.example.json` 复制成 `app/config.json`（不复制也能跑：热键、唤醒词、路径都有默认值，只是模型路径要自己指）。示例里的 `<你的用户名>` 换成自己的。
2. `cordis.patch.example.yml` 复制成 `cordis.patch.yml`，改 `dataDir` / `agentPreset` / `cwd` 三个值，再用 `plugin_manager` 或 `dsh plugin --profile <profile 名> add <本目录>` 把它作为 bundle 装进 DSH。
3. 重启桌面端，浮窗会自己起来；也可以双击 `启动语音浮窗.vbs`。
4. Electron 本体去哪找（按顺序，第一个存在的就用）：
   - 环境变量 `DSH_VOICE_COPILOT_ELECTRON` 指到某个 `electron.exe`；
   - `desktop\node_modules\electron\dist\electron.exe`（`cd desktop && npm i` 就有了）；
   - `%USERPROFILE%\.dsh\electron\electron.exe`（DSH 桌面端的桌宠之类插件下过一份，本机就在这儿，Electron 43.3.0）；
   - `%LOCALAPPDATA%\Programs\DSH NEXT\DSH NEXT.exe`（Electron 版的 DSH 自己，passthrough 着用）。

   一个都找不到才退回 `app/main.py`（需要 Python + PySide6 + sherpa-onnx）。

## 仓库结构（单仓库双包）

本仓库同时维护两个可以独立安装的 DSH bundle：

| 目录 | 包名 | 作用 |
| --- | --- | --- |
| 根目录 | `@local/dsh-voice-copilot` | 通用语音插件本体（本 README 讲的部分） |
| `presets/example-assistant/` | `@local/dsh-preset-example` | 自定义 agent preset 的最小示例，可选安装 |

语音插件不依赖示例预设；示例预设也不依赖语音插件，它只是演示「怎么给 DSH 加一个自己的会话模式」：一条 `dsh-agent-preset` 声明、一段人设、一组按需挂载的工具，以及一个默认关闭的 MCP 能力行。装了示例之后，把插件页里的「语音会话预设」填成 `example-assistant`，就能让语音会话跑在这个模式里。安装、结构与改造说明见 [presets/example-assistant/README.md](presets/example-assistant/README.md)。

私有的业务预设不放这里：`presets/private-*/` 已被 `.gitignore` 挡住，换台机器想复现就按示例骨架自己填一遍。

## 配置（插件页）

打开 DSH 侧栏 **插件 → 已安装 → DSH 语音助手 → 配置**，改完点保存即可，浮窗下一拍（约 1 秒）同步：

| 字段 | 作用 |
| --- | --- |
| 称呼 / 唤醒名 | 显示名，同时是默认唤醒词；会自动派生「称呼」「嘿称呼」「称呼称呼」三个词 |
| 额外唤醒词 | 逗号分隔；留空用自动派生。填了就以填的为准 |
| 提示词 / 人设 | 作为一条开发者消息注入语音会话，`{{name}}` 会替换成称呼；回答风格、业务背景都写这里 |
| 全局热键 | 如 `Ctrl+Alt+J`，改完立即重注册 |
| 监听唤醒词 / 关唤醒词时释放麦克风 | 前者只关 KWS 解码；勾上后者才会连采音流一起放掉（任务栏麦克风图标灭），按热键时才临时开麦，代价是不再有 600 ms 预录 |
| 声纹 / 声纹阈值 | 只认机主：唤醒后先比对声纹，低于阈值不直接接话，浮窗会问「仍然发送 / 丢弃」；阈值默认 `0.5`，越高越严 |
| 语音会话预设 / 工作区目录 | 留空就用 `agents/<id>/agent.json` 里声明的值；这两项是过渡期的覆盖项，P1 会迁进智能体包 |
| 静音判定 / 最长录音 / 识别语言 | 端点与 SenseVoice 参数 |
| 学习记录开关 / 目录 | 默认开，记到 `<dataDir>/learning`；本机指到仓库 `learning/`，见下节 |
| 记录截断（思考/参数/返回） | 默认 4000 / 2000 / 1500 字符，超出截断但保留原长 |
| 落盘脱敏 | 默认开：手机号、身份证、`wxid_` 打码 |
| 教务监视器目录 / python 解释器 | `voice_courses` 用；目录留空则用 `agents/<id>/agent.json` 的 `settings.kbmonDir`，解释器留空用 PATH 上的 `python`。见下节 |

这些值写回 profile 的 `cordis.patch.yml`；标了 `.volatile()` 的字段由 DSH 的 live 配置机制即时生效，不需要重启。`dataDir`、`autoStart` 是安装级设置，改配置文件后重启 DSH。

设置页里的「当前预设人设（只读）」会从当前 `agentPreset` 读取预设的 `persona.prefix` 并展开显示；它只读，不写回预设，避免把 60 行业务人设复制成第二份。

## 声纹（只认机主）

浮窗右下角有个「声纹」按钮，把唤醒词从「谁喊都答应」收紧成「只认机主」：

- **模型**：`models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`（3D-Speaker CAM++ 中文 16k，约 28 MB，取自 sherpa-onnx 的 `speaker-recongition-models` release）。文件不在时按钮会说明「声纹不可用」，其余功能照常。
- **注册**：点「录制 3 句」，连着说三句两三秒的话（内容随便）。样本落在 `<dataDir>/voiceprints/owner.json`，存的是三句向量平均后的 192 维模板和自检分。
- **生效**：唤醒后先拿这一句算相似度。低于阈值就停住、弹面板问「仍然发送 / 丢弃」；选发送才走原来的识别 → 送进会话流程。
- **阈值**：插件页 `声纹阈值`，默认 `0.5`。调高更严（别人更难叫醒），调低更松（自己不容易被挡）。
- **边界**：这是便利性过滤，不是安全认证。放一段录音、感冒哑嗓、换麦克风都可能混过去或过不去；高危操作不要指望它兜底。

底层就是 sherpa-onnx 的 `SpeakerEmbeddingExtractor`——和唤醒词、识别用的是同一份运行时（随 DSH 桌面端自带），没有额外进程。

## 群白名单（侧栏「小印」页）

左侧栏多了一个**小印**页（新会话 / 插件 / 自动化任务 / **小印** / 上下文洞察 / 记忆系统），里面是群聊白名单管理：

- 勾选 = 小印会去这个群里找文件；取消勾选 = 排除（写 `chats.excluded = 1`），台账搜索、微信搜索、新消息都不再出现它，但记录不删，随时能勾回来。
- 页面直接读本机台账 `ledger.db` 的 `chats` 表，不依赖台账网页服务（127.0.0.1:47612）是否开着；切换只改排除标记，不刷索引、不动文件。
- 台账路径来自插件配置 `ledgerDb`（默认写在 `cordis.patch.yml` 里，如 `<台账项目>/var/ledger.db`）；没配时页面会提示去填。
- 群聊只用来**检索文件**：`wechat_send_text` / `wechat_send_file` 的目标如果解析成群聊会直接 `refused`，报价、订单、金额一律走私聊。
- 改了 `index.js`（宿主路由）或 `client.js`（页面）后要**完全重启桌面端**才会加载，见下面的开发笔记。

仓库里不含：`models/`（唤醒词 + 识别模型，约 2 GB，换机器自己拷）、`app/config.json` 与 `cordis.patch.yml`（本机路径）、`desktop/node_modules`、调试截图和日志（`.gitignore` 里排掉了）。

## 学习记录（复盘用）

小印每跑一轮，插件会把这轮的**思考过程、每次工具调用与返回、最终回复**记成一行 JSON，
落到 `learning/turns/YYYY-MM-DD.jsonl`；它自己遇到卡点还能用 `voice_note` 工具记一条到
`learning/notes/`。数据只在本机，`learning/` 已被 `.gitignore` 挡住。

- 数据怎么来的：订阅宿主的会话事件（`ctx.on('session/event', …, { global: true })`，按 `seq` 去重），
  只记语音会话；插件卸载时把没收尾的半轮也落盘，标 `interrupted: true`。
- 怎么用：`python tools/learning_report.py --days 14` 出摘要（工具失败率、重试、耗时 p50/p95、
  思考长度、最慢的轮次、小印自记的问题、可动手的建议），照着摘要改 persona 或工具，
  再用同一批数据对比，而不是凭感觉。
- 字段定义、脱敏规则、配置项、症状 → 改哪里的对照表都写在 [docs/learning.md](docs/learning.md)；
  本仓库的 `.agents/skills/voice-learning/` 把这个闭环写成了技能，回到仓库里对话时可以直接用。

它跟「模型训练」无关：不改权重、不做在线学习，只是把工作现场留成可分析的账本。

## 听错的名字（一步定位到人）

语音识别把「张山」写成「张三」这种事避不开，靠模型硬猜又容易张冠李戴。

最初的版本给的是 `voice_pinyin`：**先把候选名单交给它**，它按拼音排序。但「先取名单」这一步得模型自己做，
而它经常没做就直接反问用户——2026-11-18 实机：用户说「帮我打一下拓亦乐的这个东西」，转写成「他一乐」，
小印回的是「没听清是谁的东西。「他一乐」是哪位？是刘浩东，还是另外的人？」，用户只好再补一句「拓亦乐」。
多一次来回，语音场景里尤其刺耳。

所以现在主路径是 `voice_who`，一次调用把整条链子走完：

```
voice_who({ action: "resolve", heard: "他一乐", context: "帮我打一下他这个东西" })
→ 「他一乐」→ ta yi le（tyl）
  结论：软工2301 拓亦乐（0.858）  可以说：是软工2301 拓亦乐吧？他 12 分钟前还说过话。
  依据：听音「他一乐」≈「拓亦乐」，12 分钟前聊过；最后一句「订单号: HN20260000-0000…」
```

它做的事：

- **取人**：本机 WeChatDataAnalysis 的实时联系人 + 会话列表（`DSH_XIAOYIN_CONTACTS_URL` /
  `DSH_XIAOYIN_SESSIONS_URL` 可改），再用 `ledger.db` 里的会话名和 `name_aliases.json` 补。
  接口不可用就退到台账名，再不行只剩别名表——任何一环缺了都不报错，只是候选池小一点。
- **比拼音**：把听到的汉字拆成声母/韵母，对每个名字做滑动窗口比对。声母、韵母各自按「混淆类」打分
  （`z/zh/j`、`c/ch/q`、`s/sh/x`、`n/l`、`f/h`、`r/l`；`an/ang`、`en/eng`、`in/ing`、`ian/iang`、
  `uan/uang`、`eng/ong`、`o/uo`、`ei/ie`），同类直接给高分，跨类才退回字母编辑距离。
  这就是为什么「他一乐 → 拓亦乐」能到 0.833、「黄虎 → 皇甫韩心」0.93、「马洪陶 → 马宏涛」1.0。
- **定人**：综合分 = `0.85 × 拼音 + 0.15 × 近期活跃`（活跃度取会话的最后说话时间：≤1h 满分、
  ≤6h 0.85、≤24h 0.7、≤3d 0.45、≤7d 0.25、更久 0.05）。用户嘴上说「文件/作业/东西」而这人 7 天内
  真发过文件时再加 0.03。拼音是主角——活跃度只用来在几个都像的人之间分先后。
- **给结论**：拼音 ≥ 0.78、综合分 ≥ 0.80、且领先第二名 ≥ 0.05 才返回 `decision=confident`，
  persona 要求它直接去办事；否则 `ask`，只给 1–2 个候选让用户点头；都不像就 `none`，
  不硬凑。分在 0.55 以下的候选不会出现在结果里。默认只比「人」，不比微信群名——
  用户真说的是群名时，工具结果会提示带 `includeGroups=true` 再试一次。
- **记住**：用户确认后 `action=confirm` 把这次听错的写法写进 `name_aliases.json`（就在 `ledger.db`
  旁边，和台账网页共用同一份文件，格式不变），下次同样听错直接字面命中、拼音记 1.0。

`voice_pinyin` 仍然保留，作为手动/兜底：模型自己想拿一份名单比对时用，或者 `voice_who` 返回
`ok=false`（比如没配台账、接口和台账都没起）时退回这条路。

## 课表（问明天有什么课）

本机有个独立的教务监视器 `kbmon`（`<本机>\教务系统研究`）：它常驻托盘盯正方教务系统，把课表快照
写进自己的 `kbmon/data/monitor.db`。语音这边不碰教务系统，只把「哪天有什么课」翻译给它：

```
voice_courses({ when: "明天" })          → 明天有 2 门课，上午1-2节 数据结构与算法设计（王老师，A101）…
voice_courses({ when: "今天", part: "下午" })
voice_courses({ when: "周三" })          → 本周最近的那个周三
```

- **接口**：`python -m kbmon today [全天|上午|下午|晚上] [--date YYYY-MM-DD] --json`，纯本地推算
  （第几周由 `term_start` + 课时表算），不联网、不触发检查，实机约 `0.38 s`；结果按「日期+时段」
  缓存 45 秒，连问几句不会反复起进程。
- **日期解析在 JS 侧**：`今天/明天/后天/昨天`、`周三/礼拜天`（取最近的那个，今天也算）、
  `2026-11-27`、`11月20日`（跨年自动归到明年）。说不认识就直接报错，不会悄悄当成今天。
  「今天下午」这种把日期和时段连在一起的说法会自动拆开。
- **时段过滤也在 JS 侧**：`kbmon today --json` 只有文本输出会按时段收窄，JSON 是全天的，所以
  `part` 是自己过滤的；问的时段没课时，结果会把这一天另外的课带上一句，免得模型以为整天没课。
- **快照旧了要提醒**：`monitor.db` 的快照只在课表**变化**时才新写一行，所以「快照是 11-16 的」并不等于
  监视器停了。新鲜度看的是 meta 里的 `last_timetable_ok`（最近一次成功检查）：它超过 20 小时，
  `stale=true`，口头结论后面会带「不过课表监视器 X 之后就没成功检查过，可能有新调课」；
  监视器好好跑着但课表一直没变时，明细里会写「课表快照 11-16 17:31，监视器 11-18 21:54 检查过」，
  不吓唬人。它只读快照，不会替你去教务系统刷新——要刷新还是让 kbmon 自己跑一轮 `check`。
- **没配也能用**：`kbmonDir` 空着、目录不在、python 找不到、`kbmon` 没装，都会返回 `ok=false`
  和一句「怎么修」，不会抛异常打断语音链路。

质量基线用本机真实联系人跑（`node tools/who_bench.mjs`，按拼音表反查同音/近音字模拟 ASR 错法）：

| 场景 | top1 | top3 | 直接下结论 | 下结论但认错 |
| --- | --- | --- | --- | --- |
| 原样（169 条） | 95.3% | 95.3% | 84.6% | 0 |
| 同音节换字（161 条） | 97.5% | 97.5% | 86.3% | 0 |
| 声母/韵母混淆（94 条） | 98.9% | 98.9% | 73.4% | 0 |
| 漏听一个字（118 条） | 86.4% | 94.9% | 28.8% | 0 |

最后两列是重点：**宁可多问一句，也不许自信地认错人**——`confident` 的门槛就是按这个调的
（漏听一个字时它自己降到 25%，剩下的都会反问）。调完阈值重跑这个脚本，别凭感觉改。

- 比的是**音节**，不是字：`li` = `li` 满分，`hu` vs `fu` 同组声母算 0.86，
  再把首字母对齐结果按 3:1 加权。所以打 `lh` 时，`李虎(lh)` 能排到 `李福生(lfsh)` 前面，
  而 `李强(lq)` 这类只共第一个音的候选会被阈值挡掉。
- 也吃**手打拼音**（`zhang wei`、`lifusheng`）和**首字母缩写**（`lf`、`LFSH`），方便用户直接说缩写。
- 名字后面的备注（`王老师（辅导员）`）不参与比对；名字以听到的字开头时优先（单说一个「李」，
  姓李的候选排在只是谐音的候选前面）。命中段落只有落在名字中段时才打折——名字是「姓+名」，
  窗口两头都没到头多半只是碰巧有个同音字（「李」不该靠昵称「万里独行」里的「里」上位）。
- **中间漏听一个字**（「拓亦乐」听成「拓乐」、「尹建龙」听成「尹龙」）用带惩罚的子序列对齐救回来：
  跳过一个候选音节扣 0.35 分，名字开头的班级前缀（`软工2301`）不算跳过。实测这一条把
  「漏听一个字」的 top1 从 66.9% 拉到 86.4%。

实现在 [name-resolver.js](name-resolver.js) + [pinyin-match.js](pinyin-match.js)，用
`desktop/data/pinyin.json` 那张带声调的静态表，没有第三方依赖；全部数据源都是只读，
不刷新索引、不改台账、不动微信数据。

## 用法

1. 打开 DSH 桌面端就会自己起来（见下节）；也可以双击 `启动语音浮窗.vbs` 手动起，或者再点一次——不会开第二个窗口，只会把已经在跑的那个叫出来。
2. 叫它：说 **「小印」**（默认称呼；可以在插件页改成别的名字或额外唤醒词），也可以带一句，「小印，今天有什么安排」；或者按热键（默认 `Ctrl+Alt+J`）。
   小印被 `×` 收起、甚至整个退出之后，也可以直接在 DSH 里点 **「叫出小印」**：会话标题栏右侧的小印图标，或侧栏「小印」页顶部的按钮。进程还在就把它叫到前台，进程已经退出就现拉一个。
3. 浮窗弹出后继续说完；说完自动停，文字直接送进 DSH，回答在同一个窗里出来。说到一半想早点了事：点电平条右边那个红色方块（停止录音），已经说出口的部分照常送去识别、发出去；整段都不想要才按 `Esc`——丢掉这段录音，**窗口不收起**。
4. `Enter` 也可以纯打字发送；右上角 `×` 收起浮窗（托盘图标双击可再唤起）；托盘菜单里可以关掉「语音唤醒」、看日志、退出。
5. 想换个话题就说 **「开个新话题」**（或「重开一段」「换个话题」）：小印会把当前这段收尾、改名成带时间的标题留在侧边栏，下一句开始进一个干净的会话。旧会话不动，随时能翻回去看。
6. 窗口是拖不动的（无边框），位置记在 `<dataDir>\window.json`，下次按它摆；只在屏幕外时才被拉回来。

热键、唤醒词、静音判定、称呼、提示词都在插件页改（见上节）；`app/config.json` 的 `hotkey` / `wake_words` 只在 runtime.json 不存在时作兜底。

## 换一段新的

同一个 `cwd` 下默认一直复用「语音浮窗」那一个会话，跨天、换话题都堆在同一段里，越滚越长。说一句「开个新话题」就会换段：

- 小印调 `voice_new_session` 登记意图，当前这一轮仍在旧会话里正常收尾（不会被半路换掉 Agent）。
- 下一句开始前才真正新建：旧会话改名成 `语音浮窗 · 截至 11-05 22:30`（或你给的名字）留在侧边栏，新会话接回「语音浮窗」标题，`state.json` 指向新的那个。
- 新会话要等桌面端重载（Ctrl+R）才会出现在侧栏树里，浮窗这边不受影响，下一句照常能用。
- 「换段」的意图只记在内存里：说完那句之后如果插件重载（Ctrl+R）或 DSH 重启，这次意图会丢，下一句仍进旧会话——重说一句即可。
- 自动换段没做（按天 / 空闲超时），要的话在 `resolveSessionId()` 里加个时间戳判断最省事。

## 随 DSH 启动

插件 `apply()` 的最后会调 `autostart.js` 把浮窗拉起来（detached、无控制台窗口）；插件卸载 / DSH 退出时再把它停掉，宿主若是崩溃，浮窗靠 `runtime.json` 里的 `hostPid` 心跳自己退出。

- 三种情况只写日志、不报错：不是 Windows、找不到 Electron / `app/main.py`、spawn 失败。
- 已经在跑就不重复开：先看 `%USERPROFILE%\.dsh\voice-copilot\app.pid` 里的进程还活着没（Electron 单实例锁兜底）。
- 日志：DSH 的插件日志里那行 `floating window autostart {"started":true,"engine":"electron",...}`；浮窗自己的日志在 `<dataDir>\window.log`。
- 不想要自启：在 `cordis.patch.yml` 的 voice-copilot insert 行加 `autoStart: false`，然后照旧双击 vbs。
- 自己拉起来调试：`node --input-type=module -e "import {startFloatingWindow} from './autostart.js'; console.log(startFloatingWindow())"`。

## 浮窗是怎么搭的

`desktop/` 是个普通 Electron app（CommonJS，`main.js` 入口），三个进程分工：

| 进程 | 文件 | 干什么 |
| --- | --- | --- |
| 主进程 | `main.js` + `lib/{config,bridge,audio,window,tray,focus,pinyin}.js` | 建窗、托盘、热键、采音收尾、跑 sherpa 识别、读写文件队列 |
| 渲染进程 | `ui/{index.html,style.css,app.js,pcm-worklet.js}` | 画面与输入；`getUserMedia` 采 16 kHz 单声道，AudioWorklet 128 帧一块推给主进程 |
| preload | `preload.js` | 只开 `window.xiaoyin` 一组方法，`contextIsolation: true` / `nodeIntegration: false` |

- 窗口默认 720×520、圆角、透明、无边框、置顶（`screen-saver` 级）。四条边和四个角都能拖（最小 420×320），尺寸记在 `window.json` 的 `size` 里，下次启动照旧。没开 BrowserWindow 的 `resizable`——透明窗口开原生缩放会把透明和圆角打坏，所以是 UI 里铺 8 个隐形把手，走 `xiaoyin.resize()` 让主进程 `setBounds`。**隐藏不是 `win.hide()`**，是 `setOpacity(0)` + 鼠标穿透——真隐藏会让渲染进程被节流，Web Audio 掉帧。
- 麦克风默认只开一路、常驻：渲染进程一直采，主进程里既做唤醒词、又做命令录音，所以「听见小印」到「开始录」中间不丢音（唤醒时把最近 150 ms 一起带上，热键时带 600 ms）。勾上「关唤醒词时释放麦克风」后改成按需：关唤醒词就 `track.stop()`（任务栏图标灭），热键时临时开麦、录完再放。
- 识别引擎不另装：直接 require DSH 安装目录 `resources/app.asar.unpacked/node_modules/sherpa-onnx-node`（原生模块按 N-API 编的，Electron 里能直接加载）。模型还是 `app/config.json` 里那个 `model`（SenseVoice int8，239 MB）。
- 识别结果不回宿主转写：本机 desktop profile 的 `speechToText` 服务是空的（`speech={"available":false}`），所以 `desktop/` 把文字连同 wav 路径一起入队，`index.js` 看到有 `text` 就直接用，不碰转写服务。
- 「回到会话」走 `lib/focus.js`（从 dsh-notify-me 抄的 PowerShell 抬升阶梯：还原 → Alt 轻敲 + SetForegroundWindow → AttachThreadInput → 最小化/还原兜底，每级回读 `GetForegroundWindow` 核对），同时把「切到语音浮窗会话」这件事交给插件：浮窗写一张 `{kind:'open'}` 条子，宿主挂到回环路由 `/__dsh-voice-copilot/open-session`，页面半侧 `client.js` 轮询取走后调 `uiWorkspace.openSession()` 真的切过去。

## 唤醒词怎么工作的

一路麦克风常开（不开第二路，所以从「听见」到「开始录」不会丢开头），唤醒词走的是 sherpa-onnx 的流式关键词识别（3.3M zipformer，拼音建模，`models/` 下自带）。勾了「关唤醒词时释放麦克风」就改为按需开麦，判定与开关的日志见 `<dataDir>/window.log` 里的 `麦克风策略 / 麦克风开（热键） / 麦克风关（…）`：

1. 每 20 ms 把新采到的音频喂给关键词模型，说完「小印」当场命中（不等静音、不做整句识别）。
2. 命中就弹窗，并**把刚才最近 150 ms 的音频一起带上**开录——所以「小印，今天有什么安排」这种连读也不会丢半句。
3. 命令转写出来后会去掉开头的唤醒词（称呼和额外唤醒词都在插件页里配），送进会话的是干净的指令。
4. 录音期间不再做唤醒检测；`Esc` 取消后回到监听（窗口留着）。

唤醒词的拼音由 `desktop/data/pinyin.json`（本地静态拼音表）生成到 `<dataDir>/keywords.txt`（一行一个，`x iǎo y ìn @小印`）。改称呼或唤醒词时宿主重写 runtime.json，浮窗收到后重建词表，不需要重启。

## 识别引擎

`desktop/` 只认 SenseVoice（`app/config.json` 的 `model` / `tokens`，`stt_engine` 等键只对 Python 回退版有效）：带标点、数字规整，CPU 上 10 秒音频 0.3 秒左右，加载 1.5–1.8 秒。

Python 回退版还支持 FireRedASR2 int8（`models/fire-red-asr2-int8/`、`firered-ctc-int8/`），但同样三条测试音上并没有稳定比 SenseVoice 准，CPU 上还慢一个量级，所以默认没换。GPU 用不上：DSH 带的 sherpa-onnx 是 CPU-only 构建。

## 自己测的时候

环境变量（都只影响一次启动）：

| 变量 | 作用 |
| --- | --- |
| `XIAOYIN_SHOW=1` | 启动就显示窗口，不用按热键 |
| `XIAOYIN_SIM_WAV=<wav>` | 按 20 ms 一帧实时喂一段 wav，替掉真麦克风（末尾自动补 1.6 s 静音） |
| `XIAOYIN_SIM_CAPTURE=1` | 600 ms 后直接开录，绕过唤醒词 |
| `XIAOYIN_DEBUG_AUDIO=1` | 每 3 s 打一行音频帧统计和电平 |
| `XIAOYIN_SHOT=<png>` | 把窗口截成图（`XIAOYIN_SHOT_QUIT=1` 截完退出） |
| `XIAOYIN_PHASE=thinking` | 起来就把状态设成指定阶段（`sleeping`/`recording`/`thinking`/`replying`/`error`），配合截图看「思考中」这类状态条 |
| `XIAOYIN_DATA_DIR=<dir>` | 换一套队列目录（autostart 会自动带上真实的那套） |

## 已验证

- 插件：`plugin_manager` 安装后 `application: applied`，`ready` 事件落盘，`ping → pong` 通。
- 文字链路：`submit_text` → `prompt accepted` → 思考中 → `assistant-message`（整段）→ `turn-end` 一次性贴出，实测回复正常。
- 新浮窗拉起来就能用：`history 补齐 11 条` / `13 条`，旧会话的消息直接铺进窗里；热键注册成功，`SendKeys ^%j` 实测窗口弹出。
- 模拟一段真音频（`models/fire-red-asr2-int8/test_wavs/0.wav`）走完整链路：日志 `检测到说话 @720ms` → `一段结束 reason=silence` → `识别 101ms -> "昨天是monday。"` → 队列里落 `{"kind":"voice","wav":"…\\audio\\<ts>.wav","text":"昨天是monday。","language":"zh"}`。
- 真麦克风：渲染进程按 16 kHz 稳定推流（`[audio] 375 帧 / 3.0s`）；房间里正常说话能被认出并送进会话（顺手验了「说错话 → 助手回『这句没听明白』」这一路）。
- 自启：`{"started":true,"engine":"electron","pid":...+exe:...\\electron.exe}`，第二次调用返回 `already-running`；热键与还在跑的 Python 版互斥，杀掉旧的之后立刻注册成功。
- 窗口位置：主屏 2560×1600 / 150% 缩放下落在底部居中（workArea 里 `(1707-720)/2`、离底 `520+24`），DPI 感知截图核对过不越界。
- 窗口尺寸：CDP 驱动实测——右下角拖 +40/+40 得到 +40/+40；上边下拖 44 得到高 -44、`y` +46（底边钉住）；左边右拖 44 得到宽 -44、`x` +45（右边钉住）；强塞 120×90 被夹到 420×320；`window.json` 落了 `size`，重启后按存的尺寸恢复。
- 课表：`voice_courses` 对真实 kbmon 实测 `0.38–0.42 s`（进程冷起）——`明天`→2 门课、`今天 part=上午`→2 门、`今晚`→0 门（另附当天其余课）、`周六`→没课、`2027-03-10`→「课表只排到第 17 周」、`瞎写`→直接报「看不懂的日期」；同一日期+时段第二次调用命中缓存不再起进程。新鲜度能区分两种旧：监视器还在跑（`last_timetable_ok` 是 11-18 21:54）时只注明「快照 11-16，检查过」，`last_timetable_ok` 也过期才报 `stale`。`test/courses.test.mjs` 20 条覆盖日期解析/时段拆分/各种 status/新鲜度/缓存/失败路径。

## 同时开着官方 dsh 和 DSH NEXT

两个桌面端共用 `DSH_HOME`（`~/.dsh`），因此共用同一个 desktop profile、同一份 `voice-copilot` 数据目录。以前只有一个 `runtime.json.hostPid`：谁后启动谁覆盖，而且任一方退出时都 `taskkill` 同一个 `app.pid` —— 先退出的会把另一方的浮窗杀掉。

现在「谁持有小印」是一份显式租约：`<dataDir>/lease.json`。

- 只有持有者写 `runtime.json`、消费 `queue/`、拉起和结束浮窗；另一个宿主什么都不做（不显示浮窗、不抢队列）。
- 持有者每 5 s 续一次心跳；心跳超过 20 s 没续、或宿主进程不在了，别人可以接管（`reason: stale`）。
- 抢租约在 `lease.lock`（`O_EXCL` 原子创建）里做「读—判断—写」，两个宿主同时启动也只会有一个人写成功。
- 退出时只释放自己的租约：如果租约已经换人，这一侧的 dispose **不会**再 taskkill 共享的浮窗。
- 在「没持有小印」的那个 DSH 里点「叫出小印」＝把小印切过来：先写 `control/takeover.json` 请对方让位，对方 400 ms 内看到就让出（3 s 没反应则强制接管，旧窗口关掉后重开）。接口回 `{mode:'takeover'}`；两个宿主都没有响应时才回 409。

插件配置里多了一项 `voiceHost`：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 先到先得；先启动的那一方持有，另一方只挂心跳 |
| `stable` | 官方 dsh 启动时接管（不管谁先开） |
| `next` | DSH NEXT 启动时接管 |

「哪一方」由进程安装路径推断（`...\Programs\DSH NEXT\...` → `next`，`...\DeepSeek Harness\...` → `stable`），认不出来就是 `unknown`，`voiceHost` 对它不生效，退回先到先得。被指定的一方接管后，原来那一方进入 30 s 冷静期，不会立刻抢回去。

浮窗自己也认租约：它启动时拿到宿主塞的 `XIAOYIN_OWNER_INSTANCE`，每 2 s 比对 `lease.json`；租约换人（或心跳过期）就自己退出，不会变成一个孤儿窗口。

语音引擎（`sherpa-onnx-node`）跟着**拉起它的那个宿主**走：`autostart.js` 从宿主的 `resources/` 里找到那份原生模块，通过 `XIAOYIN_SHERPA` 传给浮窗，而不是写死 DSH NEXT 的安装路径。

## 已知限制

- 常驻内存：Electron 五个进程加起来约 0.7–0.8 GB（主进程里压着 SenseVoice 239 MB + KWS），比 PySide6 那版（约 0.5–0.6 GB）**并不更省**；换掉它图的是界面质量、没有 Python 依赖、改 UI 不用重启，不是内存。
- 唤醒是流式关键词识别，说完「小印」约 0.3 秒弹窗；连读靠前摇补回来，但要求接着说完后半句。
- 唤醒词按拼音匹配，同音字不区分；环境里有人说「小×」可能误触发，托盘里可临时关掉。
- 常驻监听会一直占用麦克风（默认行为）；要么在插件页勾上「关唤醒词时释放麦克风」，要么直接退出浮窗。DSH 网页里的那个麦克风按钮同一时间只能有一个在采。
- 录音的端点靠能量阈值（RMS 0.012，`autoGainControl` 关掉了——开着会把底噪放大到 0.99，整段被误判成「有人在说」），比真正的 VAD 粗；环境特别吵时可能把噪声当一句话送去识别。
- 麦克风权限：主进程对 `media` / `audioCapture` 一律放行，没有系统级的二次确认。
- 插件改代码后要**完全重启桌面端**才会重新加载 JS（本机是 `link:` 安装，profile 的 `node_modules/@local/dsh-voice-copilot` 直指本仓库，重启即读到新代码）；万一重启后行为没变，再 `remove_bundle` + `install_bundle` 一次。
- 浮窗就是那个会话的一扇窗：启动时拉最近 60 条消息铺出来，DSH 里打的字也会实时出现；会话建在 `cordis.patch.yml` 里 `cwd` 指向的那个工作区（标题「语音浮窗」），可以直接去那边接着聊。
- 浮窗自己新建的会话，侧栏不是立刻出现：DSH 的工作区树是启动时加载的，程序侧新建的会话要等桌面端重载（Ctrl+R 或重开）后才会列进侧栏。
- 会话里插件注入的记忆快照 / 环境上下文会被过滤掉，只显示人说的话和模型的回复；正文自己滚，鼠标滚轮上翻不会被新消息拽回底部。
- 「回到会话」会把 `DSH NEXT` 主窗口还原到前台、把浮窗收起来，并**切到「语音浮窗」那段对话**。切会话这件事必须是页面干的（DSH 的 `uiWorkspace.openSession` 只活在浏览器半侧，宿主进程没有对应 API，dsh-notify-me / dsh-pet 点通知能跳会话也是同一个原因），所以插件多了一个浏览器半侧 `client.js`：它每 800 ms 向宿主回环路由取一次待办，拿到会话 id 就切过去。宿主那半边改了代码、新加了页面半侧，**必须重启 DSH 才会加载**。
- Electron 本体不在仓库里，也不在后者的 `package.json` 依赖里（默认走 `~/.dsh/electron`）；要在别的机器上从零起，得先 `npm i` 或者让它下 Electron。
- 本机 shell 环境带着 `ELECTRON_RUN_AS_NODE=1` 时直接 spawn electron 会变成 node 报 `Cannot find module 'electron'`；`autostart.js` / vbs 都会先把这个变量删掉，手搓命令行时记得也删。
