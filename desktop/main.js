/**
 * 小印浮窗 · 主进程。
 *
 * 职责边界（和旧的 Python 版一一对应）：
 *   窗口/托盘/热键        <- PySide6 那一层
 *   录音/唤醒/分段/识别   <- app/audiohub.py + kws.py + stt.py（现在跑在 Node 里，sherpa-onnx-node 直接用 DSH 自带的那份）
 *   队列通信              <- app/bridge.py
 *   UI                    <- desktop/ui（Web）
 *
 * 它由插件宿主（仓库根 index.js → autostart.js）以 detached 方式拉起，
 * 自己不做自启、不写 app.pid（那是启动器的事），只负责把进程活着、窗口在、耳朵竖着。
 *
 * 测试用环境变量：
 *   XIAOYIN_SHOW=1        启动即显示窗口（平时只在叫出来时显示）
 *   XIAOYIN_SIM_WAV=path  启动后把某个 wav 当实时麦克风喂进来（验证唤醒/识别链路）
 *   XIAOYIN_DATA_DIR=path 换一个队列目录（避免和正在跑的实例抢队列）
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { app, ipcMain, globalShortcut, session, shell } = require('electron')

const { loadConfig, writeKeywordsFile, loadWindowState, saveWindowState } = require('./lib/config')
const { createLogger } = require('./lib/log')
const { Bridge } = require('./lib/bridge')
const { FloatingWindow } = require('./lib/window')
const { TrayController } = require('./lib/tray')
const { VoiceLoop, SAMPLE_RATE } = require('./lib/audio')

const DESKTOP_DIR = __dirname
const PRELOAD = path.join(DESKTOP_DIR, 'preload.js')
const INDEX_HTML = path.join(DESKTOP_DIR, 'ui', 'index.html')

// ---------------------------------------------------------------- 依赖定位

/** 找 sherpa-onnx-node：优先环境变量，其次 DSH 桌面端自带的那份。 */
function resolveSherpa() {
  const candidates = []
  if (process.env.XIAOYIN_SHERPA) candidates.push(process.env.XIAOYIN_SHERPA)
  const fromEnv = process.env.DSH_DESKTOP_APP_ROOT
  if (fromEnv) candidates.push(path.join(fromEnv, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node'))
  candidates.push(
    'C:/Program Files/DSH NEXT/resources/app.asar.unpacked/node_modules/sherpa-onnx-node',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH NEXT', 'resources', 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node'),
    path.join(DESKTOP_DIR, 'node_modules', 'sherpa-onnx-node'),
  )
  for (const dir of candidates) {
    if (!dir) continue
    const entry = path.join(dir, 'sherpa-onnx.js')
    if (fs.existsSync(entry)) return entry
  }
  return ''
}

// ---------------------------------------------------------------- 全局状态

const config = loadConfig()
const log = createLogger(config.logFile)

/** 进程还在不在；EPERM 说明在、只是没权限碰它。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

const messages = []
let messageSeq = 0
let state = {
  phase: 'sleeping',
  level: 0,
  wake: config.wake,
  // 麦克风是不是开着。默认「唤醒词关着也继续采音」：热键叫出来时要靠 600 ms 预录。
  // 用户在设置里打开「唤醒词关闭时释放麦克风」后，这里就跟着 wake 走。
  mic: config.wake || !config.releaseMicWhenWakeOff,
  name: config.name,
  hotkey: String(config.hotkey || 'ctrl+alt+j').toUpperCase(),
  hint: '',
  recordingMs: 0,
  error: '',
}

let windowRef = null
let tray = null
let bridge = null
let loop = null
// requestMic 的超时兜底；见下面「麦克风策略」
let micWatchdog = null
let activeAccelerator = ''
let activeHotkeyRaw = ''
let replyStreaming = false
let idleTimer = null
const audioStats = { frames: 0, samples: 0 }

// ---------------------------------------------------------------- 消息 & 状态推送

function bumpMessage(message) {
  messages.push({ streaming: false, ...message, id: message.id || `m${(messageSeq += 1)}` })
  if (messages.length > 60) messages.splice(0, messages.length - 60)
  pushMessages()
}

function pushMessages() {
  if (!windowRef) return
  windowRef.send('xiaoyin:messages', messages.map((m) => ({ id: m.id, role: m.role, text: m.text, streaming: Boolean(m.streaming) })))
}

function pushState(patch) {
  if (patch) Object.assign(state, patch)
  if (!windowRef) return
  windowRef.send('xiaoyin:state', { ...state })
}

function toast(text, kind = 'info') {
  if (windowRef) windowRef.send('xiaoyin:toast', { text, kind })
}

function setPhase(phase, extra) {
  clearTimeout(idleTimer)
  replyStreaming = phase === 'replying'
  pushState({ phase, recordingMs: 0, error: '', ...(extra || {}) })
}

/**
 * 调试用：把窗口钉在某个状态上，配合 XIAOYIN_SHOT 截图核对界面。
 * XIAOYIN_PHASE=thinking / recording / replying / error / sleeping
 */
function applyDemoPhase() {
  const want = String(process.env.XIAOYIN_PHASE || '').trim()
  if (!want) return
  if (!['sleeping', 'recording', 'thinking', 'replying', 'error'].includes(want)) return
  setPhase(want, want === 'error' ? { error: '示例错误：状态条长这样' } : {})
}

function hintText() {
  const name = String(config.name || '语音助手')
  const hotkey = String(config.hotkey || 'ctrl+alt+j').toUpperCase().replace(/\+/g, '+')
  if (!state.wake) {
    return config.releaseMicWhenWakeOff
      ? `按 ${hotkey} 叫出来（唤醒词已关，麦克风按需开）`
      : `按 ${hotkey} 叫出来（唤醒词已关）`
  }
  return `说「${name}」就能叫出来，或按 ${hotkey}`
}

// ---------------------------------------------------------------- 麦克风策略

/**
 * 麦克风该不该开着。
 * 默认「关唤醒词也继续采音」，因为热键要预录 600 ms，现开麦会丢开头。
 * 只有用户显式打开 releaseMicWhenWakeOff，才把「关唤醒词」等同于「释放麦克风」。
 */
function desiredMicOn() {
  if (!config.releaseMicWhenWakeOff) return true
  return Boolean(state.wake)
}

/** 按策略开/关采音。真正开麦的是渲染进程，这里只改状态并推给它。 */
function applyMicPolicy(reason) {
  const want = desiredMicOn()
  if (want === state.mic) return want
  state.mic = want
  if (!want) {
    if (loop && loop.state === 'recording') loop.cancel()
    // 关麦期间环形缓存不会再进新样本，不清掉的话下次热键会把几分钟前的声音当预录
    if (loop) loop.clearRing()
    state.level = 0
  }
  pushState({ mic: want })
  log(`麦克风${want ? '开' : '关'}（${reason}）`)
  return want
}

/** 策略要求关麦时，热键这一下临时开麦；这一句录完再按策略关回去。 */
function requestMic(reason) {
  if (state.mic) return
  state.mic = true
  pushState({ mic: true })
  log(`麦克风开（${reason}）`)
  // 等采音流搬上来最多 4 秒：设备被别的程序占着、权限被拒时 getOpen 不会回来，
  // 不兜底的话录音会一直挂在 recording（框架里没有帧就不会自己超时）。
  clearTimeout(micWatchdog)
  micWatchdog = setTimeout(() => {
    if (!state.mic || !loop || loop.state !== 'recording') return
    if (loop.capture && loop.capture.samples > 0) return
    log('等麦克风超时，放弃这一句')
    loop.cancel()
    applyMicPolicy('麦克风没打开')
  }, 4000)
}

/**
 * DSH 插件页改了称呼/唤醒词/热键/静音时长后，宿主会重写 runtime.json；
 * 这里重读并尽量不动正在进行的那一句录音。
 */
function applyRuntimeConfig() {
  let next
  try {
    next = loadConfig()
  } catch (error) {
    log(`重读 runtime.json 失败：${error && error.message ? error.message : error}`)
    return
  }

  const nameChanged = next.name !== config.name
  const hotkeyChanged = next.hotkey !== config.hotkey
  const wakeChanged = next.wake !== config.wake
  const wordsChanged = JSON.stringify(next.wakeWords) !== JSON.stringify(config.wakeWords)
  const languageChanged = next.language !== config.language

  Object.assign(config, next)
  state.name = config.name
  state.hotkey = String(config.hotkey || 'ctrl+alt+j').toUpperCase()

  if (nameChanged) {
    if (windowRef) windowRef.setName(config.name)
    if (tray) tray.refresh()
  }

  if (wordsChanged) {
    writeKeywordsFile(config)
    if (loop) loop.reloadKeywords()
  }

  if (languageChanged && loop) loop.reloadRecognizer()

  if (hotkeyChanged) registerShortcut()

  if (wakeChanged) {
    const enabled = loop ? loop.setWake(config.wake) : config.wake
    config.wake = enabled
    state.wake = enabled
    if (tray) tray.setWake(enabled)
  }

  applyMicPolicy('配置更新')

  state.hint = hintText()
  pushState({ name: state.name, hotkey: state.hotkey, wake: state.wake, hint: state.hint })
  log(`运行配置已更新 name=${config.name} hotkey=${config.hotkey} wake=${config.wake} words=${config.wakeWords.map((w) => w.text).join('/')}`)
}

function watchRuntime() {
  try {
    fs.watchFile(config.runtimeFile, { interval: 800 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
      applyRuntimeConfig()
    })
    log(`监听运行配置 ${config.runtimeFile}`)
  } catch (error) {
    log(`监听运行配置失败：${error && error.message ? error.message : error}`)
  }
}

/** 一段时间后自己回到待命态（例如回复结束、错误提示看完）。 */
function returnToSleeping(delayMs = 0) {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (state.phase === 'error') setPhase('sleeping', { error: '' })
    else if (state.phase === 'thinking' || state.phase === 'replying') setPhase('sleeping')
  }, delayMs)
}

