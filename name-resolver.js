/**
 * 「听错的名字」一键定位：把语音里听到的一个词，直接还原成某个人。
 *
 * 为什么要有这一步（实机案例，2026-11-18）：
 *   用户说「帮我打一下拓亦乐的这个东西」，转写成了「他一乐」。
 *   小印手里其实有 voice_pinyin（能按音节比对），但人设要求它「先取一份候选名单」——
 *   也就是先自己列人、再调工具。模型没列、直接问了「是刘浩东还是别人」，
 *   用户只好补一句「拓亦乐」。多这一步就多一次来回，语音场景里尤其刺耳。
 *
 * 所以这里把整条链子压成一次调用：
 *   1. 取本机微信联系人（实时接口，只读）+ 会话列表（拿最后说话时间）；
 *   2. 把听到的汉字的声母/韵母拆出来，对每个联系人名做滑动窗口比对（pinyin-match.js）；
 *   3. 结合「最近有没有说话/发文件」给一个综合分，直接给结论或 1–2 个候选；
 *   4. 用户确认后（action=confirm）把这次听错的写法记进 name_aliases.json，
 *      下次同样听错时字面直接命中，分数 1.0。
 *
 * 数据来源全部只读、且都可缺：
 *   - 联系人 / 会话：WeChatDataAnalysis 的本地接口（DSH_XIAOYIN_CONTACTS_URL / _SESSIONS_URL 可改）；
 *   - 没起 WCDA 或没配台账时退到 ledger.db 里的会话名；再没有就只剩别名表。
 * 不刷新索引、不改台账、不动微信数据。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { bestWindow, initialsOf, stripNotes, syllablesOf } from './pinyin-match.js'

const DEFAULT_CONTACTS_URL =
  String(process.env.DSH_XIAOYIN_CONTACTS_URL || '').trim() ||
  'http://127.0.0.1:10392/api/chat/contacts?include_friends=true&include_groups=true'
const DEFAULT_SESSIONS_URL =
  String(process.env.DSH_XIAOYIN_SESSIONS_URL || '').trim() ||
  'http://127.0.0.1:10392/api/chat/sessions?limit=2000'

const CONTACTS_TTL_MS = 5 * 60_000
const SESSIONS_TTL_MS = 45_000
const FETCH_TIMEOUT_MS = 3_000
// 只保留拼音分过线的候选：低于 0.5 基本是「压根不像」。
const MIN_PHONETIC = 0.5
const MAX_CANDIDATES = 4
// 敢直接下结论的门槛：拼音本身够像、综合分够高、且领先第二名一截。
const CONFIDENT_PHONETIC = 0.78
const CONFIDENT_SCORE = 0.8
const CONFIDENT_GAP = 0.05
// 用户提到文件类的东西时，最近真发过文件的人加分——打印场景里这条最有用。
const FILE_HINT = /(文件|文档|作业|论文|报告|表格|图片|照片|压缩包|ppt|pdf|excel|word|东西)/i

// 系统账号不是「人」，混进来只会干扰。
const SYSTEM_USERS = new Set([
  'weixin', 'filehelper', 'fmessage', 'medianote', 'floatbottle', 'newsapp',
  'notifymessage', 'brandsessionholder', 'weixinreminder', 'officialaccounts',
  'exmail_tool', 'qmessage', 'qqmail', 'tmessage', 'qqsafe',
])
const SYSTEM_NAMES = new Set(['微信团队', '文件传输助手', '微信支付', '服务通知', '微信运动'])

const CN_WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

const EMPTY_FILES = { total: 0, recent: 0, lastAt: null }

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`：和 name_aliases.json 里已有的写法保持一致。 */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 微信会话列表里的时间是「人话」而不是时间戳：21:21 / 昨天 12:30 / 星期一 / 11月3日。
 * 解析成毫秒；认不出来就返回 null（调用方按「很久以前」处理）。
 */
