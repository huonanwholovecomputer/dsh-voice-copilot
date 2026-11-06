/**
 * 「小印」群白名单的自动策略：按订单来源圈定查找范围。
 *
 * 背景：小印去微信里找文件时，只会在白名单（chats.excluded = 0）的会话里找。
 * 手工勾选一场能接受，但每次进出顾客/群成员都在变，需要一套可重复的口径：
 *
 *   1. 从打印机日志里重建「最近的订单」——每个打印批次包含哪些文件、在什么时间；
 *   2. 把这些文件名和台账 file_msgs 对齐（精确 → 归一 → 去加工后缀），判断文件是谁发的；
 *   3. 按会话汇总：这个群/这个人最近供过几份要打印的文件；
 *   4. 按策略给出 excluded / pinned 的目标值。
 *
 * 三种口径：
 *   - hybrid（默认）：群只留「最近供过订单文件」的群；私聊留「台账里有文件」的私聊。
 *     这样群不会因为闲聊/资料转发被拉进检索范围，私聊则尽量不漏顾客。
 *   - orders：群和私聊都只留最近供过订单文件的会话。最干净，但会排除只发过
 *     非打印文件（照片、证明材料）的家人朋友。
 *   - files：只要台账里有文件就留。最宽松，会把资料群重新拉回来。
 *
 * 不碰的：云端 H5 上传（没有微信会话）、微信图片（台账不收）、店主自己加工后
 * 回传的文件（is_sent=1），它们不计入任何会话的「供单」。
 *
 * 只改 chats.excluded / chats.pinned，不删记录、不重刷索引。台账刷新时
 * excluded/pinned 不会被覆盖（bridge/ledger.py 的 upsert 不碰这两列），
 * 被排除的会话在刷新时直接跳过（skipped_excluded）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 缺省日志目录：打印机工具装在当前用户下，路径基本固定。 */
export function defaultLogDir() {
  return process.env.DSH_VOICE_COPILOT_PRINTER_LOG_DIR
    || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'HN打印工具', 'logs')
}

export const MODES = ['hybrid', 'orders', 'files']

const TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/
const BATCH_RE = /共 (\d+) 个任务待处理/
const FILE_RE = /\[(\d+)\/(\d+)\]\s*(.+?)\s*$/
const CLOUD_TASK_RE = /收到云端任务 #(\d+): (.+?) \(|下载完成 #(\d+): (.+?) \(/
const EXT_RE = /\.(docx?|pdf|xlsx?|pptx?|zip|rar|7z|md|wps|txt|csv|bmp|gif|jpg|jpeg|png|webp)$/i
const IMG_RE = /\.(jpg|jpeg|png|bmp|gif|webp)$/i
const GUESS_RE = /^([\u4e00-\u9fa5]{2,4})[_-]/

/** 去扩展名、前导 [xx]、前导数字下划线、副本编号、空白。 */
export function norm(name) {
  let t = String(name || '').trim().replace(EXT_RE, '')
  t = t.replace(/^\[[^\]]*\]/, '')
  t = t.replace(/^\d+_/, '')
  t = t.replace(/\s*[\(（]\d+[\)）]/g, '')
  return t.replace(/[\s\u3000]+/g, '')
}

/** 更激进：再去掉店主加工痕迹的后缀（打印版/最终版/修改版/扩充版）。 */
export function norm2(name) {
  return norm(name)
    .replace(/[\(（](打印版|最终版|最终|修改版|扩充版|模板)[\)）]/g, '')
    .replace(/[_\-]?(打印版|最终版|修改版|扩充版)$/, '')
}

function parseLocalStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

/**
 * 读日志 → 打印批次。批次 = `共 N 个任务待处理` 行 + 后面的 `[i/N] 文件名` 行。
 * 同一批次里重名文件只算一次（复制多份的归因一样）。
 */
export function parseLogs(logDir) {
  const dir = String(logDir || '').trim()
  if (!dir) throw new Error('没有配置打印机日志目录')
  if (!fs.existsSync(dir)) throw new Error(`打印机日志目录不存在：${dir}`)
  const files = fs.readdirSync(dir)
    .filter((name) => /^2026-.*\.log$/i.test(name))
    .sort()
  const batches = []
  const cloudTasks = []
  let cur = null

  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const tm = TS_RE.exec(line)
      if (!tm) continue
      const ts = parseLocalStamp(tm[1])
      if (!ts) continue

      const cm = CLOUD_TASK_RE.exec(line)
      if (cm) {
        const name = (cm[2] || cm[4] || '').trim()
        if (name) cloudTasks.push({ ts, name })
        continue
      }

      const bm = BATCH_RE.exec(line)
      if (bm) {
        cur = { ts, files: [] }
        batches.push(cur)
        continue
      }

      if (!cur) continue
      const fm = FILE_RE.exec(line)
      if (fm) {
        const name = (fm[3] || '').trim()
        if (name && !cur.files.includes(name)) cur.files.push(name)
      }
    }
  }

  return { batches: batches.filter((batch) => batch.files.length > 0), cloudTasks }
}

