/**
 * 配置：以仓库里原有的 app/config.json 为底层默认（Python 版也在用它），
 * 再加上插件宿主写来的 <data_dir>/runtime.json（用户可在 DSH 插件页改）。
 *
 * 优先级：runtime.json > app/config.json > 内置默认。
 * runtime.json 只由宿主写，浮窗只读；浮窗自己的窗口位置仍单独存 window.json，
 * 两边都不回写 app/config.json，避免和 Python 版打架。
 *
 * 通用性：称呼、唤醒词、热键、静音时长、最长录音、识别语言都由 runtime.json 下发。
 * 唤醒词在浮窗侧按称呼自动派生（称呼 / 嘿+称呼 / 称呼两遍），并用静态拼音表
 * 生成 KWS 要的声调拼音。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { pinyinOf, defaultWakeTexts } = require('./pinyin')

const DESKTOP_DIR = path.join(__dirname, '..')
const REPO_DIR = path.join(DESKTOP_DIR, '..')
const PY_CONFIG = path.join(REPO_DIR, 'app', 'config.json')

/** 兼容旧调用方；新逻辑按称呼动态派生，不再写死「小印」。 */
const DEFAULT_NAME = '小印'

const KWS_MODEL_DIR = path.join(REPO_DIR, 'models', 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01')
const KWS_STEM = 'epoch-12-avg-2-chunk-16-left-64'
const VOICEPRINT_MODEL = path.join(REPO_DIR, 'models', '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx')

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function existing(candidate, fallback) {
  return candidate && fs.existsSync(candidate) ? candidate : fallback
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function splitWakeWords(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(/[,，、;；\n\r]+/).map((item) => text(item)).filter(Boolean)
  }
  return []
}

/**
 * @returns {{
 *   repoDir: string, desktopDir: string, dataDir: string, runtimeFile: string, logFile: string,
 *   queueDir: string, eventsDir: string, audioDir: string, stateFile: string,
 *   leaseFile: string, ownerInstance: string, ownerProduct: string,
 *   name: string, hotkey: string, wake: boolean, releaseMicWhenWakeOff: boolean, wakeWords: Array<{text: string, pinyin: string}>,
 *   maxSeconds: number, silenceSeconds: number, language: string, threads: number,
 *   asr: {model: string, tokens: string}, kws: {encoder: string, decoder: string, joiner: string, tokens: string, keywordsFile: string},
 *   voiceprint: {enabled: boolean, model: string, threshold: number, samples: number, ownerGate: boolean}
 * }}
 */
function loadConfig() {
  const raw = readJson(PY_CONFIG)
  const dataDir =
    process.env.XIAOYIN_DATA_DIR ||
    text(raw.data_dir) ||
    path.join(os.homedir(), '.dsh', 'voice-copilot')
  const runtimeFile = path.join(dataDir, 'runtime.json')
  const runtime = readJson(runtimeFile)

  const name = text(runtime.name, text(raw.assistant_name, DEFAULT_NAME))
  const extraWake = splitWakeWords(runtime.wakeWords)
  const wakeTexts = extraWake.length ? extraWake : defaultWakeTexts(name)
  const wakeWords = wakeTexts.map((value) => ({ text: value, pinyin: pinyinOf(value) }))

  const senseVoiceDir = path.join(process.env.APPDATA || '', 'WeQ', 'models', 'sensevoice')
  const model = existing(raw.model, path.join(senseVoiceDir, 'model.int8.onnx'))
  const tokens = existing(raw.tokens, path.join(senseVoiceDir, 'tokens.txt'))

  return {
    repoDir: REPO_DIR,
    desktopDir: DESKTOP_DIR,
    dataDir,
    runtimeFile,
    logFile: path.join(dataDir, 'window.log'),
    queueDir: path.join(dataDir, 'queue'),
    eventsDir: path.join(dataDir, 'events'),
    audioDir: path.join(dataDir, 'audio'),
    stateFile: path.join(dataDir, 'window.json'),
    // 宿主进程号；0 表示没拿到（老版本 runtime.json），此时不做看门狗。
    hostPid: positive(runtime.hostPid, 0),
    // 宿主租约：同时开官方 dsh 和 DSH NEXT 时谁持有小印（见插件根目录 lease.js）。
    // ownerInstance 由拉起本窗口的宿主通过 XIAOYIN_OWNER_INSTANCE 塞进来。
    leaseFile: path.join(dataDir, 'lease.json'),
    ownerInstance: text(process.env.XIAOYIN_OWNER_INSTANCE),
    ownerProduct: text(process.env.XIAOYIN_OWNER_PRODUCT),
    name,
    hotkey: text(runtime.hotkey, text(raw.hotkey, 'ctrl+alt+j')),
    maxSeconds: positive(runtime.maxSeconds, positive(raw.max_seconds, 20)),
    silenceSeconds: positive(runtime.silenceSeconds, positive(raw.silence_seconds, 1.2)),
    language: text(runtime.language, text(raw.language, 'zh')),
    threads: positive(raw.stt_threads, 4),
    wake: typeof runtime.wake === 'boolean' ? runtime.wake : raw.wake !== false,
    // 关掉唤醒词时要不要连麦克风一起释放（任务栏的麦克风图标会灭）；
    // 默认否：常驻采音是为了热键能预录 600 ms。氛围设置见 runtime.json。
    releaseMicWhenWakeOff: runtime.releaseMicWhenWakeOff === true,
    wakeWords,
    asr: { model, tokens },
    // 声纹（说话人校验）：只判断「这句是不是机主」，见 lib/voiceprint.js。
    // 模型缺失时整体降级成「不校验」，不影响唤醒/识别。
    voiceprint: {
      enabled: runtime.voiceprint !== false && raw.voiceprint !== false,
      model: existing(process.env.XIAOYIN_VOICEPRINT_MODEL, VOICEPRINT_MODEL),
      threshold: clamp(Number(runtime.voiceprintThreshold || raw.voiceprint_threshold || 0.5), 0.3, 0.95),
      samples: 3,
      // 多人环境优化：只有机主的声音刷新收尾计时，旁边人插话不算（见 lib/endpoint.js）。
      // 关掉就完全退回旧行为；没注册声纹时本来也不生效。
      ownerGate: runtime.voiceprintOwnerGate !== false,
    },
    kws: {
      encoder: path.join(KWS_MODEL_DIR, `encoder-${KWS_STEM}.int8.onnx`),
      decoder: path.join(KWS_MODEL_DIR, `decoder-${KWS_STEM}.int8.onnx`),
      joiner: path.join(KWS_MODEL_DIR, `joiner-${KWS_STEM}.int8.onnx`),
      tokens: path.join(KWS_MODEL_DIR, 'tokens.txt'),
      keywordsFile: path.join(dataDir, 'keywords.txt'),
    },
  }
}

/** 把唤醒词写成 sherpa 认的 keywords.txt（一行一个：`pinyin @文字`）。 */
function writeKeywordsFile(config) {
  const words = Array.isArray(config.wakeWords) ? config.wakeWords : []
  const body = words.map((word) => `${word.pinyin} @${word.text}`).join('\n') + '\n'
  fs.mkdirSync(path.dirname(config.kws.keywordsFile), { recursive: true })
  fs.writeFileSync(config.kws.keywordsFile, body, 'utf8')
}

/** 窗口位置/尺寸，独立于 config.json。 */
function loadWindowState(config) {
  const state = readJson(config.stateFile)
  const pos = Array.isArray(state.pos) && state.pos.length === 2 ? state.pos.map(Number) : null
  const size = Array.isArray(state.size) && state.size.length === 2 ? state.size.map(Number) : null
  return { pos: pos && pos.every(Number.isFinite) ? pos : null, size: size && size.every(Number.isFinite) ? size : null }
}

/**
 * 窗口位置/尺寸。patch 里给什么就写什么，没给的沿用文件里原来的值——
 * 拖动位置和拖动尺寸是两个回调，不能互相把对方抹掉。
 */
function saveWindowState(config, patch) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    const previous = readJson(config.stateFile)
    const pick = (value, fallback) => {
      if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return value
      return fallback
    }
    const payload = {
      pos: pick(patch && patch.pos, pick(previous.pos, null)),
      size: pick(patch && patch.size, pick(previous.size, null)),
      savedAt: new Date().toISOString(),
    }
    fs.writeFileSync(config.stateFile, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch {
    /* 记不住位置/尺寸不算故障 */
  }
}

module.exports = {
  loadConfig,
  writeKeywordsFile,
  loadWindowState,
  saveWindowState,
  DEFAULT_NAME,
}
