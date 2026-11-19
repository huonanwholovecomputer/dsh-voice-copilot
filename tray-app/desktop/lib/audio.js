/**
 * 本地语音环：常驻听唤醒词 → 抓一句命令 → 本机 SenseVoice 转文字。
 *
 * 音频来源是渲染进程（getUserMedia + AudioWorklet）推上来的 16 kHz 单声道 Float32；
 * 这里只做「重采样 → 环形缓存 → RMS 分段 → KWS/ASR」。
 *
 * 与 Python 版（app/audiohub.py + app/kws.py + app/stt.py）的对应关系：
 *   QAudioSource 采集        -> 渲染进程 Web Audio 采集
 *   KeywordSpotter.feed()   -> this._feedSpotter()
 *   命令分段（静音 1s 收尾） -> this._onFrame()
 *   OfflineRecognizer       -> this._transcribe()
 *
 * 事件：
 *   level   {value}      0..1，已平滑，给波形用
 *   wake    {source, keyword}
 *   capture {phase: 'start'|'tick'|'end', ms, level}
 *   text    {text, wavPath, ms, source}
 *   empty   {reason}     没听清 / 没说话
 *   voiceprint-rejected {score, threshold, reason}  这句不像机主，暂存等用户决定
 *   enroll-progress {index, want, ok, error?}       声纹注册进度
 *   enroll-done     {ok, selfCheck?, dim?, samples?, error?}
 *   error   {stage, message}
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const { Voiceprint } = require('./voiceprint')
const { OwnerEndpoint } = require('./endpoint')

const SAMPLE_RATE = 16000
const FRAME = 320 // 20 ms
const RING_SECONDS = 30
const SPEECH_RMS = 0.012
const MIN_SPEECH_MS = 250
const NO_SPEECH_TIMEOUT_MS = 6000
const PREROLL_WAKE_MS = 150
const PREROLL_HOTKEY_MS = 600

/** 线性重采样（带相位延续，避免每块接头处爆音）。只在采样率不是 16k 时才用。 */
class Resampler {
  constructor() {
    this.phase = 0
    this.prev = 0
  }

  process(input, inRate) {
    if (inRate === SAMPLE_RATE) return input
    const ratio = SAMPLE_RATE / inRate
    const outLength = Math.floor((input.length - 1 - this.phase) * ratio)
    if (outLength <= 0) {
      this.phase -= input.length
      return new Float32Array(0)
    }
    const out = new Float32Array(outLength)
    let pos = this.phase
    for (let i = 0; i < outLength; i += 1) {
      const index = Math.floor(pos)
      const frac = pos - index
      const a = index < 0 ? this.prev : input[Math.min(index, input.length - 1)]
      const b = index + 1 < 0 ? this.prev : input[Math.min(index + 1, input.length - 1)]
      out[i] = a + (b - a) * frac
      pos += ratio
    }
    this.prev = input[input.length - 1]
    this.phase = pos - input.length
    return out
  }
}

function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** 16 k 单声道 16 bit PCM 的 wav（自己写，省得依赖 sherpa 的 writeWave 行为）。 */
function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

class VoiceLoop extends EventEmitter {
  /**
   * @param {object} options
   * @param {ReturnType<import('./config').loadConfig>} options.config
   * @param {(message: string) => void} options.log
   * @param {object} options.sherpa sherpa-onnx-node 模块
   */
  constructor({ config, log, sherpa }) {
    super()
    this.config = config
    this.log = log
    this.sherpa = sherpa
    this.resampler = new Resampler()

    this.ring = new Float32Array(SAMPLE_RATE * RING_SECONDS)
    this.ringLength = 0

    this.spotter = null
    this.spotterStream = null
    this.recognizer = null

    this.state = 'off' // off | monitor | recording | busy
    this.wakeEnabled = Boolean(config.wake)
    this.level = 0
    this.lastLevelAt = 0
    this.lastTickAt = 0

    this.capture = null // {source, chunks, samples, speechMs, startedAt, lastVoiceAt, prerollFrames}
    this.endpoint = null // 这一句的端点判定（见 lib/endpoint.js）
    this._transcribing = false
    this.pendingKeywords = false

    // 声纹（可选）：模型缺失/没注册时整条链路都当它不存在
    this.voiceprint = null
    this._rejected = null // 声纹没过、暂存等用户决定的那一句 {samples, verdict, at}
    this._enroll = null // 注册中 {vectors, want, startedAt}
  }

