/**
 * 智能体包加载器（L2 → L1 的唯一接口）。
 *
 * 壳（voice-shell）只认这里吐出来的形状，永远不认「小印」这两个字：
 *   agent.json  →  { id, name, session:{agentPreset,cwd,workspaceTitle,sessionTitle},
 *                    persona:{kind,preset,file,text}, voiceNotes:()=>string,
 *                    settings:{...}, sidebar:{module,title}|null, dir }
 *
 * 这份文件是纯 I/O + 校验，不依赖 DSH、也不 import 任何 DSH 服务，
 * 所以能单独跑单元测试（见 test/agent.test.mjs），P1 的打包 / 导入
 * 也会复用同一个 normalizeAgent 做导入校验。
 *
 * 优先级（P0 过渡期，P1 会删掉旧字段）：
 *   插件配置里显式填的值  >  agent.json  >  内置兜底
 * 这样本机现有 cordis.patch.yml 一个字不改，行为完全不变。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENT_SCHEMA_VERSION = 1

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 内置 agent 包所在目录：<仓库>/agents/ */
export function defaultAgentsDir() {
  return path.join(HERE, 'agents')
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

function fail(error) {
  return { ok: false, agent: null, error }
}

function readText(file, log) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    log(`读不了 ${file}：${error && error.message ? error.message : error}`)
    return ''
  }
}

/**
 * 语音补充说明（voice-notes.md）：壳把「怎么说话」的通用规则写死，
 * 具体到某个业务的示例（人名、单号、标签页）归 agent 包。
 * 按 mtime 缓存，改文件不用重启插件。
 */
function voiceNotesReader(file, log) {
  let cached = { mtimeMs: -1, value: '' }
  return () => {
    if (!file) return ''
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs === cached.mtimeMs) return cached.value
      const value = fs.readFileSync(file, 'utf8').trim()
      cached = { mtimeMs: stat.mtimeMs, value }
      return value
    } catch (error) {
      log(`读不了 ${file}：${error && error.message ? error.message : error}`)
      return cached.value
    }
  }
}

/**
 * 把一份 agent.json 规范成壳认识的形状。导入包里也走这里，所以校验只写一次。
 * 返回 { ok, agent, error }；error 是给人看的一句话，不做异常抛出。
 */
