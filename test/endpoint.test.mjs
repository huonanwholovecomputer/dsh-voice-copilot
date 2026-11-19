import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { OwnerEndpoint } = require('../desktop/lib/endpoint.js')
const { VoiceLoop } = require('../desktop/lib/audio.js')

const SR = 16000
const OWNER_HZ = 180 // 「机主」的音高
const OTHER_HZ = 1200 // 「旁人」的音高

function tone(seconds, hz = OWNER_HZ, amp = 0.1) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
  return out
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR))
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * 假声纹：按过零率估主频。只含机主音高 → 0.9，只含旁人 → 0.08，
 * 两者都有（窗口横跨两个人的话）→ 0.35，模拟真实 CAM++ 「混窗分数介于两者之间、但到不了机主线」的行为。
 */
function fakeVoiceprint() {
  return {
    enrolled: true,
    verify(audio) {
      const sub = Math.round(SR * 0.1)
      let ownerBlocks = 0
      let otherBlocks = 0
      for (let b = 0; b + sub <= audio.length; b += sub) {
        let crossings = 0
        let peak = 0
        for (let i = b + 1; i < b + sub; i += 1) {
          if ((audio[i - 1] < 0) !== (audio[i] < 0)) crossings += 1
          const a = Math.abs(audio[i])
          if (a > peak) peak = a
        }
        if (peak < 0.01) continue
        const hz = crossings / (sub / SR) / 2
        if (Math.abs(hz - OWNER_HZ) < 400) ownerBlocks += 1
        else if (Math.abs(hz - OTHER_HZ) < 400) otherBlocks += 1
      }
      const score = ownerBlocks > 0 && otherBlocks > 0 ? 0.35 : ownerBlocks > 0 ? 0.9 : 0.08
      return { enrolled: true, score, ok: score >= 0.5, threshold: 0.5 }
    },
  }
}

/** 按 8 ms 一块推（和渲染进程 push 的粒度一致），返回第一次收尾的判定。 */
function feed(endpoint, audio, blockMs = 8) {
  const block = Math.round((blockMs / 1000) * SR)
  let done = null
  for (let i = 0; i < audio.length; i += block) {
    const decision = endpoint.push(audio.subarray(i, Math.min(audio.length, i + block)))
    if (decision && !done) done = decision
  }
  return done
}

function makeEndpoint(options = {}) {
  return new OwnerEndpoint({ silenceMs: 1200, maxMs: 20000, log: () => {}, ...options })
}

/**
 * 「机主说完之后的就不该进识别」：裁剪点必须正好落在「机主末点 + 300 ms」。
 * 机主末点本身允许落在 2.0-3.4 s：滚动判主用 1.5 s 的窗，窗口里混进旁人/静音时
 * 会多推进几百毫秒（144 段真录音上也是这个量级，见 <临时分析目录>/replay-endpoint.json）。
 */
function assertTrimmedToOwner(done, label = '') {
  assert.ok(done.seenOwner, `${label} 应该确认过机主`)
  assert.ok(done.ownerLastMs >= 2000 && done.ownerLastMs <= 3400, `${label} 机主末点应在 2.0-3.4 s，实际 ${done.ownerLastMs}ms`)
  assert.equal(done.trimSamples, Math.round(((done.ownerLastMs + 300) / 1000) * SR), `${label} 裁剪点 = 机主末点 + 300 ms`)
}

test('机主说完、旁人接着一直讲：裁到机主末点，不把旁人的话送进识别', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint() })
  // 机主 2 s → 0.5 s 停顿 → 旁人连讲 6 s（中间不留 300 ms 以上的停顿）
  const audio = concat(tone(2), silence(0.5), tone(6, OTHER_HZ), silence(2))
  const done = feed(ep, audio)

  assert.ok(done, '应该收尾')
  assert.equal(done.reason, 'silence')
  assert.equal(done.seenOwner, true)
  assertTrimmedToOwner(done, '旁人连讲')
})

test('旁人一直讲不停：认出不是机主就直接收尾，不必等到 max-length', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint(), maxMs: 8000 })
  const done = feed(ep, concat(tone(2), silence(0.5), tone(10, OTHER_HZ)))

  assert.ok(done)
  assert.equal(done.reason, 'silence')
  assertTrimmedToOwner(done, '旁人一直讲')
})

test('旁人只插一句 1.5 s：机主停下后就收尾', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint() })
  const done = feed(ep, concat(tone(2), silence(0.5), tone(1.5, OTHER_HZ), silence(2)))

  assert.equal(done.reason, 'silence')
  assertTrimmedToOwner(done, '旁人插一句')
})

