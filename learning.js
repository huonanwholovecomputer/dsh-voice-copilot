/**
 * 学习记录（Host 半侧）。
 *
 * 目标：小印每轮在干什么，都能在离线时复盘——思考了几步、调了哪些工具、参数长什么样、
 * 哪一步报错、最后怎么回答。数据只落本地 `learning/`，不进开源提交，也不发网络。
 *
 * 数据来源是宿主的会话事件流 `ctx.on('session/event', …)`，不是解析 zstd 会话文件：
 * 同一条流里既有 reasoning 也有 tool/call、tool/result，还带 seq，重载后可以靠 seq 去重。
 *
 * 目录结构：
 *   learning/turns/YYYY-MM-DD.jsonl    每轮一行
 *   learning/notes/YYYY-MM-DD.jsonl    小印自己记的问题（voice_note 工具）
 *   learning/sessions/<id>.json        每个会话的累计摘要
 *
 * 隐私：落盘前做基础脱敏（手机号、身份证号、wxid），超长文本按配置截断并保留原长度，
 * 分析时既能看出「这段被截了」，也不会把完整顾客资料堆在磁盘上。
 */
import fs from 'node:fs'
import path from 'node:path'

const PHONE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g
const ID_CARD = /(?<!\d)(\d{17}[\dXx])(?!\d)/g
const WXID = /wxid_[A-Za-z0-9_-]{4,}/gi

/** 基础脱敏：手机号留前 3 后 4，身份证与 wxid 整段打码。 */
export function redactText(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text
    .replace(ID_CARD, (match) => `${match.slice(0, 4)}${'*'.repeat(14)}`)
    .replace(PHONE, (match) => `${match.slice(0, 3)}****${match.slice(-4)}`)
    .replace(WXID, 'wxid_***')
}