// ---------------------------------------------------------------- 队列事件

function handleEvent(event) {
  const type = event && event.type
  if (!type) return
  switch (type) {
    case 'history': {
      const turns = Array.isArray(event.turns) ? event.turns : []
      messages.length = 0
      for (const turn of turns) {
        if (!turn || !turn.text) continue
        messages.push({
          id: `h${(messageSeq += 1)}`,
          role: turn.role === 'user' ? 'user' : 'assistant',
          text: String(turn.text),
          streaming: false,
        })
      }
      pushMessages()
      log(`history 补齐 ${turns.length} 条`)
      return
    }
    case 'user-message': {
      // 插件回放了会话里的人工输入（可能包括用户在 DSH 主窗里说的）
      const text = String(event.text || '').trim()
      if (!text) return
      const last = messages[messages.length - 1]
      if (last && last.role === 'user' && last.text === text) return
      bumpMessage({ role: 'user', text })
      return
    }
    case 'assistant-message': {
      const text = String(event.text || '')
      if (!text) return
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) last.text = text
      else bumpMessage({ role: 'assistant', text, streaming: true })
      pushMessages()
      if (state.phase !== 'replying') setPhase('replying')
      return
    }
    case 'reply-start':
      setPhase('replying')
      return
    case 'done':
    case 'turn-end': {
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') last.streaming = false
      pushMessages()
      setPhase('sleeping')
      return
    }
    case 'error': {
      const message = String(event.message || '出错了')
      log(`插件报错 stage=${event.stage} ${message}`)
      if (state.phase === 'recording') loop.cancel()
      setPhase('error', { error: message })
      toast(message, 'warn')
      returnToSleeping(4000)
      return
    }
    case 'transcript':
      // 自己发出去的文本不用再画一遍
      return
    case 'summon':
      // 用户在 DSH 里点了「叫出小印」：把窗口叫到前台（已在显示也重新聚焦）
      log('收到 summon，显示浮窗')
      showWindow()
      return
    case 'prompt':
      if (event.accepted === false) {
        setPhase('error', { error: 'DSH 没有接住这条消息' })
        returnToSleeping(4000)
      }
      return
    case 'cancelled':
      setPhase('sleeping')
      return
    case 'ready':
    case 'pong':
    case 'listening-done':
    default:
      return
  }
}

