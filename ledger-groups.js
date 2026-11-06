/**
 * 「小印」管理页的数据层：读写微信文件台账里的群白名单。
 *
 * 为什么放在 DSH 插件里而不是复用台账的网页服务：
 *   - 台账网页服务（127.0.0.1:47612）不一定在跑，浏览器跨源访问还要处理 CORS；
 *   - 这里只需要一次 SELECT + 一次 UPDATE，直连 ledger.db 比多绕一跳稳。
 *
 * 只碰 chats 表的 excluded 标记和统计，不刷新索引、不改文件、不删记录。
 * 台账是 WAL 模式，两边同时写由 busy_timeout 兜住。
 */

import { MODES, analyze, applyPlan, hasSnapshot, loadChats, saveSnapshot, undoSnapshot } from './whitelist-policy.js'

const MAX_BODY_BYTES = 64 * 1024

let sqlitePromise = null
function loadSqlite() {
  if (!sqlitePromise) sqlitePromise = import('node:sqlite')
  return sqlitePromise
}

const LIST_SQL = `
  SELECT c.username, c.name, c.is_group, c.excluded, c.pinned, c.note,
         c.last_preview, c.last_seen_ts,
         (SELECT COUNT(*) FROM file_msgs f WHERE f.chat_username = c.username) AS file_count
  FROM chats c
  ORDER BY c.is_group DESC, c.excluded ASC, c.pinned DESC, c.last_seen_ts DESC, c.name ASC
`

const UPDATE_SQL = 'UPDATE chats SET excluded = ?, updated_at = ? WHERE username = ?'

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function normalizeChat(row) {
  return {
    username: asText(row.username),
    name: asText(row.name) || asText(row.username),
    isGroup: Boolean(row.is_group),
    excluded: Boolean(row.excluded),
    pinned: Boolean(row.pinned),
    note: asText(row.note),
    preview: asText(row.last_preview).slice(0, 160),
    files: Number(row.file_count) || 0,
    lastSeenTs: Number(row.last_seen_ts) || 0,
  }
}

export function countChats(chats) {
  const groups = chats.filter((chat) => chat.isGroup)
  const directs = chats.filter((chat) => !chat.isGroup)
  return {
    chats: chats.length,
    // 群聊：included / excluded 是群层面的计数，保持旧字段不变。
    groups: groups.length,
    included: groups.filter((chat) => !chat.excluded).length,
    excluded: groups.filter((chat) => chat.excluded).length,
    // 个人聊天：单独计数，页面分区展示。
    directs: directs.length,
    directsIncluded: directs.filter((chat) => !chat.excluded).length,
    directsExcluded: directs.filter((chat) => chat.excluded).length,
  }
}

/**
 * 读整张会话表（含群与私聊），附带每会话的文件数。
 * @param {string} dbPath
 */
export async function listChats(dbPath) {
  const { DatabaseSync } = await loadSqlite()
  if (typeof DatabaseSync !== 'function') throw new Error('当前 Node 不支持 node:sqlite（需要 22.5+）')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const rows = db.prepare(LIST_SQL).all()
    const chats = rows.map(normalizeChat)
    return { counts: countChats(chats), chats }
  } finally {
    db.close()
  }
}

/**
 * 切换一个会话的排除标记。返回 changed（0 表示 username 不存在）。
 * @param {string} dbPath
 * @param {string} username
 * @param {boolean} excluded
 */
export async function setChatExcluded(dbPath, username, excluded) {
  const { DatabaseSync } = await loadSqlite()
  if (typeof DatabaseSync !== 'function') throw new Error('当前 Node 不支持 node:sqlite（需要 22.5+）')
  const name = asText(username).trim()
  if (!name) throw new Error('username 不能为空')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const result = db.prepare(UPDATE_SQL).run(excluded ? 1 : 0, Math.floor(Date.now() / 1000), name)
    return { changed: Number(result.changes) || 0 }
  } finally {
    db.close()
  }
}

function sendJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch { /* 页面已经断开，无所谓 */ }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({}) ; return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * 网页半侧的两个处理函数。dbPath 传函数，配置改了不用重新注册路由。
 * @param {{ dbPath: string | (() => string), log?: (line: string) => void }} options
 */
export function createLedgerApi({ dbPath, logDir, dataDir, log = () => {} }) {
  const configured = () => (typeof dbPath === 'function' ? dbPath() : dbPath) || ''
  const configuredLogDir = () => (typeof logDir === 'function' ? logDir() : logDir) || ''
  const configuredDataDir = () => (typeof dataDir === 'function' ? dataDir() : dataDir) || ''

  return {
    /** GET /__dsh-voice-copilot/ledger/chats */
    async chats(req, res) {
      if ((req.method || 'GET') !== 'GET') {
        sendJson(res, 405, { error: '只支持 GET' })
        return
      }
      const path = asText(configured()).trim()
      if (!path) {
        sendJson(res, 503, { error: '还没有配置台账路径：在插件配置里填 ledgerDb（ledger.db 的绝对路径）' })
        return
      }
      try {
        const data = await listChats(path)
        sendJson(res, 200, { db: path, ...data })
      } catch (error) {
        log(`ledger read failed: ${error && error.stack ? error.stack : error}`)
        sendJson(res, 500, { db: path, error: `读台账失败：${error && error.message ? error.message : error}` })
      }
    },

    /** POST /__dsh-voice-copilot/ledger/exclude  body: { username, excluded } */
    async exclude(req, res) {
      if ((req.method || 'POST') !== 'POST') {
        sendJson(res, 405, { error: '只支持 POST' })
        return
      }
      const path = asText(configured()).trim()
      if (!path) {
        sendJson(res, 503, { error: '还没有配置台账路径：在插件配置里填 ledgerDb（ledger.db 的绝对路径）' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
        return
      }
      const username = asText(body && body.username).trim()
      const excluded = body && body.excluded
      if (!username) {
        sendJson(res, 400, { error: 'username 必填' })
        return
      }
      if (typeof excluded !== 'boolean') {
        sendJson(res, 400, { error: 'excluded 必须是布尔值' })
        return
      }
      try {
        const result = await setChatExcluded(path, username, excluded)
        if (result.changed === 0) {
          sendJson(res, 404, { error: `台账里没有这个会话：${username}` })
          return
        }
        sendJson(res, 200, { ok: true, username, excluded, changed: result.changed, db: path })
      } catch (error) {
        log(`ledger write failed: ${error && error.stack ? error.stack : error}`)
        sendJson(res, 500, { error: `写台账失败：${error && error.message ? error.message : error}` })
      }
    },

    /**
     * GET /__dsh-voice-copilot/ledger/policy?days=10&mode=hybrid&pin=1
     * 预览「一键策略」会怎么改：只读，不写库。
     */
    async policyPreview(req, res) {
      if ((req.method || 'GET') !== 'GET') {
        sendJson(res, 405, { error: '只支持 GET' })
        return
      }
      const path = asText(configured()).trim()
      if (!path) {
        sendJson(res, 503, { error: '还没有配置台账路径：在插件配置里填 ledgerDb（ledger.db 的绝对路径）' })
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      let params
      try {
        params = readPolicyParams(url.searchParams)
      } catch (error) {
        sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
        return
      }
      try {
        const result = await analyze({
          dbPath: path,
          logDir: configuredLogDir(),
          days: params.days,
          mode: params.mode,
          pinOrderChats: params.pinOrderChats,
        })
        sendJson(res, 200, {
          db: path,
          logDir: configuredLogDir(),
          snapshotAvailable: hasSnapshot(configuredDataDir()),
          attr: result.attrTotals,
          plan: {
            mode: result.plan.mode,
            days: result.plan.days,
            pinOrderChats: result.plan.pinOrderChats,
            since: result.plan.since,
            generatedAt: result.plan.generatedAt,
            totals: result.plan.totals,
            changes: result.plan.changes,
          },
        })
      } catch (error) {
        log(`ledger policy preview failed: ${error && error.stack ? error.stack : error}`)
        sendJson(res, 500, { error: `生成方案失败：${error && error.message ? error.message : error}` })
      }
    },

    /**
     * POST /__dsh-voice-copilot/ledger/policy/apply  body: { days, mode, pinOrderChats }
     * 先按当前数据重算一遍再写库，避免页面上的预览过期。
     */
    async policyApply(req, res) {
      if ((req.method || 'POST') !== 'POST') {
        sendJson(res, 405, { error: '只支持 POST' })
        return
      }
      const path = asText(configured()).trim()
      if (!path) {
        sendJson(res, 503, { error: '还没有配置台账路径：在插件配置里填 ledgerDb（ledger.db 的绝对路径）' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
        return
      }
      let params
      try {
        params = readPolicyParams(new URLSearchParams(), body)
      } catch (error) {
        sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
        return
      }
      try {
        const result = await analyze({
          dbPath: path,
          logDir: configuredLogDir(),
          days: params.days,
          mode: params.mode,
          pinOrderChats: params.pinOrderChats,
        })
        const plan = result.plan
        if (!plan.changes.length) {
          sendJson(res, 200, { ok: true, changed: 0, plan: planSummary(plan), attr: result.attrTotals, message: '当前策略下没有需要改动的会话' })
          return
        }
        const snapshot = saveSnapshot(configuredDataDir(), await loadChats(path))
        const applied = await applyPlan(path, plan)
        log(`ledger policy applied mode=${plan.mode} days=${plan.days} changed=${applied.changed} snapshot=${snapshot}`)
        sendJson(res, 200, {
          ok: true,
          changed: applied.changed,
          snapshot,
          plan: planSummary(plan),
          attr: result.attrTotals,
        })
      } catch (error) {
        log(`ledger policy apply failed: ${error && error.stack ? error.stack : error}`)
        sendJson(res, 500, { error: `应用策略失败：${error && error.message ? error.message : error}` })
      }
    },

    /** POST /__dsh-voice-copilot/ledger/policy/undo：把上次应用策略前的 excluded/pinned 复原。 */
    async policyUndo(req, res) {
      if ((req.method || 'POST') !== 'POST') {
        sendJson(res, 405, { error: '只支持 POST' })
        return
      }
      const path = asText(configured()).trim()
      if (!path) {
        sendJson(res, 503, { error: '还没有配置台账路径：在插件配置里填 ledgerDb（ledger.db 的绝对路径）' })
        return
      }
      try {
        const result = await undoSnapshot(path, configuredDataDir())
        log(`ledger policy undone changed=${result.changed} savedAt=${result.savedAt}`)
        sendJson(res, 200, { ok: true, changed: result.changed, savedAt: result.savedAt })
      } catch (error) {
        log(`ledger policy undo failed: ${error && error.stack ? error.stack : error}`)
        sendJson(res, 500, { error: `撤销失败：${error && error.message ? error.message : error}` })
      }
    },
  }
}

/** 预览/应用响应里只带摘要，不把 230 行原始数据全发给页面。 */
function planSummary(plan) {
  return {
    mode: plan.mode,
    days: plan.days,
    pinOrderChats: plan.pinOrderChats,
    since: plan.since,
    generatedAt: plan.generatedAt,
    totals: plan.totals,
    changes: plan.changes,
  }
}

/** 应用前读一遍当前标记做备份（和 plan 里的旧值一致，这里重读更稳）。 */
function readPolicyParams(searchParams, body = {}) {
  const rawDays = Number(body.days != null ? body.days : searchParams.get('days'))
  const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 10
  const mode = asText(body.mode != null ? body.mode : searchParams.get('mode')).trim() || 'hybrid'
  if (!MODES.includes(mode)) throw new Error(`未知策略：${mode}（可选 ${MODES.join(' / ')}）`)
  const rawPin = body.pinOrderChats != null ? body.pinOrderChats : searchParams.get('pin')
  const pinOrderChats = rawPin == null || rawPin === '' ? true : !(rawPin === false || rawPin === '0' || rawPin === 'false')
  return { days, mode, pinOrderChats }
}
