# dsh-voice-copilot · DSH 语音助手

一个常驻托盘的通用语音浮窗：默认说一句「小印」，或者按一下热键，浮窗从屏幕底下弹出来开始听；本机转成文字，送进 DSH 的一个固定会话，回答贴回来。DSH 桌面端一启动它就在（插件把浮窗拉起来），DSH 关掉它也跟着退出，不用手动开、也不留孤儿进程。

称呼、唤醒词、提示词、热键、静音时长这些都在 **DSH 插件页**里改（插件 → 已安装 → DSH 语音助手 → 配置），改完浮窗自动同步；仓库里的 `app/config.json` 只保留模型路径等本机启动参数。

分两半，靠 `%USERPROFILE%\.dsh\voice-copilot` 里的文件队列通信，不开端口、不碰 DSH 的 HTTP 鉴权。

| 部分 | 位置 | 干什么 |
| --- | --- | --- |
| Host 插件 | `index.js`（bundle `@local/dsh-voice-copilot`） | 把文字作为 prompt 送进会话，把助手每轮的流式 / 整段回复写成事件文件 |
| 浮窗程序 | `desktop/`（Electron） | 托盘常驻、全局热键、听唤醒词、录音、本地识别、显示回答 |
| 老浮窗 | `app/`（PySide6，仅回退） | 只有找不到 Electron 时才会用；协议与 `desktop/` 完全一样 |

浮窗这一半是个自带 Electron 的独立进程，但生命周期跟着 DSH 走（宿主退出就结束）：界面是 HTML/CSS，透明无边框、贴屏幕底部，改界面不用重启桌面端；识别用的是 DSH 安装目录里已经带的 `sherpa-onnx-node`，不用再装一套 Python。

语音会话挂的是哪个 DSH 预设由插件配置的 `agentPreset` 决定（留空就走默认预设）：填上一个带工具的预设，随口一句「上次那份材料放哪了」它就能直接去查。用户填的 `prompt` 会注册成这个语音会话的系统提示段（`{{name}}` 会替换成称呼），只在该会话的 Agent 上生效，不污染主界面里的其他会话。

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
| 语音会话预设 / 工作区目录 | 决定语音会话用哪个 agent preset、落在哪个工作区；改预设只影响之后新建的语音会话 |
| 静音判定 / 最长录音 / 识别语言 | 端点与 SenseVoice 参数 |
| 学习记录开关 / 目录 | 默认开，记到 `<dataDir>/learning`；本机指到仓库 `learning/`，见下节 |
| 记录截断（思考/参数/返回） | 默认 4000 / 2000 / 1500 字符，超出截断但保留原长 |
| 落盘脱敏 | 默认开：手机号、身份证、`wxid_` 打码 |

这些值写回 profile 的 `cordis.patch.yml`；标了 `.volatile()` 的字段由 DSH 的 live 配置机制即时生效，不需要重启。`dataDir`、`autoStart` 是安装级设置，改配置文件后重启 DSH。

设置页里的「当前预设人设（只读）」会从当前 `agentPreset` 读取预设的 `persona.prefix` 并展开显示；它只读，不写回预设，避免把 60 行业务人设复制成第二份。

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

## 听错的名字（拼音模糊匹配）

语音识别把「张伟」写成「张玮」这种事避不开，靠模型硬猜又容易张冠李戴。所以插件给小印配了一个
`voice_pinyin` 工具：把**听到的词**和**候选名单**一起交给它，按拼音算相似度、返回排序后的候选。

```
voice_pinyin({ action: "match", heard: "李虎", candidates: ["李福生", "李强", "韩鑫", …] })
→ 李福生  0.688  lfsh  命中：李→李、虎→福
```

- 比的是**音节**，不是字：`li` = `li` 满分，`hu` vs `fu` 差 1 个字母算 0.5，
  再把首字母对齐结果按 3:1 加权。所以打 `lh` 时，`李虎(lh)` 能排到 `李福生(lfsh)` 前面，
  而 `李强(lq)` 这类只共第一个音的候选会被阈值挡掉。
- 也吃**手打拼音**（`zhang wei`、`lifusheng`）和**首字母缩写**（`lf`、`LFSH`），方便用户直接说缩写。
- 名字后面的备注（`王芳（辅导员）`）不参与比对；名字以听到的字开头时优先（单说一个「李」，
  姓李的候选排在只是谐音的候选前面）。
- 只做比对、不查人：候选名单还是模型自己用联系人/群成员工具取。得分接近时 persona 要求它列给用户确认，
  不许自己拍板。

实现在 [pinyin-match.js](pinyin-match.js)，用 `desktop/data/pinyin.json` 那张带声调的静态表，没有第三方依赖。

## 用法

1. 打开 DSH 桌面端就会自己起来（见下节）；也可以双击 `启动语音浮窗.vbs` 手动起，或者再点一次——不会开第二个窗口，只会把已经在跑的那个叫出来。
2. 叫它：说 **「小印」**（默认称呼；可以在插件页改成别的名字或额外唤醒词），也可以带一句，「小印，今天有什么安排」；或者按热键（默认 `Ctrl+Alt+J`）。
3. 浮窗弹出后继续说完；说完自动停，文字直接送进 DSH，回答在同一个窗里出来。说到一半不想说了按 `Esc`：只停这一下、丢掉这段录音，**窗口不收起**。
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

- 窗口 720×520、圆角、透明、无边框、置顶（`screen-saver` 级）。**隐藏不是 `win.hide()`**，是 `setOpacity(0)` + 鼠标穿透——真隐藏会让渲染进程被节流，Web Audio 掉帧。
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
| `XIAOYIN_DATA_DIR=<dir>` | 换一套队列目录（autostart 会自动带上真实的那套） |

## 已验证

- 插件：`plugin_manager` 安装后 `application: applied`，`ready` 事件落盘，`ping → pong` 通。
- 文字链路：`submit_text` → `prompt accepted` → 思考中 → `assistant-message`（整段）→ `turn-end` 一次性贴出，实测回复正常。
- 新浮窗拉起来就能用：`history 补齐 11 条` / `13 条`，旧会话的消息直接铺进窗里；热键注册成功，`SendKeys ^%j` 实测窗口弹出。
- 模拟一段真音频（`models/fire-red-asr2-int8/test_wavs/0.wav`）走完整链路：日志 `检测到说话 @720ms` → `一段结束 reason=silence` → `识别 101ms -> "昨天是monday。"` → 队列里落 `{"kind":"voice","wav":"…\\audio\\<ts>.wav","text":"昨天是monday。","language":"zh"}`。
- 真麦克风：渲染进程按 16 kHz 稳定推流（`[audio] 375 帧 / 3.0s`）；房间里正常说话能被认出并送进会话（顺手验了「说错话 → 助手回『这句没听明白』」这一路）。
- 自启：`{"started":true,"engine":"electron","pid":...+exe:...\\electron.exe}`，第二次调用返回 `already-running`；热键与还在跑的 Python 版互斥，杀掉旧的之后立刻注册成功。
- 窗口位置：主屏 2560×1600 / 150% 缩放下落在底部居中（workArea 里 `(1707-720)/2`、离底 `520+24`），DPI 感知截图核对过不越界。

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