export function dayKey(ts) {
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const textOf = (content) => {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

/**
 * @param {object} options
 * @param {string} options.dir 落盘根目录（learning/）
 * @param {(line: string) => void} [options.log] 插件日志
 * @param {() => {thinking: number, args: number, result: number}} [options.limits] 动态截断上限
 * @param {() => boolean} [options.redact] 是否脱敏
 * @param {(event: object) => boolean} [options.isHuman] 判断 user/message 是不是人说的话
 * @param {(text: string) => boolean} [options.isNoise] 兜底过滤运行时上下文
 * @param {() => string} [options.cwd] 语音会话工作目录
 * @param {() => string} [options.preset] 语音会话 preset
 */
export function createLearning(options) {
  const dir = options.dir
  const log = options.log || (() => {})
  const limits = options.limits || (() => ({ thinking: 4000, args: 2000, result: 1500 }))
  const redact = options.redact || (() => true)
  const isHuman = options.isHuman || (() => true)
  const isNoise = options.isNoise || (() => false)
  const currentCwd = options.cwd || (() => '')
  const currentPreset = options.preset || (() => '')

  const turnsDir = path.join(dir, 'turns')
  const notesDir = path.join(dir, 'notes')
  const sessionsDir = path.join(dir, 'sessions')

  /** sessionId -> { lastSeq, turn, lastUser, lastUserAt } */
  const state = new Map()
  let lastSessionId = ''

  const appendJsonl = (file, value) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
      return file
    } catch (error) {
      log(`learning write failed (${file}): ${error}`)
      return ''
    }
  }

  const clean = (value, cap) => {
    const raw = typeof value === 'string' ? value : ''
    const text = redact() ? redactText(raw) : raw
    const chars = text.length
    const cut = Number.isFinite(cap) && cap > 0 && chars > cap
    return { text: cut ? `${text.slice(0, cap)}…` : text, chars, cut }
  }

  const track = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') return
    lastSessionId = sessionId
    if (!state.has(sessionId)) state.set(sessionId, { lastSeq: -1, turn: null, lastUser: '', lastUserAt: 0 })
  }

  const activeTurn = () => {
    const entry = lastSessionId ? state.get(lastSessionId) : null
    return entry && entry.turn ? entry.turn : null
  }

  const turnRecord = (turn) => {
    const caps = { ...limits(), user: 2000, answer: 8000 }
    const user = clean(turn.user, caps.user)
    const answer = clean(turn.answer, caps.answer)
    const thinking = turn.thinking.map((item) => {
      const body = clean(item.text, caps.thinking)
      return { step: item.step, chars: body.chars, text: body.text }
    })
    const tools = turn.tools.map((item) => {
      const args = clean(item.args, caps.args)
      const result = clean(item.result, caps.result)
      const error = clean(item.error, 600)
      return {
        step: item.step,
        name: item.name,
        callId: item.callId,
        args: args.text,
        argsChars: args.chars,
        ok: item.ok,
        ms: item.ms,
        result: result.text,
        resultChars: result.chars,
        ...(error.text ? { error: error.text } : {}),
      }
    })
    return {
      v: 1,
      sessionId: turn.sessionId,
      turn: turn.turn,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      durationMs: turn.durationMs,
      cwd: turn.cwd,
      preset: turn.preset,
      model: turn.model,
      user: user.text,
      userChars: user.chars,
      steps: turn.steps,
      thinking,
      tools,
      answer: answer.text,
      answerChars: answer.chars,
      reason: turn.reason,
      interrupted: turn.interrupted,
    }
  }

  const updateSession = (record) => {
    const file = path.join(sessionsDir, `${record.sessionId}.json`)
    let previous = {}
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 第一次写 */ }
    const failures = record.tools.filter((tool) => tool.ok === false).length
    const next = {
      sessionId: record.sessionId,
      cwd: record.cwd,
      preset: record.preset,
      model: record.model || previous.model || '',
      firstSeen: previous.firstSeen || record.startedAt,
      lastSeen: record.endedAt,
      turns: (previous.turns || 0) + 1,
      tools: (previous.tools || 0) + record.tools.length,
      toolFailures: (previous.toolFailures || 0) + failures,
      lastTurn: record.turn,
      lastTurnAt: record.endedAt,
      lastDurationMs: record.durationMs,
      lastReason: record.reason,
      lastUser: record.user,
    }
    try {
      fs.mkdirSync(sessionsDir, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      log(`learning session summary failed: ${error}`)
    }
  }

  const finish = (sessionId, reason, time) => {
    const entry = state.get(sessionId)
    if (!entry || !entry.turn) return
    const turn = entry.turn
    entry.turn = null
    turn.endedAt = time
    turn.durationMs = Math.max(0, time - turn.startedAt)
    turn.reason = reason && typeof reason.kind === 'string' ? reason.kind : ''
    turn.interrupted = Boolean(turn.reason && turn.reason !== 'completed')
    const record = turnRecord(turn)
    appendJsonl(path.join(turnsDir, `${dayKey(turn.startedAt)}.jsonl`), record)
    updateSession(record)
  }

  const observe = (session, event) => {
    if (!session || !event || typeof event.seq !== 'number') return
    const sessionId = session.id
    if (!sessionId || !state.has(sessionId)) return
    const entry = state.get(sessionId)
    if (event.seq <= entry.lastSeq) return
    const time = Number.isFinite(event.time) ? event.time : Date.now()
    const data = event.data || {}

    switch (event.type) {
      case 'turn/start': {
        // 上一轮没收到 turn/end（插件重载/进程被杀）就把残轮标成 interrupted 落盘，别丢。
        if (entry.turn) finish(sessionId, { kind: 'superseded' }, time)
        entry.turn = {
          sessionId,
          turn: typeof data.turn === 'number' ? data.turn : 0,
          startedAt: time,
          cwd: session.cwd || currentCwd(),
          preset: currentPreset(),
          model: '',
          user: '',
          thinking: [],
          tools: [],
          steps: 0,
          answer: '',
          endedAt: null,
          durationMs: null,
          reason: '',
          interrupted: false,
        }
        entry.lastSeq = event.seq
        return
      }
      case 'user/message': {
        if (!entry.turn) return
        if (!isHuman(event)) return
        const text = textOf(data.content)
        if (!text || isNoise(text)) return
        entry.turn.user = entry.turn.user ? `${entry.turn.user}\n${text}` : text
        entry.lastSeq = event.seq
        return
      }
      case 'assistant/message': {
        if (!entry.turn) return
        const message = data.message || {}
        const step = typeof data.step === 'number' ? data.step : 0
        for (const part of message.content || []) {
          if (!part || typeof part.text !== 'string' || !part.text.trim()) continue
          if (part.type === 'reasoning') entry.turn.thinking.push({ step, text: part.text })
          else if (part.type === 'text') {
            entry.turn.answer = entry.turn.answer ? `${entry.turn.answer}\n${part.text}` : part.text
          }
        }
        entry.lastSeq = event.seq
        return
      }
      case 'tool/call': {
        if (!entry.turn) return
        entry.turn.tools.push({
          step: typeof data.step === 'number' ? data.step : 0,
          name: String(data.name || ''),
          callId: String(data.callId || ''),
          args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? ''),
          at: time,
          ok: null,
          ms: null,
          result: '',
          error: '',
        })
        entry.lastSeq = event.seq
        return
      }
      case 'tool/result': {
        if (!entry.turn) return
        const message = data.message || {}
        const callId = String(message.toolCallId || (message.source && message.source.callId) || '')
        const item = entry.turn.tools.find((tool) => tool.callId === callId)
        if (!item) return
        const text = textOf(message.content)
        item.ok = message.isError !== true
        item.ms = Math.max(0, time - item.at)
        item.result = text
        if (message.isError === true) item.error = text
        entry.lastSeq = event.seq
        return
      }
      case 'step/end': {
        if (!entry.turn) return
        if (typeof data.step === 'number') entry.turn.steps = Math.max(entry.turn.steps, data.step)
        entry.lastSeq = event.seq
        return
      }
      case 'request/header': {
        if (!entry.turn) return
        const config = data.header && data.header.config
        if (config && typeof config.model === 'string') entry.turn.model = config.model
        entry.lastSeq = event.seq
        return
      }
      case 'turn/end': {
        if (!entry.turn) return
        finish(sessionId, data.reason, time)
        entry.lastSeq = event.seq
        return
      }
      default:
        entry.lastSeq = event.seq
    }
  }

  /** 写一条小印自己的观察，返回落盘位置（相对 learning/）。 */
  const note = (input) => {
    const at = Date.now()
    const id = `note-${at}-${Math.random().toString(36).slice(2, 8)}`
    const turn = activeTurn()
    const entry = {
      v: 1,
      id,
      at,
      kind: String(input.kind || 'observation'),
      severity: String(input.severity || 'medium'),
      title: clean(input.title, 300).text,
      detail: clean(input.detail, 4000).text,
      sessionId: lastSessionId || null,
      turn: turn ? turn.turn : null,
      cwd: turn ? turn.cwd : currentCwd(),
    }
    const file = appendJsonl(path.join(notesDir, `${dayKey(at)}.jsonl`), entry)
    return { ok: Boolean(file), id, path: file ? `notes/${dayKey(at)}.jsonl` : '' }
  }

  /** 注册给模型的工具定义（普通对象即可，宿主 registry 只校验 output.schema）。 */
  const noteTool = () => ({
    name: 'voice_note',
    description:
      '记录一条工作观察，写进本机学习日志供之后离线分析（问题、想法、用户偏好）。'
      + '只在出现以下情况时调用：同一个工具连续失败、用户纠正你、流程明显卡住、或你发现一条值得记住的偏好。'
      + '记完继续手头的事，不要为了记录停下来解释。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['problem', 'idea', 'preference', 'observation'],
          description: 'problem=卡住/报错；idea=可改进点；preference=用户偏好；observation=其他观察',
        },
        title: { type: 'string', description: '一句话概括，会出现在日报里' },
        detail: { type: 'string', description: '现场细节：做了什么、报了什么错、卡在哪一步、看到什么' },
        severity: { type: 'string', enum: ['low', 'medium', 'high'], description: '影响程度，默认 medium' },
      },
      required: ['kind', 'title', 'detail'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['ok', 'id', 'path'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `已记录：${value.path}` : '记录失败，看看插件日志。',
      }],
    },
    execute: (args) => {
      const input = args && typeof args === 'object' ? args : {}
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const detail = typeof input.detail === 'string' ? input.detail.trim() : ''
      if (!title || !detail) throw new Error('voice_note 需要 title 和 detail（都不能为空）')
      return note({
        kind: input.kind,
        severity: input.severity,
        title,
        detail,
      })
    },
  })

  /** 插件卸载时把还没收尾的轮次落盘，避免半轮凭空消失。 */
  const flush = (reason) => {
    const time = Date.now()
    for (const [sessionId, entry] of state) {
      if (entry.turn) finish(sessionId, { kind: reason || 'flushed' }, time)
    }
  }

  return { track, observe, note, noteTool, flush, dir, activeTurn }
}
