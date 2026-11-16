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

/** 事件名前 14 位是零填充的 Date.now()（index.js 那边 emit 时 padStart(14,'0')），字典序＝时间序。 */
function millisOf(name) {
  return String(name).slice(0, 14)
}

class Bridge {
  constructor({ dataDir }) {
    this.dataDir = dataDir
    this.queueDir = path.join(dataDir, 'queue')
    this.eventsDir = path.join(dataDir, 'events')
    // 已经消费到哪一毫秒（事件名前 14 位）。只增不减，没有「忘掉老名字再当成新事件」这种回头路。
    // 以前这里只有一个「最多 4000 个名字」的 Set，超了就砍成最后 1000 个——被砍掉的老名字下一轮
    // 又变回新事件重放，历史被反复重建、列表疯狂滚动就是这么来的。
    this.watermark = ''
    // 同一毫秒里还没删掉的文件名；只是兜底，正常情况下读完就删，不需要靠它去重。
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

  /**
   * 启动时把已有事件当读过的，免得旧对话被重放。
   *
   * 只「记成读过」不够：这些文件谁都不删，攒到几千个之后，任何「只记住最近 N 个名字」的
   * 剪枝都会把更老的名字忘掉，下一轮又当新事件重放一遍。所以启动时直接把旧事件清掉——
   * 按设计它们本来就不该再出现。
   */
  skipHistory() {
    let names = []
    try {
      names = fs.readdirSync(this.eventsDir).filter((n) => n.endsWith('.json')).sort()
    } catch {
      names = []
    }
    if (names.length) this.watermark = millisOf(names[names.length - 1])
    this.pruneConsumed()
  }

  /** 删掉水位线及以前的旧事件（已经消费过，或者启动时按设计跳过的）。返回删了几个。 */
  pruneConsumed() {
    if (!this.watermark) return 0
    let names = []
    try {
      names = fs.readdirSync(this.eventsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (millisOf(name) > this.watermark) continue
      try {
        fs.unlinkSync(path.join(this.eventsDir, name))
        removed += 1
      } catch {
        /* 删不掉就留着：名字在水位线以下，不会再被当成新事件 */
      }
    }
    return removed
  }

  /** 返回上次调用之后新产生的事件（按文件名排序 = 时间序），读过的文件顺手删掉。 */
  poll() {
    let names
    try {
      names = fs.readdirSync(this.eventsDir).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return []
    }
    const fresh = []
    for (const name of names) {
      const ms = millisOf(name)
      if (this.watermark && ms < this.watermark) {
        // 水位线以下：老事件，或者上一轮读过但没删掉的文件。只补删，不再往外吐。
        try {
          fs.unlinkSync(path.join(this.eventsDir, name))
        } catch {
          /* 留着也只会在水位线以下，不会重放 */
        }
        continue
      }
      if (this.seen.has(name)) {
        try {
          fs.unlinkSync(path.join(this.eventsDir, name))
        } catch {
          /* 同上 */
        }
        continue
      }
      if (ms > this.watermark) {
        this.watermark = ms
        this.seen.clear()
      }
      this.seen.add(name)
      try {
        fresh.push(JSON.parse(fs.readFileSync(path.join(this.eventsDir, name), 'utf8')))
      } catch {
        /* 半个文件：跳过，下轮也不会再读（名字已经在水位线里） */
      }
      let removed = true
      try {
        fs.unlinkSync(path.join(this.eventsDir, name))
      } catch {
        removed = false
      }
      if (removed) this.seen.delete(name)
    }
    return fresh
  }
}

module.exports = { Bridge }
