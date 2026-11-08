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
 *
 * 尺寸：默认 720×520，可以由用户拖四边/四角改，改完记在 window.json 的 size。
 * 特意没开 BrowserWindow 的 resizable——Electron 文档明确说透明窗口开原生
 * resizable 可能把透明打坏（Windows 上加 WS_THICKFRAME 会掉分层/掉圆角），
 * 所以改成界面里铺 8 个隐形把手，自己收拖动、自己 setBounds。
 */
'use strict'

const path = require('node:path')
const { BrowserWindow, screen } = require('electron')

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 520
// 再小标题栏就塞不下「思考中」+ 恢复/关闭按钮了
const MIN_WIDTH = 420
const MIN_HEIGHT = 320
// 旧名字：以前尺寸写死，外面可能还在引
const UI_WIDTH = DEFAULT_WIDTH
const UI_HEIGHT = DEFAULT_HEIGHT
// 位置/尺寸允许顶出工作区一点点，给「贴边」的旧位置留余地
const SLACK = 40

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max)

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
    const { x, y, width, height } = this._initialBounds()
    this.win = new BrowserWindow({
      width,
      height,
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

  /** 想要的尺寸：优先用存下来的，其次默认值。0/负数当没存过。 */
  _wantedSize() {
    const saved = Array.isArray(this.state.size) ? this.state.size.map(Number) : null
    const usable = (value) => Number.isFinite(value) && value > 0
    return {
      width: saved && usable(saved[0]) ? saved[0] : DEFAULT_WIDTH,
      height: saved && usable(saved[1]) ? saved[1] : DEFAULT_HEIGHT,
    }
  }

  /** 当前尺寸：窗口还活着就以窗口为准。 */
  _size() {
    if (this.win && !this.win.isDestroyed()) {
      const [width, height] = this.win.getSize()
      return { width, height }
    }
    return this._wantedSize()
  }

  /** 把尺寸夹进「最小」和「从 x,y 出发还剩多少工作区」之间。 */
  _fitSize(area, x, y, wanted) {
    const maxWidth = Math.max(MIN_WIDTH, area.x + area.width - x)
    const maxHeight = Math.max(MIN_HEIGHT, area.y + area.height - y)
    return {
      width: Math.round(clampNumber(Number(wanted.width) || DEFAULT_WIDTH, MIN_WIDTH, maxWidth)),
      height: Math.round(clampNumber(Number(wanted.height) || DEFAULT_HEIGHT, MIN_HEIGHT, maxHeight)),
    }
  }

  _initialBounds() {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    const wanted = this._wantedSize()
    const saved = this.state.pos

    if (Array.isArray(saved) && saved.length === 2 && saved.every(Number.isFinite)) {
      // 老位置 + 老尺寸：显示器换了也要塞得回去
      const x = Math.round(saved[0])
      const y = Math.round(saved[1])
      const size = this._fitSize(area, x, y, wanted)
      const clamped = this._clamp(x, y, size)
      return { x: clamped.x, y: clamped.y, width: size.width, height: size.height }
    }

    // 默认：主屏底部居中，离底边 24 px（和原来 Python 版的位置习惯一致）
    const size = {
      width: Math.round(clampNumber(wanted.width, MIN_WIDTH, Math.max(MIN_WIDTH, area.width))),
      height: Math.round(clampNumber(wanted.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, area.height))),
    }
    const x = Math.round(area.x + (area.width - size.width) / 2)
    const y = Math.round(area.y + area.height - size.height - 24)
    this.log(`屏幕 workArea=${display.workArea.width}x${display.workArea.height}+${display.workArea.x}+${display.workArea.y} scale=${display.scaleFactor} 窗口=${x},${y} ${size.width}x${size.height}`)
    return { x, y, width: size.width, height: size.height }
  }

  _clamp(x, y, size = this._size()) {
    const point = { x: Math.round(x), y: Math.round(y) }
    const display = screen.getDisplayNearestPoint(point)
    const area = display.workArea
    const clampedX = Math.min(Math.max(point.x, area.x - SLACK), area.x + area.width - size.width + SLACK)
    const clampedY = Math.min(Math.max(point.y, area.y - 20), area.y + area.height - size.height + 20)
    return { x: Math.round(clampedX), y: Math.round(clampedY) }
  }

  /**
   * 拖动把手改尺寸。edge 里带 n/w 时窗口原点跟着动，对边钉住不动。
   * 传进来的是「想要的绝对尺寸」（渲染进程按屏幕坐标算的），这里只负责夹。
   */
  resizeTo(width, height, edge = 'se') {
    if (!this.win || this.win.isDestroyed()) return
    const [x, y] = this.win.getPosition()
    const [currentWidth, currentHeight] = this.win.getSize()
    const area = screen.getDisplayNearestPoint({ x, y }).workArea
    const right = x + currentWidth
    const bottom = y + currentHeight
    const movesLeft = String(edge).includes('w')
    const movesTop = String(edge).includes('n')

    const maxWidth = movesLeft ? right - (area.x - SLACK) : area.x + area.width - x + SLACK
    const maxHeight = movesTop ? bottom - (area.y - 20) : area.y + area.height - y + 20
    const nextWidth = Math.round(clampNumber(Number(width) || currentWidth, MIN_WIDTH, Math.max(MIN_WIDTH, maxWidth)))
    const nextHeight = Math.round(clampNumber(Number(height) || currentHeight, MIN_HEIGHT, Math.max(MIN_HEIGHT, maxHeight)))
    if (nextWidth === currentWidth && nextHeight === currentHeight) return

    const bounds = { x, y, width: nextWidth, height: nextHeight }
    if (movesLeft) bounds.x = right - nextWidth
    if (movesTop) bounds.y = bottom - nextHeight
    this.win.setBounds(bounds, false)
    this.state.pos = [bounds.x, bounds.y]
    this.state.size = [nextWidth, nextHeight]
    this._scheduleSave()
  }

  _scheduleSave() {
    if (!this.win) return
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      if (!this.win || this.win.isDestroyed()) return
      const [x, y] = this.win.getPosition()
      const [width, height] = this.win.getSize()
      this.state.pos = [x, y]
      this.state.size = [width, height]
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

module.exports = {
  FloatingWindow,
  UI_WIDTH,
  UI_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
}
