/**
 * 与 DSH 插件（仓库根的 index.js）之间的文件队列桥——和 app/bridge.py 完全同构。
 *
 *   queue/<id>.json   ->  {kind: text|voice|cancel|ping, ...}
 *   events/*.json     <-  {type: ready|transcript|reply-start|assistant-message|done|turn-end|error|history|...}
 *
 * 不开端口、不碰 DSH 的 HTTP 鉴权，两边只靠这一个目录说话。
 * 写文件一律「先写 .tmp 再 rename」，避免插件读到半个 JSON。
 */
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

class Bridge {
  constructor({ dataDir }) {
    this.dataDir = dataDir
    this.queueDir = path.join(dataDir, 'queue')
    this.eventsDir = path.join(dataDir, 'events')
    this.seen = new Set()
  }

  ensure() {
    fs.mkdirSync(this.queueDir, { recursive: true })
    fs.mkdirSync(this.eventsDir, { recursive: true })
  }

  /** @returns {string} 入队的 id */
  enqueue(payload) {
    this.ensure()
    const id = payload.id || crypto.randomBytes(6).toString('hex')
    const body = { ...payload, id, at: payload.at || Date.now() / 1000 }
    const target = path.join(this.queueDir, `${id}.json`)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8')
    fs.renameSync(tmp, target)
    return id
  }

  submitText(text) {
    return this.enqueue({ kind: 'text', text })
  }

  submitVoice(wav, text, language = 'zh') {
    // 带 text 一起入队：插件侧「有 text 就不再自己转写」，识别结果直接可用；
    // wav 照样留着，方便回放/复现。
    return this.enqueue({ kind: 'voice', wav, text, language })
  }

  cancel() {
    return this.enqueue({ kind: 'cancel' })
  }

  /**
   * 请宿主把 DSH 切到「语音浮窗」那个会话上。
   *
   * 跳会话的 API（`uiWorkspace.openSession`）只活在 DSH 的页面里，宿主插件自己叫不动，
   * 所以这里只递一张条子：宿主收到后挂在回环路由上，页面半侧下一次轮询取走并真的切过去。
   *
   * 用 `kind: 'ping'` 加一个 `open` 标记而不是新开一种 kind：还没重启 DSH 时跑的是旧宿主，
   * 它会把未知 kind 当成空文本，回一句「没听清」——旧宿主对 ping 只会安静地回 pong。
   */
  openSession(sessionId) {
    return this.enqueue(sessionId ? { kind: 'ping', open: true, sessionId } : { kind: 'ping', open: true })
  }

  syncHistory() {
    return this.enqueue({ kind: 'ping', history: true })
  }

  /** 启动时把已有事件当读过的，免得旧对话被重放。 */
  skipHistory() {
    try {
      this.seen = new Set(fs.readdirSync(this.eventsDir).filter((n) => n.endsWith('.json')))
    } catch {
      this.seen = new Set()
    }
  }

  /** 返回上次调用之后新产生的事件（按文件名排序 = 时间序）。 */
  poll() {
    let names
    try {
      names = fs.readdirSync(this.eventsDir).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return []
    }
    const fresh = []
    for (const name of names) {
      if (this.seen.has(name)) continue
      this.seen.add(name)
      try {
        fresh.push(JSON.parse(fs.readFileSync(path.join(this.eventsDir, name), 'utf8')))
      } catch {
        /* 半个文件：跳过，下轮也不会再读（名字已经记过） */
      }
    }
    if (this.seen.size > 4000) this.seen = new Set(names.slice(-1000))
    return fresh
  }
}

module.exports = { Bridge }
