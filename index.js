/**
 * Voice copilot — Host half.
 *
 * 这半边只做三件事，全部围绕一个文件队列，不监听端口、不碰鉴权：
 *   1. 看 `queue/` 里新来的任务（语音或文字），把语音交给 Host 自带的 speechToText 转写；
 *   2. 把文字作为一次 prompt 送进一个固定会话（第一次用的时候自动建「语音浮窗」）；
 *   3. 跟着这个会话的助手消息，把每轮最后的整段回复写成 `events/` 里的小文件，给浮窗读。
 *
 * 任务文件：queue/<id>.json
 *   { "kind": "voice", "id": "…", "wav": "C:/…/x.wav", "language": "zh" }
 *   { "kind": "text",  "id": "…", "text": "…" }
 *   { "kind": "cancel" }
 *   { "kind": "open", "sessionId": "…" }   ← 可选；不给就用插件自己记住的那个会话
 *   { "kind": "ping" }
 *
 * 事件文件：events/<单调递增时间戳>-<随机>.json
 *   { "type": "ready" | "pong" | "transcript" | "prompt" | "reply-start"
 *           | "assistant-message" | "done" | "turn-end" | "error", … }
 * 浮窗不做流式：不再逐 token 发 "delta"，助手的话整段跟着 assistant/message 走。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import z from '@deepseek-ai/schemastery'

import { startFloatingWindow, stopFloatingWindow } from './autostart.js'
import { createLedgerApi } from './ledger-groups.js'
import { createLearning } from './learning.js'
import { createPinyinTool } from './pinyin-match.js'

// 只把会话控制器当硬依赖；语音服务按需取，拿不到就退回「文字先通」，
// 免得语音行没挂上时整个插件卡在 pending。
export const inject = ['sessionController']

/**
 * 插件配置。所有用户可改的字段都标了 `.volatile()`：
 *   - DSH 设置表单只暴露 volatile 字段；
 *   - 改动不需要重启插件，宿主下一拍就能读到新值并同步给浮窗。
 * dataDir / autoStart 是安装级设置，改了要重启，故意不 volatile。
 *
 * 这是「一套配置」的唯一来源：浮窗不再读 app/config.json 里的 hotkey/wake_words
 * 之类的用户设置（那份只保留模型路径等本机启动参数）。
 */
export const Config = z.object({
  dataDir: z.string().default('').description('队列与日志目录，默认 ~/.dsh/voice-copilot'),
  autoStart: z.boolean().default(true).description('DSH 启动时自动拉起语音浮窗'),
  appDir: z.string().default('').description('高级：浮窗程序目录（默认用插件自带的 desktop/）'),
  pythonw: z.string().default('').description('高级：Python 回退版解释器路径'),
  name: z.string().default('小印').description('助手称呼，也是默认唤醒词').volatile(),
  wakeWords: z.string().default('').description('额外唤醒词，用逗号或换行分隔；留空则用称呼自动生成').volatile(),
  prompt: z.string().default('').description('语音助手的补充提示词 / 人设，可用 {{name}} 代入称呼').volatile(),
  agentPreset: z.string().default('standard').description('语音会话使用的 agent preset').volatile(),
  cwd: z.string().default('').description('语音会话所在工作区目录，默认用户主目录').volatile(),
  hotkey: z.string().default('ctrl+alt+j').description('叫出浮窗的全局热键').volatile(),
  wake: z.boolean().default(true).description('是否监听唤醒词').volatile(),
  releaseMicWhenWakeOff: z
    .boolean()
    .default(false)
    .description('关掉唤醒词时连麦克风一起释放（任务栏麦克风图标会灭）；按热键时才临时开麦，开头一两个字可能缺一点')
    .volatile(),
  silenceSeconds: z.number().min(0.3).max(10).default(1.2).description('说完后静音多久自动结束').volatile(),
  maxSeconds: z.number().min(3).max(120).default(20).description('一次录音最长秒数').volatile(),
  language: z.string().default('zh').description('SenseVoice 识别语言').volatile(),
  learning: z.boolean().default(true).description('记录每轮思考、工具调用与回复，供离线复盘').volatile(),
  learningDir: z.string().default('').description('学习记录目录，默认 <dataDir>/learning；可指向本仓库 learning/').volatile(),
  learningMaxChars: z.number().min(200).max(50000).default(4000).description('单段思考最多保留的字符数').volatile(),
  learningToolArgsChars: z.number().min(100).max(20000).default(2000).description('单条工具参数最多保留的字符数').volatile(),
  learningToolResultChars: z.number().min(100).max(20000).default(1500).description('单条工具结果最多保留的字符数').volatile(),
  learningRedact: z.boolean().default(true).description('落盘前打码手机号、身份证号与 wxid').volatile(),
  ledgerDb: z.string().default('').description('微信文件台账 ledger.db 的绝对路径；「小印」管理页的群白名单从这里读写').volatile(),
  printerLogDir: z.string().default('').description('打印机日志目录（订单来源分析用）；留空则用 %APPDATA%\\HN打印工具\\logs').volatile(),
})

