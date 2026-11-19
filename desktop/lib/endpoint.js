'use strict'

/**
 * 端点判定：把「机主说完了」和「旁边人还在说话」分开。
 *
 * 旧逻辑里任何一个超过 SPEECH_RMS 的 20 ms 块都算「还有人说话」（lastVoiceAt 被刷新），
 * 于是旁边人一开口，收尾就永远不触发，只能一路录到 maxSeconds，把别人的话也灌给模型。
 *
 * 这里的做法（不依赖新模型，只用已有的 CAM++ 声纹）：
 *   1. 20 ms 帧能量做分段，段间停顿 >400 ms 才算一段说完（只用于日志与「太短」判断）；
 *   2. **滚动判机主**：有声期间每 400 ms 拿最近 1.5 s 打一次分，只有分数够才推进
 *      「机主末点」ownerLastMs：
 *        score ≥ 0.50 → 确认机主（seenOwner，ownerLastMs 推进）
 *        score ≥ 0.42 → 容忍带（机主换气/句尾变轻，ownerLastMs 照样推进，不确认）
 *        否则          → 不动 ownerLastMs（旁边人接着讲也不动）
 *   3. 收尾锚点只看 ownerLastMs（不再把「正在说的那一段」算成机主——那会让任何连续
 *      说话把收尾计时一直刷新，旁边人一讲就永远收不了尾）。机主停下 silenceMs
 *      （1.2 s）就收尾，旁边人还在讲也照样收。
 *   4. 收尾后一律裁剪到 ownerLastMs + padMs(300 ms)：机主没确认过（seenOwner=false）
 *      就不裁，机主说得轻、低于能量阈值时也不会被切掉。
 *
 * 阈值依据（2026-11-19 对运行目录 141 段真实录音离线标定）：机主的窗分在 0.35–0.72
 * 之间波动（同一人句尾变轻能掉到 0.35），隔壁顾客能到 0.42–0.46，两者分布重叠，
 * 所以用「滚动 + 容忍带」而不是段级硬阈值；固定 floor 裁剪会切掉机主真话（141 段里
 * 86 段），不能只用分数一刀切。
 *
 * 没有注册声纹、没装声纹模型、或用户在设置里关掉时，voiceprint 传 null，整条逻辑
 * 退化成旧行为（任何有声都算机主、不裁剪），所以不需要两套代码路径。
 *
 * 时间基准是「已经推入的采样数」，不是墙钟：方便单测复现，也不受事件循环抖动影响。
 */

const DEFAULTS = {
  sampleRate: 16000,
  frame: 320, // 20 ms
  speechRms: 0.012, // 与 audio.js 的 SPEECH_RMS 一致
  gapMs: 400, // 段内允许的停顿；超过就认为这段说完了
  silenceMs: 1200, // 机主停下多久收尾（沿用 config.silenceSeconds）
  maxMs: 20000, // 沿用 config.maxSeconds
  noSpeechMs: 6000, // 一直没声音就放弃（沿用 NO_SPEECH_TIMEOUT_MS）
  padMs: 300, // 裁剪时给机主尾音的余量
  scoreMinMs: 600, // 短于这个不判（CAM++ 至少要 0.3 s，太短的分数不可信）
  maxScoreMs: 4000, // 打分最多取段尾 4 s，长句也够
  ownerScore: 0.5, // 段级判定「这就是机主」（与 voiceprint 的 threshold 一致）
  liveOwnerScore: 0.45, // 滚动判主用：1.5 s 小窗分数整体比整段低约 0.05，线要跟着降
  tolerateScore: 0.42, // 容忍带下限：机主句尾变轻、换气时用这个继续推进
  liveEveryMs: 400, // 滚动判机主的节奏
  liveWindowMs: 1500, // 滚动判机主每次看的音频长度
  liveShortMs: 700, // 近处复核窗：窗口末尾这一段必须仍基本有声，才算机主还在说
  liveVoicedMin: 0.5, // 近处复核窗里至少这么多比例是有声帧
  trimMinMs: 200, // 尾部不足这么多就不裁（省得白改采样数）
  ownerSilenceMs: 2000, // 机主不再确认后，再等这么久（且要等到一个真停顿）才收尾
  pauseMs: 400, // 「真停顿」= 这么久没有任何有声帧
  otherScoreLong: 0.3,
  otherScoreMid: 0.24,
  otherScoreShort: 0.18,
  otherLongMs: 1500,
  otherMidMs: 1200,
  chatterFromMs: 1500, // 段长超过这个才开始做段内判定
  chatterWindowMs: 2500,
  chatterEveryMs: 600,
  chatterMinScore: 0.18,
  chatterFails: 2,
}

