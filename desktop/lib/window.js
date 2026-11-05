/**
 * 浮窗本体：一个透明、无边框、置顶、不进任务栏的 BrowserWindow。
 *
 * 这些参数是照 dsh-pet 的 runtime/electron-helper/main/windows.js 抄的——
 * 透明置顶窗口在 Windows 上真正的坑（置顶被抢、任务栏残留、DPI、
 * 鼠标穿透）那边都踩过一遍了。
 *
 * 隐藏方式刻意用「透明度 0 + 鼠标穿透」而不是 win.hide()：
 * 页面一旦真的被隐藏，Web Audio 采音和 AudioWorklet 会被浏览器节流甚至挂起，
 * 唤醒词就听不见了。常驻一个透明窗口的代价是内存，换来的是采音不断。
 */
'use strict'

const path = require('node:path')
const { BrowserWindow, screen } = require('electron')

const UI_WIDTH = 720
const UI_HEIGHT = 520

class FloatingWindow {
  constructor({ config, log, preload, indexPath, state, onMoved, onReady }) {
    this.config = config
    this.log = log
    this.preload = preload
    this.indexPath = indexPath
    this.state = state || {}
    this.onMoved = onMoved
    this.onReady = onReady
    this.win = null
    this.visible = false
    this._saveTimer = null
  }

  create() {
    const { x, y } = this._initialBounds()
    this.win = new BrowserWindow({
      width: UI_WIDTH,
      height: UI_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: this.config.name || '语音助手',
      icon: path.join(__dirname, '..', 'assets', 'app-256.png'),
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setMenuBarVisibility(false)
    // 初始就当作「隐藏」：透明 + 鼠标穿透，等真正叫出来再恢复。
    this.win.setOpacity(0)
    this.win.setIgnoreMouseEvents(true, { forward: true })

    this.win.loadFile(this.indexPath).catch((error) => {
      this.log(`加载界面失败：${error && error.message ? error.message : error}`)
    })

    this.win.on('move', () => this._scheduleSave())
    this.win.on('resize', () => this._scheduleSave())
    this.win.webContents.on('did-finish-load', () => {
      if (this.onReady) this.onReady()
    })
    this.win.on('closed', () => {
      this.win = null
    })
    this.win.webContents.on('render-process-gone', (_event, details) => {
      this.log(`渲染进程退出：${JSON.stringify(details)}`)
    })
    this.win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) this.log(`[renderer] ${message}`)
    })
    return this.win
  }

  _initialBounds() {
    const primary = screen.getPrimaryDisplay().workArea
    const saved = this.state.pos
    if (Array.isArray(saved) && saved.length === 2) {
      const clamped = this._clamp(saved[0], saved[1])
      if (clamped) return clamped
    }
    // 默认：主屏底部居中，离底边 24 px（和原来 Python 版的位置习惯一致）
    const x = Math.round(primary.x + (primary.width - UI_WIDTH) / 2)
    const y = Math.round(primary.y + primary.height - UI_HEIGHT - 24)
    const display = screen.getPrimaryDisplay()
    this.log(`屏幕 workArea=${display.workArea.width}x${display.workArea.height}+${display.workArea.x}+${display.workArea.y} scale=${display.scaleFactor} 窗口=${x},${y}`)
    return { x, y }
  }

  _clamp(x, y) {
    const point = { x: Math.round(x), y: Math.round(y) }
    const display = screen.getDisplayNearestPoint(point)
    const area = display.workArea
    const clampedX = Math.min(Math.max(point.x, area.x - 40), area.x + area.width - UI_WIDTH + 40)
    const clampedY = Math.min(Math.max(point.y, area.y - 20), area.y + area.height - UI_HEIGHT + 20)
    return { x: Math.round(clampedX), y: Math.round(clampedY) }
  }

  _scheduleSave() {
    if (!this.win) return
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      if (!this.win || this.win.isDestroyed()) return
      const [x, y] = this.win.getPosition()
      this.state.pos = [x, y]
      if (this.onMoved) this.onMoved(this.state)
    }, 400)
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }

  /** 用户改了称呼后同步任务栏/窗口标题。 */
  setName(name) {
    if (!this.win || this.win.isDestroyed()) return
    this.win.setTitle(String(name || '语音助手'))
  }

  show() {
    if (!this.win || this.win.isDestroyed()) return
    // 位置可能因为拔插显示器而跑到屏幕外，每次露面都校一次
    const [x, y] = this.win.getPosition()
    const clamped = this._clamp(x, y)
    if (clamped.x !== x || clamped.y !== y) this.win.setPosition(clamped.x, clamped.y)
    this.win.setIgnoreMouseEvents(false)
    this.win.setOpacity(1)
    this.win.show()
    this.win.focus()
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.visible = true
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) return
    this.win.blur()
    this.win.setIgnoreMouseEvents(true, { forward: true })
    this.win.setOpacity(0)
    this.visible = false
  }

  toggle() {
    if (this.visible) this.hide()
    else this.show()
  }

  isVisible() {
    return Boolean(this.visible && this.win && !this.win.isDestroyed())
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

module.exports = { FloatingWindow, UI_WIDTH, UI_HEIGHT }
