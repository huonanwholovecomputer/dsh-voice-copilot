/**
 * 课表：把「明天有什么课」这类问题接到本机的教务监视器 kbmon 上。
 *
 * kbmon（一个独立的 Python 小工具，默认装在 <本机>\教务系统研究）常驻托盘盯着正方教务系统的课表/成绩/选课，
 * 每轮检查把快照写进 kbmon/data/monitor.db。「今天/某一天上什么课」在它有现成的子命令，
 * 而且是纯本地推算（开学周 + 节次，不联网）：
 *
 *   python -m kbmon today [全天|上午|下午|晚上] [--date YYYY-MM-DD] [--json]
 *
 * 所以这里不复制它的周次/节次逻辑——那套规则（term_start、day_parts、period_times、
 * 快照过期提醒）都在 Python 里，JS 再写一遍只会两边打架。这个模块只做三件事：
 * 把用户嘴里的「明天下午」翻成一个日期 + 时段，跑子命令，再把 JSON 说成人话。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const PARTS = ['全天', '上午', '下午', '晚上']
// 用户嘴里可能说「早上/中午/晚自习」，落到 kbmon 认识的四个时段上。
const PART_ALIASES = new Map([
  ['全天', '全天'], ['整天', '全天'], ['一天', '全天'], ['全部', '全天'],
  ['上午', '上午'], ['早上', '上午'], ['早晨', '上午'], ['一早', '上午'],
  ['下午', '下午'], ['中午', '下午'], ['午后', '下午'],
  ['晚上', '晚上'], ['晚自习', '晚上'], ['夜里', '晚上'], ['晚间', '晚上'],
])

const CACHE_TTL_MS = 45_000
const SNAPSHOT_STALE_MS = 20 * 60 * 60 * 1000
const DEFAULT_TIMEOUT = 10_000
const MAX_BUFFER = 4 * 1024 * 1024

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

export function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 中文的星期/日期写法 → 阿拉伯数字星期（周一=1，周日=0）。不认识的返回 null。 */
function weekdayOf(text) {
  const match = String(text).match(/^(?:周|星期|礼拜)([一二三四五六日天])$/)
  if (!match) return null
  const table = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
  return table[match[1]]
}

function parseExplicitDate(text) {
  const iso = String(text).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const cn = String(text).match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?$/)
  if (cn) {
    const year = cn[1] ? Number(cn[1]) : new Date().getFullYear()
    const date = new Date(year, Number(cn[2]) - 1, Number(cn[3]))
    // 「1 月 5 号」在 12 月说，指的多半是明年 —— 只往前补一年，不猜更远。
    if (!cn[1] && date.getTime() < Date.now() - 180 * 86_400_000) date.setFullYear(year + 1)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

/**
 * 把用户说的「明天」「周三」「11月27日」翻成一个具体日期。
 * 空 → 今天；「周三」→ 下一个周三（今天就是周三则今天）。
 * @returns {{date: Date, text: string}}
 */
export function resolveWhen(input, now = Date.now()) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const raw = asText(input).replace(/\s+/g, '')
  if (!raw) return { date: today, text: '' }

  const relative = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2, 昨儿: -1 }
  if (raw in relative) {
    const date = new Date(today)
    date.setDate(date.getDate() + relative[raw])
    return { date, text: raw }
  }

  const weekday = weekdayOf(raw)
  if (weekday != null) {
    const date = new Date(today)
    const delta = (weekday - today.getDay() + 7) % 7
    date.setDate(date.getDate() + delta)
    return { date, text: raw }
  }

  const explicit = parseExplicitDate(raw)
  if (explicit) return { date: explicit, text: raw }
  throw new Error(`看不懂的日期「${asText(input)}」；用今天/明天/周几或 2026-11-27 这种写法`)
}

/**
 * 「今天下午」「明天早上」是模型最可能原样塞进 when 的写法，拆成日期和时段两半。
 * 拆完 when 为空（整句就是「下午」）时按今天算。
 */
export function splitPartFromWhen(input) {
  const raw = asText(input).replace(/\s+/g, '')
  if (!raw) return { when: '', part: '' }
  const names = [...PART_ALIASES.keys()].sort((a, b) => b.length - a.length)
  for (const name of names) {
    const index = raw.indexOf(name)
    if (index < 0) continue
    const rest = raw.slice(0, index) + raw.slice(index + name.length)
    if (!rest) return { when: '', part: PART_ALIASES.get(name) }
    return { when: rest, part: PART_ALIASES.get(name) }
  }
  return { when: raw, part: '' }
}

