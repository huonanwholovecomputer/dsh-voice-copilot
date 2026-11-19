// 临时探针：把 desktop/ui 单独跑起来塞假数据，用来截图看界面状态。
// 用法：electron.exe tools/_ui_probe/probe.cjs <输出前缀> [thinking|streaming|sleeping]
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..', '..', 'desktop')
const PREFIX = process.argv[2] || path.join(__dirname, 'shot')
const SCENE = process.argv[3] || 'thinking'

const stubs = {
  'xiaoyin:send': () => ({ ok: true }),
  'xiaoyin:snapshot': () => snapPayload,
  'xiaoyin:hide': () => ({ ok: true }),
  'xiaoyin:focus-session': () => ({ ok: true }),
  'xiaoyin:set-wake': () => ({ ok: true }),
  'xiaoyin:cancel': () => ({ ok: true }),
  'xiaoyin:stop-recording': () => ({ ok: true }),
  'xiaoyin:voiceprint-status': () => (SCENE === 'vp-enroll'
    ? { available: true, enabled: true, enrolled: false, threshold: 0.5, reason: '' }
    : { enrolled: true, profile: { name: '机主' }, count: 3 }),
  'xiaoyin:voiceprint-enroll': () => (SCENE === 'vp-enroll' ? { ok: true, want: 3 } : { ok: false }),
  'xiaoyin:voiceprint-cancel': () => ({ ok: true }),
  'xiaoyin:voiceprint-accept': () => ({ ok: true }),
  'xiaoyin:voiceprint-drop': () => ({ ok: true }),
  'xiaoyin:voiceprint-remove': () => ({ ok: true }),
  'xiaoyin:audio-start': () => ({ ok: false, error: 'probe' }),
  'xiaoyin:audio-stop': () => ({ ok: true }),
  'xiaoyin:mic-state': () => ({ mic: false }),
}
for (const [ch, fn] of Object.entries(stubs)) ipcMain.handle(ch, fn)
ipcMain.on('xiaoyin:resize', () => {})
ipcMain.on('xiaoyin:audio', () => {})

const base = [
  { role: 'user', text: '帮我查一下张三那单打印没' },
  { role: 'assistant', text: '打印工具还是连不上：端口 47610 拒绝连接。你把「HN打印工具」重新打开，再把「设置 → 智能助手接口」开关拨上，我再复核。' },
  { role: 'user', text: '嗯嗯。' },
]

function sceneOf(name) {
  if (name === 'streaming') {
    return {
      messages: base.concat([{ role: 'assistant', text: '好，等你把程序打开后告诉我一声，我就去核对那一单。', streaming: true }]),
      phase: 'replying',
    }
  }
  if (name === 'sleeping') {
    return {
      messages: base.concat([{ role: 'assistant', text: '好，等你把程序打开后告诉我一声，我就去核对那一单。' }]),
      phase: 'sleeping',
    }
  }
  return { messages: base, phase: 'thinking' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let snapPayload = { state: {}, messages: [] }

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 720,
    height: 520,
    show: true,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const scene = sceneOf(SCENE)
  const state = {
    phase: scene.phase,
    level: 0,
    wake: true,
    mic: false,
    name: '小印',
    hotkey: 'Ctrl+Alt+J',
    hint: '说「小印」就能叫出来，或按 Ctrl+Alt+J',
    recordingMs: 0,
    error: '',
  }
  // 快照得在页面 load 之前就备好：boot() 在 DOMContentLoaded 里就会来问
  snapPayload = { state, messages: scene.messages }
  await win.loadFile(path.join(ROOT, 'ui', 'index.html'))
  // snapshot 场景：事件在订阅前就丢了，只靠启动快照补数据
  if (SCENE !== 'snapshot') {
    win.webContents.send('xiaoyin:messages', scene.messages)
    win.webContents.send('xiaoyin:state', state)
  }
  // blip：模拟收尾时 done→thinking 紧跟 turn-end，确认不会闪一下「正在思考」
  if (SCENE === 'blip') {
    await sleep(80)
    win.webContents.send('xiaoyin:messages', base.concat([{ role: 'assistant', text: '好，等你把程序打开后告诉我一声，我就去核对那一单。' }]))
    win.webContents.send('xiaoyin:state', { ...state, phase: 'sleeping' })
  }
  // vp-enroll：走一遍「声纹 → 录制 3 句」，并让主进程按 10Hz 推秒数，看面板里的实时计时
  if (SCENE === 'vp-enroll') {
    await sleep(400)
    await win.webContents.executeJavaScript(`document.getElementById('voiceprintBtn').click()`, true)
    await sleep(400)
    await win.webContents.executeJavaScript(`document.getElementById('vpPrimary').click()`, true)
    await sleep(300)
    for (let i = 1; i <= 24; i += 1) {
      win.webContents.send('xiaoyin:state', { ...state, phase: 'recording', recordingMs: i * 100 })
      await sleep(100)
    }
  }
  await sleep(SCENE === 'blip' ? 60 : SCENE === 'vp-enroll' ? 120 : 900)
  const frames = SCENE === 'thinking' || SCENE === 'blip' ? 3 : SCENE === 'vp-enroll' ? 2 : 1
  for (let i = 0; i < frames; i += 1) {
    const img = await win.webContents.capturePage()
    const out = `${PREFIX}-${SCENE}-${i}.png`
    fs.writeFileSync(out, img.toPNG())
    console.log('saved', out)
    if (SCENE === 'vp-enroll') {
      win.webContents.send('xiaoyin:state', { ...state, phase: 'recording', recordingMs: 4200 })
      await sleep(150)
      continue
    }
    if (i < frames - 1) await sleep(SCENE === 'blip' ? 70 : 320)
  }
  app.quit()
})
