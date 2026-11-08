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
 *   error   {stage, message}
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

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
    this._transcribing = false
    this.pendingKeywords = false
  }

  // ---------------------------------------------------------------- 引擎

  initEngines() {
    this._initSpotter()
    // 识别器创建要 1.3 s 左右，延后一点，别和窗口首帧抢时间
    setTimeout(() => this._initRecognizer(), 800)
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
    this.emit('capture', { phase: 'start', ms: 0, level: this.level, source })
    return true
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

    const now = Date.now()
    if (now - this.lastTickAt >= 100) {
      this.lastTickAt = now
      this.emit('capture', { phase: 'tick', ms: Math.round(durationMs), level: this.level })
    }

    const isOverlong = durationMs >= this.config.maxSeconds * 1000
    const isDone = capture.hasSpeech && capture.speechMs >= MIN_SPEECH_MS && now - capture.lastVoiceAt >= this.config.silenceSeconds * 1000
    const isSilent = !capture.hasSpeech && now - capture.startedAt >= NO_SPEECH_TIMEOUT_MS

    if (isDone || isOverlong) void this._finishCapture(isOverlong ? 'max-length' : 'silence')
    else if (isSilent) this._abortCapture('没听到声音')
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
    this.state = this._idleState()
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
    void this._finishCapture('manual')
    return true
  }

  async _finishCapture(reason) {
    const capture = this.capture
    if (!capture) return
    this.capture = null
    this.state = 'busy'
    const durationMs = Math.round((capture.samples / SAMPLE_RATE) * 1000)
    this.emit('capture', { phase: 'end', ms: durationMs, level: 0 })

    const samples = new Float32Array(capture.samples)
    let offset = 0
    for (const chunk of capture.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    this.log(`一段结束 reason=${reason} 时长=${durationMs}ms 采样=${samples.length}`)

    if (capture.speechMs < MIN_SPEECH_MS) {
      this.state = this._idleState()
      this.emit('empty', { reason: 'too-short' })
      return
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
      this.emit('text', { text, wavPath, ms: durationMs, source: capture.source })
    } catch (error) {
      this.log(`识别失败：${error && error.stack ? error.stack : error}`)
      this.emit('error', { stage: 'asr', message: '识别失败' })
    } finally {
      this.state = this._idleState()
      if (this.pendingKeywords) setTimeout(() => this.reloadKeywords(), 0)
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