const POLL_MS = 120
const SESSION_TITLE = '语音浮窗'
// 「回到会话」要跳到的会话：壳会把 dsh-app://app/ 下任何非静态路径原样转给宿主 web 服务，
// 所以页面半侧（client.js）用同源 fetch 就能取走这条待办，再调 uiWorkspace.openSession 切过去。
const OPEN_ROUTE = '/__dsh-voice-copilot/open-session'
const PERSONA_ROUTE = '/__dsh-voice-copilot/preset-persona'
// 「小印」侧栏页的群白名单：一次读全表，按 username 切换 excluded。
const LEDGER_ROUTE = '/__dsh-voice-copilot/ledger/chats'
const LEDGER_EXCLUDE_ROUTE = '/__dsh-voice-copilot/ledger/exclude'
// 「一键策略」：按订单来源自动圈定白名单（预览 / 应用 / 撤销）。
const LEDGER_POLICY_ROUTE = '/__dsh-voice-copilot/ledger/policy'
const LEDGER_POLICY_APPLY_ROUTE = '/__dsh-voice-copilot/ledger/policy/apply'
const LEDGER_POLICY_UNDO_ROUTE = '/__dsh-voice-copilot/ledger/policy/undo'
// 超过这个时间没人来取就作废：浮窗早就收起了，用户也不会希望下次打开 DSH 时突然被切会话。
const OPEN_TTL_MS = 30_000
// 不指定 cwd 时会话会落在 Host 进程的工作目录（profile 目录），DSH 侧栏里看不见。
// 用自己的工作目录：插件 config 里的 cwd 优先，其次环境变量 DSH_VOICE_COPILOT_CWD，最后退回主目录。
const DEFAULT_CWD = process.env.DSH_VOICE_COPILOT_CWD || os.homedir()
const WORKSPACE_TITLE = '语音浮窗'
const DEFAULT_NAME = '小印'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function moveInto(doneDir, file) {
  try {
    fs.renameSync(file, path.join(doneDir, `${Date.now()}-${path.basename(file)}`))
  } catch {
    try { fs.unlinkSync(file) } catch { /* already gone */ }
  }
}

