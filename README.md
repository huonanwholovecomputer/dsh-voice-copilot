# dsh-voice-copilot · DSH 语音助手

一个常驻托盘的语音浮窗：说一句「小印」，或者按一下热键，浮窗从屏幕底下弹出来开始听；本机转成文字，送进 DSH 的一个固定会话，回答贴回同一个窗里。DSH 桌面端一启动它就在，DSH 关掉它也跟着退出，不用手动开、也不留孤儿进程。

本体是通用的，本机拿它当本地打印项目（打印机接单 + 微信台账）的语音入口——小印只是把「这份文件是谁发的、这个群该不该查」搬进语音，主线业务不在这边，见 [xiaoyin-persona/README.md](xiaoyin-persona/README.md)。

## 三个文件夹

仓库按「壳 / 人 / 窗」分成三块，每块都能单看：

| 文件夹 | 是什么 | 里面有什么 |
| --- | --- | --- |
| [voice-assistant/](voice-assistant/README.md) | **插件本体**（bundle `@local/dsh-voice-copilot`） | Host 半边 `index.js`、浏览器半边 `client.js`、智能体包加载器、`voice_*` 工具、租约、测试、语音相关文档 |
| [xiaoyin-persona/](xiaoyin-persona/README.md) | **小印这个人** | 智能体包 `agents/xiaoyin/`、agent preset（示例 + 私有）、learning 复盘记录、业务脚本 |
| [tray-app/](tray-app/README.md) | **托盘常驻的窗** | Electron 浮窗 `desktop/`、PySide6 回退版 `app/`、模型 `models/`、`启动语音浮窗.vbs` |

根目录只剩下打包和安装要用的东西：`package.json`（bundle 清单，link 安装也指向这里）、`cordis.patch.yml`（本机路径，已 gitignore）、`.gitignore`、`.agents/skills/voice-learning/`。

## 它怎么转起来的

1. 浮窗常驻听唤醒词（或接热键），本地 sherpa-onnx 转写成文字 —— 全程不上云，DSH 的转写服务本机是空的，所以不绕这一圈。
2. 文字连同 wav 路径写成队列文件（`<dataDir>/queue/`），不开端口、不碰 DSH 的 HTTP 鉴权。
3. Host 插件 `index.js` 把文字作为 prompt 送进固定会话，再把每轮回复写成事件文件。
4. 浮窗轮询事件文件，把回答贴回窗里；「回到会话」则通过 `client.js` 在浏览器半侧真的切到那段对话。

分层是「**语音壳 + 可打包的智能体包**」：壳只管听、说、会话与浮窗；称呼、人设、会话预设/目录、业务配置、侧栏页都归 `agents/<id>/agent.json`。本机绑的是 `xiaoyin-persona/agents/xiaoyin/`，插件配置里显式填的值优先于包（过渡期，行为与以前一致）。细节见 [voice-assistant/docs/ARCHITECTURE.md](voice-assistant/docs/ARCHITECTURE.md)。

## 装起来

1. `tray-app/app/config.example.json` 复制成 `tray-app/app/config.json`（不复制也能跑：热键、唤醒词、路径都有默认值，只是模型路径要自己指）。示例里的 `<你的用户名>` 换成自己的。
2. `cordis.patch.example.yml` 复制成 `cordis.patch.yml`，改 `dataDir` / `agentPreset` / `cwd` 三处路径，再用 `plugin_manager` 或 `dsh plugin --profile <profile 名> add <本目录>` 把它作为 bundle 装进 DSH。
3. 重启桌面端，浮窗会自己起来；也可以双击 `tray-app/启动语音浮窗.vbs`。
4. Electron 本体去哪找（按顺序，第一个存在的就用）：
   - 环境变量 `DSH_VOICE_COPILOT_ELECTRON` 指到某个 `electron.exe`；
   - `tray-app/desktop/node_modules/electron/dist/electron.exe`（`cd tray-app/desktop && npm i` 就有了）；
   - `%USERPROFILE%\.dsh\electron\electron.exe`（DSH 桌面端那边下过一份，本机就在这儿，Electron 43.3.0）；
   - `%LOCALAPPDATA%\Programs\DSH NEXT\DSH NEXT.exe`（Electron 版的 DSH 自己，passthrough 着用）。

   一个都找不到才退回 `tray-app/app/main.py`（需要 Python + PySide6 + sherpa-onnx）。浮窗这一侧的细节在 [tray-app/README.md](tray-app/README.md)。

