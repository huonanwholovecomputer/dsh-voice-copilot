import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Voiceprint, l2norm, cosine, averageVectors, decide, templatePath, DEFAULT_THRESHOLD } = require(
  '../desktop/lib/voiceprint.js',
)

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyin-vp-'))
}

function unitVector(dim, weights) {
  const vector = new Float32Array(dim)
  for (const [index, value] of Object.entries(weights || {})) vector[Number(index)] = value
  return l2norm(vector)
}

test('l2norm 归一化后长度为 1', () => {
  const vector = l2norm(new Float32Array([3, 4]))
  assert.equal(Math.round(vector[0] * 10) / 10, 0.6)
  assert.equal(Math.round(vector[1] * 10) / 10, 0.8)
})

test('cosine：同向 1、正交 0、长度不等 0', () => {
  const a = l2norm(new Float32Array([1, 0, 0]))
  const b = l2norm(new Float32Array([0, 1, 0]))
  assert.equal(Math.round(cosine(a, a)), 1)
  assert.equal(cosine(a, b), 0)
  assert.equal(cosine(a, new Float32Array([1, 0])), 0)
  assert.equal(cosine(null, a), 0)
})

test('averageVectors 取平均并归一化', () => {
  const a = l2norm(new Float32Array([1, 0, 0]))
  const b = l2norm(new Float32Array([0, 1, 0]))
  const average = averageVectors([a, b])
  const norm = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0))
  assert.ok(Math.abs(norm - 1) < 1e-6)
  assert.ok(Math.abs(average[0] - average[1]) < 1e-6)
  assert.equal(averageVectors([]), null)
  // 维度不一致的那条被跳过，结果仍按第一段的维度归一化
  const mixed = averageVectors([a, new Float32Array([1, 0])])
  assert.equal(mixed.length, 3)
  assert.ok(Math.abs(Math.sqrt(mixed.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-6)
})

test('decide：没注册一律放行，注册了比阈值', () => {
  assert.equal(decide(0.1, 0.5, false), true)
  assert.equal(decide(0.7, 0.5, true), true)
  assert.equal(decide(0.45, 0.5, true), false)
  assert.equal(DEFAULT_THRESHOLD, 0.5)
})

test('templatePath 落在 dataDir/voiceprints/owner.json', () => {
  assert.equal(templatePath('C:/tmp/x'), path.join('C:/tmp/x', 'voiceprints', 'owner.json'))
})

test('saveTemplate → readTemplate → status → removeTemplate', () => {
  const dir = tempDir()
  const vp = new Voiceprint({ model: 'no-such-model.onnx', dataDir: dir, sherpa: {} })
  assert.equal(vp.available, false)
  assert.equal(vp.status().available, false)

  const vectors = [
    unitVector(192, { 0: 1, 1: 0.2 }),
    unitVector(192, { 0: 0.9, 1: 0.3 }),
    unitVector(192, { 0: 1, 1: 0.1 }),
  ]
  const saved = vp.saveTemplate(vectors)
  assert.equal(saved.ok, true)
  assert.equal(saved.dim, 192)
  assert.ok(saved.selfCheck > 0.9)

  const stored = JSON.parse(fs.readFileSync(templatePath(dir), 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.vector.length, 192)

  const reopened = new Voiceprint({ model: 'no-such-model.onnx', dataDir: dir, sherpa: {} })
  assert.equal(reopened.enrolled, true)
  const status = reopened.status()
  assert.equal(status.enrolled, true)
  assert.equal(status.samples, 3)
  assert.ok(status.selfCheck > 0.9)

  reopened.removeTemplate()
  assert.equal(reopened.enrolled, false)
  assert.equal(fs.existsSync(templatePath(dir)), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('saveTemplate 拒绝空样本', () => {
  const vp = new Voiceprint({ model: 'x.onnx', dataDir: tempDir(), sherpa: {} })
  assert.equal(vp.saveTemplate([]).ok, false)
})

test('没注册时 verify 直接放行', () => {
  const vp = new Voiceprint({ model: 'x.onnx', dataDir: tempDir(), sherpa: {} })
  const verdict = vp.verify(new Float32Array(16000))
  assert.equal(verdict.enrolled, false)
  assert.equal(verdict.ok, true)
})