export function parseWeChatTime(text, nowMs = Date.now()) {
  const raw = asText(text).trim()
  if (!raw) return null
  const now = new Date(nowMs)
  const atClock = (dayOffset, hours, minutes) => {
    const date = new Date(nowMs)
    date.setDate(date.getDate() + dayOffset)
    date.setHours(hours, minutes, 0, 0)
    return date.getTime()
  }

  let match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (match) {
    const at = atClock(0, Number(match[1]), Number(match[2]))
    // 钟点比现在还晚一点，说明是昨天这个点（会话列表不会显示未来）。
    return at > nowMs + 60_000 ? at - 86_400_000 : at
  }

  match = raw.match(/^昨天(?:\s*(\d{1,2}):(\d{2}))?$/)
  if (match) return atClock(-1, match[1] ? Number(match[1]) : 12, match[2] ? Number(match[2]) : 0)

  match = raw.match(/^前天(?:\s*(\d{1,2}):(\d{2}))?$/)
  if (match) return atClock(-2, match[1] ? Number(match[1]) : 12, match[2] ? Number(match[2]) : 0)

  match = raw.match(/^星期([一二三四五六日天])(?:\s*(\d{1,2}):(\d{2}))?$/)
  if (match) {
    const today = now.getDay() === 0 ? 7 : now.getDay()
    let back = (today - CN_WEEK[match[1]] + 7) % 7
    if (back === 0) back = 7
    return atClock(-back, match[2] ? Number(match[2]) : 12, match[3] ? Number(match[3]) : 0)
  }

  match = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?$/)
  if (match) {
    return new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      match[4] ? Number(match[4]) : 12, match[5] ? Number(match[5]) : 0,
    ).getTime()
  }

  match = raw.match(/(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/)
  if (match) {
    const year = now.getFullYear()
    let at = new Date(year, Number(match[1]) - 1, Number(match[2]),
      match[3] ? Number(match[3]) : 12, match[4] ? Number(match[4]) : 0).getTime()
    if (at > nowMs + 86_400_000) {
      at = new Date(year - 1, Number(match[1]) - 1, Number(match[2]),
        match[3] ? Number(match[3]) : 12, match[4] ? Number(match[4]) : 0).getTime()
    }
    return at
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(raw)) {
    const at = Date.parse(raw)
    return Number.isFinite(at) ? at : null
  }
  return null
}

/**
 * 近期活跃度：语音里「帮我打一下某某的东西」绝大多数是刚聊过的人。
 * 一小时内的权重最高，隔一周就几乎不提供信息（0.05 是「有这个人但没聊过」的底）。
 */
export function recencyScore(atMs, nowMs = Date.now()) {
  if (!atMs) return { score: 0.05, minutes: null }
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000))
  if (minutes <= 60) return { score: 1, minutes }
  if (minutes <= 6 * 60) return { score: 0.85, minutes }
  if (minutes <= 24 * 60) return { score: 0.7, minutes }
  if (minutes <= 3 * 24 * 60) return { score: 0.45, minutes }
  if (minutes <= 7 * 24 * 60) return { score: 0.25, minutes }
  return { score: 0.05, minutes }
}

