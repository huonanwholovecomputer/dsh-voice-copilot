/**
 * 托盘：浮窗是常驻程序，托盘是它唯一「一直看得见」的入口。
 * 菜单刻意保持很短：叫出来、开关唤醒词、看日志、退出。
 */
'use strict'

const path = require('node:path')
const { Tray, Menu, shell, nativeImage } = require('electron')

class TrayController {
  constructor({ log, logFile, config, onShow, onToggleWake, onQuit }) {
    this.log = log
    this.logFile = logFile
    this.config = config
    this.onShow = onShow
    this.onToggleWake = onToggleWake
    this.onQuit = onQuit
    this.wakeEnabled = true
    this.tray = null
  }

  create() {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
    const image = nativeImage.createFromPath(iconPath)
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    this.tray.on('double-click', () => this.onShow())
    this._render()
    return this.tray
  }

  /** 称呼/热键改了之后由主进程调用，重建 tooltip 与菜单。 */
  refresh() {
    this._render()
  }

  setWake(enabled) {
    this.wakeEnabled = enabled
    this._render()
  }

  _render() {
    if (!this.tray) return
    const name = String(this.config.name || '语音助手')
    const hotkey = String(this.config.hotkey || 'ctrl+alt+j').toUpperCase().replace(/\+/g, ' + ')
    this.tray.setToolTip(`${name} · 语音助手`)
    const menu = Menu.buildFromTemplate([
      { label: `叫出${name}（${hotkey}）`, click: () => this.onShow() },
      { type: 'separator' },
      {
        label: '唤醒词监听',
        type: 'checkbox',
        checked: this.wakeEnabled,
        click: (item) => this.onToggleWake(item.checked),
      },
      { label: '查看日志', click: () => shell.openPath(this.logFile) },
      { type: 'separator' },
      { label: `退出${name}`, click: () => this.onQuit() },
    ])
    this.tray.setContextMenu(menu)
  }

  destroy() {
    if (this.tray) this.tray.destroy()
    this.tray = null
  }
}

module.exports = { TrayController }