// ---------------------------------------------------------------- 提交

function submitTyped(text) {
  const value = String(text || '').trim()
  if (!value) return false
  bridge.submitText(value)
  bumpMessage({ role: 'user', text: value })
  setPhase('thinking')
  return true
}

function submitVoice(text, wavPath) {
  const value = String(text || '').trim()
  if (!value) return false
  bridge.submitVoice(wavPath, value, config.language)
  bumpMessage({ role: 'user', text: value })
  setPhase('thinking')
  return true
}

// ---------------------------------------------------------------- 语音环

function wireVoiceLoop(voiceLoop) {
  voiceLoop.on('level', ({ value }) => {
    state.level = value
    if (state.phase === 'recording') pushState()
  })

  voiceLoop.on('wake', ({ keyword }) => {
    log(`唤醒词：${keyword}`)
    showWindow()
  })

  voiceLoop.on('capture', ({ phase, ms, level, aborted }) => {
    if (phase === 'start') {
      showWindow()
      setPhase('recording', { recordingMs: 0, level: level || 0 })
    } else if (phase === 'tick') {
      pushState({ phase: 'recording', recordingMs: ms, level: level || 0 })
    } else if (phase === 'end') {
      // 按需开麦时，一句话收完（样本已经攒好）就把麦克风还回去
      setTimeout(() => applyMicPolicy('录音结束'), 0)
      if (aborted) {
        // 用户主动取消：窗口留着不动，什么都不发
        if (state.phase === 'recording') {
          setPhase('sleeping')
          toast('已取消，没有发送', 'info')
        }
      } else if (state.phase === 'recording') {
        setPhase('thinking')
      }
    }
  })

  voiceLoop.on('text', ({ text, wavPath }) => {
    log(`识别结果：${text}`)
    if (!submitVoice(text, wavPath)) {
      setPhase('error', { error: '没听清，再说一次？' })
      returnToSleeping(2500)
      return
    }
    toast('已送进会话', 'info')
  })

  voiceLoop.on('empty', ({ reason }) => {
    log(`没听清：${reason}`)
    setPhase('error', { error: '没听清，再说一次？' })
    returnToSleeping(2500)
  })

  voiceLoop.on('error', ({ stage, message }) => {
    log(`语音环错误 ${stage}: ${message}`)
    toast(message, 'warn')
    if (stage === 'kws') {
      state.wake = false
      tray.setWake(false)
      applyMicPolicy('唤醒词不可用')
      pushState({ wake: false, hint: hintText() })
    }
  })
}