export function normalizeAgent(id, dir, raw, { log = () => {} } = {}) {
  const manifest = asObject(raw)
  const schemaVersion = Number(manifest.schemaVersion || AGENT_SCHEMA_VERSION)
  if (schemaVersion > AGENT_SCHEMA_VERSION) {
    return fail(`agent.json 的 schemaVersion=${schemaVersion} 比本插件认识的 ${AGENT_SCHEMA_VERSION} 新，先升级插件`)
  }
  const agentId = text(manifest.id) || text(id)
  if (!agentId) return fail('agent.json 缺少 id')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(agentId)) return fail(`agent id 不合法：${agentId}`)
  if (text(id) && agentId !== text(id)) {
    log(`agent.json 的 id=${agentId} 与目录名 ${id} 不一致，按 manifest 走`)
  }
  const name = text(manifest.name)
  if (!name) return fail(`agent ${agentId} 缺少 name`)

  const sessionRaw = asObject(manifest.session)
  const session = {
    agentPreset: text(sessionRaw.agentPreset) || text(asObject(manifest.preset).id),
    cwd: text(sessionRaw.cwd),
    workspaceTitle: text(sessionRaw.workspaceTitle) || '语音浮窗',
    sessionTitle: text(sessionRaw.sessionTitle) || '语音浮窗',
  }

  const personaRaw = asObject(manifest.persona)
  const preset = text(personaRaw.preset)
  const kind = ['preset', 'markdown', 'none'].includes(text(personaRaw.kind))
    ? text(personaRaw.kind)
    : (preset ? 'preset' : 'none')
  const personaFile = text(personaRaw.file) ? path.resolve(dir, text(personaRaw.file)) : ''
  let personaText = ''
  if (kind === 'markdown') {
    if (!personaFile) return fail(`agent ${agentId} 的 persona.kind=markdown 但没有给 file`)
    personaText = readText(personaFile, log).trim()
    if (!personaText) return fail(`agent ${agentId} 的人设文件是空的：${personaFile}`)
  }
  if (kind === 'preset' && !preset) return fail(`agent ${agentId} 的 persona.kind=preset 但没有给 preset`)
  if (kind === 'none' && !text(manifest.voiceNotes)) {
    log(`agent ${agentId} 既没有人设也没有语音补充，回复风格全靠壳的默认规则`)
  }

  const voiceNotesFile = text(manifest.voiceNotes) ? path.resolve(dir, text(manifest.voiceNotes)) : ''

  const sidebarRaw = asObject(manifest.sidebar)
  const sidebarModule = text(sidebarRaw.module)
  const sidebar = sidebarModule
    ? { module: path.resolve(dir, sidebarModule), title: text(sidebarRaw.title) || name }
    : null
  if (sidebar && !fs.existsSync(sidebar.module)) {
    return fail(`agent ${agentId} 声明的侧栏模块不存在：${sidebar.module}`)
  }

  const settings = {}
  for (const [key, value] of Object.entries(asObject(manifest.settings))) {
    settings[key] = typeof value === 'string' ? value.trim() : value
  }

  return {
    ok: true,
    error: '',
    agent: Object.freeze({
      id: agentId,
      name,
      version: text(manifest.version) || '0.0.0',
      description: text(manifest.description),
      dir,
      session,
      persona: Object.freeze({ kind, preset, file: personaFile, text: personaText }),
      voiceNotes: voiceNotesReader(voiceNotesFile, log),
      settings: Object.freeze(settings),
      sidebar: sidebar ? Object.freeze(sidebar) : null,
    }),
  }
}

/** 读 <agentsDir>/<id>/agent.json。读不到 / 校验不过都返回 { ok:false }，不抛。 */
export function loadAgent(id, { agentsDir = defaultAgentsDir(), log = () => {} } = {}) {
  const agentId = text(id)
  if (!agentId) return fail('没有指定 agent id')
  const dir = path.join(agentsDir, agentId)
  const manifestPath = path.join(dir, 'agent.json')
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return fail(`${manifestPath} 读不出来：${error && error.message ? error.message : error}`)
  }
  return normalizeAgent(agentId, dir, raw, { log })
}

/** 列出所有装了 agent.json 的包（坏包跳过并记一行日志，不让一个坏包挡住整个壳）。 */
export function listAgents({ agentsDir = defaultAgentsDir(), log = () => {} } = {}) {
  let entries
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const agents = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const result = loadAgent(entry.name, { agentsDir, log })
    if (result.ok) agents.push(result.agent)
    else log(`跳过 agent 包 ${entry.name}：${result.error}`)
  }
  return agents
}

/**
 * 决定这次插件加载用哪个 agent：
 * 配置里点名 → 用它；点名的包坏了 → 退回默认；没点名 → xiaoyin，再不行取第一个装了包的。
 * 一个包都没有时返回 { agent:null }，壳仍然能跑（只是没有业务人设）。
 */
export function resolveActiveAgent({ requested, agentsDir = defaultAgentsDir(), log = () => {} } = {}) {
  const wanted = text(requested)
  let requestedError = ''
  if (wanted) {
    const result = loadAgent(wanted, { agentsDir, log })
    if (result.ok) return { agent: result.agent, error: '' }
    requestedError = result.error
    log(`指定的 agent「${wanted}」加载失败：${result.error}`)
  }
  const fallback = loadAgent('xiaoyin', { agentsDir, log })
  if (fallback.ok) return { agent: fallback.agent, error: requestedError }
  const all = listAgents({ agentsDir, log })
  if (all.length) return { agent: all[0], error: requestedError || fallback.error }
  return { agent: null, error: requestedError || fallback.error || `没在 ${agentsDir} 里找到任何智能体包` }
}