/** 读台账里的文件消息（只 SELECT，不写）。 */
export async function loadMessages(dbPath) {
  const { DatabaseSync } = await import('node:sqlite')
  if (typeof DatabaseSync !== 'function') throw new Error('当前 Node 不支持 node:sqlite（需要 22.5+）')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    return db.prepare(`
      SELECT message_id, chat_username, chat_name, is_group, sender, is_sent, create_time, filename
      FROM file_msgs
    `).all().map((row) => ({
      messageId: Number(row.message_id) || 0,
      chatUsername: String(row.chat_username || ''),
      chatName: String(row.chat_name || ''),
      isGroup: Number(row.is_group) || 0,
      sender: String(row.sender || ''),
      isSent: Number(row.is_sent) || 0,
      createTime: Number(row.create_time) || 0,
      filename: String(row.filename || ''),
    }))
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function buildIndexes(messages) {
  const exact = new Map()
  const n1 = new Map()
  const n2 = new Map()
  const push = (map, key, row) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(row)
    else map.set(key, [row])
  }
  for (const row of messages) {
    push(exact, row.filename, row)
    push(n1, norm(row.filename), row)
    push(n2, norm2(row.filename), row)
  }
  return { exact, n1, n2 }
}

/** 在候选里取「最接近打印时间、且优先是对方发来」的一条。 */
function pick(cands, tsSeconds) {
  const usable = cands.filter((row) => row.createTime <= tsSeconds + 120)
  if (!usable.length) return null
  const received = usable.filter((row) => !row.isSent)
  const pool = (received.length ? received : usable)
    .slice()
    .sort((a, b) => b.createTime - a.createTime)
  return pool[0] || null
}

const MATCH_WINDOW_S = 14 * 86400

function matchFile(name, tsSeconds, ix) {
  const lo = tsSeconds - MATCH_WINDOW_S
  const passes = [
    ['exact', name, ix.exact],
    ['norm', norm(name), ix.n1],
    ['fuzzy', norm2(name), ix.n2],
  ]
  for (const [how, key, map] of passes) {
    const cands = (map.get(key) || []).filter((row) => row.createTime >= lo && row.createTime <= tsSeconds + 120)
    if (!cands.length) continue
    const best = pick(cands, tsSeconds)
    if (best) return { row: best, how }
  }
  return null
}

function guessOwner(name, messages) {
  const gm = GUESS_RE.exec(String(name || ''))
  if (!gm) return null
  const who = gm[1]
  let best = null
  for (const row of messages) {
    if ((row.chatName || '').includes(who) || (row.sender || '').includes(who)) {
      if (!best || row.createTime > best.createTime) best = row
    }
  }
  return best
}

/**
 * 把一批「打印了什么」归因到会话。
 * @returns {{orderFiles: Map<string, {count:number,lastAt:number}>, guessFiles: Map<string, number>, totals: object}}
 */
export function attributeOrders({ batches, cloudTasks }, messages, sinceMs) {
  const ix = buildIndexes(messages)
  const cloudByNorm = new Map()
  for (const task of cloudTasks) {
    const key = norm(task.name)
    if (!key) continue
    const list = cloudByNorm.get(key)
    const item = { tsSeconds: Math.floor(task.ts.getTime() / 1000), name: task.name }
    if (list) list.push(item)
    else cloudByNorm.set(key, [item])
  }

  const orderFiles = new Map()
  const guessFiles = new Map()
  const totals = { batches: 0, files: 0, private: 0, group: 0, self: 0, cloud: 0, image: 0, unknown: 0, guess: 0 }

  const bump = (map, key) => {
    if (!key) return
    const hit = map.get(key)
    if (hit) hit.count += 1
    else map.set(key, { count: 1, lastAt: 0 })
  }

  for (const batch of batches) {
    const batchMs = batch.ts.getTime()
    if (batchMs < sinceMs) continue
    totals.batches += 1
    const tsSeconds = Math.floor(batchMs / 1000)
    for (const name of batch.files) {
      totals.files += 1

      const cloudKey = norm(name)
      const cloudHit = (cloudByNorm.get(cloudKey) || []).find((task) => task.tsSeconds >= tsSeconds - 900 && task.tsSeconds <= tsSeconds + 60)
      if (cloudHit) { totals.cloud += 1; continue }

      const match = matchFile(name, tsSeconds, ix)
      if (!match) {
        const guess = guessOwner(name, messages)
        if (guess) {
          totals.guess += 1
          const key = guess.chatUsername
          const hit = guessFiles.get(key)
          if (hit) guessFiles.set(key, hit + 1)
          else guessFiles.set(key, 1)
        } else if (IMG_RE.test(name)) totals.image += 1
        else totals.unknown += 1
        continue
      }

      const row = match.row
      if (row.isSent || row.chatName === '文件传输助手') { totals.self += 1; continue }
      if (row.isGroup) totals.group += 1
      else totals.private += 1
      const key = row.chatUsername
      if (key) {
        const hit = orderFiles.get(key)
        if (hit) { hit.count += 1; hit.lastAt = Math.max(hit.lastAt, row.createTime) }
        else orderFiles.set(key, { count: 1, lastAt: row.createTime })
      }
    }
  }

  return { orderFiles, guessFiles, totals }
}