  // ---------------------------------------------------------------- 引擎

  initEngines() {
    this._initSpotter()
    // 识别器创建要 1.3 s 左右，延后一点，别和窗口首帧抢时间
    setTimeout(() => this._initRecognizer(), 800)
    // 声纹 0.9 s 左右，排在识别器后面，避免三套模型同时抢 CPU
    setTimeout(() => this._initVoiceprint(), 1800)
  }

  _initVoiceprint() {
    if (this.voiceprint) return true
    const settings = this.config.voiceprint || {}
    if (settings.enabled === false) {
      this.log('声纹：配置里关掉了')
      return false
    }
    if (!settings.model || !fs.existsSync(settings.model)) {
      this.log(`声纹模型缺失，跳过校验：${settings.model || '(未配置)'}`)
      return false
    }
    this.voiceprint = new Voiceprint({
      model: settings.model,
      dataDir: this.config.dataDir,
      threshold: settings.threshold,
      log: this.log,
      sherpa: this.sherpa,
    })
    if (!this.voiceprint.init()) {
      this.voiceprint = null
      return false
    }
    // 有模板就提前读一次，省得第一句话多等一次磁盘
    const status = this.voiceprint.status()
    this.log(`声纹：${status.enrolled ? '已注册，唤醒后校验机主' : '未注册，先不校验'}`)
    return true
  }

  /** 声纹状态（给浮窗显示）。 */
  voiceprintStatus() {
    if (!this.voiceprint) {
      return { available: false, enabled: false, enrolled: false, threshold: 0, reason: '声纹模型未加载' }
    }
    return this.voiceprint.status()
  }

  /** 开始注册声纹：连录 want 句，录完自动求平均落盘。 */
  startEnroll(want = 3) {
    if (!this.voiceprint) return { ok: false, error: '声纹模型没加载（检查 models/ 下是否有 CAM++ 模型）' }
    if (this.state === 'recording' || this._transcribing) return { ok: false, error: '正在处理上一句，稍等一下' }
    const count = Math.max(1, Math.min(6, Number(want) || 3))
    this._enroll = { vectors: [], want: count, startedAt: Date.now() }
    this._rejected = null
    this.beginCapture('enroll')
    return { ok: true, want: count }
  }

  cancelEnroll() {
    if (!this._enroll) return { ok: true }
    if (this.state === 'recording') {
      this._abortCapture('取消注册声纹', true)
    } else {
      this._enroll = null
      this.emit('enroll-done', { ok: false, error: '取消注册声纹' })
    }
    return { ok: true }
  }

  /**
   * 声纹没过、用户点「仍然发送」：把暂存的那一句照常识别发出去。
   * 只保留最近一句，避免麦克风开着攒一堆别人的话。
   */
  async acceptRejected() {
    const pending = this._rejected
    if (!pending) return { ok: false, error: '没有等待中的那一句' }
    this._rejected = null
    this.state = 'busy'
    try {
      const text = await this._transcribe(pending.samples)
      if (!text) {
        this.state = this._idleState()
        this.emit('empty', { reason: 'no-text' })
        return { ok: false, error: '没听清' }
      }
      const wavPath = path.join(this.config.audioDir, `${Date.now()}.wav`)
      writeWav(wavPath, pending.samples)
      this.emit('text', {
        text,
        wavPath,
        ms: Math.round((pending.samples.length / SAMPLE_RATE) * 1000),
        source: 'voiceprint-override',
      })
      return { ok: true }
    } catch (error) {
      this.log(`识别失败：${error && error.stack ? error.stack : error}`)
      this.emit('error', { stage: 'asr', message: '识别失败' })
      return { ok: false, error: '识别失败' }
    } finally {
      this.state = this._idleState()
    }
  }