/** 「下午」「早上」→ kbmon 的时段名。认不出来就全天。 */
export function normalizePart(input) {
  const raw = asText(input).replace(/\s+/g, '')
  if (!raw) return '全天'
  return PART_ALIASES.get(raw) || '全天'
}

function fmtDay(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** 标签本身就是星期几时（「周六」），别在表头再重复一遍。 */
function weekdaysEqual(label, weekday) {
  const text = asText(label)
  const name = asText(weekday)
  if (!text || !name) return false
  return text === name || text.endsWith(name) || text.includes(name)
}

function formatSnapshotStamp(text) {
  const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!match) return ''
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}

function snapshotAgeMs(snapshotAt, now) {
  const match = String(snapshotAt || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return null
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0))
  return Number.isNaN(at.getTime()) ? null : now - at.getTime()
}

/**
 * 读监视器自己的健康状态（只读打开 monitor.db）：
 * 快照只在课表**变化**时才新写一行，所以 snapshot_at 旧不代表监控停了——meta.last_timetable_ok
 * 才是「最近一次成功检查」的时刻。
 * @returns {null | {lastTimetableOk: string, count: number, lastRun: null | {status: string, message: string, startedAt: string}}}
 */
export function readMonitorHealth(dir, dbFile) {
  const file = dbFile || (dir ? path.join(dir, 'kbmon', 'data', 'monitor.db') : '')
  if (!file || !fs.existsSync(file)) return null
  let db = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare('select key, value from meta').all()
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]))
    const run = db.prepare("select status, message, started_at from runs where kind = 'timetable' order by id desc limit 1").get()
    return {
      lastTimetableOk: asText(meta.last_timetable_ok),
      count: Number(meta.timetable_count) || 0,
      lastRun: run ? { status: asText(run.status), message: asText(run.message), startedAt: asText(run.started_at) } : null,
    }
  } catch {
    return null
  } finally {
    if (db) {
      try {
        db.close()
      } catch { /* 关不掉也无所谓 */ }
    }
  }
}

function courseLine(course) {
  const room = asText(course.room) || '地点未定'
  const teacher = asText(course.teacher)
  const head = `${asText(course.period) || asText(course.periods)} ${asText(course.course)}`
  return `${head}｜${teacher || '老师未定'}｜${room}`
}

/**
 * 把 kbmon 的 today --json 翻成「模型能直接念出来」的两段：
 *   say  —— 一句话结论（口语，含门数/时段/教室）
 *   text —— 分行的明细（谁教、在哪、第几周），供模型回答追问
 */
