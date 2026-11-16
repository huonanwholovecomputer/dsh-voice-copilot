/**
 * 声纹（说话人校验）：用 sherpa-onnx 的 SpeakerEmbeddingExtractor 算一个 192 维向量，
 * 跟注册模板比余弦相似度。只做「这句是不是机主」这一件事，不做安全认证——
 * 手机外放一段录音就能过，所以它只是便利性过滤，别拿它锁高危操作。
 *
 * 模型：3D-Speaker CAM++ 中文 16k（3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx，约 28 MB）。
 * 模板：<dataDir>/voiceprints/owner.json，存归一化后的平均向量 + 模型标识 + 注册时间。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_THRESHOLD = 0.5
const ENROLL_SAMPLES = 3

/** L2 归一化（原地返回新数组，向量本身不改）。 */
function l2norm(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (!norm) return Float32Array.from(vector)
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm
  return out
}

/** 余弦相似度；两个向量都按 L2 归一化过时就是点积。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 多条注册向量取平均后再归一化（比单条稳，能吃掉一点麦克风抖动）。 */
function averageVectors(vectors) {
  const list = (vectors || []).filter((item) => item && item.length)
  if (!list.length) return null
  const dim = list[0].length
  const sum = new Float64Array(dim)
  for (const vector of list) {
    if (vector.length !== dim) continue
    for (let i = 0; i < dim; i++) sum[i] += vector[i]
  }
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = sum[i] / list.length
  return l2norm(out)
}

/** 判定：没注册就放行；注册了高于阈值就放行。 */
function decide(score, threshold, enrolled = true) {
  if (!enrolled) return true
  return Number(score) >= Number(threshold)
}

function templatePath(dataDir) {
  return path.join(dataDir, 'voiceprints', 'owner.json')
}

class Voiceprint {
  /**
   * @param {object} options
   * @param {string} options.model 声纹模型路径
   * @param {string} options.dataDir 模板存放根目录
   * @param {number} [options.threshold]
   * @param {(message: string) => void} [options.log]
   * @param {object} options.sherpa sherpa-onnx-node 模块
   */
  constructor({ model, dataDir, threshold = DEFAULT_THRESHOLD, log = () => {}, sherpa }) {
    this.model = model
    this.dataDir = dataDir
    this.threshold = Number(threshold) > 0 ? Number(threshold) : DEFAULT_THRESHOLD
    this.log = log
    this.sherpa = sherpa
    this.extractor = null
    this.dim = 0
    this._failed = ''
    this._template = undefined // undefined=未读，null=没有，对象=已读
  }

  get available() {
    return Boolean(this.sherpa && this.model && fs.existsSync(this.model))
  }

  get enabled() {
    return this.available && !this._failed
  }

  /** 建 extractor（约 0.9 s，别在启动首帧里做）。 */
  init() {
    if (this.extractor) return true
    if (!this.available) {
      this._failed = '声纹模型缺失'
      return false
    }
    try {
      const startedAt = Date.now()
      this.extractor = new this.sherpa.SpeakerEmbeddingExtractor({
        model: this.model,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      })
      this.dim = this.extractor.dim || 0
      this.log(`声纹引擎就绪 ${Date.now() - startedAt} ms dim=${this.dim}`)
      return true
    } catch (error) {
      this._failed = error && error.message ? error.message : String(error)
      this.extractor = null
      this.log(`声纹引擎创建失败：${this._failed}`)
      return false
    }
  }

  /** 一句音频（16 k 单声道 Float32）→ 归一化向量；失败返回 null。 */
  embed(samples) {
    if (!this.init()) return null
    const usable = samples && samples.length >= 16000 * 0.3
    if (!usable) return null
    try {
      const stream = this.extractor.createStream()
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      stream.inputFinished()
      if (!this.extractor.isReady(stream)) return null
      // 第二个参数关掉外部缓冲区：Electron 43（Node 24）不再允许 native 侧
      // 造 external ArrayBuffer，默认 true 会抛 "External buffers are not allowed"，
      // 声纹就永远算不出来（日志里 21:12 起整片都是这个错）。
      return l2norm(this.extractor.compute(stream, false))
    } catch (error) {
      this.log(`声纹计算失败：${error && error.message ? error.message : error}`)
      return null
    }
  }