  /** 丢掉「声纹没过」的那一句。 */
  dropRejected() {
    const had = Boolean(this._rejected)
    this._rejected = null
    return { ok: had }
  }

  /** 删掉已注册的声纹模板（下次唤醒不再校验）。 */
  removeVoiceprint() {
    if (!this.voiceprint) return { ok: false, error: '声纹模型没加载' }
    return this.voiceprint.removeTemplate()
  }

  _initSpotter() {
    if (this.spotter) return true
    const { encoder, decoder, joiner, tokens, keywordsFile } = this.config.kws
    for (const file of [encoder, decoder, joiner, tokens, keywordsFile]) {
      if (!fs.existsSync(file)) {
        this.log(`唤醒词模型缺文件：${file}`)
        this.wakeEnabled = false
        this.emit('error', { stage: 'kws', message: `唤醒词模型缺失：${path.basename(file)}` })
        return false
      }
    }
    try {
      this.spotter = new this.sherpa.KeywordSpotter({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder, decoder, joiner },
          tokens,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        maxActivePaths: 4,
        keywordsFile,
        keywordsScore: 1.5,
        keywordsThreshold: 0.25,
        numTrailingBlanks: 2,
      })
      this.spotterStream = this.spotter.createStream()
      this.log('唤醒词引擎就绪')
      if (this.wakeEnabled) this.state = 'monitor'
      return true
    } catch (error) {
      this.spotter = null
      this.wakeEnabled = false
      this.log(`唤醒词引擎创建失败：${error && error.stack ? error.stack : error}`)
      this.emit('error', { stage: 'kws', message: '唤醒词引擎创建失败' })
      return false
    }
  }

  _initRecognizer() {
    if (this.recognizer) return true
    const { model, tokens } = this.config.asr
    if (!fs.existsSync(model) || !fs.existsSync(tokens)) {
      this.log(`识别模型缺文件：model=${model} tokens=${tokens}`)
      this.emit('error', { stage: 'asr', message: 'SenseVoice 模型缺失' })
      return false
    }
    const startedAt = Date.now()
    try {
      this.recognizer = new this.sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model, language: this.config.language, useInverseTextNormalization: 1 },
          tokens,
          numThreads: this.config.threads,
          provider: 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
      })
      this.log(`识别引擎就绪 ${Date.now() - startedAt} ms`)
      return true
    } catch (error) {
      this.recognizer = null
      this.log(`识别引擎创建失败：${error && error.stack ? error.stack : error}`)
      this.emit('error', { stage: 'asr', message: '识别引擎创建失败' })
      return false
    }
  }

  // ---------------------------------------------------------------- 开关

  /**
   * 用户改了称呼/唤醒词后热重载 KWS 词表。
   * 录音中不打断当前这一句，记个标记，等这一段结束后再换。
   * @returns {boolean} 是否立即重载成功
   */
  reloadKeywords() {
    if (this.state === 'recording' || this.state === 'busy') {
      this.pendingKeywords = true
      this.log('唤醒词已更新，等这一段处理完再重载')
      return false
    }
    this.pendingKeywords = false
    this.spotter = null
    this.spotterStream = null
    const ok = this._initSpotter()
    this.state = ok && this.wakeEnabled ? 'monitor' : 'off'
    this.log(`唤醒词词表已重载（${ok ? '成功' : '失败'}）`)
    return ok
  }

  /** 识别语言改动后重建识别器（SenseVoice 的语言在构造时固定）。 */
  reloadRecognizer() {
    this.recognizer = null
    setTimeout(() => this._initRecognizer(), 100)
  }

  setWake(enabled) {
    if (enabled === this.wakeEnabled) return this.wakeEnabled
    if (enabled && !this._initSpotter()) return false
    this.wakeEnabled = enabled
    if (this.state === 'monitor' && !enabled) this.state = 'off'
    if (this.state === 'off' && enabled && this.spotter) this.state = 'monitor'
    this.log(`唤醒词监听 ${enabled ? '开' : '关'}`)
    return enabled
  }

  // ---------------------------------------------------------------- 音频入口

  /**
   * 渲染进程推上来的一块 PCM。
   * @param {Float32Array} samples
   * @param {number} sampleRate
   */
  push(samples, sampleRate) {
    if (!samples || !samples.length) return
    const chunk = this.resampler.process(samples, Number(sampleRate) || SAMPLE_RATE)
    if (!chunk.length) return

    this._appendRing(chunk)
    this._updateLevel(chunk)

    if (this.state === 'monitor') this._feedSpotter(chunk)
    else if (this.state === 'recording') this._feedCapture(chunk)
  }

  _appendRing(chunk) {
    const ring = this.ring
    const size = ring.length
    if (chunk.length >= size) {
      ring.set(chunk.subarray(chunk.length - size))
      this.ringLength = size
      return
    }
    const overflow = this.ringLength + chunk.length - size
    if (overflow > 0) {
      ring.copyWithin(0, overflow, this.ringLength)
      this.ringLength -= overflow
    }
    ring.set(chunk, this.ringLength)
    this.ringLength += chunk.length
  }

  /**
   * 丢掉环形缓存里的旧采样。
   * 唤醒词关掉、麦克风被释放之后再开麦时用：否则 beginCapture 的预录会取到
   * 几分钟前的那段声音（ringLength 一直停在上次关麦的位置）。
   */
  clearRing() {
    this.ringLength = 0
  }

  _tail(seconds) {
    const want = Math.min(this.ringLength, Math.round(seconds * SAMPLE_RATE))
    if (want <= 0) return new Float32Array(0)
    return this.ring.slice(this.ringLength - want, this.ringLength)
  }

  _updateLevel(chunk) {
    const rms = rmsOf(chunk)
    const target = Math.min(1, rms / 0.12)
    this.level = target > this.level ? target : this.level * 0.82 + target * 0.18
    const now = Date.now()
    if (now - this.lastLevelAt >= 50) {
      this.lastLevelAt = now
      this.emit('level', { value: Number(this.level.toFixed(3)) })
    }
  }

  _feedSpotter(chunk) {
    if (!this.spotter || !this.spotterStream) return
    try {
      this.spotterStream.acceptWaveform({ samples: chunk, sampleRate: SAMPLE_RATE })
      while (this.spotter.isReady(this.spotterStream)) this.spotter.decode(this.spotterStream)
      const result = this.spotter.getResult(this.spotterStream)
      if (result && result.keyword) {
        this.log(`唤醒词命中：${result.keyword}`)
        this.spotter.reset(this.spotterStream)
        this.emit('wake', { source: 'wake', keyword: result.keyword })
        this.beginCapture('wake')
      }
    } catch (error) {
      this.log(`唤醒词解码失败：${error && error.message ? error.message : error}`)
    }
  }

  // ---------------------------------------------------------------- 一句命令

  /**
   * 开始录一句。热键进来时也走这里（source='hotkey'）。
   * @param {'wake'|'hotkey'} source
   */
  beginCapture(source) {
    if (this.state === 'recording') return false
    if (this._transcribing) return false
    // 注册声纹时别让唤醒词/热键插进来抢这一段
    if (this._enroll && source !== 'enroll') return false
    this.state = 'recording'
    const prerollMs = source === 'wake' ? PREROLL_WAKE_MS : PREROLL_HOTKEY_MS
    const preroll = this._tail(prerollMs / 1000)
    this.capture = {
      source,
      chunks: preroll.length ? [preroll] : [],
      samples: preroll.length,
      speechMs: 0,
      startedAt: Date.now(),
      lastVoiceAt: 0,
      hasSpeech: false,
    }
    this.endpoint = this._createEndpoint()
    // 预录也算这一句的开头，端点里的时间和 capture.samples 才对得上（裁剪点按采样数算）
    if (preroll.length) this.endpoint.push(preroll)
    this.emit('capture', { phase: 'start', ms: 0, level: this.level, source })
    return true
  }

  /**
   * 这一句的端点判定。声纹可用、并且用户在设置里没关掉时，由它判断「哪几段是机主」；
   * 否则传 null 声纹，整条逻辑退化成旧行为（任何有声都算机主、不裁剪）。
   */
  _createEndpoint() {
    const settings = this.config.voiceprint || {}
    const usable = Boolean(this.voiceprint && this.voiceprint.enrolled && settings.ownerGate !== false)
    return new OwnerEndpoint({
      sampleRate: SAMPLE_RATE,
      speechRms: SPEECH_RMS,
      silenceMs: this.config.silenceSeconds * 1000,
      maxMs: this.config.maxSeconds * 1000,
      noSpeechMs: NO_SPEECH_TIMEOUT_MS,
      voiceprint: usable ? this.voiceprint : null,
      log: (line) => this.log(`端点 ${line}`),
    })
  }

  _feedCapture(chunk) {
    const capture = this.capture
    if (!capture) return
    this._appendToCapture(chunk)
    const rms = rmsOf(chunk)
    const durationMs = (capture.samples / SAMPLE_RATE) * 1000

    if (rms >= SPEECH_RMS) {
      if (!capture.hasSpeech) {
        capture.hasSpeech = true
        this.log(`检测到说话 @${Math.round(durationMs)}ms`)
      }
      capture.speechMs += (chunk.length / SAMPLE_RATE) * 1000
      capture.lastVoiceAt = Date.now()
    }

    // 收尾交给端点：只有「机主」的段才刷新计时。旁边人一直说，录音也会在机主停下
    // silenceSeconds 后结束，而不是一路录到 maxSeconds。
    const decision = this.endpoint ? this.endpoint.push(chunk) : null

    const now = Date.now()
    if (now - this.lastTickAt >= 100) {
      this.lastTickAt = now
      this.emit('capture', { phase: 'tick', ms: Math.round(durationMs), level: this.level })
    }

    if (!decision) return
    if (decision.reason === 'no-speech') {
      this._abortCapture('没听到声音')
      return
    }
    void this._finishCapture(decision.reason, { trimSamples: decision.trimSamples })
  }

  _appendToCapture(chunk) {
    const capture = this.capture
    capture.chunks.push(chunk.slice())
    capture.samples += chunk.length
  }

  _abortCapture(reason, silent = false) {
    if (this.state !== 'recording') return
    const had = this.capture && this.capture.hasSpeech
    this.capture = null
    this.endpoint = null
    this.state = this._idleState()
    if (this._enroll) {
      this._enroll = null
      this.emit('enroll-done', { ok: false, error: '取消注册声纹' })
    }
    this.emit('capture', { phase: 'end', ms: 0, level: 0, aborted: true })
    this.log(`录音取消：${reason}`)
    // 用户主动取消不是「没听清」，别弹错误提示
    if (!had && !silent) this.emit('empty', { reason })
    if (this.pendingKeywords) setTimeout(() => this.reloadKeywords(), 0)
  }

  cancel() {
    if (this.state === 'recording') {
      this._abortCapture('用户取消', true)
      return true
    }
    return false
  }

  /**
   * 手动结束这一句（界面上的「停止录音」）：有内容就照常送去识别、发出去，
   * 一个字都没说就当取消——不然用户点了会收到一句「没听清」。
   */
  stop() {
    if (this.state !== 'recording') return false
    const capture = this.capture
    if (!capture || !capture.hasSpeech) {
      this._abortCapture('用户停止（没说话）', true)
      return true
    }
    // 手动停止也要走端点的裁剪判定：机主按停之前那段「旁边人的话」同样要剪掉
    const decision = this.endpoint ? this.endpoint.finish('manual') : null
    void this._finishCapture('manual', { trimSamples: decision ? decision.trimSamples : 0 })
    return true
  }

  /**
   * @param {string} reason silence | max-length | manual | ...
   * @param {{trimSamples?: number}} [options] 端点判定「尾部是旁人」时给出的裁剪点
   */
  async _finishCapture(reason, options = {}) {
    const capture = this.capture
    if (!capture) return
    this.capture = null
    this.endpoint = null
    this.state = 'busy'
    const durationMs = Math.round((capture.samples / SAMPLE_RATE) * 1000)
    this.emit('capture', { phase: 'end', ms: durationMs, level: 0 })

    let samples = new Float32Array(capture.samples)
    let offset = 0
    for (const chunk of capture.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    this.log(`一段结束 reason=${reason} 时长=${durationMs}ms 采样=${samples.length}`)

    const trim = Math.max(0, Math.round(Number(options.trimSamples) || 0))
    if (trim > 0 && trim < samples.length) {
      const dropped = ((samples.length - trim) / SAMPLE_RATE).toFixed(2)
      samples = samples.slice(0, trim)
      this.log(`端点裁剪：去掉尾部 ${dropped}s（旁边人的话）`)
    }
    const finalMs = Math.round((samples.length / SAMPLE_RATE) * 1000)

    if (capture.speechMs < MIN_SPEECH_MS) {
      this.state = this._idleState()
      // 注册时这一句太短，当成「算不出声纹」再给一次机会，别把注册流程卡死
      if (capture.source === 'enroll' && this._enroll) {
        this._handleEnrollSample(null)
        return
      }
      this.emit('empty', { reason: 'too-short' })
      return
    }

    // 注册声纹时不识别，只算向量；连着录几句
    if (capture.source === 'enroll') {
      this._handleEnrollSample(samples)
      return
    }

    // 声纹门禁：唤醒/热键收上来的整句先验机主，不像就先扣着等用户决定
    if (this.voiceprint && this.voiceprint.enrolled) {
      let verdict = this.voiceprint.verify(samples)
      if (!verdict.ok && verdict.enrolled) {
        // 整句平均分会被尾部噪声/别人的低语稀释：2026-11-19 10:28:34 机主自己那句
        // 整句 0.460 被拒（要重说一遍），但滑窗最好的一段是 0.524。整句不过再看最好窗。
        const best = this.voiceprint.bestScore(samples)
        if (best && best.score >= verdict.threshold) {
          this.log(
            `声纹整句 ${verdict.score.toFixed(3)} 未过，最好窗 ${best.score.toFixed(3)}@${best.atMs}ms 过`,
          )
          verdict = { ...verdict, ok: true, score: best.score, reason: 'best-window' }
        }
      }
      if (!verdict.ok) {
        this._rejected = { samples, verdict, at: Date.now() }
        this._saveRejected(samples, verdict)
        this.state = this._idleState()
        this.log(`声纹没过 score=${verdict.score.toFixed(3)} < ${verdict.threshold}`)
        this.emit('voiceprint-rejected', {
          score: Number(verdict.score.toFixed(3)),
          threshold: verdict.threshold,
          reason: verdict.reason || '',
        })
        return
      }
      this.log(`声纹通过 score=${verdict.score.toFixed(3)}`)
    }

    try {
      const text = await this._transcribe(samples)
      if (!text) {
        this.state = this._idleState()
        this.emit('empty', { reason: 'no-text' })
        return
      }
      const wavPath = path.join(this.config.audioDir, `${Date.now()}.wav`)
      writeWav(wavPath, samples)
      this.emit('text', { text, wavPath, ms: finalMs, source: capture.source })
    } catch (error) {
      this.log(`识别失败：${error && error.stack ? error.stack : error}`)
      this.emit('error', { stage: 'asr', message: '识别失败' })
    } finally {
      this.state = this._idleState()
      if (this.pendingKeywords) setTimeout(() => this.reloadKeywords(), 0)
    }
  }

  /**
   * 门禁没过的录音也留一份：调阈值/查误拒时得能听回原音，
   * 以前只有内存里那一份，界面一关日志里就只剩一个分数。
   */
  _saveRejected(samples, verdict) {
    try {
      const dir = path.join(this.config.audioDir, 'rejected')
      fs.mkdirSync(dir, { recursive: true })
      const score = Number(verdict && verdict.score ? verdict.score : 0).toFixed(3)
      const file = path.join(dir, `${Date.now()}-${score}.wav`)
      writeWav(file, samples)
      this.log(`被拒录音已存档 ${file}`)
    } catch (error) {
      this.log(`归档被拒录音失败：${error && error.message ? error.message : error}`)
    }
  }

  /** 注册流程收一句：算向量、报进度，够数就平均落盘。 */
  _handleEnrollSample(samples) {
    const enroll = this._enroll
    this.state = this._idleState()
    if (!enroll) return
    const vector = this.voiceprint ? this.voiceprint.embed(samples) : null
    if (!vector) {
      enroll.failures = (enroll.failures || 0) + 1
      this.emit('enroll-progress', {
        index: enroll.vectors.length,
        want: enroll.want,
        ok: false,
        error: enroll.failures >= 3 ? '连续几句都算不出声纹，先退出重试' : '这句太短或太吵，再说一次',
      })
      if (enroll.failures >= 3) {
        this._enroll = null
        this.emit('enroll-done', { ok: false, error: '声纹样本不够，注册取消' })
        return
      }
      setTimeout(() => {
        if (this._enroll) this.beginCapture('enroll')
      }, 350)
      return
    }

    enroll.vectors.push(vector)
    enroll.failures = 0
    this.emit('enroll-progress', { index: enroll.vectors.length, want: enroll.want, ok: true })
    if (enroll.vectors.length < enroll.want) {
      setTimeout(() => {
        if (this._enroll) this.beginCapture('enroll')
      }, 400)
      return
    }

    const result = this.voiceprint.saveTemplate(enroll.vectors)
    this._enroll = null
    if (result.ok) {
      this.emit('enroll-done', { ok: true, selfCheck: result.selfCheck, dim: result.dim, samples: enroll.vectors.length })
    } else {
      this.emit('enroll-done', { ok: false, error: result.error })
    }
  }

  async _transcribe(samples) {
    if (!this.recognizer && !this._initRecognizer()) return ''
    this._transcribing = true
    const startedAt = Date.now()
    try {
      const stream = this.recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      this.recognizer.decode(stream)
      const result = this.recognizer.getResult(stream)
      const raw = (result && result.text) || ''
      const text = this._clean(raw)
      this.log(`识别 ${Date.now() - startedAt}ms -> ${JSON.stringify(text)}`)
      return text
    } finally {
      this._transcribing = false
    }
  }

  /** 去掉开头的唤醒词（用户说「小印，帮我…」时识别结果常把唤醒词也带上）。 */
  _clean(raw) {
    let text = String(raw).trim()
    if (!text || text === '。' || text === '.') return ''
    const names = (Array.isArray(this.config.wakeWords) ? this.config.wakeWords : [])
      .map((word) => String(word && word.text ? word.text : '').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    for (const name of names) {
      if (text.startsWith(name)) {
        text = text.slice(name.length).replace(/^[，,。.、！!？?\s]+/, '')
        break
      }
    }
    return text.trim()
  }

  _idleState() {
    return this.wakeEnabled && this.spotter ? 'monitor' : 'off'
  }
}

module.exports = { VoiceLoop, SAMPLE_RATE, writeWav }
