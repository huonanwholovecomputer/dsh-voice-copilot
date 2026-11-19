# tray-app · 托盘常驻的浮窗

浮窗就是那个常驻托盘的小窗：听唤醒词、录音、本地识别、显示 DSH 的回答。它是独立进程，但生命周期跟着 DSH 走——插件 `apply()` 里把它拉起来，DSH 退出时停掉；宿主崩溃时它靠 `runtime.json` 里的 `hostPid` 心跳自己退出。

两套实现，协议完全一样：

| 目录 | 实现 | 什么时候用 |
| --- | --- | --- |
| `desktop/` | Electron（CommonJS） | 默认。自带 Electron 的独立进程，界面是 HTML/CSS，改 UI 不用重启桌面端 |
| `app/` | PySide6 | 只有找不到 Electron 时才回退；需要 Python + PySide6 + sherpa-onnx |
| `models/` | 模型文件 | 唤醒词 + SenseVoice + 声纹 + 未采用的 FireRedASR2，约 2 GB，gitignore |
| `启动语音浮窗.vbs` | 手动启动脚本 | 不打 DSH 也能单独起浮窗调试 |

## 启动

- 正常路径：DSH 启动 → 插件 `autostart.js` 找 Electron → detached spawn（无控制台窗口）→ 写 `<dataDir>/app.pid`。
- 手动：双击 `启动语音浮窗.vbs`。脚本以**自己所在目录**为基准，按顺序找 Electron：`%DSH_VOICE_COPILOT_ELECTRON%` → `tray-app/desktop/node_modules/electron/dist/electron.exe` → `%USERPROFILE%\.dsh\electron\electron.exe`，要求 `tray-app/desktop/main.js` 存在，然后以 `cwd=tray-app/desktop` 运行。再点一次不会开第二个窗口，只会把已有的叫到前台。
- 避免重复：先看 `app.pid` 里的进程还活着没，Electron 单实例锁兜底。
- 优先级：两个 DSH 安装同时开着时，只有租约持有者会拉起浮窗（见根 README）。浮窗启动时拿到 `XIAOYIN_OWNER_INSTANCE`，每 2 s 比对 `lease.json`，租约换人或心跳过期就自己退出，不留孤儿窗口。

`desktop/` 自带的 `npm i` 只是为了装 Electron；识别用的原生模块不在里面。

## 进程分工（`desktop/`）

| 进程 | 文件 | 干什么 |
| --- | --- | --- |
| 主进程 | `main.js` + `lib/{config,bridge,audio,endpoint,window,tray,focus,pinyin,voiceprint,log}.js` | 建窗、托盘、热键、采音收尾、跑 sherpa 识别、读写文件队列 |
| 渲染进程 | `ui/{index.html,style.css,app.js,pcm-worklet.js}` | 画面与输入；`getUserMedia` 采 16 kHz 单声道，AudioWorklet 128 帧一块推给主进程 |
| preload | `preload.js` | 只开 `window.xiaoyin` 一组方法，`contextIsolation: true` / `nodeIntegration: false` |

渲染层与主进程的接口契约写在 [desktop/CONTRACT.md](desktop/CONTRACT.md)：能力全从 `window.xiaoyin` 走，preload 由主进程维护。

## 窗口行为

- 默认 720×520、圆角、透明、无边框、置顶（`screen-saver` 级）。四条边和四个角都能拖（最小 420×320），尺寸记在 `window.json` 的 `size` 里。
- 没开 BrowserWindow 的原生 `resizable`——透明窗口开原生缩放会把透明和圆角打坏；改成 UI 里铺 8 个隐形把手，走 `xiaoyin.resize()` 让主进程 `setBounds`。
- **隐藏不是 `win.hide()`**，是 `setOpacity(0)` + 鼠标穿透——真隐藏会让渲染进程被节流，Web Audio 掉帧。
- 窗口拖不动，位置按 `window.json` 恢复，只在跑出屏幕时才被拉回来。

## 麦克风与唤醒词

默认只开一路、常驻：渲染进程一直采，主进程里既做唤醒词、又做命令录音，所以「听见小印」到「开始录」中间不丢音。

1. 每 20 ms 把新采到的音频喂给 sherpa-onnx 流式关键词模型（3.3M zipformer，拼音建模），说完「小印」当场命中，不等静音。
2. 命中就把最近 150 ms 一起带上开录（连读「小印，今天有什么安排」不丢半句）；热键则带 600 ms 预录。
3. 转写后去掉开头的唤醒词，送进会话的是干净指令。录音期间不再做唤醒检测；`Esc` 取消后回到监听（窗口留着）。
4. 勾上「关唤醒词时释放麦克风」改成按需：关唤醒就 `track.stop()`（任务栏图标灭），热键时临时开麦、录完再放——代价是没有预录。

唤醒词的拼音由 `desktop/data/pinyin.json` 生成到 `<dataDir>/keywords.txt`（一行一个，`x iǎo y ìn @小印`）；改称呼时宿主重写 `runtime.json`，浮窗收到后重建词表，不需要重启。

## 识别引擎