test('只有机主一个人说：只裁掉尾部静音，不动说话内容', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint() })
  const done = feed(ep, concat(tone(3), silence(2)))

  assert.equal(done.reason, 'silence')
  assert.equal(done.seenOwner, true)
  assert.ok(done.ownerLastMs >= 2800, `机主末点应在句尾附近，实际 ${done.ownerLastMs}ms`)
  const trimmedSec = (done.trimSamples / SR).toFixed(2)
  assert.ok(done.trimSamples >= Math.round(3.0 * SR), `不该动 3 s 以内的话，实际裁到 ${trimmedSec}s`)
  assert.ok(done.trimSamples <= Math.round(3.4 * SR), `裁剪点不该越过句尾太多，实际 ${trimmedSec}s`)
})

test('没注册声纹：退化成旧行为（任何有声都算机主、不裁剪）', () => {
  const ep = makeEndpoint({ voiceprint: null })
  const done = feed(ep, concat(tone(2), silence(0.45), tone(3, OTHER_HZ), silence(2)))

  assert.equal(done.reason, 'silence')
  assert.equal(done.seenOwner, false)
  assert.equal(done.trimSamples, 0)
  assert.equal(done.ownerLastMs, 0)
})

test('一直没人说话：6 s 后报 no-speech', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint() })
  const done = feed(ep, silence(8))
  assert.equal(done.reason, 'no-speech')
  assert.equal(done.trimSamples, 0)
})

test('机主一口气说 8 s 不换气：不误判、不裁剪说话内容', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint() })
  const done = feed(ep, concat(tone(8), silence(2)))

  assert.equal(done.reason, 'silence')
  assert.ok(done.ownerLastMs >= 7800, `机主末点应贴句尾，实际 ${done.ownerLastMs}ms`)
  assert.ok(done.trimSamples >= Math.round(7.9 * SR), `实际裁到 ${(done.trimSamples / SR).toFixed(2)}s`)
})

test('短命令 0.8 s 也能确认机主', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint() })
  const done = feed(ep, concat(tone(0.8), silence(0.5), tone(6, OTHER_HZ), silence(2)))

  assert.equal(done.seenOwner, true)
  assert.ok(done.ownerLastMs >= 700 && done.ownerLastMs <= 900, `实际 ${done.ownerLastMs}ms`)
  assert.ok(done.trimSamples >= Math.round(0.9 * SR) && done.trimSamples <= Math.round(1.3 * SR))
})

test('手动停止（finish）也带裁剪判定', () => {
  const ep = makeEndpoint({ voiceprint: fakeVoiceprint(), maxMs: 60000 })
  // 只喂到「机主说完 + 旁人刚开口 0.4 s」，还不该自动收尾
  assert.equal(ep.push(concat(tone(2), silence(0.5), tone(0.4, OTHER_HZ))), null)
  const done = ep.finish('manual')

  assert.equal(done.reason, 'manual')
  assertTrimmedToOwner(done, '手动停止')
})

test('录音路径接上了端点：VoiceLoop 在机主停下后就收尾并带裁剪点', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyin-endpoint-'))
  const loop = new VoiceLoop({
    config: {
      wake: true,
      audioDir: path.join(dir, 'audio'),
      dataDir: dir,
      kws: {},
      silenceSeconds: 1.2,
      maxSeconds: 20,
      voiceprint: { enabled: true, ownerGate: true },
    },
    log: () => {},
    sherpa: {},
  })
  loop.voiceprint = fakeVoiceprint()

  const calls = []
  let fed = 0
  let fedAtEnd = 0
  // 桩要和真实 _finishCapture 一样清掉 capture/endpoint；否则这条断言一旦失败，
  // Node 会对那个带 8s Float32Array 缓冲的 OwnerEndpoint 做 inspect + diff，
  // 十几万行 × Myers diff 会直接把几个 GB 内存吃光（真实踩过）。
  // 另外：断言里别对这类大对象用 assert.equal/deepEqual，用 === 判断。
  loop._finishCapture = async function (reason, options) {
    calls.push({ reason, options })
    fedAtEnd = fed
    this.capture = null
    this.endpoint = null
  }

  assert.equal(loop.beginCapture('wake'), true)
  const audio = concat(tone(2), silence(0.45), tone(6, OTHER_HZ), silence(2))
  const block = 128
  for (let i = 0; i < audio.length && calls.length === 0; i += block) {
    loop.push(audio.subarray(i, Math.min(audio.length, i + block)), SR)
    fed = Math.min(audio.length, i + block)
  }

  assert.equal(calls.length, 1, '应该只收尾一次')
  assert.equal(calls[0].reason, 'silence')
  const trimSec = calls[0].options.trimSamples / SR
  assert.ok(trimSec >= 2.0 && trimSec <= 3.7, `裁剪点应落在机主句尾附近（2.0-3.7 s），实际 ${trimSec.toFixed(2)}s`)
  assert.ok(fedAtEnd / SR < 8.45, `不该等旁人 6 s 讲完才收（实际 ${(fedAtEnd / SR).toFixed(2)}s）`)
  // 用 === 而不是 assert.equal：端点对象里有 12.8 万个浮点数，失败时 diff 会爆内存。
  assert.ok(loop.endpoint === null, '收尾后清掉端点')
  fs.rmSync(dir, { recursive: true, force: true })
})