// ---------------------------------------------------------------- 窗口

function showWindow() {
  if (!windowRef) return
  windowRef.show()
  // 从 DSH 点按钮叫出来时，窗口常常在别的窗口后面：显式提到前台
  if (typeof windowRef.focus === 'function') windowRef.focus()
  pushState({ hint: hintText(), name: config.name, hotkey: state.hotkey })
  pushMessages()
}

function hideWindow() {
  if (!windowRef) return
  windowRef.hide()
  if (state.phase === 'recording') loop.cancel()
}

// ---------------------------------------------------------------- 主流程

// 这个窗口只画几十个 DOM 节点，用不上 GPU 合成；关掉能少一个 ~90 MB 的 GPU 进程。
app.disableHardwareAcceleration()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(onReady).catch((error) => {
    log(`启动失败：${error && error.stack ? error.stack : error}`)
    app.quit()
  })

  app.on('window-all-closed', (event) => {
    // 托盘常驻：窗口「没了」也不退出（正常情况下窗口压根不会被销毁）
    event.preventDefault()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    // 窗口已经没了就别存：以前这里存过 [0,0]，会把记住的位置抹掉
    if (windowRef && windowRef.win && !windowRef.win.isDestroyed()) {
      const [x, y] = windowRef.win.getPosition()
      const [width, height] = windowRef.win.getSize()
      saveWindowState(config, { pos: [x, y], size: [width, height] })
    }
    if (tray) tray.destroy()
  })
}