/**
 * 读台账 chats 表（带文件数），不动 excluded/pinned 以外的任何列。
 * @returns {Promise<Array<{username,name,isGroup,excluded,pinned,files,lastSeenTs}>>}
 */
export async function loadChats(dbPath) {
  const { DatabaseSync } = await import('node:sqlite')
  if (typeof DatabaseSync !== 'function') throw new Error('当前 Node 不支持 node:sqlite（需要 22.5+）')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    return db.prepare(`
      SELECT c.username, c.name, c.is_group, c.excluded, c.pinned,
             (SELECT COUNT(*) FROM file_msgs f WHERE f.chat_username = c.username) AS files
      FROM chats c
      ORDER BY c.is_group DESC, c.name ASC
    `).all().map((row) => ({
      username: String(row.username || ''),
      name: String(row.name || row.username || ''),
      isGroup: Boolean(Number(row.is_group)),
      excluded: Boolean(Number(row.excluded)),
      pinned: Boolean(Number(row.pinned)),
      files: Number(row.files) || 0,
    }))
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

const ALWAYS_KEEP = new Set(['文件传输助手'])

/**
 * 由统计结果生成白名单方案（纯函数，方便 CLI 和页面共用）。
 * @param {object} input
 * @param {Array} input.chats  loadChats() 的结果
 * @param {Map} input.orderFiles  attributeOrders().orderFiles
 * @param {string} input.mode  hybrid | orders | files
 * @param {number} input.days  窗口天数
 * @param {boolean} input.pinOrderChats  是否把供单群置顶
 * @param {number} input.now  ms
 */
export function buildPlan({ chats, orderFiles, mode = 'hybrid', days = 10, pinOrderChats = true, now = Date.now() }) {
  if (!MODES.includes(mode)) throw new Error(`未知策略：${mode}（可选 ${MODES.join(' / ')}）`)
  const windowDays = Math.min(Math.max(Number(days) || 10, 1), 120)
  const items = []
  let changed = 0
  const totals = { chats: chats.length, groups: 0, groupsIncluded: 0, groupsExcluded: 0, directs: 0, directsIncluded: 0, directsExcluded: 0, changed, files: 0, visibleFiles: 0, hiddenFiles: 0 }

  for (const chat of chats) {
    const order = orderFiles.get(chat.username) || { count: 0, lastAt: 0 }
    const orderCount = Math.max(order.count, 0)
    let keep
    let reason
    if (mode === 'orders') {
      keep = orderCount > 0
      reason = keep ? `近 ${windowDays} 天供单 ${orderCount} 份` : '近窗口没有供单文件'
    } else if (mode === 'files') {
      keep = chat.files > 0 || orderCount > 0
      reason = orderCount > 0 ? `近 ${windowDays} 天供单 ${orderCount} 份` : (chat.files > 0 ? `台账有 ${chat.files} 份文件` : '台账里没有文件')
    } else {
      keep = chat.isGroup ? orderCount > 0 : chat.files > 0
      if (chat.isGroup) {
        reason = orderCount > 0 ? `近 ${windowDays} 天供单 ${orderCount} 份` : (chat.files > 0 ? `有 ${chat.files} 份文件但近窗口未供单` : '没有文件，也未供单')
      } else {
        reason = orderCount > 0 ? `近 ${windowDays} 天供单 ${orderCount} 份` : (chat.files > 0 ? `台账有 ${chat.files} 份文件` : '台账里没有文件')
      }
    }
    if (ALWAYS_KEEP.has(chat.name) && chat.files > 0) keep = true

    const proposedExcluded = !keep
    const proposedPinned = keep && orderCount > 0 && (chat.isGroup ? pinOrderChats : false)
    const isChanged = proposedExcluded !== chat.excluded || proposedPinned !== chat.pinned
    if (isChanged) changed += 1

    items.push({
      username: chat.username,
      name: chat.name,
      isGroup: chat.isGroup,
      files: chat.files,
      orderFiles: orderCount,
      lastOrderAt: order.lastAt || 0,
      excluded: chat.excluded,
      pinned: chat.pinned,
      proposedExcluded,
      proposedPinned,
      changed: isChanged,
      reason,
      action: proposedExcluded ? 'exclude' : 'keep',
    })
  }

  for (const item of items) {
    totals.files += item.files
    if (item.proposedExcluded) totals.hiddenFiles += item.files
    else totals.visibleFiles += item.files
    if (item.isGroup) {
      totals.groups += 1
      if (item.proposedExcluded) totals.groupsExcluded += 1
      else totals.groupsIncluded += 1
    } else {
      totals.directs += 1
      if (item.proposedExcluded) totals.directsExcluded += 1
      else totals.directsIncluded += 1
    }
  }
  totals.changed = changed

  return {
    mode,
    days: windowDays,
    pinOrderChats: Boolean(pinOrderChats),
    generatedAt: new Date(now).toISOString(),
    since: new Date(now - windowDays * 86400000).toISOString(),
    totals,
    changes: items.filter((item) => item.changed),
    items,
  }
}

/** 写库前备份当前 excluded/pinned，供撤销。 */
export function saveSnapshot(dataDir, chats) {
  const dir = path.resolve(dataDir || path.join(os.homedir(), '.dsh', 'voice-copilot'))
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'whitelist-snapshot.json')
  const payload = {
    savedAt: new Date().toISOString(),
    chats: Object.fromEntries(chats.map((chat) => [chat.username, { excluded: chat.excluded, pinned: chat.pinned, name: chat.name }])),
  }
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8')
  return target
}