- 引擎不另装：直接 require 宿主安装目录里的 `resources/app.asar.unpacked/node_modules/sherpa-onnx-node`（N-API 原生模块，Electron 里能直接加载）。路径由 `autostart.js` 通过 `XIAOYIN_SHERPA` 传给浮窗，不写死 DSH NEXT 的安装路径。
- 模型：SenseVoice int8（`tray-app/app/config.json` 的 `model` / `tokens`，239 MB）。带标点、数字规整，CPU 上 10 秒音频约 0.3 秒，加载 1.5–1.8 秒。
- `desktop/` 只认 SenseVoice；`stt_engine` 等键只对 Python 回退版有效。FireRedASR2 int8 模型在 `models/` 里（`fire-red-asr2-int8/`、`fire-red-asr2-ctc-int8/`），但同样三条测试音上没稳定比 SenseVoice 准，CPU 还慢一个量级，所以默认没换。GPU 用不上：DSH 带的 sherpa-onnx 是 CPU-only 构建。

## 端点

录音靠能量阈值判一句说完（`lib/endpoint.js`，RMS `0.012`；`autoGainControl` 关掉了——开着会把底噪放大到 0.99，整段被误判成「有人在说」）。比真正的 VAD 粗，环境特别吵时可能把噪声当一句话送进去。

## 声纹（只认机主）

`lib/voiceprint.js` 用的是同一份 sherpa-onnx 运行时的 `SpeakerEmbeddingExtractor`：唤醒后算这一句和 `voiceprints/owner.json` 里 192 维模板的相似度，低于阈值（默认 `0.5`）就停住问「仍然发送 / 丢弃」。模型 `models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` 不在时提示不可用、其余照常。这是便利性过滤，不是安全认证。

## 和宿主怎么通信

`lib/bridge.js`：浮窗把识别结果连同 wav 路径写成 `<dataDir>/queue/<ts>.json`，轮询 `<dataDir>/events/` 拿回答与状态；另外写 `control/`（`{kind:'open'}` 请宿主切会话、`takeover.json` 请求交出租约）。不开端口、不碰 DSH 的 HTTP 鉴权。

浮窗被收起或退出后，从 DSH 里点「叫出小印」也能把它叫回来：宿主写一条控制消息，`autostart.js` 发现进程不在就现拉一个。

## 日志与自测

- 浮窗日志在 `<dataDir>/window.log`（麦克风策略、唤醒命中、端点、识别耗时都在里面）；DSH 插件日志里有一行 `floating window autostart {...}`。
- 环境变量（都只影响一次启动）：

| 变量 | 作用 |
| --- | --- |
| `XIAOYIN_SHOW=1` | 启动就显示窗口，不用按热键 |
| `XIAOYIN_SIM_WAV=<wav>` | 按 20 ms 一帧实时喂一段 wav，替掉真麦克风（末尾自动补 1.6 s 静音） |
| `XIAOYIN_SIM_CAPTURE=1` | 600 ms 后直接开录，绕过唤醒词 |
| `XIAOYIN_DEBUG_AUDIO=1` | 每 3 s 打一行音频帧统计和电平 |
| `XIAOYIN_SHOT=<png>` | 把窗口截成图（`XIAOYIN_SHOT_QUIT=1` 截完退出） |
| `XIAOYIN_PHASE=thinking` | 起来就把状态设成指定阶段（`sleeping`/`recording`/`thinking`/`replying`/`error`），配合截图看状态条 |
| `XIAOYIN_DATA_DIR=<dir>` | 换一套队列目录（autostart 会自动带上真实的那套） |
| `XIAOYIN_SHERPA=<path>` | 指定 sherpa-onnx-node 模块位置 |

- 自己拉起来调试：`node --input-type=module -e "import {startFloatingWindow} from './voice-assistant/autostart.js'; console.log(startFloatingWindow())"`。
- 探测脚本在 `../voice-assistant/tools/`（`probe_wake*.py`、`_snap*.py`、`_shot*.ps1`、`make_test_wav.py`）。

## `app/`（PySide6 回退）

`main.py`（窗口与流程）、`audiohub.py`（采音）、`kws.py`（唤醒词）、`stt.py`（SenseVoice / FireRed）、`bridge.py`（队列协议）、`winfocus.py`（回到会话）。

- 配置：`config.example.json` 复制成 `config.json`（gitignore）。`hotkey` / `wake_words` 只在 `runtime.json` 不存在时作兜底；`model` / `tokens` / `firered_model_dir` / `firered_ctc_model_dir` 指模型位置。
- 单实例名 `Local\dsh-voice-copilot`，和 Electron 版互斥（同一时间只能有一个在听）。

## 模型（`models/`）

| 目录/文件 | 干什么 |
| --- | --- |
| `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/` | 唤醒词（流式关键词识别） |
| `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` | 声纹（约 28 MB，取自 sherpa-onnx 的 speaker-recognition-models release） |
| `fire-red-asr2-int8/`、`fire-red-asr2-ctc-int8/` | FireRedASR2，仅 Python 回退版可换，默认不用 |
| `keywords.txt` | 唤醒词表（可随时由拼音表重建） |

SenseVoice 本体的模型/词表在 `%APPDATA%/WeQ`（本机），不在仓库里；`models/` 整个被 gitignore，换机器自己拷。
