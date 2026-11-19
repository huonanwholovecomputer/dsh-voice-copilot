#!/usr/bin/env node
/**
 * voice_who 的识别质量基线：拿本机真实联系人当语料，模拟语音转写的几种典型错法，
 * 统计 top1 / top3 命中率和「很自信但认错人」的比例（这个最危险）。
 *
 *   node voice-assistant/tools/who_bench.mjs                    # 拉实时联系人跑一遍
 *   node voice-assistant/tools/who_bench.mjs --file snapshot.json   # 用之前存下的联系人快照
 *
 * 模拟的错法（都按拼音表反查同音/近音字，跟真实 ASR 出错的方式一致）：
 *   homophone   同音节换字（拓→唾）——意思完全不同，读音一样
 *   confusable  声母/韵母按混淆类换（zh↔z、n↔l、an↔ang）
 *   drop        少听一个字（三字名只听清两个）
 * 只用联系人名单本身（人名部分），不含群名；每条 3 次抽样。
 */
import fs from 'node:fs'
import http from 'node:http'

import { initialsOf, syllablesOf } from '../pinyin-match.js'
import { aliasPeople, decide, normalizeContacts, rankPeople, readAliasBook } from '../name-resolver.js'

const LEXICON = JSON.parse(fs.readFileSync(new URL('../../tray-app/desktop/data/pinyin.json', import.meta.url), 'utf8'))
const INITIAL_GROUPS = [['zh', 'z', 'j'], ['ch', 'c', 'q'], ['sh', 's', 'x'], ['n', 'l'], ['f', 'h'], ['r', 'l']]
const FINAL_GROUPS = [['an', 'ang'], ['en', 'eng'], ['in', 'ing'], ['ian', 'iang'], ['uan', 'uang'], ['eng', 'ong'], ['o', 'uo'], ['ei', 'ie']]
const CONTACTS_URL = String(process.env.DSH_XIAOYIN_CONTACTS_URL || '').trim()
  || 'http://127.0.0.1:10392/api/chat/contacts?include_friends=true&include_groups=true'

function toneless(pinyin) {
  return String(pinyin || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ü/g, 'u').toLowerCase()
}

// 音节 → 汉字（优先常用字：拼音表按码位排，够用）
const CHARS_BY_SYLLABLE = new Map()
for (const [char, toned] of Object.entries(LEXICON)) {
  const syllable = toneless(toned)
  if (!CHARS_BY_SYLLABLE.has(syllable)) CHARS_BY_SYLLABLE.set(syllable, [])
  CHARS_BY_SYLLABLE.get(syllable).push(char)
}

function split(syllable) {
  for (const initial of ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']) {
    if (syllable.startsWith(initial)) return { initial, final: syllable.slice(initial.length) }
  }
  return { initial: '', final: syllable }
}

function sameGroup(groups, a, b) {
  for (const group of groups) if (group.includes(a) && group.includes(b)) return true
  return false
}

/** 给一个音节找一个「听起来像但字不同」的音节。 */
function confusableSyllable(syllable) {
  const { initial, final } = split(syllable)
  const candidates = []
  for (const group of INITIAL_GROUPS) {
    if (!group.includes(initial)) continue
    for (const other of group) if (other !== initial) candidates.push(`${other}${final}`)
  }
  for (const group of FINAL_GROUPS) {
    if (!group.includes(final)) continue
    for (const other of group) if (other !== final) candidates.push(`${initial}${other}`)
  }
  return candidates.filter((item) => CHARS_BY_SYLLABLE.has(item))
}

function pick(list, seed) {
  return list[Math.abs(seed) % list.length]
}

/** 把名字改成「听错的样子」。返回 null 表示这次抽到的错法用不了。 */
function corrupt(name, mode, seed) {
  const items = syllablesOf(name)
  if (items.length < 2) return null
  const index = seed % items.length
  const target = items[index]
  if (mode === 'homophone') {
    const pool = (CHARS_BY_SYLLABLE.get(target.syllable) || []).filter((char) => char !== target.char)
    // 优先「不像」的字：改成完全另一个词更接近真实 ASR 的错误
    if (!pool.length) return null
    const replacement = pick(pool, seed >> 2)
    return items.map((item, i) => (i === index ? replacement : item.char)).join('')
  }
  if (mode === 'confusable') {
    const pool = confusableSyllable(target.syllable)
    if (!pool.length) return null
    const syllable = pick(pool, seed >> 1)
    const chars = CHARS_BY_SYLLABLE.get(syllable) || []
    if (!chars.length) return null
    const replacement = pick(chars, seed >> 3)
    return items.map((item, i) => (i === index ? replacement : item.char)).join('')
  }
  if (mode === 'drop') {
    if (items.length < 3) return null
    return items.filter((_, i) => i !== index).map((item) => item.char).join('')
  }
  return null
}

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

