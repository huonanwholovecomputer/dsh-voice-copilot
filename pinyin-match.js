/**
 * 拼音模糊匹配：语音转写经常把名字听成同音/近音字。
 *
 * 实例：用户说的是「李福生」，转写成了「李虎」。
 *   李福生 → li fu sheng
 *   李虎   → li hu
 * 首字母分别是 LFSH 和 LH，纯首字母前缀匹配根本对不上；但按「音节」比，
 * li=li 完全一致、hu vs fu 只差一个字母，所以能排到最前面。
 *
 * 所以这里做两件事：
 *   1. 音节级编辑距离（同音字 → 同一个音节 → 满分；近音 → 按字母差算分）；
 *   2. 首字母对齐（用户直接打 LF 这种缩写时也认）。
 *
 * 纯计算、无依赖。拼音表复用 desktop/data/pinyin.json（pypinyin 生成的带声调表）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAP_FILE = path.join(HERE, 'desktop', 'data', 'pinyin.json')

// 声母按长度降序，保证 zh/ch/sh 先于 z/c/s 命中。
const INITIALS = [
  'zh', 'ch', 'sh',
  'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w',
]

let MAP = null
let SYLLABLES = null

function lexicon() {
  if (MAP) return MAP
  try {
    MAP = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
  } catch {
    MAP = {}
  }
  return MAP
}

/** 拼音表里出现过的音节集合（去声调），按长度降序，用于把连写拼音切开。 */
function syllableSet() {
  if (SYLLABLES) return SYLLABLES
  const set = new Set()
  for (const value of Object.values(lexicon())) {
    const syllable = toneless(value)
    if (/^[a-z]+$/.test(syllable)) set.add(syllable)
  }
  SYLLABLES = [...set].sort((a, b) => b.length - a.length)
  return SYLLABLES
}

/** `lifusheng` → ['li','fu','sheng']；切不开返回 null（当作首字母缩写处理）。 */
function segmentPinyin(text) {
  const syllables = syllableSet()
  const out = []
  let index = 0
  while (index < text.length) {
    const found = syllables.find((syllable) => text.startsWith(syllable, index))
    if (!found) return null
    out.push(found)
    index += found.length
  }
  return out.length ? out : null
}

/** `huáng` → `huang`；ü → u。比较时不分声调。 */
function toneless(pinyin) {
  return String(pinyin || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ü/g, 'u')
    .toLowerCase()
}

function splitInitial(syllable) {
  for (const initial of INITIALS) {
    if (syllable.startsWith(initial)) {
      return { initial, final: syllable.slice(initial.length) }
    }
  }
  return { initial: '', final: syllable }
}

/**
 * 汉字 → 音节数组。非汉字直接跳过。
 * @param {string} text
 * @returns {{char: string, toned: string, syllable: string, initial: string, final: string}[]}
 */
export function syllablesOf(text) {
  const map = lexicon()
  const out = []
  for (const char of String(text || '')) {
    const toned = map[char]
    if (!toned) continue
    const syllable = toneless(toned)
    const { initial, final } = splitInitial(syllable)
    out.push({ char, toned, syllable, initial, final })
  }
  return out
}

/** 汉字的声母串：李福生 → lfsh */
export function initialsOf(text) {
  return syllablesOf(text).map((item) => item.initial || item.syllable.slice(0, 1)).join('')
}

function editDistance(a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, index) => index)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}

/** 两个音节有多像：完全相同 1；hu vs fu 差 1 个字母 → 0.5。 */
function syllableSim(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const length = Math.max(a.length, b.length)
  return Math.max(0, 1 - editDistance(a, b) / length)
}

/**
 * 在候选里找「听到的这一串音节」最像的一段连续区间，返回平均相似度。
 * 候选可以比听到的长（只听清「李」，候选可以是「李福生」），但更短时按重叠比例打折。
 */
function phoneticScore(heard, candidate) {
  if (!heard.length || !candidate.length) return 0
  if (candidate.length < heard.length) {
    let sum = 0
    for (let index = 0; index < candidate.length; index++) {
      sum += syllableSim(heard[index].syllable, candidate[index].syllable)
    }
    return (sum / candidate.length) * (candidate.length / heard.length)
  }
  let best = 0
  for (let start = 0; start + heard.length <= candidate.length; start++) {
    let sum = 0
    for (let index = 0; index < heard.length; index++) {
      sum += syllableSim(heard[index].syllable, candidate[start + index].syllable)
    }
    best = Math.max(best, sum / heard.length)
  }
  return best
}

