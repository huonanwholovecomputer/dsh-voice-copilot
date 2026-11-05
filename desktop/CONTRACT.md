# DSH 语音助手浮窗 · 渲染层契约（desktop/ui ↔ desktop/main.js）

渲染进程**没有** Node 权限（`contextIsolation: true`、`nodeIntegration: false`）。
所有能力都从 `window.xiaoyin` 走，preload 由主进程侧维护（`desktop/preload.js`）。
**渲染层只做三件事**：画界面、把麦克风转成 16 kHz 单声道 Float32 推给主进程、把用户操作发回主进程。
识别（KWS / SenseVoice）、队列通信、窗口与托盘全部在主进程。

## 1. 主进程 → 渲染层

### 1.1 `xiaoyin.onState(cb)` → 退订函数
状态变化时回调，参数：

```ts
{
  phase: 'sleeping' | 'recording' | 'thinking' | 'replying' | 'error'
  level: number          // 0..1，当前麦克风电平（RMS 归一化后，已做平滑）
  wake: boolean          // 唤醒词监听是否开启
  hint: string           // 一行小字，例如「说「小印」就能叫出来，或按 Ctrl+Alt+J」
  name: string           // 当前称呼（插件页可改），用于品牌字
  hotkey: string         // 当前热键的显示形式，例如 Ctrl+Alt+J
  recordingMs: number    // recording 阶段已录时长；其它阶段为 0
  error: string          // phase==='error' 时的说明，否则为空串
}
```

phase 语义：
- `sleeping`：窗口已弹出但还没开始录（等待唤醒词/热键/输入）。
- `recording`：正在录这一句。`level` 要驱动波形跳动。
- `thinking`：已送进 DSH，等第一个字。
- `replying`：助手正在流式回话。
- `error`：出错了，`error` 里是给人看的一句话；几秒后主进程会自己退回 `sleeping`。

### 1.2 `xiaoyin.onMessages(cb)` → 退订函数
每次历史变化推**全量**数组（最多 60 条，直接整体重渲染即可）：

```ts
Array<{
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  streaming: boolean     // true 表示这条还在流式增长（末尾可加光标/省略号）
}>
```

用户说过的话（`user`）、助手回的话（`assistant`）、系统提示（`system`，例如「正在听…」「没听清」）。

### 1.3 `xiaoyin.onToast(cb)` → 退订函数
轻提示，`{ text: string, kind: 'info' | 'warn' }`，用于「已复制」「不在 DSH 会话里」这类一次性反馈。

## 2. 渲染层 → 主进程

| 方法 | 说明 |
| --- | --- |
| `xiaoyin.send(text)` | 用户敲进输入框后提交（主进程负责入队 + 显示为 user 气泡）。空串忽略。 |
| `xiaoyin.hide()` | 收起窗口（回到 `sleeping`，唤醒词继续听）。 |
| `xiaoyin.focusSession()` | 「回到会话」：请宿主把 DSH 切到「语音浮窗」会话（队列 `{kind:'open'}`），把 DSH 主窗口切到前台，然后把浮窗收起来（不然置顶的浮窗挡住，用户看不出变化）。 |
| `xiaoyin.setWake(on)` | 开/关唤醒词监听。 |
| `xiaoyin.cancel()` | 取消当前录音或打断当前回复。 |
| `xiaoyin.audio.start()` | 申请麦克风并开始推流，`Promise<{ ok: boolean, sampleRate: number, device: string, error?: string }>`。 |
| `xiaoyin.audio.stop()` | 停止推流并释放麦克风。 |
| `xiaoyin.audio.push(samples, sampleRate)` | 推一段 **Float32** 单声道 PCM（值域 -1..1）。 |

## 3. 采音要求（渲染层实现）

- `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`。
- `new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })`；用 `AudioWorkletNode` 挂 `ui/pcm-worklet.js`，每个 process 块把 128 帧 `Float32Array` postMessage 出来。
- 若实际 `audioContext.sampleRate !== 16000`，用 `xiaoyin.audio.push(samples, ctx.sampleRate)` 把真实采样率一并带上，主进程负责重采样（不要在渲染层重采样）。
- 推流要持续（窗口隐藏时也在推），`level` 由主进程算，渲染层不要自己算。
- 页面加载完成后**自动**调用一次 `xiaoyin.audio.start()`；失败就在状态行显示「麦克风不可用：<error>」，并允许用户点一下重试。

## 4. 关键交互

- `Enter` 发送，`Shift+Enter` 换行，`Esc` 暂停当前这一下（停录 / 打断回复），**不收起窗口**。
- 头部整条可拖动（`-webkit-app-region: drag`），按钮/输入框必须 `no-drag`。
- 窗口 **720×520**，透明、无边框、圆角 18px；内容不许溢出，正文区自己滚动。
- 关闭按钮 `×` 调 `xiaoyin.hide()`（**不是**退出程序）。
- 不要自己写 `window.close()`，不要开 `target=_blank`。