export function apply(ctx, config = {}) {
  const dataDir = (typeof config.dataDir === 'string' && config.dataDir.trim())
    || path.join(os.homedir(), '.dsh', 'voice-copilot')
  const queueDir = ensureDir(path.join(dataDir, 'queue'))
  const eventsDir = ensureDir(path.join(dataDir, 'events'))
  const doneDir = ensureDir(path.join(dataDir, 'done'))
  const runtimePath = path.join(dataDir, 'runtime.json')
  const logPath = path.join(dataDir, 'plugin.log')
  const statePath = path.join(dataDir, 'state.json')

  const log = (line) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch { /* logging must never break the bridge */ }
  }

  const emit = (payload) => {
    try {
      const name = `${String(Date.now()).padStart(14, '0')}-${crypto.randomBytes(4).toString('hex')}.json`
      const target = path.join(eventsDir, name)
      const tmp = `${target}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, target)
    } catch (error) {
      log(`emit failed: ${error}`)
    }
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { return {} }
  }
  const writeState = (next) => {
    try { fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8') } catch (error) { log(`state write failed: ${error}`) }
  }

  // Schemastery 的 volatile 字段是「可读写引用」：config.name.get() 才能拿到最新值；
  // 非 volatile 字段是普通值。两种都收在这里，免得每个调用点各写一遍。
  const liveRaw = (field, fallback) => {
    const raw = config[field]
    const value = raw && typeof raw.get === 'function' ? raw.get() : raw
    return value === undefined || value === null ? fallback : value
  }
  const liveText = (field, fallback = '') => {
    const value = liveRaw(field, fallback)
    return typeof value === 'string' ? value.trim() : String(value ?? fallback)
  }
  const liveNumber = (field, fallback) => {
    const value = Number(liveRaw(field, fallback))
    return Number.isFinite(value) ? value : fallback
  }
  const liveBool = (field, fallback) => {
    const value = liveRaw(field, fallback)
    return typeof value === 'boolean' ? value : fallback
  }
  const currentName = () => liveText('name', '') || DEFAULT_NAME
  const currentCwd = () => liveText('cwd', '') || DEFAULT_CWD
  const currentPreset = () => liveText('agentPreset', '')
  const currentLedgerDb = () => liveText('ledgerDb', '') || process.env.DSH_VOICE_COPILOT_LEDGER_DB || ''
  const currentPrinterLogDir = () => liveText('printerLogDir', '') || process.env.DSH_VOICE_COPILOT_PRINTER_LOG_DIR || ''

  // 学习记录：默认开，落 dataDir/learning；本机把它指到仓库 learning/，这样在这个工作目录里
  // 直接读原始记录就能复盘。isHuman/isNoise 延迟引用（它们定义在后面），只在真正收到事件时才调用。
  const learningEnabled = () => liveBool('learning', true)
  const learningDir = () => {
    const custom = liveText('learningDir', '')
    return custom ? path.resolve(custom) : path.join(dataDir, 'learning')
  }
  const learning = createLearning({
    dir: learningDir(),
    log,
    limits: () => ({
      thinking: liveNumber('learningMaxChars', 4000),
      args: liveNumber('learningToolArgsChars', 2000),
      result: liveNumber('learningToolResultChars', 1500),
    }),
    redact: () => liveBool('learningRedact', true),
    isHuman: (event) => { try { return isHuman(event) } catch { return false } },
    isNoise: (text) => { try { return isNoise(text) } catch { return false } },
    cwd: currentCwd,
    preset: currentPreset,
  })

  // 浮窗进程看不到 Cordis 配置，靠这个快照同步「称呼 / 唤醒词 / 热键 / 端点参数」。
  // 放在 dataDir 而不是 profile，是因为浮窗只需要读一个文件，也方便用户手改排查。
  const runtimeSnapshot = () => ({
    // 宿主进程号：浮窗拿它判断「DSH 还在不在」，宿主一没就自己退出。
    // 每次 DSH 重启 pid 都会变，所以跟着 runtime.json 一起刷新。
    hostPid: process.pid,
    name: currentName(),
    wakeWords: liveText('wakeWords', '')
      .split(/[,，;；\n]+/)
      .map((word) => word.trim())
      .filter(Boolean),
    hotkey: liveText('hotkey', '') || 'ctrl+alt+j',
    wake: liveBool('wake', true),
    // 浮窗据此决定「关掉唤醒词后要不要放开麦克风」；默认 false = 保持常驻采音
    releaseMicWhenWakeOff: liveBool('releaseMicWhenWakeOff', false),
    silenceSeconds: liveNumber('silenceSeconds', 1.2),
    maxSeconds: liveNumber('maxSeconds', 20),
    language: liveText('language', '') || 'zh',
  })
  let runtimeJson = ''
  const syncRuntime = (force = false) => {
    try {
      const snapshot = runtimeSnapshot()
      const json = JSON.stringify(snapshot, null, 2)
      if (!force && json === runtimeJson) return
      const tmp = `${runtimePath}.tmp`
      fs.writeFileSync(tmp, json, 'utf8')
      fs.renameSync(tmp, runtimePath)
      runtimeJson = json
      log(`runtime.json synced name=${snapshot.name} wakeWords=${snapshot.wakeWords.length}`)
    } catch (error) {
      log(`runtime sync failed: ${error && error.stack ? error.stack : error}`)
    }
  }

  let followAbort = null
  let following = ''
  let processing = false
  // 浮窗递来的「切到会话」条子，等页面半侧来取；取走即清空、过期即作废。
  let pendingOpen = null
  // 最近一次铺出来的对话，浮窗晚启动时用它补齐
  let historyTurns = []

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // DSH 侧栏是按「工作区」列会话的：只给 cwd 不给 workspaceId，会话虽然写盘了，侧栏里找不到。
  // 所以先把 cwd 登记成一个工作区，再让会话创建在里面。
  // 用户改了 cwd 之后要重新登记，所以缓存里带上 cwd。
  let ensuredWorkspace = { cwd: '', id: '' }
  const ensureWorkspace = async (cwd) => {
    if (ensuredWorkspace.id && ensuredWorkspace.cwd === cwd) return ensuredWorkspace.id
    const registry = ctx.get('workspaceRegistry')
    if (!registry) {
      log('workspaceRegistry 不在组合里，会话只能按 cwd 落盘，侧栏可能看不到')
      return ''
    }
    const found = await registry.resolveByPath(cwd)
    if (found) {
      ensuredWorkspace = { cwd, id: found.id }
      return found.id
    }
    const workspace = await registry.create(cwd, WORKSPACE_TITLE)
    ensuredWorkspace = { cwd, id: workspace.id }
    log(`created workspace ${workspace.id} at ${cwd}`)
    return workspace.id
  }

  // 老会话如果还没登记进工作区，就把它插进去，别让历史对话丢在侧栏外面。
  const adoptIntoWorkspace = async (workspaceId, sessionId) => {
    const registry = ctx.get('workspaceRegistry')
    const controller = ctx.get('workspaceController')
    const workspace = registry ? registry.get(workspaceId) : undefined
    if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return true
    // 首选工作区对象自己的 attachSession：宿主 sessionController.create 内部就是这么挂的，
    // 认的「accounting」比 insertSessionBefore 宽，刚建好的会话用它最稳。
    if (workspace && typeof workspace.attachSession === 'function') {
      try {
        await workspace.attachSession(sessionId)
        return true
      } catch (error) {
        log(`attachSession failed: ${error}`)
      }
    }
    if (!controller) return false
    try {
      await controller.insertSessionBefore({ workspaceId, sessionId })
      return true
    } catch (error) {
      log(`adopt session failed: ${error}`)
      return false
    }
  }

  /**
   * 「提示词 / 人设」用会话级 developer/message 注入，而不是克隆一个 agent preset：
   *   - 只影响这个语音会话，用户在主界面开的会话不受影响；
   *   - append-only，不替换系统提示，KV 前缀不会整段作废；
   *   - 配置改动时补一条新的，旧的自然被后面的覆盖。
   */
  /**
   * 从 preset 的 YAML 里抠出 persona.prefix。
   * 只做「prefix: | 的缩进块」这一种写法，够本机用；抠不到就返回空串，不猜。
   */
  const personaFromYaml = (yaml) => {
    const lines = String(yaml || '').split(/\r?\n/)
    const start = lines.findIndex((line) => /^\s*prefix:\s*\|/.test(line))
    if (start < 0) return ''
    const base = (lines[start].match(/^\s*/) || [''])[0].length
    const body = []
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      const indent = (line.match(/^\s*/) || [''])[0].length
      if (line.trim() && indent <= base) break
      body.push(line.slice(Math.min(line.length, base + 2)))
    }
    return body.join('\n').trim()
  }

  const personaText = () => {
    const name = currentName()
    const extra = liveText('prompt', '').replaceAll('{{name}}', name)
    const lines = [
      '【语音助手设定】',
      `你的称呼是「${name}」。用户通过语音浮窗和你对话，回答尽量简短、口语化，适合直接朗读。`,
      '',
      '【怎么说话】',
      '- 默认一两句、最多三行，先说结论。不列点、不加粗、不写标题，也不要念出 Markdown 符号。',
      '- 只给用户问的那件事：谁、什么时候、什么东西、现在什么状态、在哪（标签页/单号）、钱。不解释你是怎么查到的，不报工具名，不复述用户的话。',
      '- 一次最多问一个问题、最多给两个选项。候选接近时问「是不是某某」，不要整份名单摆出来让他挑。',
      '- 例（用户问「刚刚张玮发的什么」，只回这一句）：张伟在半小时前给你发了「计算机程序设计第二次作业.doc」，已经打好了，本地打印工具在 3 号标签页，订单号 L0056，钱已经收了。不要拆成三段，也不要再问「你要我看哪一个」。',
    ]
    if (extra) lines.push('', extra)
    if (learningEnabled()) {
      lines.push(
        '',
        '【复盘记录】这轮对话的思考、工具调用与回复会以脱敏形式记到本机 learning/ 目录，供之后离线分析。',
        '遇到同一工具反复失败、用户纠正你、或流程明显卡住时，用 voice_note 记一条（kind、title、detail），记完继续做事，别停下来解释。',
      )
    }
    lines.push(
      '',
      '【听错的名字】语音转写经常出现同音错字，人名尤其容易（例如「张伟」被写成「张玮」）。',
      '按字面查不到人时别急着说没有：先取一份候选名单（联系人、群成员、最近聊天里的人），连同听到的名字交给 voice_pinyin（action=match）按拼音做模糊比对；也可以直接传首字母缩写（如 ZW）。',
      '匹配分接近或候选不止一个时，挑最像的一个（最多两个）去问用户「是不是他」，不要把整份名单摆出来让他挑；确认过的名字再用工具去查。',
      '',
      '【换话题】用户说「开个新话题」「重开一段」「换个话题」时，调用 voice_new_session（可带一个简短的 title），然后只回一句「好，下一句进新的一段」。别自己猜会话 id，也别长篇解释旧会话怎么了。',
    )
    return lines.join('\n')
  }

  // 人设不进会话日志（developer/message 要求挂在已打开的 turn/step 上，会话级写入会被格式校验拒绝），
  // 而是注册成该 Agent 自己的系统提示段：作用域限定在这个会话，不污染日志、也不影响别的会话。
  const PERSONA_SECTION = 'voice-copilot:persona'
  const personaApplied = new WeakSet()
  // 当前语音会话的 id：session/event 里用它筛事件（学习关掉时也能判断小印在不在跑）。
  let voiceSessionId = ''
  // 「开个新话题」的下一句才真正切会话：这一轮留在旧会话里收尾。
  let pendingFresh = null

  const applyPersona = (agent) => {
    try {
      if (!agent || personaApplied.has(agent)) return
      const sessionId = agent.session && agent.session.id ? agent.session.id : agent.id
      const state = readState()
      if (!sessionId || !state.sessionId || sessionId !== state.sessionId) return
      personaApplied.add(agent)
      voiceSessionId = sessionId
      if (learningEnabled()) learning.track(sessionId)
      const text = personaText().trim()
      if (!text) return
      const prompt = agent.ctx && agent.ctx.systemPrompt
      if (!prompt || typeof prompt.section !== 'function') {
        log('systemPrompt 服务不可用，跳过人设注册')
        return
      }
      prompt.section({ name: PERSONA_SECTION, order: 1, text })
      log(`persona 已注册为系统提示段 session=${sessionId}`)
    } catch (error) {
      log(`persona 注册失败：${error && error.stack ? error.stack : error}`)
    }
  }

  const ensurePersona = async (sessionId) => {
    voiceSessionId = sessionId || voiceSessionId
    if (learningEnabled()) learning.track(sessionId)
    return sessionId
  }

  /**
   * 开一段新的：当前会话改成带时间的标题（侧边栏还能翻回去），新建一个接上。
   * archiveOld=false 用于「旧会话已经取不到」的情形，不去改一个不存在的会话。
   */
  const startNewSession = async (options = {}) => {
    const archiveOld = options.archiveOld !== false
    const wantedTitle = String(options.title || '').trim()
    const cwd = currentCwd()
    const preset = currentPreset()
    const state = readState()
    let workspaceId = ''
    try {
      workspaceId = await ensureWorkspace(cwd)
    } catch (error) {
      log(`ensureWorkspace failed: ${error}`)
    }
    if (archiveOld && state.sessionId) {
      const stamp = new Date().toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      })
      const archived = wantedTitle || `语音浮窗 · 截至 ${stamp}`
      try {
        await ctx.sessionController.rename({ sessionId: state.sessionId, title: archived })
      } catch (error) {
        log(`rename previous session failed: ${error}`)
      }
    }
    const where = workspaceId ? { workspaceId } : { cwd }
    let created
    try {
      created = await ctx.sessionController.create(preset ? { ...where, agentPreset: preset } : where)
    } catch (error) {
      log(`create with preset ${preset} failed: ${error}`)
      created = await ctx.sessionController.create(where)
    }
    const sessionId = created.sessionId
    writeState({ sessionId, title: SESSION_TITLE, cwd, workspaceId, createdAt: Date.now() })
    try {
      await ctx.sessionController.rename({ sessionId, title: SESSION_TITLE })
    } catch (error) {
      log(`rename failed: ${error}`)
    }
    log(`created session ${sessionId} in ${cwd}${archiveOld ? '（换了新的一段）' : ''}`)
    // create({workspaceId}) 正常会把会话挂进工作区，但实测有漏（2026-11-08：
    // session-6d19f96e 就是这么掉进侧栏「未分组」的），这里再核一次、没挂上就补插。
    if (workspaceId) {
      const attached = await adoptIntoWorkspace(workspaceId, sessionId)
      log(`workspace attach ${attached ? 'ok' : 'failed'} session=${sessionId} workspace=${workspaceId}`)
    }
    return await ensurePersona(sessionId)
  }

  const resolveSessionId = async () => {
    // 用户刚说过「开个新话题」：这一轮还在旧会话里收尾，下一句才切过去。
    if (pendingFresh) {
      const options = pendingFresh
      pendingFresh = null
      return await startNewSession(options)
    }
    const cwd = currentCwd()
    const state = readState()
    let workspaceId = ''
    try {
      workspaceId = await ensureWorkspace(cwd)
    } catch (error) {
      log(`ensureWorkspace failed: ${error}`)
    }
    if (state.sessionId && (state.cwd || '') === cwd) {
      try {
        const resolved = await ctx.sessionController.resolveAgent(state.sessionId)
        if (resolved && resolved.agent) {
          // 别信 state.workspaceId：它只说明「建会话时打算进哪个工作区」，不代表真进去了。
          // 宿主 create({workspaceId}) 会 attach，但实测有漏；而原来的早退
          // （state.workspaceId === workspaceId 就直接 return）让兜底 adopt 永远跑不到，
          // 于是漏挂的会话在侧栏「未分组」里一躺就是好几天。改为每次都按
          // workspace.sessionIds 实地核对，不在就补插（adoptIntoWorkspace 本身幂等）。
          if (workspaceId) {
            const registry = ctx.get('workspaceRegistry')
            const workspace = registry ? registry.get(workspaceId) : undefined
            const inWorkspace = Boolean(
              workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(state.sessionId),
            )
            if (!inWorkspace) {
              if (await adoptIntoWorkspace(workspaceId, state.sessionId)) {
                writeState({ ...state, workspaceId })
                log(`adopted session ${state.sessionId} into workspace ${workspaceId}`)
              }
            } else if (state.workspaceId !== workspaceId) {
              writeState({ ...state, workspaceId })
            }
          }
          return await ensurePersona(state.sessionId)
        }
      } catch (error) {
        log(`resolveAgent failed: ${error}`)
      }
    }
    // 旧会话取不到了（删了/归档了），直接开新的；这里不去改一个不存在的会话。
    return await startNewSession({ archiveOld: false })
  }

  const textOf = (content) => {
    if (!Array.isArray(content)) return ''
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim()
  }

  // 会话里还有 DSH 自己注入的「运行时上下文 / 时间上下文 / 记忆快照」，它们也是
  // user/message，但不是人说的话。先按 source.kind 挡，再按正文特征兜底——
  // 宿主偶尔不给 kind，只靠 kind 会漏到浮窗里变成一大段提示词。
  const CONTEXT_MARKERS = [
    'Current runtime context',
    'This snapshot supersedes earlier runtime-context snapshots',
    'Current working directory:',
    'Current DSH file policy:',
    'Approval prompts are disabled in this session',
    'Current DeepSeek Harness implementation checkout',
    'Current DeepSeek Harness Web GUI URL',
    'You are the Team Lead',
    'Time sampled while preparing turn',
    'Browser time zone for this request',
    'Elapsed since the preceding model-visible message',
    '<runtime-memory-file',
    'MNEMON RUNTIME MEMORY SNAPSHOT',
    '[MNEMON]',
    '<environment_context',
    '<user_instructions',
    '<system-reminder>',
  ]
  const isNoise = (text) => CONTEXT_MARKERS.some((marker) => text.includes(marker))
  const isHuman = (event) => {
    const kind = event && event.data && event.data.source && event.data.source.kind
    return !kind || kind === 'user'
  }

  const handleFrame = (frame) => {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'snapshot') {
      // 连上时先把这个会话最近的对话铺出来：浮窗只是 DSH 会话的一扇窗。
      const turns = []
      const sources = new Set()
      for (const record of frame.records || []) {
        const event = record && record.event
        if (!event) continue
        if (event.type === 'user/message') {
          const kind = event.data && event.data.source && event.data.source.kind
          sources.add(String(kind))
          if (!isHuman(event)) continue   // 运行时上下文、团队消息之类不是人说的话
          const text = textOf(event.data && event.data.content)
          if (text && !isNoise(text)) turns.push({ role: 'user', text })
        } else if (event.type === 'assistant/message') {
          const text = textOf(event.data && event.data.message && event.data.message.content)
          if (text) turns.push({ role: 'assistant', text })
        }
      }
      emit({ type: 'history', turns, cursor: frame.cursor })
      historyTurns = turns.slice()
      log(`snapshot records=${(frame.records || []).length} turns=${turns.length} sources=${[...sources].join(',')}`)
      return
    }
    if (frame.type === 'assistant-stream') {
      const stream = frame.frame
      if (!stream) return
      if (stream.type === 'start') {
        emit({ type: 'reply-start', attemptId: stream.attemptId, turn: stream.turn, step: stream.step })
      } else if (stream.type === 'end') {
        const outcome = stream.outcome || {}
        emit({ type: 'done', attemptId: stream.attemptId, outcome: outcome.kind || 'unknown' })
      }
      return
    }
    if (frame.type === 'event') {
      const event = frame.event || {}
      // 别人（DSH 界面里）发的话也要显示出来，这样两边看到的是同一段对话。
      if (event.type === 'user/message') {
        if (!isHuman(event)) return
        const text = textOf(event.data && event.data.content)
        if (text && !isNoise(text)) {
          historyTurns.push({ role: 'user', text })
          emit({ type: 'user-message', text, seq: event.seq })
        }
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data && event.data.message && event.data.message.content)
        if (text) {
          const last = historyTurns[historyTurns.length - 1]
          if (last && last.role === 'assistant') last.text = text
          else historyTurns.push({ role: 'assistant', text })
          emit({ type: 'assistant-message', text, seq: event.seq })
        }
        return
      }
      if (event.type === 'turn/end') {
        emit({ type: 'turn-end', reason: event.data && event.data.reason ? event.data.reason : null })
      }
      return
    }
  }

  const followSession = async (sessionId) => {
    if (following === sessionId) return
    following = sessionId
    if (followAbort) followAbort.abort()
    followAbort = new AbortController()
    const signal = followAbort.signal
    while (!signal.aborted) {
      try {
        const stream = ctx.sessionController.follow({
          address: { kind: 'session', sessionId },
          assistantStream: true,
          maxMessages: 60,
        }, signal)
        for await (const frame of stream) handleFrame(frame)
      } catch (error) {
        if (signal.aborted) return
        log(`follow failed: ${error}`)
        emit({ type: 'error', stage: 'follow', message: String(error) })
      }
      if (signal.aborted) return
      await sleep(1500)
    }
  }

  const speech = () => ctx.get('speechToText')

  const describeSpeech = () => {
    const service = speech()
    if (!service) return { available: false, providers: [] }
    try {
      return { available: true, providers: service.listProviders().map((info) => info.id) }
    } catch (error) {
      return { available: true, providers: [], error: String(error) }
    }
  }

  const transcribe = async (wavPath, language) => {
    const service = speech()
    if (!service) {
      throw new Error('DSH 的语音服务没挂上（speechToText 不在组合里），这一条没转成文字。')
    }
    const bytes = fs.readFileSync(wavPath)
    const audio = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const spec = service.resolve({ audio, language })
    const transcript = await service.transcribe(spec, new AbortController().signal)
    return transcript && typeof transcript.text === 'string' ? transcript.text.trim() : ''
  }

  const submit = async (text) => {
    if (!text) {
      emit({ type: 'error', stage: 'input', message: '没听清，再说一次？' })
      return
    }
    const sessionId = await resolveSessionId()
    emit({ type: 'transcript', text })
    const requestId = `voice-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const result = await ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: timeZone,
    }, new AbortController().signal)
    emit({ type: 'prompt', requestId, accepted: Boolean(result && result.accepted), text })
    void followSession(sessionId)
  }

  const handleItem = async (file) => {
    const item = JSON.parse(fs.readFileSync(file, 'utf8'))
    const id = item.id || path.basename(file, '.json')
    if (item.kind === 'open' || (item.kind === 'ping' && item.open === true)) {
      // 浮窗点了「回到会话」：宿主叫不动页面里的 uiWorkspace，只能把会话挂到回环路由上，
      // 等页面半侧（client.js）下一次轮询取走再真的切过去。
      const age = item.at ? Date.now() / 1000 - Number(item.at) : 0
      if (age > 60) {
        // DSH 关着的时候按下的按钮：等下次启动再切会话只会莫名其妙，直接作废。
        log(`open 过期（${Math.round(age)}s），丢掉`)
        moveInto(doneDir, file)
        return
      }
      const sessionId = item.sessionId || readState().sessionId || (await resolveSessionId())
      pendingOpen = sessionId ? { sessionId, at: Date.now() } : null
      log(`open 请求：${sessionId || '(没有会话)'}`)
      moveInto(doneDir, file)
      return
    }
    if (item.kind === 'ping') {
      emit({ type: 'pong', id, sessionId: readState().sessionId || null })
      if (item.history === true && historyTurns.length > 0) {
        emit({ type: 'history', turns: historyTurns.slice(), cursor: null })
      }
      moveInto(doneDir, file)
      return
    }
    if (item.kind === 'cancel') {
      const state = readState()
      if (state.sessionId) {
        try {
          ctx.sessionController.cancel({ sessionId: state.sessionId })
          emit({ type: 'cancelled', id })
        } catch (error) {
          emit({ type: 'error', stage: 'cancel', message: String(error) })
        }
      }
      moveInto(doneDir, file)
      return
    }
    try {
      let text = typeof item.text === 'string' ? item.text.trim() : ''
      if (!text && item.wav) {
        emit({ type: 'listening-done', id })
        text = await transcribe(item.wav, item.language || 'zh')
      }
      await submit(text)
    } catch (error) {
      log(`handleItem failed: ${error && error.stack ? error.stack : error}`)
      emit({ type: 'error', stage: 'item', message: String(error && error.message ? error.message : error) })
    }
    moveInto(doneDir, file)
  }

  const tick = async () => {
    if (processing) return
    processing = true
    try {
      syncRuntime()
      const names = fs.readdirSync(queueDir).filter((name) => name.endsWith('.json')).sort()
      for (const name of names) await handleItem(path.join(queueDir, name))
    } catch (error) {
      log(`tick failed: ${error && error.stack ? error.stack : error}`)
    } finally {
      processing = false
    }
  }

  const timer = setInterval(() => { void tick() }, POLL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    if (followAbort) followAbort.abort()
    try { learning.flush('plugin-dispose') } catch (error) { log(`learning flush failed: ${error}`) }
    // 小印跟着 DSH 走：宿主退出/插件卸载时把浮窗一起结束掉。
    // 不额外写 host-closed 事件：那类事件会被下一个宿主拉起的浮窗读到，反而把自己立刻关掉；
    // taskkill 是同步的，杀不掉还有浮窗自己的 hostPid 看门狗兜底。
    try {
      const stopped = stopFloatingWindow({ dataDir })
      if (stopped.stopped) log(`floating window stopped pid=${stopped.pid}`)
      else if (stopped.reason !== 'not-running') log(`floating window stop failed: ${JSON.stringify(stopped)}`)
    } catch (error) {
      log(`floating window stop failed: ${error && error.stack ? error.stack : error}`)
    }
  })

  // Agent 创建（含重启后激活已有会话）时把这一段人设挂到它自己的系统提示里；
  // 只在是我们那个语音会话时才挂，别的会话不受影响。
  ctx.on('agent/created', (payload) => {
    applyPersona(payload && payload.agent)
  }, { global: true })

  // 学习记录订阅：session 事件从会话自己的上下文发出来，普通 ctx.on 收不到别的会话，
  // 必须带 global；这里只处理 resolveSessionId 登记过的那个会话，别的会话 observe 会直接返回。
  // 语音会话当前跑到第几轮：0 = 没在跑。工具可见性用它判断，独立于学习开关。
  let voiceTurn = 0
  ctx.on('session/event', (session, event) => {
    if (session && voiceSessionId && session.id === voiceSessionId) {
      if (event.type === 'turn/start') voiceTurn = Number(event.data && event.data.turn) || 1
      else if (event.type === 'turn/end') voiceTurn = 0
    }
    if (!learningEnabled()) return
    try {
      learning.observe(session, event)
    } catch (error) {
      log(`learning observe failed: ${error && error.stack ? error.stack : error}`)
    }
  }, { global: true })

  // 让小印自己记问题：普通对象定义即可，宿主只校验 output.schema。
  // when 每步求值：只有小印正在跑某一轮（activeTurn 非空）时这些工具才进模型视野，别的会话看不到。
  /**
   * 「开一段新的」工具：只登记意图，真正切会话发生在下一句（resolveSessionId）。
   * 这样当前这一轮仍在旧会话里正常收尾，不会被半路换 Agent。
   */
  const newSessionTool = () => ({
    name: 'voice_new_session',
    description:
      '开一段新的对话：当前这段会在下一句之前收尾（旧会话改名后仍留在侧边栏，可翻回去），接下来的话进新会话。用户说「开个新话题」「重开一段」「换个话题」时调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '可选：给刚结束的这一段起个名字（不给就按时间命名）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          queued: { type: 'boolean' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.ok ? '好，下一句进新的一段。' : `没换成：${value.error || '未知原因'}`,
      }],
    },
    async execute(args) {
      try {
        const title = args && typeof args.title === 'string' ? args.title.trim() : ''
        pendingFresh = { archiveOld: true, title }
        log(`pending new session (title=${title || '(按时间)'})`)
        return { ok: true, queued: true }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(learning.noteTool(), {
      when: () => learningEnabled() && Boolean(learning.activeTurn()),
    }), 'dsh-voice-copilot: voice_note')
    // 语音转写容易把名字听成同音字，给它一个按拼音比对候选的工具。
    // 独立于学习开关：只要小印这轮在跑就可见（voiceTurn 由 session/event 维护）。
    toolCtx.effect(() => toolCtx.tools.register(createPinyinTool(), {
      when: () => voiceTurn > 0,
    }), 'dsh-voice-copilot: voice_pinyin')
    // 开一段新的：同样是「小印这轮在跑」时才可见。
    toolCtx.effect(() => toolCtx.tools.register(newSessionTool(), {
      when: () => voiceTurn > 0,
    }), 'dsh-voice-copilot: voice_new_session')
  })

  // 先把会话挂进一个侧栏看得见的工作区，再跟它的流：这样浮窗一开就能看到这段对话（包括你在 DSH 界面里说的）
  void resolveSessionId()
    .then((sessionId) => followSession(sessionId))
    .catch((error) => log(`initial session failed: ${error}`))

  const speechInfo = describeSpeech()
  log(`plugin ready dataDir=${dataDir} speech=${JSON.stringify(speechInfo)}`)
  emit({ type: 'ready', dataDir, pid: process.pid, speech: speechInfo })

  // 页面半侧每 800ms 来取一次「要切到哪个会话」。
  // 宿主拿不到 uiWorkspace（那是浏览器里的服务），所以这里只做一个一次性的信箱。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: OPEN_ROUTE,
      handler: (req, res) => {
        const send = (status, body) => {
          try {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(body))
          } catch { /* 页面已经断开，无所谓 */ }
        }
        if ((req.method || 'GET') !== 'GET') { send(405, { sessionId: null }); return }
        const stale = pendingOpen && Date.now() - pendingOpen.at > OPEN_TTL_MS
        if (!pendingOpen || stale) {
          pendingOpen = null
          send(200, { sessionId: null })
          return
        }
        const { sessionId } = pendingOpen
        pendingOpen = null
        send(200, { sessionId })
      },
    }), 'dsh-voice-copilot: open-session route')

    // 设置页的「当前预设人设」只读预览。只回 persona.prefix，不回整份 preset YAML，
    // 避免把工具路径、MCP 环境变量这类东西顺手带到浏览器里。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PERSONA_ROUTE,
      handler: async (req, res) => {
        const send = (status, body) => {
          try {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(body))
          } catch { /* 页面已经断开，无所谓 */ }
        }
        if ((req.method || 'GET') !== 'GET') { send(405, { preset: '', persona: '' }); return }
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const preset = String(url.searchParams.get('preset') || currentPreset() || '').trim()
        if (!preset) { send(200, { preset: '', persona: '', error: '没有配置语音会话预设' }); return }
        try {
          const presets = ctx.get('agentPresets')
          if (!presets || typeof presets.resolve !== 'function' || typeof presets.readDocument !== 'function') {
            send(200, { preset, persona: '', error: 'agentPresets 服务不可用' })
            return
          }
          // readDocument 收的是 preset 的 identity 字符串（不是 resolve() 返回的对象），
          // 传对象会被注册表转成 "[object Object]" 并报 Unknown agent preset。
          const doc = await presets.readDocument(preset)
          const content = typeof doc === 'string' ? doc : (doc && doc.content) || ''
          send(200, { preset, persona: personaFromYaml(content) })
        } catch (error) {
          send(200, { preset, persona: '', error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'dsh-voice-copilot: preset persona route')

    // 「小印」侧栏页：群白名单列表与勾选切换。读的是台账 chats 表，
    // 只改 excluded 标记；台账网页服务没开着也能用。
    const ledgerApi = createLedgerApi({ dbPath: currentLedgerDb, logDir: currentPrinterLogDir, dataDir, log: (line) => log(line) })
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LEDGER_ROUTE,
      handler: (req, res) => { void ledgerApi.chats(req, res) },
    }), 'dsh-voice-copilot: ledger chats route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LEDGER_EXCLUDE_ROUTE,
      handler: (req, res) => { void ledgerApi.exclude(req, res) },
    }), 'dsh-voice-copilot: ledger exclude route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LEDGER_POLICY_ROUTE,
      handler: (req, res) => { void ledgerApi.policyPreview(req, res) },
    }), 'dsh-voice-copilot: ledger policy route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LEDGER_POLICY_APPLY_ROUTE,
      handler: (req, res) => { void ledgerApi.policyApply(req, res) },
    }), 'dsh-voice-copilot: ledger policy apply route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LEDGER_POLICY_UNDO_ROUTE,
      handler: (req, res) => { void ledgerApi.policyUndo(req, res) },
    }), 'dsh-voice-copilot: ledger policy undo route')
  })

  // 先把运行时快照落盘，再拉起浮窗，避免浮窗先启动读到旧配置
  syncRuntime(true)

  // 小印随 DSH 启动：桌面端一加载本插件，就把浮窗程序拉起来（不用再双击 vbs）。
  // config.autoStart: false 可关掉；重复拉起由 app.pid + 浮窗自己的命名互斥量兜住。
  if (config.autoStart !== false) {
    try {
      const autostart = startFloatingWindow({
        appDir: config.appDir,
        pythonw: config.pythonw,
        dataDir,
        log,
      })
      log(`floating window autostart ${JSON.stringify(autostart)}`)
    } catch (error) {
      log(`floating window autostart failed: ${error && error.stack ? error.stack : error}`)
    }
  }
}
