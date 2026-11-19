/**
 * 汉字 → 声调拼音 token。
 *
 * sherpa-onnx 的 KWS 模型不认识汉字，keywords.txt 要的是「带声调拼音、按声母/韵母
 * 拆开」的 token，例如「小印」→ `x iǎo y ìn`。这里不引第三方拼音库：
 * desktop/data/pinyin.json 是一张覆盖 20902 个常用汉字的静态表（pypinyin 生成，
 * Style.TONE），构建时生成一次即可，运行时只做声母切分。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAP_FILE = path.join(__dirname, '..', 'data', 'pinyin.json')

// 声母按长度降序，保证 zh/ch/sh 先于 z/c/s 命中。
const INITIALS = [
  'zh', 'ch', 'sh',
  'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w',
]

let MAP = null

function loadMap() {
  if (MAP) return MAP
  try {
    MAP = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
  } catch {
    MAP = {}
  }
  return MAP
}

/** `xiǎo` → `x iǎo`；零声母（`ài`）原样返回。 */
function splitSyllable(syllable) {
  const lower = String(syllable || '').toLowerCase()
  if (!lower) return ''
  for (const initial of INITIALS) {
    if (lower.startsWith(initial)) {
      const final = lower.slice(initial.length)
      return final ? `${initial} ${final}` : initial
    }
  }
  return lower
}

/**
 * 把一段文字转成 keywords.txt 的拼音列。
 * 非汉字（英文字母/数字）原样保留，空白与标点丢弃。
 * @param {string} text
 * @returns {string}
 */
function pinyinOf(text) {
  const map = loadMap()
  const tokens = []
  for (const ch of String(text || '')) {
    if (/\s/.test(ch)) continue
    const syllable = map[ch]
    if (syllable) {
      const split = splitSyllable(syllable)
      if (split) tokens.push(split)
    } else if (/[a-z0-9]/i.test(ch)) {
      tokens.push(ch.toLowerCase())
    }
  }
  return tokens.join(' ')
}

/**
 * 根据称呼生成默认唤醒词：称呼本身、「嘿+称呼」、称呼重复两遍。
 * 用户显式配置了唤醒词时由调用方覆盖。
 * @param {string} name
 * @returns {string[]}
 */
function defaultWakeTexts(name) {
  const value = String(name || '').trim()
  if (!value) return []
  return [...new Set([value, `嘿${value}`, `${value}${value}`])]
}

module.exports = { pinyinOf, splitSyllable, defaultWakeTexts, MAP_FILE }