/** 首字母逐位对齐：lh vs lfsh 在开头对齐时 l=l、h≠f → 0.5。 */
function initialScore(heard, candidate) {
  if (!heard.length) return 0
  if (candidate.length < heard.length) {
    let hit = 0
    for (let index = 0; index < candidate.length; index++) {
      if (candidate[index] === heard[index]) hit++
    }
    return (hit / candidate.length) * (candidate.length / heard.length)
  }
  let best = 0
  for (let start = 0; start + heard.length <= candidate.length; start++) {
    let hit = 0
    for (let index = 0; index < heard.length; index++) {
      if (candidate[start + index] === heard[index]) hit++
    }
    best = Math.max(best, hit / heard.length)
  }
  return best
}

/** heard 的首字母是否按顺序出现在 candidate 的首字母里（允许中间隔字）。 */
function initialsSubsequence(needle, haystack) {
  let cursor = 0
  for (const char of haystack) {
    if (char === needle[cursor]) cursor++
    if (cursor >= needle.length) return true
  }
  return needle.length === 0
}

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/

/** 名字后面常带备注（王芳（辅导员）），备注里的音不该参与比对。 */
function stripNotes(name) {
  return String(name || '').replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, ' ')
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * 把 query 归一成三种形态：
 *   han       —— 汉字，按拼音表拆音节
 *   pinyin    —— 用户手打的完整拼音（zhang wei / zhang-wei）
 *   initials  —— 用户手打的首字母缩写（lf / lfsh）
 */
function parseQuery(query) {
  const han = syllablesOf(query)
  if (han.length) return { mode: 'han', syllables: han, initials: han.map((item) => item.initial || item.syllable.slice(0, 1)).join('') }

  const lower = query.toLowerCase()
  // 连写拼音（lifusheng / zhangwei）先试着按音节切开；切不开才当首字母缩写。
  if (/^[a-z]{3,24}$/.test(lower)) {
    const segments = segmentPinyin(lower)
    if (segments && segments.length >= 2) {
      const syllables = segments.map((syllable) => {
        const { initial, final } = splitInitial(syllable)
        return { char: syllable, toned: syllable, syllable, initial, final }
      })
      return { mode: 'pinyin', syllables, initials: syllables.map((item) => item.initial || item.syllable.slice(0, 1)).join('') }
    }
  }
  if (/^[a-z]{1,12}$/.test(lower)) return { mode: 'initials', syllables: [], initials: lower }
  if (/^[a-z]+(?:[\s'\-][a-z]+)+$/.test(lower)) {
    const syllables = lower.split(/[\s'\-]+/).filter(Boolean).map((syllable) => {
      const { initial, final } = splitInitial(syllable)
      return { char: syllable, toned: syllable, syllable, initial, final }
    })
    return { mode: 'pinyin', syllables, initials: syllables.map((item) => item.initial || item.syllable.slice(0, 1)).join('') }
  }
  return { mode: 'han', syllables: [], initials: '' }
}

/**
 * 听到的词 vs 候选名单，按相似度排序。
 *
 * @param {string} heard 语音转写出来的词（可含错字），或纯首字母缩写（LF）
 * @param {string[]} candidates 候选名字
 * @param {{limit?: number, threshold?: number}} [options]
 * @returns {{heard: string, initials: string, syllables: string[], matches: {name: string, score: number, initials: string, syllables: string[], shared: string[]}[]}}
 */
export function matchNames(heard, candidates, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 5))
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.55
  const query = String(heard || '').trim()
  const names = [...new Set((candidates || []).map((name) => String(name || '').trim()).filter(Boolean))]

  const parsed = parseQuery(query)
  const asciiQuery = parsed.mode === 'initials' ? parsed.initials : ''
  const heardSyllables = parsed.syllables
  const heardInitials = parsed.initials

  const matches = []
  const bare = stripNotes(query)
  for (const name of names) {
    const syllables = syllablesOf(stripNotes(name))
    if (!syllables.length) continue
    const candidateInitials = syllables.map((item) => item.initial || item.syllable.slice(0, 1)).join('')
    // 名字以「听到的那几个字」开头时优先：单说一个「李」，李强/李虎应排在李福生前面。
    const prefix = parsed.mode === 'han' && bare.length > 0 && String(name).startsWith(bare)

    let score
    if (parsed.mode === 'initials') {
      // 用户直接打首字母：LFSH / lfsh / LF
      if (candidateInitials === asciiQuery) score = 1
      else if (candidateInitials.startsWith(asciiQuery)) score = 0.95
      else if (initialsSubsequence(asciiQuery, candidateInitials)) score = 0.6
      else score = 0
    } else {
      const phonetic = phoneticScore(heardSyllables, syllables)
      const initial = initialScore(
        heardSyllables.map((item) => item.initial || item.syllable.slice(0, 1)),
        [...candidateInitials],
      )
      score = phonetic * 0.75 + initial * 0.25
    }

    if (score < threshold) continue
    // 命中的音节，方便向用户解释「为什么像」
    const shared = []
    if (parsed.mode !== 'initials') {
      for (const item of heardSyllables) {
        let best = null
        for (const candidate of syllables) {
          const sim = syllableSim(item.syllable, candidate.syllable)
          if (!best || sim > best.sim) best = { sim, candidate }
        }
        if (best && best.sim >= 0.5) shared.push(`${item.char}→${best.candidate.char}`)
      }
    }
    matches.push({
      name,
      score: round(score),
      initials: candidateInitials,
      syllables: syllables.map((item) => item.syllable),
      shared,
      prefix,
    })
  }

  matches.sort((a, b) =>
    b.score - a.score ||
    Number(b.prefix) - Number(a.prefix) ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name, 'zh'),
  )
  return {
    heard: query,
    mode: parsed.mode,
    initials: heardInitials,
    syllables: heardSyllables.map((item) => item.syllable),
    matches: matches.slice(0, limit),
  }
}