5. 想连业务一起用：`xiaoyin-persona/presets/private-print-assistant/` 是本机那份，已被 gitignore；换台机器按 `xiaoyin-persona/presets/example-assistant/` 的骨架自己填，见 [xiaoyin-persona/README.md](xiaoyin-persona/README.md)。

## 用法

1. 打开 DSH 桌面端就会自己起来；也可以双击 `tray-app/启动语音浮窗.vbs` 手动起，再点一次不会开第二个窗口，只会把已经在跑的那个叫出来。
2. 叫它：说 **「小印」**（默认称呼，插件页可改），也可以连说「小印，今天有什么安排」；或者按热键（默认 `Ctrl+Alt+J`）。浮窗被收起甚至退出后，也能在 DSH 里点 **「叫出小印」**（会话标题栏右侧的小印图标，或侧栏「小印」页顶部按钮）。
3. 说完自动停，文字直接送进 DSH。想早点了事：点电平条右边的红色方块（停止录音），说过的话照常发出去；整段都不要按 `Esc`（丢录音，窗口不收起）。
4. `Enter` 也可以纯打字发送；右上角 `×` 收起浮窗（托盘图标双击再唤起）；托盘菜单里能关「语音唤醒」、看日志、退出。
5. 想换话题说 **「开个新话题」**（或「重开一段」「换个话题」）：当前这段收尾、改名成带时间的标题留在侧栏，下一句进一个干净的会话，旧会话随时能翻回去。
6. 窗口拖不动（无边框），位置记在 `<dataDir>/window.json`，只在跑出屏幕时才被拉回来。

## 配置

称呼、唤醒词、提示词、热键、静音时长这些都在 **DSH 插件页**（插件 → 已安装 → DSH 语音助手 → 配置）里改，保存后浮窗下一拍（约 1 秒）同步；`tray-app/app/config.json` 只保留模型路径等本机启动参数。

字段逐条解释、`dataDir` 里各文件的意思、声纹/白名单/learning/`voice_who`/课表这些功能怎么用，都写在 [voice-assistant/README.md](voice-assistant/README.md)。

## 数据目录（`dataDir`）

默认 `%USERPROFILE%\.dsh\voice-copilot`，本机指到 `%USERPROFILE%/.dsh/voice-copilot`：

| 文件 | 谁写 | 干什么 |
| --- | --- | --- |
| `queue/` | 浮窗 → 宿主 | 一条语音任务一个文件（text + wav） |
| `events/` | 宿主 → 浮窗 | 每轮流式/整段回复、状态、错误 |
| `state.json` | 宿主 | 当前语音会话 id |
| `runtime.json` | 宿主 | 称呼、唤醒词、热键、阈值、`hostPid` 心跳等，浮窗照着跑 |
| `window.json` | 浮窗 | 窗口位置与尺寸 |
| `lease.json` | 宿主 | 哪个 DSH 安装持有小印（见下） |
| `voiceprints/owner.json` | 浮窗 | 声纹模板（三句平均的 192 维向量） |
| `keywords.txt` | 宿主 | 由拼音表生成的唤醒词表 |
| `window.log` / `app.pid` | 浮窗 | 浮窗日志与进程号 |

`learning/` 不在 `dataDir` 时指向 `xiaoyin-persona/learning/`（本机就是这样），复盘见 [voice-assistant/docs/learning.md](voice-assistant/docs/learning.md)。

## 两个桌面端同时开着

官方 dsh 和 DSH NEXT 共用 `DSH_HOME`（`~/.dsh`），所以也共用同一份数据目录。谁持有小印由 `<dataDir>/lease.json` 这份**显式租约**决定：只有持有者写 `runtime.json`、消费队列、拉起和结束浮窗；另一个宿主只挂心跳。心跳超过 20 s 没续或宿主进程不在了，别人可以接管。在没持有的那一侧点「叫出小印」＝把小印切过来（写 `control/takeover.json` 请对方让位，对方 400 ms 内让出，3 s 没反应就强制接管）。