export function formatDay(payload, { label = '', part = '全天', now = Date.now(), health = null } = {}) {
  const dateText = asText(payload.date)
  const weekday = asText(payload.weekday)
  const week = Number(payload.week) || 0
  const status = asText(payload.status) || 'ok'
  const note = asText(payload.note)
  const stamp = formatSnapshotStamp(payload.snapshot_at)
  // 快照只在课表**变化**时才新写一行，所以「快照是 11-16 的」并不等于「监视器停了」。
  // 监视器每轮成功检查的时刻记在 monitor.db 的 meta 里，用它判断新鲜度。
  const checkedAt = formatSnapshotStamp(health && health.lastTimetableOk)
  const age = snapshotAgeMs((health && health.lastTimetableOk) || payload.snapshot_at, now)
  const stale = age != null && age > SNAPSHOT_STALE_MS
  const courses = Array.isArray(payload.courses) ? payload.courses : []

  // 没给标签但问的就是今天时，说「今天」比报日期口语。
  const isToday = dateText === ymd(new Date(now))
  const dayName = label || (isToday ? '今天' : (dateText ? fmtDay(new Date(`${dateText}T00:00:00`)) : '这天'))
  const weekText = week > 0 ? `第 ${week} 周` : ''
  // 标签（明天/周三）和具体日期一起给，用户才知道「周三」指的是哪一天。
  const dateBit = dateText ? fmtDay(new Date(`${dateText}T00:00:00`)) : ''
  const isDateLabel = /^(\d{4}[-/.]|(\d{4}年)?\d{1,2}月)/.test(label)
  const parenBits = [weekday && !weekdaysEqual(label, weekday) ? weekday : '', weekText].filter(Boolean)
  const headCore = `${dateBit}${parenBits.length ? `（${parenBits.join('，')}）` : ''}`
  const head = label && !isDateLabel ? `${label} ${headCore}` : (headCore || label)

  const lines = []
  const sayBits = []
  let staleHint = ''
  // kbmon 的 --json 不按时段过滤（只有文本输出会），所以过滤在这里做。
  const picked = part === '全天' ? courses : courses.filter((course) => asText(course.part) === part)
  const dropped = part === '全天' ? [] : courses.filter((course) => asText(course.part) !== part)

  if (status === 'ok') {
    const byPart = new Map()
    for (const course of picked) {
      const key = asText(course.part) || '其他'
      if (!byPart.has(key)) byPart.set(key, [])
      byPart.get(key).push(course)
    }
    const spoken = []
    for (const name of PARTS.slice(1)) {
      const list = byPart.get(name)
      if (!list) continue
      spoken.push(`${name}${list.map((course) => {
        const room = asText(course.room)
        const teacher = asText(course.teacher)
        const tail = [teacher, room && room !== '未排地点' ? room : ''].filter(Boolean).join('，')
        return `${asText(course.period)} ${asText(course.course)}${tail ? `（${tail}）` : ''}`
      }).join('、')}`)
    }
    const partText = part && part !== '全天' ? part : ''
    if (!picked.length) {
      sayBits.push(`${dayName}${partText}没课`)
    } else {
      sayBits.push(`${dayName}${partText}有 ${picked.length} 门课`)
      if (spoken.length) sayBits.push(spoken.join('；'))
    }
    lines.push(`${head}·${picked.length} 门课${stamp ? `（课表快照 ${stamp}${checkedAt && checkedAt !== stamp ? `，监视器 ${checkedAt} 检查过` : ''}）` : ''}`)
    for (const course of picked) lines.push(`· ${asText(course.part)} ${courseLine(course)}`)
    // 只问了上午、下午还有课时给一句，免得模型以为这一天全空。
    if (!picked.length && dropped.length) {
      sayBits.push(`另外${dropped.map((course) => `${asText(course.part)}${asText(course.period)}有${asText(course.course)}`).join('、')}`)
      lines.push(`（这一天另外还有：${dropped.map((course) => `${asText(course.part)} ${courseLine(course)}`).join('；')}）`)
    }
  } else if (status === 'empty') {
    sayBits.push(`${dayName}${part !== '全天' ? part : ''}没课`)
    lines.push(`${head}·没课`)
  } else if (status === 'before') {
    sayBits.push(note || '还没开学')
    lines.push(`${head}·${note || '还没开学'}`)
  } else if (status === 'after') {
    sayBits.push(note || '这一天已经不在课表的周次里')
    lines.push(`${head}·${note || '超出课表周次'}`)
  } else if (status === 'no-start') {
    sayBits.push(note || '没配置开学日期，算不出第几周')
    lines.push(`${head}·${note || '没配置开学日期'}`)
  } else {
    sayBits.push(note || `课表状态异常（${status}）`)
    lines.push(`${head}·${note || status}`)
  }

  if (stale) {
    // 口头只说「多久没查过」：真正该提醒的是监控停了，而不是快照本身哪天的。
    const hours = Math.round(age / 3_600_000)
    const since = checkedAt || stamp
    staleHint = `，不过课表监视器 ${since || '很久'} 之后就没成功检查过（已经 ${hours} 小时），可能有新调课`
    lines.push(`（${since || '上一次'} 之后没再成功检查过，已经 ${hours} 小时；让 kbmon 跑一次 check）`)
  }

  return {
    say: `${sayBits.join('，')}${staleHint}。`,
    text: lines.join('\n'),
    courses: picked,
    dropped,
    week,
    status,
    stale,
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = asText(stderr) || asText(stdout) || error.message
        error.detail = detail.split('\n').filter(Boolean).slice(-3).join(' / ')
        reject(error)
        return
      }
      resolve(String(stdout))
    })
  })
}

/**
 * voice_courses 工具：只读本地快照，不联网、不触发检查（要刷新课表就让 kbmon 自己去跑）。
 * @param {object} options
 * @param {() => string} [options.dir]  kbmon 所在目录（由插件配置的 kbmonDir 提供）
 * @param {() => string} [options.python] python 解释器
 * @param {(text: string) => void} [options.log]
 * @param {(args: object) => Promise<{stdout: string}>} [options.run] 覆盖子进程（测试用）
 */
