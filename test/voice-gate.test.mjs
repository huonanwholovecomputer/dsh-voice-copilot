import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { VoiceLoop } = require('../desktop/lib/audio.js')

function makeLoop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyin-gate-'))
  const loop = new VoiceLoop({
    config: { wake: true, audioDir: path.join(dir, 'audio'), dataDir: dir, kws: {}, voiceprint: { enabled: true } },
    log: () => {},
    sherpa: {},
  })
  return { loop, dir }
}

function fakeCapture(source = 'wake') {
  return { chunks: [new Float32Array(16000).fill(0.01)], samples: 16000, speechMs: 1200, source }
}

test('声纹没过：扣住这一句、发 voiceprint-rejected、不送识别', async () => {
  const { loop, dir } = makeLoop()
  let rejected = null
  const texts = []
  loop.on('voiceprint-rejected', (payload) => { rejected = payload })
  loop.on('text', (payload) => texts.push(payload))
  loop.voiceprint = { enrolled: true, verify: () => ({ enrolled: true, score: 0.3123, threshold: 0.5, ok: false }) }
  loop.state = 'busy'
  loop.capture = fakeCapture()
  await loop._finishCapture('silence')

  assert.ok(rejected, '应该发 voiceprint-rejected')
  assert.equal(rejected.score, 0.312)
  assert.equal(loop.state, loop._idleState())
  assert.equal(texts.length, 0, '没过不许送识别')
  assert.ok(loop._rejected && loop._rejected.samples, '那一句要暂存')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('仍然发送：暂存的那句照常识别，带 voiceprint-override 标记', async () => {
  const { loop, dir } = makeLoop()
  const texts = []
  loop.on('text', (payload) => texts.push(payload))
  loop.voiceprint = { enrolled: true, verify: () => ({ enrolled: true, score: 0.3, threshold: 0.5, ok: false }) }
  loop.state = 'busy'
  loop.capture = fakeCapture()
  await loop._finishCapture('silence')
  loop._transcribe = async () => '小印，帮我看看明天有什么安排'
  const result = await loop.acceptRejected()

  assert.deepEqual(result, { ok: true })
  assert.equal(texts.length, 1)
  assert.equal(texts[0].source, 'voiceprint-override')
  assert.ok(fs.existsSync(texts[0].wavPath), 'wav 要落盘')
  assert.equal(loop._rejected, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('声纹通过：照原样走识别', async () => {
  const { loop, dir } = makeLoop()
  const texts = []
  loop.on('text', (payload) => texts.push(payload))
  loop.voiceprint = { enrolled: true, verify: () => ({ enrolled: true, score: 0.81, threshold: 0.5, ok: true }) }
  loop._transcribe = async () => '小印，几点了'
  loop.state = 'busy'
  loop.capture = fakeCapture('hotkey')
  await loop._finishCapture('silence')

  assert.equal(texts.length, 1)
  assert.equal(texts[0].source, 'hotkey')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('注册：样本够数就落模板并发 enroll-done', async () => {
  const { loop, dir } = makeLoop()
  let done = null
  loop.on('enroll-done', (payload) => { done = payload })
  loop.voiceprint = {
    enrolled: false,
    embed: () => Float32Array.from({ length: 192 }, (_, i) => (i === 0 ? 1 : 0)),
    saveTemplate: () => ({ ok: true, selfCheck: 0.99, dim: 192 }),
  }
  loop._enroll = { vectors: [], want: 1, startedAt: Date.now() }
  loop.state = 'busy'
  loop.capture = fakeCapture('enroll')
  await loop._finishCapture('silence')

  assert.ok(done && done.ok, '注册完成事件')
  assert.equal(loop._enroll, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('注册时这一句太短：给一次重试，不卡死', async () => {
  const { loop, dir } = makeLoop()
  let progress = null
  loop.on('enroll-progress', (payload) => { progress = payload })
  loop.voiceprint = { enrolled: false, embed: () => null }
  loop._enroll = { vectors: [], want: 3, startedAt: Date.now() }
  loop.state = 'busy'
  loop.capture = { chunks: [], samples: 3200, speechMs: 100, source: 'enroll' }
  await loop._finishCapture('silence')

  assert.ok(progress && progress.ok === false, '要报「这一句没录好」')
  assert.ok(loop._enroll, '注册流程还在')
  fs.rmSync(dir, { recursive: true, force: true })
})