插件配置里 `voiceHost` 决定谁优先：`auto`（默认，先到先得）/ `stable`（官方 dsh 接管）/ `next`（DSH NEXT 接管）。认不出安装路径就是 `unknown`，退回先到先得。浮窗自己也认租约，租约换人或心跳过期就退出，不会变成孤儿窗口。

## 文档

| 文档 | 讲什么 |
| --- | --- |
| [voice-assistant/docs/ARCHITECTURE.md](voice-assistant/docs/ARCHITECTURE.md) | 语音壳与智能体包的分层、P1/P2/P3 计划 |
| [voice-assistant/docs/learning.md](voice-assistant/docs/learning.md) | learning 记录字段、脱敏、症状 → 改哪里 |
| [voice-assistant/docs/语音采集_端点优化.md](voice-assistant/docs/语音采集_端点优化.md) | 滚动判主、机主锚定收尾、精确裁剪 |
| [tray-app/desktop/CONTRACT.md](tray-app/desktop/CONTRACT.md) | 渲染层契约（`desktop/ui` ↔ `desktop/main.js`） |
| [xiaoyin-persona/docs/](xiaoyin-persona/docs/) | 小印复盘（11-10 / 11-11 / 11-16）、白名单策略、生活域扩展、订单文件来源 |

## 开发

- 测试：仓库根 `node --test`（Node 22+），84 条全过。
- 改 JS 后要**完全重启桌面端**才会重新加载（本机是 `link:` 安装，profile 的 `node_modules/@local/dsh-voice-copilot` 直指本仓库，重启即读到新代码）；行为没变就再 `remove_bundle` + `install_bundle` 一次。
- 改了 `package.json` 的 `exports`/`files` 或搬动了目录，记得同步 profile 的 `cordis.patch.yml` 与 `package.json` 里的 `link:` 路径。
- 浮窗调试用的环境变量（`XIAOYIN_SHOW` / `XIAOYIN_SIM_WAV` / `XIAOYIN_SHOT` 等）在 [tray-app/README.md](tray-app/README.md)；`voice_who` 的质量基线 `node voice-assistant/tools/who_bench.mjs`。

## 已知限制

- 常驻内存：Electron 五个进程约 0.7–0.8 GB（主进程里压着 SenseVoice 239 MB + KWS），比 PySide6 那版（约 0.5–0.6 GB）并不更省；换它图的是界面质量、没有 Python 依赖、改 UI 不用重启。
- 唤醒是流式关键词识别，说完「小印」约 0.3 秒弹窗；唤醒词按拼音匹配，同音字不区分，环境里有人说「小×」可能误触发（托盘里能临时关掉）。
- 常驻监听会一直占麦克风（默认行为）；要么勾「关唤醒词时释放麦克风」，要么退出浮窗。DSH 网页里的麦克风按钮同一时间只能有一个在采。
- 端点靠能量阈值（RMS 0.012，`autoGainControl` 关掉了——开着会把底噪放大到 0.99，整段被误判成「有人在说」），比真正的 VAD 粗。
- 浮窗自己新建的会话，侧栏要等桌面端重载（Ctrl+R）才会列出来。
- 本机 shell 带着 `ELECTRON_RUN_AS_NODE=1` 时直接 spawn electron 会变成 node 报 `Cannot find module 'electron'`；`autostart.js` / vbs 都会先把这个变量删掉，手搓命令行时记得也删。

## 不进仓库的东西

`tray-app/models/`（唤醒词 + 识别模型，约 2 GB）、`tray-app/app/config.json` 与 `cordis.patch.yml`（本机路径）、`tray-app/desktop/node_modules/`、`xiaoyin-persona/presets/private-*/`（私有业务人设）、`xiaoyin-persona/learning/`（真实对话记录）、`xiaoyin-persona/tools/local_config.py`（真实姓名/群名/台账路径），以及调试截图和日志。清单在 `.gitignore`。