const EMPTY = new Float32Array(0)

function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}


class OwnerEndpoint {
  /**
   * @param {object} [options]
   * @param {object} [options.voiceprint] Voiceprint 实例（需要 enrolled 与 verify）；null = 只用旧逻辑
   * @param {(message: string) => void} [options.log]
   */
  constructor(options = {}) {
    const opts = { ...DEFAULTS, ...options }
    this.sampleRate = opts.sampleRate
    this.frame = opts.frame
    this.speechRms = opts.speechRms
    this.gapMs = opts.gapMs
    this.silenceMs = opts.silenceMs
    this.maxMs = opts.maxMs
    this.noSpeechMs = opts.noSpeechMs
    this.padMs = opts.padMs
    this.scoreMinMs = opts.scoreMinMs
    this.maxScoreMs = opts.maxScoreMs
    this.ownerScore = opts.ownerScore
    this.liveOwnerScore = opts.liveOwnerScore
    this.tolerateScore = opts.tolerateScore
    this.liveEveryMs = opts.liveEveryMs
    this.liveWindowMs = opts.liveWindowMs
    this.liveShortMs = opts.liveShortMs
    this.liveVoicedMin = opts.liveVoicedMin
    this.trimMinMs = opts.trimMinMs
    this.ownerSilenceMs = opts.ownerSilenceMs
    this.pauseMs = opts.pauseMs
    this.otherScoreLong = opts.otherScoreLong
    this.otherScoreMid = opts.otherScoreMid
    this.otherScoreShort = opts.otherScoreShort
    this.otherLongMs = opts.otherLongMs
    this.otherMidMs = opts.otherMidMs
    this.chatterFromMs = opts.chatterFromMs
    this.chatterWindowMs = opts.chatterWindowMs
    this.chatterEveryMs = opts.chatterEveryMs
    this.chatterMinScore = opts.chatterMinScore
    this.chatterFails = opts.chatterFails
    this.voiceprint = opts.voiceprint || null
    this.log = typeof opts.log === 'function' ? opts.log : () => {}

    // 音频缓冲：只留最近 8 s（段内判定看 2.5 s、打分最多 4 s，够了）
    this._buf = new Float32Array(this.sampleRate * 8)
    this._bufLen = 0
    this._bufOrigin = 0 // _buf[0] 对应的绝对采样序号
    this._carry = EMPTY
    this.samples = 0

    this.hasSpeech = false
    this.lastVoicedMs = 0
    this.sinceVoicedMs = 0
    this.open = null
    this.segments = []
    this.seenOwner = false
    this.ownerLastMs = 0
    this.trailingOther = false
    this.lastLiveMs = 0
    this.lastLiveScore = null // 上次滚动打分的时间点
    this.liveScores = [] // 最近几次滚动分，只给日志用
    this.done = null
  }

  /** 有没有可用声纹（没注册就退化成旧逻辑）。 */
  get gated() {
    return Boolean(this.voiceprint && this.voiceprint.enrolled)
  }

  /**
   * 推一块 16 kHz 单声道采样。
   * @param {Float32Array} chunk
   * @returns {null|{reason: string, trimSamples: number, ownerLastMs: number, seenOwner: boolean, segments: Array}}
   */
  push(chunk) {
    if (!chunk || !chunk.length) return this._decide()
    const carryLen = this._carry.length
    this._write(chunk)
    const total = carryLen + chunk.length
    let data
    if (carryLen === 0) {
      data = chunk
    } else {
      data = new Float32Array(total)
      data.set(this._carry, 0)
      data.set(chunk, carryLen)
    }
    const base = this.samples - total // data[0] 的绝对采样序号
    let i = 0
    for (; i + this.frame <= data.length; i += this.frame) {
      this._onFrame(base + i, data.subarray(i, i + this.frame))
    }
    this._carry = i < data.length ? Float32Array.from(data.subarray(i)) : EMPTY
    return this._decide()
  }

  /** 已收的采样里有多少秒是真在说话（给「太短了」之类的判断用）。 */
  get voicedMs() {
    return this.lastVoicedMs
  }

  // ------------------------------------------------------------ 缓冲

