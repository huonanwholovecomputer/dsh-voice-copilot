// ===========================================================
// 小印浮窗 · 渲染层逻辑
// 只做三件事：画界面、把麦克风转成 16 kHz 单声道 Float32 推给主进程、把操作发回去。
// 所有能力都来自 preload 注入的 window.xiaoyin（见 desktop/CONTRACT.md）。
// ===========================================================

(function () {
  'use strict'

  /* ---------------- 0. preload 兜底 ---------------- */

  // 直接用浏览器打开 index.html 时没有 preload，界面仍要能跑（截图/调试用）。
  const stub = {
    onState: () => () => {},
    onMessages: () => () => {},
    onToast: () => () => {},
    send: () => Promise.resolve(),
    hide: () => Promise.resolve(),
    focusSession: () => Promise.resolve(),
    setWake: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    audio: {
      start: () => Promise.resolve({ ok: true, sampleRate: 16000, device: 'stub' }),
      stop: () => Promise.resolve(),
      push: () => {},
    },
  }
  const api = window.xiaoyin || stub

  /* ---------------- 1. DOM ---------------- */

  const $ = (id) => document.getElementById(id)
  const card = $('card')
  const brandEl = $('brand')
  const emptyTitle = $('emptyTitle')
  const emptySub = $('emptySub')
  const thread = $('thread')
  const list = $('list')
  const emptyEl = $('empty')
  const hintText = $('hintText')
  const micRetry = $('micRetry')
  const timerEl = $('timer')
  const meterEl = $('meter')
  const composer = $('composer')
  const input = $('input')
  const sendBtn = $('sendBtn')
  const toastEl = $('toast')
  const toastText = $('toastText')

  /* ---------------- 2. 状态 ---------------- */

  const VALID_PHASES = ['sleeping', 'recording', 'thinking', 'replying', 'error']

  const state = {
    phase: 'sleeping',
    level: 0,
    wake: true,
    name: '语音助手',
    hotkey: 'Ctrl+Alt+J',
    hint: '说「语音助手」就能叫出来，或按 Ctrl+Alt+J',
    recordingMs: 0,
    error: '',
  }

  let lastStateAt = performance.now()
  let micError = ''
  let audioStarting = false
  let audioGraph = null
  // 主进程说了算：它按「关掉唤醒词是否释放麦克风」的策略推 mic true/false。
  // false 时这里连 getUserMedia 都不发，任务栏的麦克风图标才会真的灭。
  let micAllowed = null

  /* ---------------- 3. 状态渲染 ---------------- */

  function renderState() {
    card.dataset.phase = state.phase

    const name = String(state.name || '语音助手')
    if (brandEl) brandEl.textContent = name
    document.title = name
    if (emptyTitle) emptyTitle.textContent = `说声「${name}」，或者直接打字`
    if (emptySub) emptySub.textContent = `按 ${String(state.hotkey || 'Ctrl+Alt+J').toUpperCase()} 也能把窗口叫出来`

    const isError = state.phase === 'error'
    const micFailed = !!micError && !isError
    hintText.textContent = isError
      ? state.error || '出了点问题，稍后再试'
      : micFailed
        ? '麦克风不可用：' + micError
        : state.hint
    hintText.classList.toggle('err', isError || micFailed)
    micRetry.classList.toggle('show', micFailed)

    if (state.phase === 'recording') {
      meterEl.classList.add('on')
      ensureRecordingLoop()
    } else {
      meterEl.classList.remove('on')
      resetMeter()
    }
  }

  /* ---------------- 4. 录音计时 ---------------- */

  // 主进程按 ~10Hz 推 recordingMs，本地用锚点插值，让秒数连续跳。
  const recClock = { active: false, ms: 0, at: 0 }

  function syncRecordingClock() {
    if (state.phase !== 'recording') {
      recClock.active = false
      return
    }
    const now = performance.now()
    const reported = Math.max(0, Number(state.recordingMs) || 0)
    if (!recClock.active) {
      recClock.active = true
      recClock.ms = reported
      recClock.at = now
      return
    }
    const shown = recClock.ms + (now - recClock.at)
    // 和主进程报的秒数偏差超过 260ms 就以主进程为准，避免长时间累积漂移
    if (Math.abs(shown - reported) > 260) {
      recClock.ms = reported
      recClock.at = now
    } else if (reported > shown + 40) {
      recClock.ms = reported
      recClock.at = now
    }
  }

  function formatMs(ms) {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return m + ':' + String(s).padStart(2, '0')
  }

  /* ---------------- 5. 电平波形 ---------------- */

  const meter = { hist: [], smooth: 0, raf: 0, canvas: null, ctx: null, w: 0, h: 0, dpr: 0 }

  function resetMeter() {
    meter.hist.length = 0
    meter.smooth = 0
    if (meter.ctx && meter.w > 0) {
      meter.ctx.clearRect(0, 0, meter.w, meter.h)
    }
    if (meter.raf) {
      cancelAnimationFrame(meter.raf)
      meter.raf = 0
    }
  }

  function ensureCanvas() {
    const c = $('levelCanvas')
    const w = Math.max(1, c.clientWidth)
    const h = Math.max(1, c.clientHeight)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (!meter.canvas || meter.w !== w || meter.h !== h || meter.dpr !== dpr) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      meter.canvas = c
      meter.ctx = ctx
      meter.w = w
      meter.h = h
      meter.dpr = dpr
    }
    return meter
  }

  // 严格由 level 驱动：历史环形缓冲 + 平滑跟随，没有随机数。
  function drawMeter() {
    const m = ensureCanvas()
    const ctx = m.ctx
    const mid = m.h / 2
    const barW = 3
    const gap = 2
    const step = barW + gap
    const count = Math.max(16, Math.min(160, Math.floor((m.w - 2) / step)))

    // 跟随主进程给的 level（本身已平滑），这里再补一层短平滑，跳变时不生硬
    const target = Math.max(0, Math.min(1, Number(state.level) || 0))
    meter.smooth += (target - meter.smooth) * 0.28

    meter.hist.push(meter.smooth)
    if (meter.hist.length > count) meter.hist.splice(0, meter.hist.length - count)
    while (meter.hist.length < count) meter.hist.unshift(0)

    ctx.clearRect(0, 0, m.w, m.h)

    for (let i = 0; i < count; i += 1) {
      const raw = meter.hist[i]
      const v = Math.pow(Math.max(0, Math.min(1, raw)), 0.55)
      // 固定的、由索引决定的细微包络，让波形有手绘感（不是随机数）
      const wobble = 0.88 + 0.12 * Math.sin(i * 0.85)
      const bh = Math.max(3, v * wobble * (m.h - 2))
      const x = 1 + i * step
      // 亮度只跟幅度走：安静的地方暗，响的地方亮
      const alpha = 0.2 + 0.66 * Math.min(1, v * 1.35)
      ctx.fillStyle = 'rgba(79,140,255,' + alpha.toFixed(3) + ')'
      const y = mid - bh / 2
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath()
        ctx.roundRect(x, y, barW, bh, barW / 2)
        ctx.fill()
      } else {
        ctx.fillRect(x, y, barW, bh)
      }
    }
  }

  function recordingFrame() {
    meter.raf = 0
    if (state.phase !== 'recording') return
    syncRecordingClock()
    timerEl.textContent = formatMs(recClock.ms + (performance.now() - recClock.at))
    drawMeter()
    meter.raf = requestAnimationFrame(recordingFrame)
  }

  function ensureRecordingLoop() {
    if (!meter.raf) meter.raf = requestAnimationFrame(recordingFrame)
  }

  /* ---------------- 6. 消息 ---------------- */

  let messages = []
  let lastSignature = ''

  function atBottom() {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48
  }

  function pinToBottom() {
    // 等一次布局，再贴底，避免本帧新内容还没算进 scrollHeight
    requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight
    })
  }

  // 录音电平条出现/消失、窗口缩放都会改变可视高度。用「变化前」的三个量判断用户
  // 当时是不是贴着底看：是就继续保持贴底，否则底部那行会被硬切掉。
  let metrics = { sh: 0, st: 0, ch: 0 }
  function syncScrolled() {
    const t = thread
    // 顶部/底部渐隐：真的滚动了才加，静止时保持首行清晰
    t.classList.toggle('scrolled', t.scrollTop > 8)
    t.classList.toggle('detached', t.scrollHeight - t.scrollTop - t.clientHeight > 2)
    metrics = { sh: t.scrollHeight, st: t.scrollTop, ch: t.clientHeight }
  }
  thread.addEventListener('scroll', syncScrolled, { passive: true })
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const wasBottom = metrics.sh - metrics.st - metrics.ch < 48
      if (wasBottom) thread.scrollTop = thread.scrollHeight
      syncScrolled()
    }).observe(thread)
  }

  function cursorEl() {
    const el = document.createElement('span')
    el.className = 'cursor'
    return el
  }

  function buildMessage(msg) {
    const el = document.createElement('div')
    const role = msg.role
    el.className = 'msg ' + (role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant')
    if (msg.id) el.dataset.id = String(msg.id)

    const text = typeof msg.text === 'string' ? msg.text : String(msg.text == null ? '' : msg.text)

    if (role === 'assistant') {
      // 多段：空行分段，段内换行保留
      const paras = text.split(/\n{2,}/)
      const parts = paras.length > 0 ? paras : ['']
      parts.forEach((p) => {
        const div = document.createElement('div')
        div.className = 'para'
        div.textContent = p.replace(/^\n+|\n+$/g, '')
        el.appendChild(div)
      })
      if (msg.streaming) {
        const last = el.lastElementChild || el
        last.appendChild(cursorEl())
      }
    } else {
      el.textContent = text
    }
    return el
  }

  function renderMessages(forceStick) {
    // 清空列表会把 scrollTop 打回 0，先记住位置：贴底就滚到底，否则还原
    const prevTop = thread.scrollTop
    const stick = !!forceStick || atBottom()
    list.textContent = ''
    for (let i = 0; i < messages.length; i += 1) {
      list.appendChild(buildMessage(messages[i]))
    }
    emptyEl.classList.toggle('hidden', messages.length > 0)
    if (stick) {
      pinToBottom()
    } else {
      thread.scrollTop = prevTop
    }
    syncScrolled()
  }

  function onMessages(next) {
    const arr = Array.isArray(next) ? next : []
    const sig = JSON.stringify(arr)
    if (sig === lastSignature) return
    const prevCount = messages.length
    const last = arr[arr.length - 1]
    const grewWithUser = arr.length > prevCount && last && last.role === 'user'
    messages = arr
    lastSignature = sig
    renderMessages(grewWithUser)
  }

  function onState(payload) {
    if (!payload || typeof payload !== 'object') return
    if (VALID_PHASES.indexOf(payload.phase) >= 0) state.phase = payload.phase
    state.level = clamp01(payload.level)
    if (typeof payload.wake === 'boolean') state.wake = payload.wake
    if (typeof payload.mic === 'boolean') setMicAllowed(payload.mic)
    if (typeof payload.name === 'string' && payload.name.trim()) state.name = payload.name.trim()
    if (typeof payload.hotkey === 'string' && payload.hotkey.trim()) state.hotkey = payload.hotkey.trim()
    if (typeof payload.hint === 'string') state.hint = payload.hint
    if (typeof payload.recordingMs === 'number' && isFinite(payload.recordingMs)) {
      state.recordingMs = Math.max(0, payload.recordingMs)
    }
    if (typeof payload.error === 'string') state.error = payload.error
    lastStateAt = performance.now()
    if (state.phase !== 'recording') {
      state.level = 0
    }
    syncRecordingClock()
    renderState()
  }

  function clamp01(v) {
    const n = Number(v)
    if (!isFinite(n)) return 0
    return n < 0 ? 0 : n > 1 ? 1 : n
  }

  /* ---------------- 7. 输入与发送 ---------------- */

  function autoGrow() {
    input.style.height = 'auto'
    const h = Math.min(96, Math.max(24, input.scrollHeight))
    input.style.height = h + 'px'
  }

  function syncSendButton() {
    sendBtn.disabled = input.value.trim().length === 0
  }

  function submit() {
    const text = input.value.replace(/[ \t\r\n]+$/, '')
    if (!text.trim()) {
      input.value = ''
      autoGrow()
      syncSendButton()
      return
    }
    input.value = ''
    autoGrow()
    syncSendButton()
    pinToBottom()
    Promise.resolve(api.send(text)).catch((err) => {
      console.warn('[xiaoyin] send 失败', err)
    })
    input.focus()
  }

  input.addEventListener('input', () => {
    autoGrow()
    syncSendButton()
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      submit()
    }
  })

  // Esc 只「暂停」当前这一下：停录 / 打断回复，窗口留着不收起（收起请点 ×）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      Promise.resolve(api.cancel()).catch(() => {})
    }
  })

  sendBtn.addEventListener('click', () => {
    submit()
  })

  $('closeBtn').addEventListener('click', () => {
    Promise.resolve(api.hide()).catch(() => {})
  })

  $('backToSession').addEventListener('click', () => {
    Promise.resolve(api.focusSession()).catch(() => {})
  })

  // 点消息区空白处把焦点还给输入框（别抢走文字选中）
  thread.addEventListener('mousedown', (e) => {
    if (e.target.closest('.msg')) return
    if (e.target.closest('button')) return
    window.setTimeout(() => input.focus(), 0)
  })

  /* ---------------- 8. 轻提示 ---------------- */

  let toastTimer = 0

  function showToast(text, kind) {
    if (!text) return
    toastText.textContent = String(text)
    toastEl.classList.toggle('warn', kind === 'warn')
    // 重新触发一次过渡
    toastEl.classList.remove('show')
    void toastEl.offsetWidth
    toastEl.classList.add('show')
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove('show')
    }, 1800)
  }

  /* ---------------- 9. 采音 ---------------- */

  function describeMicError(err) {
    if (!err) return '未知错误'
    const name = err.name || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝'
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有检测到麦克风'
    if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风被其它程序占用'
    if (name === 'OverconstrainedError') return '麦克风不支持所需参数'
    if (name === 'AbortError') return '采音被中断'
    return err.message || String(err)
  }

  /**
   * 主进程放行 / 收回麦克风。
   * 收回时一定要真把 track 停掉，否则任务栏的麦克风图标还会亮着（这正是用户报的现象）。
   */
  function setMicAllowed(on) {
    if (micAllowed === on) return
    micAllowed = on
    if (!on) {
      teardownAudio()
      micError = ''
      renderState()
      return
    }
    if (!audioGraph && !audioStarting) startAudio()
  }

  function teardownAudio() {
    const g = audioGraph
    audioGraph = null
    if (!g) return
    try {
      if (g.node) {
        if (g.node.port) g.node.port.onmessage = null
        g.node.onaudioprocess = null
        g.node.disconnect()
      }
    } catch (e) {
      /* 已断开 */
    }
    try {
      if (g.source) g.source.disconnect()
    } catch (e) {
      /* 已断开 */
    }
    try {
      if (g.mute) g.mute.disconnect()
    } catch (e) {
      /* 已断开 */
    }
    try {
      if (g.stream) g.stream.getTracks().forEach((t) => t.stop())
    } catch (e) {
      /* 已释放 */
    }
    try {
      if (g.ctx && g.ctx.state !== 'closed') g.ctx.close()
    } catch (e) {
      /* 已关闭 */
    }
    try {
      Promise.resolve(api.audio.stop()).catch(() => {})
    } catch (e) {
      /* 主进程没实现也无所谓 */
    }
  }

  async function startAudio() {
    if (micAllowed === false) return
    if (audioGraph || audioStarting) return
    audioStarting = true
    micError = ''

    const g = { ctx: null, stream: null, source: null, node: null, mute: null }
    try {
      // 先让主进程记录「开始采音」；它没实现也不阻塞本地采音
      let info = null
      try {
        info = await api.audio.start()
      } catch (err) {
        console.warn('[xiaoyin] audio.start 调用失败，继续本地采音', err)
      }
      if (info && info.ok === false) {
        throw new Error(info.error || '主进程未允许采音')
      }

      const media = navigator.mediaDevices
      if (!media || typeof media.getUserMedia !== 'function') {
        throw new Error('当前环境不支持 getUserMedia')
      }
      g.stream = await media.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          // 自动增益会把底噪一起放大（实测电平常年 0.99），端点检测会误判成「有人在说」
          autoGainControl: false,
        },
      })
      // 等权限弹窗的这几百毫秒里主进程可能已经改主意（比如用户刚把唤醒词关了）
      if (micAllowed === false) {
        try {
          g.stream.getTracks().forEach((t) => t.stop())
        } catch (e) {
          /* 已释放 */
        }
        try {
          Promise.resolve(api.audio.stop()).catch(() => {})
        } catch (e) {
          /* 忽略 */
        }
        return
      }
      audioGraph = g

      try {
        g.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
      } catch (e) {
        // 部分设备不接受 16 kHz，退回默认采样率，把真实采样率一起报给主进程
        g.ctx = new AudioContext({ latencyHint: 'interactive' })
      }
      if (g.ctx.state === 'suspended') {
        try {
          await g.ctx.resume()
        } catch (e) {
          /* 忽略，后面还有机会恢复 */
        }
      }

      g.source = g.ctx.createMediaStreamSource(g.stream)

      let via = 'worklet'
      try {
        await g.ctx.audioWorklet.addModule('pcm-worklet.js')
        g.node = new AudioWorkletNode(g.ctx, 'pcm-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        })
        g.node.port.onmessage = (ev) => {
          const samples = ev.data
          if (samples instanceof Float32Array && samples.length > 0) {
            api.audio.push(samples, g.ctx.sampleRate)
          }
        }
      } catch (err) {
        // 回退：老式 ScriptProcessorNode（CSP/环境不支持 worklet 时仍能采音）
        console.warn('[xiaoyin] AudioWorklet 不可用，回退 ScriptProcessorNode', err)
        via = 'script-processor'
        g.node = g.ctx.createScriptProcessor(1024, 1, 1)
        g.node.onaudioprocess = (ev) => {
          const src = ev.inputBuffer.getChannelData(0)
          api.audio.push(new Float32Array(src), g.ctx.sampleRate)
        }
      }

      g.mute = g.ctx.createGain()
      g.mute.gain.value = 0
      g.source.connect(g.node)
      g.node.connect(g.mute)
      g.mute.connect(g.ctx.destination)

      const onTrackEnded = () => {
        if (audioGraph !== g) return
        micError = '麦克风已断开'
        teardownAudio()
        renderState()
      }
      g.stream.getAudioTracks().forEach((t) => t.addEventListener('ended', onTrackEnded))

      console.info('[xiaoyin] 采音已启动 · ' + g.ctx.sampleRate + ' Hz · ' + via)
    } catch (err) {
      micError = describeMicError(err)
      console.warn('[xiaoyin] 采音启动失败', err)
      if (g.stream) {
        try {
          g.stream.getTracks().forEach((t) => t.stop())
        } catch (e) {
          /* 已释放 */
        }
      }
      if (g.ctx && g.ctx.state !== 'closed') {
        try {
          g.ctx.close()
        } catch (e) {
          /* 已关闭 */
        }
      }
      if (audioGraph === g) audioGraph = null
      try {
        Promise.resolve(api.audio.stop()).catch(() => {})
      } catch (e) {
        /* 忽略 */
      }
    } finally {
      audioStarting = false
      renderState()
    }
  }

  micRetry.addEventListener('click', (e) => {
    e.stopPropagation()
    if (audioStarting || micAllowed === false) return
    micError = ''
    teardownAudio()
    renderState()
    startAudio()
  })

  /* ---------------- 10. 启动 ---------------- */

  function bindSubscriptions() {
    try {
      api.onState(onState)
      api.onMessages(onMessages)
      api.onToast((payload) => {
        if (!payload) return
        showToast(payload.text, payload.kind)
      })
    } catch (err) {
      console.warn('[xiaoyin] 订阅主进程事件失败', err)
    }
  }

  function buildDivider() {
    // 柔和的手绘感正弦：q 段 + 反射 t 段，宽度铺满 640 的 viewBox
    const path = $('dividerPath')
    if (!path) return
    let d = 'M0 5 q8 -2.4 16 0'
    for (let i = 0; i < 39; i += 1) d += ' t16 0'
    path.setAttribute('d', d)
  }

  async function boot() {
    buildDivider()
    bindSubscriptions()
    autoGrow()
    syncSendButton()
    renderState()
    renderMessages(false)

    // 少数环境里 AudioContext 会因自动播放策略停在 suspended，用户一操作就补一次恢复
    const resumeOnGesture = () => {
      if (audioGraph && audioGraph.ctx && audioGraph.ctx.state === 'suspended') {
        Promise.resolve(audioGraph.ctx.resume()).catch(() => {})
      }
    }
    window.addEventListener('pointerdown', resumeOnGesture, { passive: true })
    window.addEventListener('keydown', resumeOnGesture)

    // 先问一次主进程的麦克风策略：要求释放时，连 getUserMedia 都不发，
    // 任务栏的麦克风图标才不会一直亮着。读不到就按「允许」处理，保持旧行为。
    try {
      const s = await api.audio.state()
      if (s && typeof s.mic === 'boolean') micAllowed = s.mic
    } catch (err) {
      console.warn('[xiaoyin] 读取麦克风状态失败，按允许处理', err)
    }
    if (micAllowed === null) micAllowed = true
    if (micAllowed === false) return

    // 合同要求：页面加载完成后自动申请一次麦克风
    if (document.readyState === 'complete') {
      startAudio()
    } else {
      window.addEventListener('load', () => startAudio(), { once: true })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