  readTemplate() {
    if (this._template !== undefined) return this._template
    try {
      const raw = JSON.parse(fs.readFileSync(templatePath(this.dataDir), 'utf8'))
      const vector = Array.isArray(raw.vector) ? Float32Array.from(raw.vector) : null
      this._template = vector && vector.length ? { ...raw, vector } : null
    } catch {
      this._template = null
    }
    return this._template
  }

  get enrolled() {
    return Boolean(this.readTemplate())
  }

  status() {
    const template = this.readTemplate()
    const base = {
      available: this.available,
      enabled: this.enabled,
      reason: this._failed,
      threshold: this.threshold,
      enrolled: Boolean(template),
    }
    if (!template) return base
    return {
      ...base,
      createdAt: template.createdAt || '',
      samples: template.samples || 0,
      selfCheck: Number(template.selfCheck),
      model: template.model || '',
    }
  }

  /**
   * 注册：把几段音频的向量平均后落盘。
   * @param {Float32Array[]} vectors
   * @returns {{ok: boolean, error?: string, selfCheck?: number, dim?: number}}
   */
  saveTemplate(vectors) {
    const list = (vectors || []).filter(Boolean)
    if (!list.length) return { ok: false, error: '没有可用的声纹样本' }
    const average = averageVectors(list)
    if (!average) return { ok: false, error: '声纹样本维度不一致' }
    let selfCheck = 1
    for (const vector of list) selfCheck = Math.min(selfCheck, cosine(vector, average))
    const payload = {
      version: 1,
      model: path.basename(this.model || ''),
      dim: average.length,
      threshold: this.threshold,
      samples: list.length,
      createdAt: new Date().toISOString(),
      selfCheck: Number(selfCheck.toFixed(4)),
      vector: Array.from(average),
    }
    try {
      const file = templatePath(this.dataDir)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      fs.writeFileSync(temp, JSON.stringify(payload), 'utf8')
      fs.renameSync(temp, file)
    } catch (error) {
      return { ok: false, error: `写声纹模板失败：${error && error.message ? error.message : error}` }
    }
    this._template = { ...payload, vector: Float32Array.from(payload.vector) }
    this.log(`声纹已注册 selfCheck=${selfCheck.toFixed(3)} dim=${average.length}`)
    return { ok: true, selfCheck: Number(selfCheck.toFixed(4)), dim: average.length }
  }

  removeTemplate() {
    try {
      fs.rmSync(templatePath(this.dataDir), { force: true })
    } catch {
      /* 删不掉就当没有 */
    }
    this._template = null
    return { ok: true }
  }

  /**
   * 校验一句音频。
   * @param {Float32Array} samples
   * @param {number} [threshold]
   * @returns {{enrolled: boolean, score: number, threshold: number, ok: boolean, reason?: string}}
   */
  verify(samples, threshold = this.threshold) {
    const template = this.readTemplate()
    const limit = Number(threshold) > 0 ? Number(threshold) : this.threshold
    if (!template) return { enrolled: false, score: 0, threshold: limit, ok: true }
    const vector = this.embed(samples)
    if (!vector) return { enrolled: true, score: 0, threshold: limit, ok: false, reason: '声纹算不出来（这一段太短或全是噪声）' }
    const score = cosine(vector, template.vector)
    return { enrolled: true, score, threshold: limit, ok: decide(score, limit) }
  }

  /** 注册流程要录几句。 */
  static get enrollSamples() {
    return ENROLL_SAMPLES
  }
}

module.exports = {
  Voiceprint,
  l2norm,
  cosine,
  averageVectors,
  decide,
  templatePath,
  DEFAULT_THRESHOLD,
  ENROLL_SAMPLES,
}