  _write(chunk) {
    const cap = this._buf.length
    if (this._bufLen + chunk.length > cap) {
      const drop = Math.min(this._bufLen, this._bufLen + chunk.length - cap)
      this._buf.copyWithin(0, drop, this._bufLen)
      this._bufOrigin += drop
      this._bufLen -= drop
    }
    if (chunk.length > cap) {
      const tail = chunk.subarray(chunk.length - cap)
      this._bufOrigin = this.samples + chunk.length - cap
      this._buf.set(tail, 0)
      this._bufLen = cap
      this.samples += chunk.length
      return
    }
    this._buf.set(chunk, this._bufLen)
    this._bufLen += chunk.length
    this.samples += chunk.length
  }

  /** 取 [startMs, endMs) 的音频；越界部分自动夹到缓冲里，没有就返回 null。 */
  _slice(startMs, endMs) {
    const sr = this.sampleRate
    const a = Math.max(this._bufOrigin, Math.round((startMs / 1000) * sr))
    const b = Math.min(this._bufOrigin + this._bufLen, Math.round((endMs / 1000) * sr))
    if (b - a < 1) return null
    return this._buf.slice(a - this._bufOrigin, b - this._bufOrigin)
  }

  // ------------------------------------------------------------ 分段

  _onFrame(startSample, frame) {
    const sr = this.sampleRate
    const t0 = (startSample / sr) * 1000
    const t1 = ((startSample + frame.length) / sr) * 1000
    const voiced = rmsOf(frame) >= this.speechRms

    if (voiced) {
      this.hasSpeech = true
      this.lastVoicedMs = t1
      this.sinceVoicedMs = 0
      if (this.open) this.open.endMs = t1
      else this.open = { startMs: t0, endMs: t1, fails: 0, lastEvalMs: 0, markedOther: false }
      this._trackLive(t1)
      this._maybeJudge()
      return
    }

    // 静音帧也要累计「距离最后一个有声帧多久」：段已经关掉（open=null）的时候
    // 这个计数器仍然必须走，否则 _decide 里的「落在真停顿上」永远不成立，
    // 只能一路录到 maxSeconds 或者等到用户手动按停。
    this.sinceVoicedMs += (frame.length / sr) * 1000
    if (!this.open) return
    if (this.sinceVoicedMs >= this.gapMs) this._closeSegment()
  }
  /**
   * 滚动判机主：有声期间每 liveEveryMs 拿最近 liveWindowMs 的音频打一次分，
   * 只有分数够才推进 ownerLastMs。旁边人接着讲时分数掉下去，ownerLastMs 就停住，
   * 收尾计时（_decide 里的 now - ownerLastMs）才会走完。
   */
  _trackLive(t1) {
    if (!this.gated) return // 没声纹：退化成旧逻辑（按 lastVoicedMs 收尾）
    if (t1 - this.lastLiveMs < this.liveEveryMs) return
    if (t1 < this.liveWindowMs) return
    const audio = this._slice(t1 - this.liveWindowMs, t1)
    const score = this._score(audio)
    if (score == null) return
    this.lastLiveMs = t1
    // 近处这 liveShortMs 必须还有声音在：只用 1.5 s 的窗判「谁在说」时，机主刚停下、
    // 旁人起头的那一小段会把窗口里的机主语音混进来、照样打高分（实测 0.8 s 短命令会被
    // 一路推到 1.9 s，把旁人开头 0.6 s 也带进来）。
    // 判据用「100 ms 里有没有能量」而不是逐 20 ms 帧的占空比：正常说话在 20 ms 尺度上
    // 到处是低能量帧，逐帧占比只有 0.2 左右，会把机主自己正常的话也判掉。
    const near = this._slice(t1 - this.liveShortMs, t1)
    const nearOk = this._voicedFraction(near) >= this.liveVoicedMin
    if (score >= this.liveOwnerScore && nearOk) {
      this.seenOwner = true
      this.ownerLastMs = Math.max(this.ownerLastMs, t1)
    } else if (this.seenOwner && score >= this.tolerateScore && nearOk) {
      this.ownerLastMs = Math.max(this.ownerLastMs, t1)
    }
    this.liveScores.push(`${(t1 / 1000).toFixed(2)}s:${score.toFixed(3)}`)
    this.lastLiveScore = score
    if (this.liveScores.length > 12) this.liveScores.shift()
  }

