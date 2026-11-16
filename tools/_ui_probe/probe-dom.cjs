// 临时探针：验证「正在思考」出现/消失的时机（不靠肉眼截图，直接读 DOM 状态）。
// 用法：electron.exe tools/_ui_probe/probe-dom.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..', 'desktop')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const stubs = {
  'xiaoyin:send': () => ({ ok: true }),
  'xiaoyin:hide': () => ({ ok: true }),
  'xiaoyin:focus-session': () => ({ ok: true }),
  'xiaoyin:set-wake': () => ({ ok: true }),
  'xiaoyin:cancel': () => ({ ok: true }),
  'xiaoyin:stop-recording': () => ({ ok: true }),
  'xiaoyin:voiceprint-status': () => ({ enrolled: true, profile: { name: '机主' }, count: 3 }),
  'xiaoyin:voiceprint-enroll': () => ({ ok: false }),
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
  { role: 'assistant', text: '打印工具还是连不上：端口 47610 拒绝连接。' },
  { role: 'user', text: '嗯嗯。' },
]
const reply = { role: 'assistant', text: '好，等你把程序打开后告诉我一声，我就去核对那一单。' }
const stateOf = (phase) => ({
  phase, level: 0, wake: true, mic: false, name: '小印', hotkey: 'Ctrl+Alt+J',
  hint: '说「小印」就能叫出来，或按 Ctrl+Alt+J', recordingMs: 0, error: '',
})

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 720, height: 520, show: false, frame: false, transparent: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  await win.loadFile(path.join(ROOT, 'ui', 'index.html'))
  const probe = (label) => win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.thinking')
      return JSON.stringify({
        label: ${JSON.stringify(label)},
        exists: !!el,
        on: !!el && el.classList.contains('on'),
        pill: !!(document.getElementById('status') || {}).classList?.contains('on'),
      })
    })()`,
  ).then((v) => console.log(v))

  // 场景 A：真的在等答复 —— 240ms 后才亮
  win.webContents.send('xiaoyin:messages', base)
  win.webContents.send('xiaoyin:state', stateOf('thinking'))
  await sleep(60)
  await probe('A@60ms 应该还没亮')
  await sleep(380)
  await probe('A@440ms 应该亮了')

  // 场景 B：刚亮的尾巴上回复到了 —— 立刻消失
  win.webContents.send('xiaoyin:state', stateOf('replying'))
  win.webContents.send('xiaoyin:messages', base.concat([reply]))
  await sleep(80)
  await probe('B@80ms 应该已消失')

  // 场景 C：收尾 done→thinking 紧跟 turn-end —— 全程不该闪
  win.webContents.send('xiaoyin:state', stateOf('thinking'))
  await sleep(60)
  await probe('C@60ms 不该闪')
  win.webContents.send('xiaoyin:state', stateOf('sleeping'))
  await sleep(260)
  await probe('C@320ms 不该闪')

  // 场景 D：流式输出中 —— 不叠这行
  win.webContents.send('xiaoyin:messages', base.concat([{ ...reply, streaming: true }]))
  win.webContents.send('xiaoyin:state', stateOf('replying'))
  await sleep(320)
  await probe('D@320ms 流式时不该亮')
  win.webContents.send('xiaoyin:state', stateOf('sleeping'))
  await sleep(60)
  await probe('D 收尾后不该亮')

  // 场景 E：说完一段、开始跑工具（done→thinking）—— 240ms 后应该重新亮
  win.webContents.send('xiaoyin:messages', base.concat([reply]))
  win.webContents.send('xiaoyin:state', stateOf('thinking'))
  await sleep(60)
  await probe('E@60ms 工具刚开跑，还不亮')
  await sleep(300)
  await probe('E@360ms 工具跑着，应该亮')
  win.webContents.send('xiaoyin:state', stateOf('sleeping'))
  await sleep(60)
  await probe('E 收尾后不该亮')

  app.quit()
})