/** 只留「人名」部分：去掉「软工2301 」这类班级前缀、尾巴上的标点/罗马数字，模拟用户只说名字。 */
function personalName(display) {
  const text = String(display || '').trim()
  // 前缀：可能是「软工2301 」「软工2301 」这种班级号，也可能是「延小创-」这种组织名前缀
  const parts = text.split(/[\s\-—－]+/).filter(Boolean)
  let last = parts.length ? parts[parts.length - 1] : text
  last = last.replace(/^[^\u4e00-\u9fff]+|[^\u4e00-\u9fff]+$/g, '')
  if (last.length >= 2) return last
  return text.replace(/^[^\u4e00-\u9fff]+|[^\u4e00-\u9fff]+$/g, '')
}

function cases(people) {
  const seen = new Set()
  const out = []
  for (const person of people) {
    if (person.isGroup) continue
    const display = (person.names.find((name) => name.kind === 'display') || person.names[0]).text
    const name = personalName(display) || display
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ username: person.username, name, display })
  }
  return out
}

function evaluate(people, sessions, scenario) {
  const stats = { total: 0, top1: 0, top3: 0, confident: 0, confidentWrong: 0, miss: 0 }
  const wrong = []
  let seed = 0
  for (const item of cases(people)) {
    const heard = scenario(item.name, seed)
    seed += 7
    if (!heard) continue
    const ranked = rankPeople({ heard, people, sessions, now: Date.now() }).slice(0, 4)
    const decision = decide(ranked).decision
    stats.total += 1
    const top = ranked[0]
    if (!top) {
      stats.miss += 1
      continue
    }
    const hit = (candidate) => {
      if (!candidate) return false
      if (candidate.username === item.username) return true
      // 同一个人可能有多个写法（霍洁Ⅰ/霍洁Ⅱ），名字互相包含也算对
      const got = String(candidate.name || '').replace(/\s+/g, '')
      return got.includes(item.name) || personalName(got) === personalName(item.name)
    }
    if (hit(top)) stats.top1 += 1
    else wrong.push(`${heard} → ${top.name}（应为 ${item.name}）`)
    if (ranked.slice(0, 3).some(hit)) stats.top3 += 1
    if (decision === 'confident') {
      stats.confident += 1
      if (!hit(top)) stats.confidentWrong += 1
    }
  }
  return { stats, wrong }
}

const args = process.argv.slice(2)
const fileIndex = args.indexOf('--file')
let contactPayload
if (fileIndex >= 0) {
  contactPayload = JSON.parse(fs.readFileSync(args[fileIndex + 1], 'utf8'))
} else {
  contactPayload = await fetchJson(CONTACTS_URL)
}
const people = [...normalizeContacts(contactPayload), ...aliasPeople(readAliasBook(args.includes('--aliases')
  ? args[args.indexOf('--aliases') + 1] : ''))]
const sessions = new Map()
const scenarios = {
  原样: (name) => name,
  同音节换字: (name, seed) => corrupt(name, 'homophone', seed),
  声母韵母混淆: (name, seed) => corrupt(name, 'confusable', seed),
  漏听一个字: (name, seed) => corrupt(name, 'drop', seed),
}

console.log(`联系人 ${people.filter((person) => !person.isGroup).length} 人`)
for (const [label, scenario] of Object.entries(scenarios)) {
  const { stats, wrong } = evaluate(people, sessions, scenario)
  const pct = (value) => (stats.total ? `${(100 * value / stats.total).toFixed(1)}%` : '-')
  console.log(`\n【${label}】${stats.total} 条`)
  console.log(`  top1 ${pct(stats.top1)}   top3 ${pct(stats.top3)}   直接下结论 ${pct(stats.confident)}（其中认错 ${stats.confidentWrong} 条）`)
  if (wrong.length) console.log(`  认错的例子：${wrong.slice(0, 6).join('；')}`)
}