  /**
   * 一段音频里「有声音」的占比：按 100 ms 分块，块里只要有一个 20 ms 帧够响就算有声。
   * 逐 20 ms 帧算占比会把正常说话的换气、辅音缝隙算成静音（实测只剩 0.2），不能用。
   */
  _voicedFraction(audio) {
    if (!audio || audio.length === 0) return 0
    const sub = Math.max(1, Math.round(this.sampleRate * 0.02))
    const block = Math.max(sub, Math.round(this.sampleRate * 0.1))
    let voiced = 0
    let total = 0
    for (let b = 0; b < audio.length; b += block) {
      total += 1
      const end = Math.min(audio.length, b + block)
      for (let i = b; i + sub <= end; i += sub) {
        if (rmsOf(audio.subarray(i, i + sub)) >= this.speechRms) {
          voiced += 1
          break
        }
      }
    }
    return total === 0 ? 0 : voiced / total
  }

  /** 段内判定：一段连续说话太久，就定期看一眼是不是别人在讲。 */
  _maybeJudge() {
    const open = this.open
    if (!open || open.markedOther) return
    if (open.endMs - open.startMs < this.chatterFromMs) return
    if (open.endMs - open.lastEvalMs < this.chatterEveryMs) return
    open.lastEvalMs = open.endMs
    const from = Math.max(open.startMs, open.endMs - this.chatterWindowMs)
    const score = this._score(this._slice(from, open.endMs))
    if (score == null) return
    open.fails = score < this.chatterMinScore ? open.fails + 1 : 0
    this.log(`段内 ${(open.endMs / 1000).toFixed(2)}s score=${score.toFixed(3)} 连击=${open.fails}`)
    if (open.fails >= this.chatterFails) {
      open.markedOther = true
      this.log(`段内判定为旁人（${(open.endMs / 1000).toFixed(2)}s），不再算机主`)
      this._closeSegment()
    }
  }

  _closeSegment() {
    const open = this.open
    if (!open) return
    this.open = null
    // 注意：不要在这里清 sinceVoicedMs ——它表示「距离最后一个有声帧多久」，
    // 关段之后 _decide 还要靠它判断有没有落在真停顿上。
    const durMs = open.endMs - open.startMs
    let score = null
    let verdict = 'ambig'

    if (open.markedOther) {
      verdict = 'other'
    } else if (durMs >= this.scoreMinMs) {
      const from = Math.max(open.startMs, open.endMs - this.maxScoreMs)
      score = this._score(this._slice(from, open.endMs))
      if (score != null) verdict = this._verdict(score, durMs)
    }

    this.segments.push({ startMs: open.startMs, endMs: open.endMs, durMs, score, verdict })
    if (this.segments.length > 60) this.segments.shift()
    const tag = score == null ? '' : ` score=${score.toFixed(3)}`

    if (verdict === 'other') {
      if (this.seenOwner) this.trailingOther = true
      this.log(`段 ${(open.startMs / 1000).toFixed(2)}-${(open.endMs / 1000).toFixed(2)}s 判别人${tag}`)
      return
    }

    if (verdict === 'owner') {
      this.seenOwner = true
      this.ownerLastMs = Math.max(this.ownerLastMs, open.endMs)
      this.trailingOther = false
    }
    // 「模糊」段不再推进 ownerLastMs：以前 fail-open 把它当机主，旁边人一接话，
    // 收尾计时就被一路刷新，结果只能录到 maxSeconds。现在只认 _trackLive 的滚动分。
    this.log(`段 ${(open.startMs / 1000).toFixed(2)}-${(open.endMs / 1000).toFixed(2)}s 判${verdict === 'owner' ? '机主' : '模糊'}${tag}`)
  }

  _verdict(score, durMs) {
    if (score >= this.ownerScore) return 'owner'
    if (durMs >= this.otherLongMs && score < this.otherScoreLong) return 'other'
    if (durMs >= this.otherMidMs && score < this.otherScoreMid) return 'other'
    if (score < this.otherScoreShort) return 'other'
    return 'ambig'
  }

  /** 一段音频 → 与机主模板的余弦分；算不出来（太短/没声纹/异常）返回 null。 */
  _score(audio) {
    if (!audio) return null
    if (audio.length < this.sampleRate * 0.3) return null
    if (!this.gated) return null
    try {
      const verdict = this.voiceprint.verify(audio, this.ownerScore)
      if (!verdict || verdict.enrolled === false) return null
      const score = Number(verdict.score)
      return Number.isFinite(score) ? score : null
    } catch (error) {
      this.log(`声纹判定失败：${error && error.message ? error.message : error}`)
      return null
    }
  }