/**
 * voice_pinyin 工具定义：宿主用 ctx.tools.register 注册（普通对象形态，不需要 defineTool）。
 */
export function createPinyinTool() {
  return {
    name: 'voice_pinyin',
    description:
      '语音转写常把名字听成同音/近音字（如「李福生」听成「李虎」）。这个工具把「听到的词」和候选项按拼音做模糊比对，返回排序后的候选与得分。用法：先拿到候选名单（联系人、群成员、最近聊天里的人名），再把听到的名字和候选一起传进来；也可以直接传首字母缩写（LF、LFSH）或连写拼音（lifusheng、zhangwei）。只做比对，不查人。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['match', 'initials'],
          description: 'match=比对候选；initials=只要听到的词的拼音与首字母',
        },
        heard: { type: 'string', description: '语音转写出来的名字/词，例如「李虎」；也可以是 LF 这样的首字母' },
        candidates: {
          type: 'array',
          items: { type: 'string' },
          description: '候选名单，例如联系人里的名字；match 时必填',
        },
        limit: { type: 'number', description: '最多返回几个候选，默认 5' },
        threshold: { type: 'number', description: '低于这个分数的不返回，默认 0.55' },
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
          mode: { type: 'string' },
          initials: { type: 'string' },
          syllables: { type: 'array', items: { type: 'string' } },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                score: { type: 'number' },
                initials: { type: 'string' },
                syllables: { type: 'array', items: { type: 'string' } },
                shared: { type: 'array', items: { type: 'string' } },
                prefix: { type: 'boolean' },
              },
            },
          },
        },
        required: ['ok'],
      },
      render: (args, value) => {
        if (!value.ok) return [{ type: 'text', text: `拼音比对失败：${value.error || '参数不对'}` }]
        const lines = [`「${value.heard}」的首字母：${value.initials || '（无汉字）'}`]
        if (value.syllables && value.syllables.length) lines.push(`音节：${value.syllables.join(' ')}`)
        if (value.matches && value.matches.length) {
          lines.push('候选（按相似度）：')
          for (const item of value.matches) {
            const shared = item.shared && item.shared.length ? `  命中：${item.shared.join('、')}` : ''
            const prefix = item.prefix ? '  开头一致' : ''
            lines.push(`- ${item.name}  ${item.score}  ${item.initials}${prefix}${shared}`)
          }
        } else {
          lines.push('没有超过阈值的候选。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const action = input.action === 'initials' ? 'initials' : 'match'
      const heard = typeof input.heard === 'string' ? input.heard.trim() : ''
      if (!heard) return { ok: false, error: 'heard 不能为空' }

      const syllables = syllablesOf(heard)
      const initials = syllables.map((item) => item.initial || item.syllable.slice(0, 1)).join('')

      if (action === 'initials') {
        return {
          ok: true,
          heard,
          initials,
          syllables: syllables.map((item) => item.syllable),
          matches: [],
        }
      }

      const candidates = Array.isArray(input.candidates)
        ? input.candidates.filter((name) => typeof name === 'string')
        : []
      if (!candidates.length) return { ok: false, error: 'candidates 不能为空（先取一份候选名单）' }

      const result = matchNames(heard, candidates, {
        limit: input.limit,
        threshold: input.threshold,
      })
      return { ok: true, ...result }
    },
  }
}

export { HAN }