async function onReady() {
  log(`启动 electron=${process.versions.electron} node=${process.versions.node} dataDir=${config.dataDir}`)
  fs.mkdirSync(config.dataDir, { recursive: true })
  writeKeywordsFile(config)

  bridge = new Bridge({ dataDir: config.dataDir })
  bridge.ensure()
  bridge.skipHistory()

  const windowState = loadWindowState(config)
  windowRef = new FloatingWindow({
    config,
    log,
    preload: PRELOAD,
    indexPath: INDEX_HTML,
    state: windowState,
    onMoved: (next) => saveWindowState(config, { pos: next.pos, size: next.size }),
    // 页面加载完再补一次状态：启动时 pushState 早于渲染进程订阅，会丢掉称呼/热键。
    onReady: () => {
      pushState({
        name: config.name,
        hotkey: String(config.hotkey || 'ctrl+alt+j').toUpperCase(),
        wake: state.wake,
        hint: hintText(),
      })
      applyDemoPhase()
    },
  })
  windowRef.create()

  state.hint = hintText()

  // 麦克风权限：Electron 默认会弹系统询问，浮窗不希望每次重启都问一遍
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture' || permission === 'mediaKeySystem')
  })

  const sherpaPath = resolveSherpa()
  if (!sherpaPath) {
    log('找不到 sherpa-onnx-node，唤醒/识别不可用（只保留打字与队列）')
    state.wake = false
    windowRef.send('xiaoyin:toast', { text: '找不到本地语音引擎，唤醒词不可用', kind: 'warn' })
    applyMicPolicy('没有语音引擎')
  } else {
    log(`语音引擎：${sherpaPath}`)
    // eslint-disable-next-line import/no-dynamic-require
    const sherpa = require(sherpaPath)
    loop = new VoiceLoop({ config, log, sherpa })
    wireVoiceLoop(loop)
    loop.initEngines()
    state.wake = loop.wakeEnabled
    applyMicPolicy('启动')
  }

  // 开机这一行要能看出「麦克风为什么开着/关着」，排查任务栏图标时只看日志就够
  log(`麦克风策略：唤醒词=${state.wake} 麦克风=${state.mic}（关唤醒词释放麦克风=${config.releaseMicWhenWakeOff}）`)

  tray = new TrayController({
    log,
    logFile: config.logFile,
    config,
    onShow: showWindow,
    onToggleWake: (enabled) => {
      if (!loop) return
      const next = loop.setWake(enabled)
      state.wake = next
      tray.setWake(next)
      applyMicPolicy(next ? '托盘开唤醒' : '托盘关唤醒')
      pushState({ wake: next, hint: hintText() })
    },
    onQuit: () => app.quit(),
  })
  tray.create()
  tray.setWake(state.wake)

  registerShortcut()
  watchRuntime()

  ipcMain.handle('xiaoyin:send', (_event, text) => ({ ok: submitTyped(text) }))
  ipcMain.handle('xiaoyin:hide', () => {
    hideWindow()
    return { ok: true }
  })
  // 拖四边/四角改尺寸：渲染进程按屏幕坐标算好想要的绝对宽高，
  // 主进程只负责夹进合法范围、钉住对边，并顺手把尺寸存下来。
  ipcMain.on('xiaoyin:resize', (_event, width, height, edge) => {
    if (windowRef) windowRef.resizeTo(width, height, edge)
  })
  ipcMain.handle('xiaoyin:focus-session', async () => {
    try {
      // 先递条子再抬窗：宿主要花最多 120ms 扫到队列表，页面半侧再 800ms 取走，
      // 顺序反过来也来得及，但先递能让「抬窗」和「切会话」几乎同时发生。
      // 不带 sessionId：插件自己记得「语音浮窗」是哪一个会话，浮窗没必要也知道。
      bridge.openSession()
      const { focusDshWindow } = require('./lib/focus')
      const result = await focusDshWindow({ log })
      if (!result.ok) {
        toast('没找到 DSH 窗口', 'warn')
        return result
      }
      // 浮窗是 always-on-top：只把 DSH 抬到前台，用户看见的还是这层浮窗，等于「没反应」。
      // 所以抬完把自己收起来，DSH 才真的露出来。
      hideWindow()
      return result
    } catch (error) {
      log(`focus-session 失败：${error && error.message ? error.message : error}`)
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  })
  ipcMain.handle('xiaoyin:set-wake', (_event, enabled) => {
    if (!loop) return { ok: false }
    const next = loop.setWake(Boolean(enabled))
    state.wake = next
    tray.setWake(next)
    applyMicPolicy(next ? '打开唤醒词' : '关闭唤醒词')
    pushState({ wake: next, hint: hintText() })
    return { ok: true, wake: next }
  })
  // 渲染进程启动时先问一次「麦克风该不该开」：策略要求关麦时连 getUserMedia 都不发。
  ipcMain.handle('xiaoyin:mic-state', () => ({ mic: state.mic }))
  ipcMain.handle('xiaoyin:cancel', () => {
    if (loop && loop.cancel()) return { ok: true, action: 'cancel-recording' }
    bridge.cancel()
    setPhase('sleeping')
    return { ok: true, action: 'cancel-reply' }
  })
  // 界面上的「停止录音」：说的是停这一句、照常送出去，不是把这段丢掉（那是 Esc / cancel）。
  ipcMain.handle('xiaoyin:stop-recording', () => {
    const stopped = Boolean(loop && loop.stop())
    return { ok: true, stopped }
  })
  ipcMain.handle('xiaoyin:audio-start', () => {
    log('渲染进程申请麦克风')
    return { ok: true, sampleRate: SAMPLE_RATE, device: '' }
  })
  ipcMain.handle('xiaoyin:audio-stop', () => {
    log('渲染进程释放麦克风')
    // 渲染进程开麦失败（权限被拒、设备被占）也会走到这里：别让录音卡在 recording
    if (loop && loop.state === 'recording') loop.cancel()
    return { ok: true }
  })
  ipcMain.on('xiaoyin:audio', (_event, samples, sampleRate) => {
    // 假麦克风模式下别把真麦克风的声音也混进来，两路一起进会直接听不清
    if (process.env.XIAOYIN_SIM_WAV) return
    audioStats.frames += 1
    audioStats.samples += samples && samples.length ? samples.length : 0
    if (loop) loop.push(samples, sampleRate)
    else if (state.phase === 'recording') setPhase('sleeping')
  })

  if (process.env.XIAOYIN_DEBUG_AUDIO === '1') {
    setInterval(() => {
      log(`[audio] ${audioStats.frames} 帧 / ${(audioStats.samples / SAMPLE_RATE).toFixed(1)}s（近期），电平=${state.level.toFixed(3)}`)
      audioStats.frames = 0
      audioStats.samples = 0
    }, 3000)
  }

  // 队列事件轮询（和插件侧 POLL_MS 同频）
  const timer = setInterval(() => {
    for (const event of bridge.poll()) handleEvent(event)
  }, 120)

  app.on('will-quit', () => clearInterval(timer))

  // 宿主看门狗：DSH 正常退出时插件会直接把本进程结束掉；这里兜住宿主崩溃/被强杀的情况，
  // 免得留下一个对着没人应的浮窗。runtime.json 里没有 hostPid（老版本宿主）时不启用。
  const hostTimer = setInterval(() => {
    const pid = Number(config.hostPid) || 0
    if (!pid || isProcessAlive(pid)) return
    log(`宿主进程 ${pid} 已不在，浮窗跟着退出`)
    clearInterval(hostTimer)
    app.quit()
  }, 2000)
  app.on('will-quit', () => clearInterval(hostTimer))

  // 启动时问一次会话要历史，浮窗晚开也不会空白
  bridge.syncHistory()
  pushState({ phase: 'sleeping', hint: state.hint, wake: state.wake, name: state.name, hotkey: state.hotkey })

  if (process.env.XIAOYIN_SHOW === '1') showWindow()
  if (process.env.XIAOYIN_SIM_WAV) startSimulatedMic(process.env.XIAOYIN_SIM_WAV)
  if (process.env.XIAOYIN_SHOT) captureShot(process.env.XIAOYIN_SHOT)

  log(`浮窗就绪 pid=${process.pid} wake=${state.wake}`)
}