export function formatAgo(minutes) {
  if (minutes == null) return '没聊过'
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`
  if (minutes < 48 * 60) return '昨天'
  if (minutes < 30 * 24 * 60) return `${Math.round(minutes / 1440)} 天前`
  return `${Math.round(minutes / (30 * 1440))} 个月前`
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

/** 联系人接口 → 可参与比对的人。备注、昵称都算「名字的一种写法」。 */
export function normalizeContacts(payload) {
  const list = payload && Array.isArray(payload.contacts) ? payload.contacts : []
  const people = []
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const username = asText(item.username).trim()
    if (!username || seen.has(username) || SYSTEM_USERS.has(username)) continue
    const isGroup = Boolean(item.isGroup) || /@chatroom$/.test(username)
    const type = asText(item.type).toLowerCase()
    // 公众号（gh_）不是「人」，群在 includeGroups=false 时也不该参与。
    if (!isGroup && (username.startsWith('gh_') || type === 'official' || type === 'gh')) continue
    const displayName = asText(item.displayName).trim()
    const remark = asText(item.remark).trim()
    const nickname = asText(item.nickname).trim()
    if (SYSTEM_NAMES.has(displayName) || SYSTEM_NAMES.has(remark)) continue
    seen.add(username)
    const names = []
    if (displayName) names.push({ text: displayName, kind: 'display' })
    if (remark && remark !== displayName) names.push({ text: remark, kind: 'remark' })
    if (nickname && nickname !== displayName) names.push({ text: nickname, kind: 'nickname' })
    if (!names.length) continue
    people.push({ username, isGroup, names })
  }
  return people
}

/** 会话接口 → username → { lastAt, preview, isGroup }。lastAt 解析不出来就是 null。 */
export function normalizeSessions(payload, nowMs = Date.now()) {
  const list = payload && Array.isArray(payload.sessions) ? payload.sessions
    : payload && Array.isArray(payload.data) ? payload.data
      : payload && Array.isArray(payload.items) ? payload.items
        : []
  const sessions = new Map()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const username = asText(item.username || item.id).trim()
    if (!username) continue
    sessions.set(username, {
      lastAt: parseWeChatTime(item.lastMessageTime || item.lastTime || item.time, nowMs),
      preview: asText(item.lastMessage).slice(0, 120),
      isGroup: Boolean(item.isGroup),
    })
  }
  return sessions
}

/**
 * 纯排序：听到的词 × 人（含别名）→ 综合分排序。
 *
 * 综合分 = 0.85 × 拼音相似 + 0.15 × 近期活跃（+ 文件线索小加成）。
 * 拼音是主角：活跃度只用来在两三个都像的人之间分先后，不该把根本不像的人顶上来。
 *
 * @param {{heard: string, people: {username: string, isGroup?: boolean, names: {text: string, kind: string}[]}[],
 *          sessions?: Map<string, {lastAt: number|null, preview?: string}>,
 *          files?: Map<string, {total: number, recent: number}>,
 *          context?: string, now?: number}} input
 */
export function rankPeople(input) {
  const { heard, people = [], sessions = new Map(), files = new Map(), context = '' } = input
  const now = Number(input.now) || Date.now()
  const heardText = stripNotes(heard).trim()
  const heardItems = syllablesOf(heardText)
  if (!heardItems.length) return []
  const heardSyllables = heardItems.map((item) => item.syllable)

  const ranked = []
  for (const person of people) {
    let best = null
    for (const variant of person.names || []) {
      const text = stripNotes(variant.text).trim()
      if (!text) continue
      const items = syllablesOf(text)
      if (!items.length) continue
      let phonetic = 0
      let span = ''
      let shared = []
      if (text === heardText) {
        phonetic = 1
        span = text
        shared = heardItems.map((item, index) => `${item.char}→${items[index] ? items[index].char : item.char}`)
      } else {
        const win = bestWindow(heardSyllables, items.map((item) => item.syllable))
        if (win.start < 0) continue
        span = items.slice(win.start, win.start + win.length).map((item) => item.char).join('')
        // 对齐位置打折。名字是「姓+名」，用户要么说姓、要么连名带姓说，
        // 所以命中窗口落在字符串中段（两头都没到头）多半只是碰巧有个同音字：
        //   李 → 万里独行（昵称里的「里」）不该和 李保乐 一样高。
        // 但「他一乐 → 软工2301 拓亦乐」是命中了名字的结尾，那是正常的：不打折。
        let factor = 1
        if (win.start + win.length < items.length) factor = 0.9
        if (win.start > 0 && heardItems.length < 2) factor *= 0.9
        phonetic = clamp01(win.score * factor)
        // 逐字对齐说清「为什么像」：他→拓、弈→一、乐→乐。
        shared = heardItems
          .map((item, index) => ({ item, candidate: items[win.start + index] }))
          .filter((pair) => pair.candidate && pair.item.syllable !== pair.candidate.syllable)
          .map((pair) => ({ pair, sim: bestWindow([pair.item.syllable], [pair.candidate.syllable]).score }))
          .filter((entry) => entry.sim >= 0.55)
          .map((entry) => `${entry.pair.item.char}→${entry.pair.candidate.char}`)
      }
      if (!best || phonetic > best.phonetic) best = { phonetic, span, matchedName: text, kind: variant.kind, shared }
    }
    if (!best || best.phonetic < MIN_PHONETIC) continue

    const session = sessions.get(person.username) || null
    const { score: recency, minutes } = recencyScore(session ? session.lastAt : null, now)
    const fileStat = files.get(person.username) || EMPTY_FILES
    const contextBonus = fileStat.recent > 0 && FILE_HINT.test(context) ? 0.03 : 0
    const score = clamp01(0.85 * best.phonetic + 0.15 * recency + contextBonus)
    // 对外显示的是「这个人是谁」——用显示名，别名/备注只作为命中依据。
    const displayName = (person.names.find((name) => name.kind === 'display') || person.names[0]).text

    ranked.push({
      username: person.username,
      name: displayName,
      isGroup: Boolean(person.isGroup),
      score,
      phonetic: best.phonetic,
      recency,
      minutes,
      matchedName: best.matchedName,
      matchedKind: best.kind,
      span: best.span,
      shared: best.shared,
      lastMessage: session ? session.preview || '' : '',
      filesTotal: fileStat.total,
      filesRecent: fileStat.recent,
    })
  }

  ranked.sort((left, right) =>
    right.score - left.score ||
    right.phonetic - left.phonetic ||
    (left.minutes == null ? Number.MAX_SAFE_INTEGER : left.minutes) - (right.minutes == null ? Number.MAX_SAFE_INTEGER : right.minutes) ||
    left.name.length - right.name.length)
  return ranked
}

/** 分够了才直接下结论，否则问一句。 */
export function decide(candidates) {
  if (!candidates.length) return { decision: 'none', gap: 0 }
  const [top, second] = candidates
  const gap = top.score - (second ? second.score : 0)
  const confident = top.phonetic >= CONFIDENT_PHONETIC && top.score >= CONFIDENT_SCORE && gap >= CONFIDENT_GAP
  return { decision: confident ? 'confident' : 'ask', gap: round3(gap) }
}

// —— 别名表（和台账网页 / wechat_alias_save 共用同一份文件） ——

export function readAliasBook(file) {
  try {
    const book = JSON.parse(fs.readFileSync(file, 'utf8'))
    const people = book && typeof book.people === 'object' && book.people ? book.people : {}
    return { version: book && book.version ? book.version : 1, people }
  } catch {
    return { version: 1, people: {} }
  }
}

export function writeAliasBook(file, book) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const payload = {
    version: book.version || 1,
    updated_at: stamp(),
    people: book.people || {},
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return payload
}

/** 别名表 → 参与比对的人（联系人接口挂了也能靠它命中）。 */
export function aliasPeople(book) {
  const people = []
  for (const [username, entry] of Object.entries((book && book.people) || {})) {
    if (!username || !entry || typeof entry !== 'object') continue
    const names = []
    const display = asText(entry.display_name).trim()
    if (display) names.push({ text: display, kind: 'display' })
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
      const text = asText(alias).trim()
      if (text && text !== display) names.push({ text, kind: 'alias' })
    }
    if (names.length) people.push({ username, isGroup: false, names })
  }
  return people
}

/** 台账里的会话名：没有实时接口时的兜底（名字可能停在上次刷新的那一刻）。 */
export function ledgerPeople(rows) {
  const people = []
  for (const row of rows || []) {
    const username = asText(row.username).trim()
    const name = asText(row.name).trim()
    if (!username || !name || SYSTEM_USERS.has(username) || SYSTEM_NAMES.has(name)) continue
    people.push({ username, isGroup: Boolean(row.is_group), names: [{ text: name, kind: 'ledger' }] })
  }
  return people
}

function mergePeople(...groups) {
  const byUser = new Map()
  for (const group of groups) {
    for (const person of group || []) {
      if (!person || !person.username) continue
      const existing = byUser.get(person.username)
      if (!existing) {
        byUser.set(person.username, { username: person.username, isGroup: Boolean(person.isGroup), names: [...(person.names || [])] })
        continue
      }
      existing.isGroup = existing.isGroup || Boolean(person.isGroup)
      const seen = new Set(existing.names.map((name) => name.text))
      for (const name of person.names || []) {
        if (!name || !name.text || seen.has(name.text)) continue
        seen.add(name.text)
        existing.names.push(name)
      }
    }
  }
  return [...byUser.values()]
}

async function loadLedger(ledgerDb) {
  if (!ledgerDb) return { ok: false, rows: [], files: new Map() }
  let db = null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(ledgerDb, { readOnly: true })
    const rows = db.prepare('SELECT username, name, is_group FROM chats').all()
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86_400
    const fileRows = db.prepare(`
      SELECT chat_username,
             COUNT(*) AS total,
             SUM(CASE WHEN create_time > ? THEN 1 ELSE 0 END) AS recent,
             MAX(create_time) AS last_at
      FROM file_msgs GROUP BY chat_username
    `).all(cutoff)
    const files = new Map()
    for (const row of fileRows) {
      files.set(asText(row.chat_username), {
        total: Number(row.total) || 0,
        recent: Number(row.recent) || 0,
        lastAt: Number(row.last_at) ? Number(row.last_at) * 1000 : null,
      })
    }
    return { ok: true, rows, files }
  } catch {
    return { ok: false, rows: [], files: new Map() }
  } finally {
    try { db?.close() } catch { /* 已经关了 */ }
  }
}

/**
 * 组装工具/接口。options：
 *   ledgerDb   —— 取台账路径的函数或字符串（别名表放在它旁边；没有就只能读、不能确认）
 *   log        —— 打日志
 *   contactsUrl / sessionsUrl —— 覆盖实时接口（测试用）
 *   fetchJson  —— 覆盖取数（测试用）
 */
export function createNameResolver(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const ledgerDbOf = typeof options.ledgerDb === 'function' ? options.ledgerDb : () => options.ledgerDb || ''
  const contactsUrl = asText(options.contactsUrl) || DEFAULT_CONTACTS_URL
  const sessionsUrl = asText(options.sessionsUrl) || DEFAULT_SESSIONS_URL
  const getJson = typeof options.fetchJson === 'function' ? options.fetchJson : fetchJson

  let contactsState = { at: 0, people: [], ok: false, pending: null }
  let sessionsState = { at: 0, sessions: new Map(), ok: false, pending: null }

  const aliasFileOf = () => {
    const db = asText(ledgerDbOf()).trim()
    if (db) return path.join(path.dirname(db), 'name_aliases.json')
    return asText(process.env.DSH_VOICE_COPILOT_ALIAS_FILE).trim()
  }

  async function loadContacts(refresh = false) {
    const now = Date.now()
    if (!refresh && contactsState.people.length && now - contactsState.at < CONTACTS_TTL_MS) return contactsState
    if (contactsState.pending) return contactsState.pending
    const task = getJson(contactsUrl, FETCH_TIMEOUT_MS)
      .then((payload) => {
        const people = normalizeContacts(payload)
        contactsState = { at: Date.now(), people, ok: people.length > 0, pending: null }
        return contactsState
      })
      .catch((error) => {
        log(`voice_who: 联系人接口不可用（${error && error.message ? error.message : error}）`)
        // 失败也留个短缓存，别每句话都重新等 3 秒超时。
        contactsState = { at: Date.now() - CONTACTS_TTL_MS + 20_000, people: contactsState.people || [], ok: false, pending: null }
        return contactsState
      })
    contactsState.pending = task
    return task
  }

  async function loadSessions(refresh = false) {
    const now = Date.now()
    if (!refresh && sessionsState.sessions.size && now - sessionsState.at < SESSIONS_TTL_MS) return sessionsState
    if (sessionsState.pending) return sessionsState.pending
    const task = getJson(sessionsUrl, FETCH_TIMEOUT_MS)
      .then((payload) => {
        const sessions = normalizeSessions(payload)
        sessionsState = { at: Date.now(), sessions, ok: sessions.size > 0, pending: null }
        return sessionsState
      })
      .catch(() => {
        sessionsState = { at: Date.now(), sessions: sessionsState.sessions || new Map(), ok: false, pending: null }
        return sessionsState
      })
    sessionsState.pending = task
    return task
  }

  async function resolve(args = {}) {
    const heard = asText(args.heard).trim()
    if (!heard) return { ok: false, error: 'heard 不能为空：把语音里听到的那个名字原样传进来' }
    const limit = Math.max(1, Math.min(MAX_CANDIDATES, Number(args.limit) || MAX_CANDIDATES))
    const includeGroups = args.includeGroups === true
    const refresh = args.refresh === true
    const context = asText(args.context).trim()
    const now = Date.now()
    const heardItems = syllablesOf(stripNotes(heard))
    const initials = initialsOf(stripNotes(heard))

    // 纯拼音/首字母（LF、lifusheng）没有汉字可比，也不该白等一轮网络请求。
    if (!heardItems.length) {
      return {
        ok: true,
        heard,
        syllables: [],
        initials,
        decision: 'none',
        gap: 0,
        best: undefined,
        candidates: [],
        say: `「${heard}」里没有汉字，去用 voice_pinyin（action=match 或 initials）比对拼音/首字母。`,
        source: { contacts: 0, contactsLive: false, sessions: 0, sessionsLive: false, ledger: false, aliases: 0, pool: 0 },
        aliasFile: aliasFileOf() || '',
      }
    }

    const [contacts, sessionsStateNow] = await Promise.all([loadContacts(refresh), loadSessions(refresh)])
    const ledger = await loadLedger(asText(ledgerDbOf()).trim())
    const aliasFile = aliasFileOf()
    const book = aliasFile ? readAliasBook(aliasFile) : { version: 1, people: {} }

    const people = mergePeople(contacts.people, aliasPeople(book), ledger.rows ? ledgerPeople(ledger.rows) : [])
    const pool = includeGroups ? people : people.filter((person) => !person.isGroup)
    const files = ledger.files

    const ranked = rankPeople({
      heard,
      people: pool,
      sessions: sessionsStateNow.sessions,
      files,
      context,
      now,
    })
    // 分数太低的（只是某个字碰巧沾上）不摆给模型看，免得它拿垃圾候选去问用户。
    // 0.62 是实机调出来的：再低就会出现「张三丰 → 张翔荣」这种纯噪音。
    const usable = ranked.filter((candidate) => candidate.score >= 0.62 || candidate.phonetic >= 0.8)
    const top = usable.slice(0, limit)
    const { decision, gap } = decide(top)

    const describe = (candidate) => {
      const bits = []
      if (candidate.matchedKind === 'alias') bits.push(`以前记过它被写成「${candidate.matchedName}」`)
      else if (candidate.matchedKind === 'remark') bits.push(`按备注「${candidate.matchedName}」命中`)
      else if (candidate.matchedKind === 'nickname') bits.push(`按昵称「${candidate.matchedName}」命中`)
      else if (candidate.shared && candidate.shared.length) bits.push(`听音接近 ${candidate.shared.join('、')}`)
      else if (candidate.span && candidate.span !== heard) bits.push(`听音「${heard}」≈「${candidate.span}」`)
      else bits.push(`和「${heard}」字面一致`)
      bits.push(candidate.minutes == null ? '没在最近聊过' : `${formatAgo(candidate.minutes)}聊过`)
      if (candidate.filesRecent > 0) bits.push(`7 天内 ${candidate.filesRecent} 份文件`)
      return bits.join('，')
    }
    const decorate = (candidate) => ({
      ...candidate,
      score: round3(candidate.score),
      phonetic: round3(candidate.phonetic),
      recency: round3(candidate.recency),
      // 没聊过的人没有「多少分钟前」，给 undefined 让它不出现在 JSON 里（schema 里是数字）
      minutes: candidate.minutes == null ? undefined : candidate.minutes,
      reason: describe(candidate),
      lastMessageAgo: formatAgo(candidate.minutes),
      // 会话预览常是整段计费明细，给模型看头一句就够，别让工具结果吃掉上下文。
      lastMessage: asText(candidate.lastMessage).slice(0, 48),
    })

    const candidates = top.map(decorate)
    const best = decision === 'none' ? undefined : candidates[0]
    let say = ''
    if (decision === 'confident') {
      const tail = best.lastMessageAgo === '没聊过' ? '' : `他 ${best.lastMessageAgo}还说过话。`
      // 字面一模一样的不用反问，直接报人；靠拼音才认出来的用「吧？」留个台阶。
      say = best.phonetic >= 0.99 ? `是${best.name}。${tail}` : `是${best.name}吧？${tail}`
    } else if (decision === 'ask' && candidates.length) {
      const names = candidates.slice(0, 2).map((item) => item.name)
      // 只有一个像的别再问「是哪位」，直接问「是不是他」。
      say = names.length === 1 ? `是${names[0]}吗？` : `「${heard}」像${names.join('、')}，是哪位？`
    } else if (decision === 'none') {
      say = `联系人里没找到像「${heard}」的名字。`
    }

    return {
      ok: true,
      heard,
      syllables: heardItems.map((item) => item.syllable),
      initials,
      decision,
      gap,
      includeGroups,
      best,
      candidates,
      say,
      source: {
        contacts: contacts.people.length,
        contactsLive: Boolean(contacts.ok),
        sessions: sessionsStateNow.sessions.size,
        sessionsLive: Boolean(sessionsStateNow.ok),
        ledger: Boolean(ledger.ok),
        aliases: Object.keys(book.people).length,
        pool: pool.length,
      },
      aliasFile: aliasFile || '',
    }
  }

  /** 用户确认之后：把这次听错的写法记进别名表，下次直接字面命中。 */
  async function confirm(args = {}) {
    const heard = asText(args.heard).trim()
    const explicitUser = asText(args.username).trim()
    const display = asText(args.display || args.name).trim()
    if (!heard) return { ok: false, error: 'heard 不能为空：把这次听错的原话填进来' }
    if (!explicitUser && !display) return { ok: false, error: 'username 或 display 至少要给一个' }
    const aliasFile = aliasFileOf()
    if (!aliasFile) return { ok: false, error: '没有台账路径，找不到 name_aliases.json；先把插件配置里的 ledgerDb 填上' }

    let username = explicitUser
    let label = display
    if (!username) {
      const contacts = await loadContacts(false)
      const people = mergePeople(contacts.people, aliasPeople(readAliasBook(aliasFile)))
      const exact = people.find((person) => person.names.some((name) => name.text === display))
      if (!exact) return { ok: false, error: `联系人里没有叫「${display}」的，请换成 username` }
      username = exact.username
      label = label || exact.names[0].text
    }
    if (!label) {
      const contacts = await loadContacts(false)
      const known = contacts.people.find((person) => person.username === username)
      label = known && known.names[0] ? known.names[0].text : username
    }

    const book = readAliasBook(aliasFile)
    const entry = book.people[username] && typeof book.people[username] === 'object' ? book.people[username] : {}
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(asText).filter(Boolean) : []
    const normalized = heard.replace(/\s+/g, '')
    if (!aliases.includes(normalized) && normalized !== asText(entry.display_name).replace(/\s+/g, '')) aliases.push(normalized)
    book.people[username] = {
      display_name: asText(entry.display_name) || label,
      aliases,
      note: asText(entry.note) || '语音听错的写法',
      updated_at: stamp(),
    }
    writeAliasBook(aliasFile, book)
    log(`voice_who: 记下别名「${normalized}」→ ${book.people[username].display_name}（${username}）`)
    return {
      ok: true,
      username,
      displayName: book.people[username].display_name,
      aliases: book.people[username].aliases,
      file: aliasFile,
    }
  }

  return { resolve, confirm, tool: () => createWhoTool({ resolve, confirm }) }
}

/** 候选人的输出形状（best 和 candidates 共用一份，别写两遍）。 */
const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    username: { type: 'string' },
    name: { type: 'string' },
    isGroup: { type: 'boolean' },
    score: { type: 'number' },
    phonetic: { type: 'number' },
    recency: { type: 'number' },
    minutes: { type: 'number' },
    matchedName: { type: 'string' },
    matchedKind: { type: 'string' },
    span: { type: 'string' },
    shared: { type: 'array', items: { type: 'string' } },
    lastMessage: { type: 'string' },
    lastMessageAgo: { type: 'string' },
    filesTotal: { type: 'number' },
    filesRecent: { type: 'number' },
    reason: { type: 'string' },
  },
}

/**
 * voice_who 的工具定义。
 * 渲染出来的文字是模型实际读到的东西，所以把「结论 / 依据 / 备选」按人能一眼看懂的顺序摆。
 */
export function createWhoTool(resolver) {
  return {
    name: 'voice_who',
    description:
      '把语音里听到的一个名字，一次调用定位到具体的人：自动取本机微信联系人与最近会话，按声母/韵母做模糊匹配，再结合「最近有没有说话、发过文件」排序，直接给出结论或 1–2 个待确认的候选。语音转写听错人名时（「拓亦乐」听成「他一乐」、「皇甫韩心」听成「黄虎」）用它，不要自己先列名单。用户确认真实身份后，再用 action=confirm 把这次的听错写法记下来，下次同样听错就直接命中。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['resolve', 'confirm'],
          description: 'resolve=定位（默认）；confirm=把 heard→这个人 记进别名表',
        },
        heard: { type: 'string', description: '语音转写出来的那个名字，原样填，例如「他一乐」' },
        context: { type: 'string', description: '可选：用户这半句原话，用来判断是不是在说文件/东西' },
        limit: { type: 'number', description: '最多返回几个候选，默认 4' },
        includeGroups: { type: 'boolean', description: '可选：连微信群名一起比，默认只比人和联系人' },
        refresh: { type: 'boolean', description: '可选：跳过缓存重新拉联系人（刚加完好友时用）' },
        username: { type: 'string', description: 'confirm 时：目标人的 wxid（最准）' },
        display: { type: 'string', description: 'confirm 时：目标人的显示名（找不到 username 时用）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          heard: { type: 'string' },
          syllables: { type: 'array', items: { type: 'string' } },
          initials: { type: 'string' },
          decision: { type: 'string' },
          say: { type: 'string' },
          gap: { type: 'number' },
          includeGroups: { type: 'boolean' },
          aliasFile: { type: 'string' },
          source: {
            type: 'object',
            properties: {
              contacts: { type: 'number' },
              contactsLive: { type: 'boolean' },
              sessions: { type: 'number' },
              sessionsLive: { type: 'boolean' },
              ledger: { type: 'boolean' },
              aliases: { type: 'number' },
              pool: { type: 'number' },
            },
          },
          best: CANDIDATE_SCHEMA,
          candidates: { type: 'array', items: CANDIDATE_SCHEMA },
        },
        required: ['ok'],
      },
      render: (args, value) => {
        if (!value.ok) return [{ type: 'text', text: `没定位成：${value.error || '未知原因'}` }]
        const lines = [`「${value.heard}」→ ${(value.syllables || []).join(' ') || '（没汉字）'}${value.initials ? `（${value.initials}）` : ''}`]
        if (value.decision === 'confident' && value.best) {
          lines.push(`结论：${value.best.name}（${value.best.score}）  可以说：${value.say}`)
        } else if (value.decision === 'ask') {
          lines.push(`不够确定，需要问一句：${value.say}`)
        } else {
          lines.push(`没有像的候选：${value.say}`)
        }
        if (value.best) {
          const extra = value.best.lastMessage ? `；最后一句「${value.best.lastMessage}」` : ''
          lines.push(`依据：${value.best.reason}${extra}`)
        }
        const others = (value.candidates || []).slice(value.best ? 1 : 0)
        // 结论够硬时只报结论：同时摆一个 0.6 的备选会让模型忍不住两个都念出来。
        if (others.length && value.decision !== 'confident') {
          lines.push(`备选：${others.map((item) => `${item.name}（${item.score}：${item.reason}）`).join('；')}`)
        }
        if (value.decision !== 'confident' && value.best) {
          lines.push(`确认后调用 voice_who(action=confirm, heard=${JSON.stringify(value.heard)}, username=${JSON.stringify(value.best.username)}) 记住这次听错。`)
        }
        if (value.decision === 'none' && value.includeGroups !== true) {
          lines.push('（默认只比人不比群名；用户说的是群名就带 includeGroups=true 再试一次。）')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      try {
        if (input.action === 'confirm') {
          const result = await resolver.confirm(input)
          if (!result.ok) return { ok: false, error: result.error }
          return { ...result, say: `记下了：「${input.heard}」= ${result.displayName}` }
        }
        return await resolver.resolve(input)
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  }
}