export function createCourses({ dir, python, log, run } = {}) {
  const dirOf = typeof dir === 'function' ? dir : () => asText(dir)
  const pythonOf = typeof python === 'function' ? python : () => asText(python)
  const cache = new Map()
  const note = typeof log === 'function' ? log : () => {}

  async function today(args = {}) {
    const now = Number(args.now) || Date.now()
    const split = splitPartFromWhen(args.when)
    const part = normalizePart(args.part || split.part)
    let when
    try {
      when = resolveWhen(split.when, now)
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const date = ymd(when.date)
    const configured = asText(dirOf())
    if (!configured) {
      return { ok: false, error: '还没配置教务监视器目录：在插件设置或 agents/xiaoyin/agent.json 的 settings.kbmonDir 里填 kbmon 的位置' }
    }
    const root = path.resolve(configured)
    if (!fs.existsSync(root)) {
      return { ok: false, error: `找不到教务监视器目录（${root}）：检查 kbmonDir 是否还是这个路径` }
    }

    const key = `${date}|${part}`
    const hit = cache.get(key)
    if (hit && hit.at > now - CACHE_TTL_MS) return { ...hit.value, cached: true }

    const exe = pythonOf() || 'python'
    let stdout
    try {
      const result = run
        ? await run({ dir: root, python: exe, date, part })
        : { stdout: await runCommand(exe, ['-m', 'kbmon', 'today', part, '--date', date, '--json'], {
          cwd: root,
          timeout: DEFAULT_TIMEOUT,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }) }
      stdout = result.stdout
    } catch (error) {
      const detail = asText(error && error.detail) || asText(error && error.message)
      note(`voice_courses：kbmon 跑失败（${detail}）`)
      if (error && error.code === 'ENOENT') {
        return { ok: false, error: `没找到 python（${exe}）：把这个解释器的绝对路径填到插件设置的 pythonExe` }
      }
      return { ok: false, error: `教务监视器没给出课表：${detail || '未知错误'}` }
    }

    let payload
    try {
      payload = JSON.parse(String(stdout).trim())
    } catch {
      return { ok: false, error: '教务监视器输出不是 JSON（版本不一致？）' }
    }

    const health = readMonitorHealth(root)
    const formatted = formatDay(payload, { label: when.text, part, now, health })
    const value = {
      ok: true,
      date,
      part,
      label: when.text,
      say: formatted.say,
      text: formatted.text,
      week: formatted.week,
      status: formatted.status,
      stale: formatted.stale,
      snapshotAt: asText(payload.snapshot_at),
      checkedAt: (health && health.lastTimetableOk) || '',
      courses: formatted.courses.map((course) => ({
        part: asText(course.part),
        period: asText(course.period),
        course: asText(course.course),
        teacher: asText(course.teacher),
        room: asText(course.room),
        weeks: asText(course.weeks),
      })),
    }
    cache.set(key, { at: now, value })
    return value
  }

  const tool = () => ({
    name: 'voice_courses',
    description: '查本机教务监视器里的课表：某一天（默认今天）上什么课，可按上午/下午/晚上过滤。问「明天有什么课」「今天下午有课吗」「周三上什么」时用它，别自己算日期。',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: '哪天：今天/明天/后天/昨天/周三/下周三/2026-11-27；留空=今天' },
        part: { type: 'string', enum: ['全天', '上午', '下午', '晚上'], description: '只看某个时段，默认全天' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          date: { type: 'string' },
          part: { type: 'string' },
          label: { type: 'string' },
          say: { type: 'string' },
          text: { type: 'string' },
          week: { type: 'number' },
          status: { type: 'string' },
          stale: { type: 'boolean' },
          snapshotAt: { type: 'string' },
          checkedAt: { type: 'string' },
          courses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                part: { type: 'string' },
                period: { type: 'string' },
                course: { type: 'string' },
                teacher: { type: 'string' },
                room: { type: 'string' },
                weeks: { type: 'string' },
              },
            },
          },
        },
        required: ['ok'],
      },
      render(args, value) {
        if (!value || value.ok !== true) {
          return [{ type: 'text', text: `查课表失败：${(value && value.error) || '没有结果'}` }]
        }
        const lines = [value.text, `可以说：${value.say}`]
        if (value.courses.length === 0 && value.status === 'ok' && value.part === '全天') lines.push('（这一天是上课周，但一节课都没有。）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args = {}) {
      return today({
        when: asText(args.when),
        part: asText(args.part),
        now: Date.now(),
      })
    },
  })

  return { tool, today, dirOf }
}