function registerShortcut() {
  const raw = String(config.hotkey || 'ctrl+alt+j')
  const accelerator = raw
    .split('+')
    .map((part) => {
      const key = part.trim().toLowerCase()
      if (key === 'ctrl' || key === 'control') return 'Control'
      if (key === 'alt') return 'Alt'
      if (key === 'shift') return 'Shift'
      if (key === 'win' || key === 'meta' || key === 'super') return 'Super'
      return key.toUpperCase()
    })
    .join('+')

  if (activeAccelerator && accelerator === activeAccelerator) return

  const ok = globalShortcut.register(accelerator, () => {
    if (state.phase === 'recording' && windowRef.isVisible()) {
      loop.cancel()
      return
    }
    showWindow()
    if (!loop || state.phase === 'recording') return
    // 唤醒词关掉且用户选择了释放麦克风：热键这一下才临时开麦。
    // 代价是没有预录（环形缓存是空的），开口太急的话头一两个字可能缺一点。
    if (!state.mic) requestMic('热键')
    if (!loop.beginCapture('hotkey')) applyMicPolicy('热键没能开录')
  })
  if (ok) {
    // 先试新的、再放旧的：新热键被别的程序占了也不会把手上能用的那个弄丢。
    if (activeAccelerator && activeAccelerator !== accelerator) {
      try { globalShortcut.unregister(activeAccelerator) } catch { /* 已经没了 */ }
    }
    activeAccelerator = accelerator
    activeHotkeyRaw = raw
    log(`全局热键 ${accelerator} 注册成功`)
    return
  }

  log(`全局热键 ${accelerator} 注册失败（可能被别的程序占用）`)
  if (activeAccelerator && windowRef) {
    // 退回上一把还能用的热键，别让用户改错一次就彻底没有热键。
    config.hotkey = activeHotkeyRaw
    state.hotkey = activeHotkeyRaw.toUpperCase()
    windowRef.send('xiaoyin:toast', { text: `热键 ${accelerator} 被占用，仍使用 ${state.hotkey}`, kind: 'warn' })
  } else if (windowRef) {
    windowRef.send('xiaoyin:toast', { text: `热键 ${accelerator} 被占用`, kind: 'warn' })
  }
}