  // ------------------------------------------------------------ 收尾

  _decide() {
    if (this.done) return this.done
    const now = (this.samples / this.sampleRate) * 1000
    // 判定过机主之后，要同时满足三条才收尾：
    // ① 机主已有 ownerSilenceMs 没再被确认；
    // ② 最近这段被评过分的音频不像是机主（lastLiveScore 低于容忍带，或者最后一次评分
    //    本来就是在机主末点上）——没有这条，机主中途停下来想事情，会被当成「旁人接话」
    //    在停顿处就收尾，直接把后面那半句话丢掉（1794920114035：停 4 s 后又说了一句）；
    // ③ 要么正好落在真停顿上（pauseMs 内没有有声帧），要么正在讲的这段已经被判成旁人。
    const staleOther =
      this.lastLiveScore == null || this.lastLiveScore < this.tolerateScore || this.lastLiveMs <= this.ownerLastMs
    const otherNow =
      Boolean(this.open && this.open.markedOther) ||
      (this.lastLiveScore != null && now - this.lastLiveMs < 1000 && this.lastLiveScore < this.tolerateScore)
    const gatedSilence = this.seenOwner
      ? now - this.ownerLastMs >= this.ownerSilenceMs && staleOther && (otherNow || this.sinceVoicedMs >= this.pauseMs)
      : now - this.lastVoicedMs >= this.silenceMs

    let reason = null
    if (now >= this.maxMs) reason = 'max-length'
    else if (this.hasSpeech && gatedSilence) reason = 'silence'
    else if (!this.hasSpeech && now >= this.noSpeechMs) reason = 'no-speech'
    if (!reason) return null

    this.done = {
      reason,
      trimSamples: this._trimSamples(now),
      ownerLastMs: Math.round(this.ownerLastMs),
      seenOwner: this.seenOwner,
      segments: this.segments.slice(-8),
      live: this.liveScores.slice(-6),
    }
    this.log(
      `收尾 reason=${reason} 机主末点=${(this.ownerLastMs / 1000).toFixed(2)}s 裁剪=${this.done.trimSamples}` +
        ` 段数=${this.segments.length}${this.trailingOther ? '（尾部有旁人）' : ''}` +
        `${this.liveScores.length ? ` 滚动分=${this.liveScores.slice(-6).join(' ')}` : ''}`,
    )
    return this.done
  }

  /**
   * 手动停止（界面上的「停止录音」）也要走同一套裁剪判定：
   * 以前 stop() 不带 trimSamples，用户自己按停就完全绕过端点，旁边人的话照收。
   * @returns {null|{reason: string, trimSamples: number, ownerLastMs: number, seenOwner: boolean, segments: Array}}
   */
  finish(reason = 'manual') {
    if (this.done) return this.done
    const now = (this.samples / this.sampleRate) * 1000
    this.done = {
      reason,
      trimSamples: this._trimSamples(now),
      ownerLastMs: Math.round(this.ownerLastMs),
      seenOwner: this.seenOwner,
      segments: this.segments.slice(-8),
      live: this.liveScores.slice(-6),
    }
    this.log(
      `收尾 reason=${reason} 机主末点=${(this.ownerLastMs / 1000).toFixed(2)}s 裁剪=${this.done.trimSamples}` +
        `${this.liveScores.length ? ` 滚动分=${this.liveScores.slice(-6).join(' ')}` : ''}`,
    )
    return this.done
  }

  /**
   * 裁剪点（采样数）；0 表示不裁剪。
   *
   * 只裁到「机主末点 + padMs」，而且机主一次都没确认过（seenOwner=false，比如没注册声纹）
   * 就一律不裁。因为收尾本来就在「机主末点 + ownerSilenceMs」附近，这里实际剪掉的大多
   * 是尾巴上的静音或旁人刚开口的那半秒，不会切掉机主成句的话（141 段回放核过）。
   */
  _trimSamples(nowMs) {
    if (!this.seenOwner) return 0
    const ms = this.ownerLastMs + this.padMs
    if (ms <= 0) return 0
    const cut = Math.round((ms / 1000) * this.sampleRate)
    const total = Math.round((nowMs / 1000) * this.sampleRate)
    if (cut <= 0 || cut >= total) return 0
    if (((total - cut) / this.sampleRate) * 1000 < this.trimMinMs) return 0
    return cut
  }
}

module.exports = { OwnerEndpoint, DEFAULTS }