export function hasSnapshot(dataDir) {
  try {
    return fs.existsSync(path.join(path.resolve(dataDir), 'whitelist-snapshot.json'))
  } catch {
    return false
  }
}

/**
 * 批量写 chats.excluded / chats.pinned。只写有变化的行。
 * @returns {Promise<{changed:number}>}
 */
export async function applyPlan(dbPath, plan) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const update = db.prepare('UPDATE chats SET excluded = ?, pinned = ?, updated_at = ? WHERE username = ?')
    const now = Math.floor(Date.now() / 1000)
    let changed = 0
    db.exec('BEGIN')
    try {
      for (const item of plan.items) {
        if (!item.changed) continue
        const result = update.run(item.proposedExcluded ? 1 : 0, item.proposedPinned ? 1 : 0, now, item.username)
        changed += Number(result.changes) || 0
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
    return { changed }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 从快照恢复 excluded/pinned，返回恢复的行数。 */
export async function undoSnapshot(dbPath, dataDir) {
  const dir = path.resolve(dataDir || path.join(os.homedir(), '.dsh', 'voice-copilot'))
  const target = path.join(dir, 'whitelist-snapshot.json')
  if (!fs.existsSync(target)) throw new Error('没有可撤销的策略快照')
  const payload = JSON.parse(fs.readFileSync(target, 'utf8'))
  const chats = payload && payload.chats && typeof payload.chats === 'object' ? payload.chats : {}
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const update = db.prepare('UPDATE chats SET excluded = ?, pinned = ?, updated_at = ? WHERE username = ?')
    const now = Math.floor(Date.now() / 1000)
    let changed = 0
    db.exec('BEGIN')
    try {
      for (const [username, state] of Object.entries(chats)) {
        if (!state) continue
        const result = update.run(state.excluded ? 1 : 0, state.pinned ? 1 : 0, now, username)
        changed += Number(result.changes) || 0
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
    fs.unlinkSync(target)
    return { changed, savedAt: payload.savedAt || '' }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * 一站式：扫日志 + 读台账 + 归因 + 出方案。页面预览和 CLI 都走这里。
 * @param {{ dbPath:string, logDir?:string, days?:number, mode?:string, pinOrderChats?:boolean, now?:number }} options
 */
export async function analyze({ dbPath, logDir, days = 10, mode = 'hybrid', pinOrderChats = true, now = Date.now() }) {
  const windowDays = Math.min(Math.max(Number(days) || 10, 1), 120)
  const sinceMs = now - windowDays * 86400000
  const { batches, cloudTasks } = parseLogs(logDir || defaultLogDir())
  const messages = await loadMessages(dbPath)
  const { orderFiles, guessFiles, totals: attrTotals } = attributeOrders({ batches, cloudTasks }, messages, sinceMs)
  const chats = await loadChats(dbPath)
  const plan = buildPlan({ chats, orderFiles, mode, days: windowDays, pinOrderChats, now })
  return { plan, attrTotals: { ...attrTotals, guessChats: guessFiles.size }, orderFiles, chats }
}