// ---------------------------------------------------------------- 调试：wav 解析

/** 够用的 wav 读取：RIFF 分块找 fmt/data，只吃 16 bit PCM。 */
function readWav(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 wav 文件')
  }
  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bits = 16
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    offset = body + size + (size % 2)
  }
  if (!data) throw new Error('wav 里没有 data 块')
  if (bits !== 16) throw new Error(`只支持 16 bit，这里是 ${bits}`)
  const frames = Math.floor(data.length / 2 / channels)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((i * channels + c) * 2)
    samples[i] = sum / channels / 32768
  }
  return { samples, sampleRate }
}

// ---------------------------------------------------------------- 调试：截屏

/** 等页面画好，把窗口内容存成 png，用来肉眼检查排版（透明窗口，png 带 alpha）。 */
function captureShot(file) {
  const win = windowRef.win
  if (!win) return
  const shoot = () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        fs.writeFileSync(file, image.toPNG())
        log(`[shot] ${file}`)
      } catch (error) {
        log(`[shot] 失败：${error && error.message ? error.message : error}`)
      }
      if (process.env.XIAOYIN_SHOT_QUIT === '1') app.quit()
    }, Number(process.env.XIAOYIN_SHOT_DELAY || 900))
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', shoot)
  else shoot()
}

// ---------------------------------------------------------------- 调试：假麦克风

/** 把一段 wav 按 20 ms 一块、实时速度喂给语音环，用来验证「唤醒词→识别→入队」。 */
function startSimulatedMic(wavPath) {
  try {
    // 不用 sherpa.readWave：它返回的是 C++ 外部内存，Electron 直接报 "External buffers are not allowed"
    const wave = readWav(wavPath)
    const samples = wave.samples
    log(`[sim] 载入 ${wavPath} ${(samples.length / wave.sampleRate).toFixed(2)}s`)
    if (process.env.XIAOYIN_SIM_CAPTURE === '1') {
      // 绕过唤醒词，直接开始录一句（验证「分段→识别→入队」）
      setTimeout(() => loop && loop.beginCapture('hotkey'), 600)
    }
    let offset = 0
    const step = 320
    // 尾巴补 1.6s 静音，方便验证「静音到点自动收尾」这条路径
    const tail = new Float32Array(SAMPLE_RATE * 1.6)
    const total = samples.length + tail.length
    const timer = setInterval(() => {
      if (offset >= total) {
        clearInterval(timer)
        log('[sim] 播放结束')
        return
      }
      if (!loop) return
      const chunk = offset < samples.length
        ? samples.subarray(offset, Math.min(offset + step, samples.length))
        : tail.subarray(0, Math.min(step, total - offset))
      loop.push(chunk, wave.sampleRate)
      offset += step
    }, 20)
    if (process.env.XIAOYIN_SHOW !== '1') showWindow()
  } catch (error) {
    log(`[sim] 失败：${error && error.stack ? error.stack : error}`)
  }
}
