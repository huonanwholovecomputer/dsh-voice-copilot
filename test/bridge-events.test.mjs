import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Bridge } = require('../desktop/lib/bridge.js')

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyin-bridge-'))
  const bridge = new Bridge({ dataDir: dir })
  bridge.ensure()
  return { bridge, dir }
}

/** 照 index.js 的 emit() 造名字：14 位零填充的毫秒 + 8 位 hex。 */
function eventName(ms, hex = '01234567') {
  return `${String(ms).padStart(14, '0')}-${hex}.json`
}

function writeEvent(bridge, name, payload) {
  fs.writeFileSync(path.join(bridge.eventsDir, name), JSON.stringify(payload), 'utf8')
}

test('老事件堆到 4000+ 也不会被重放', () => {
  const { bridge } = makeBridge()
  const base = 1793000000000
  for (let i = 0; i < 4200; i += 1) writeEvent(bridge, eventName(base + i), { type: 'history', turns: [] })

  bridge.skipHistory()
  assert.deepEqual(bridge.poll(), [], '启动时已有的老事件一条都不该吐出来')

  writeEvent(bridge, eventName(base + 5000), { type: 'transcript', text: '你好' })
  const fresh = bridge.poll()
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].text, '你好')
  assert.deepEqual(bridge.poll(), [], '同一条事件只许出现一次')
})

test('消费过的文件立刻删掉，目录不会越攒越多', () => {
  const { bridge } = makeBridge()
  const base = 1793000000000
  writeEvent(bridge, eventName(base + 1), { type: 'pong' })
  assert.equal(bridge.poll().length, 1)
  assert.deepEqual(fs.readdirSync(bridge.eventsDir), [])
})

test('skipHistory 顺手把旧事件清出磁盘', () => {
  const { bridge } = makeBridge()
  const base = 1793000000000
  for (let i = 0; i < 50; i += 1) writeEvent(bridge, eventName(base + i), { type: 'history', turns: [] })
  bridge.skipHistory()
  assert.deepEqual(fs.readdirSync(bridge.eventsDir), [])
})

test('同一毫秒进来的两条事件都不会漏', () => {
  const { bridge } = makeBridge()
  const ms = 1793000000123
  writeEvent(bridge, eventName(ms, 'aaaaaaaa'), { type: 'transcript', text: 'a' })
  writeEvent(bridge, eventName(ms, 'bbbbbbbb'), { type: 'transcript', text: 'b' })
  const fresh = bridge.poll()
  assert.equal(fresh.length, 2)
  assert.deepEqual(fresh.map((event) => event.text), ['a', 'b'])
})

test('时钟回拨写进来的老时间戳不会重放，只会被清掉', () => {
  const { bridge } = makeBridge()
  const base = 1793000000000
  writeEvent(bridge, eventName(base + 10), { type: 'pong' })
  assert.equal(bridge.poll().length, 1)
  writeEvent(bridge, eventName(base + 5), { type: 'error', stage: 'item', message: '旧时钟' })
  assert.deepEqual(bridge.poll(), [])
  assert.deepEqual(fs.readdirSync(bridge.eventsDir), [])
})
