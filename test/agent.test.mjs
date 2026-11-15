import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultAgentsDir, listAgents, loadAgent, normalizeAgent, resolveActiveAgent } from '../agent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const agentsDir = path.join(here, '..', 'agents')
const silence = () => {}

/** 造一个临时 agent 包，返回它的目录。files 是相对路径 → 内容。 */
function makeAgent(id, manifest, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyin-agent-'))
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2), 'utf8')
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content, 'utf8')
  }
  return { root, dir }
}

test('内置 agent 目录指向仓库里的 agents/', () => {
  assert.equal(path.resolve(defaultAgentsDir()), path.resolve(agentsDir))
})

test('小印的 agent.json 能被加载成壳认识的形状', () => {
  const result = loadAgent('xiaoyin', { agentsDir, log: silence })
  assert.equal(result.ok, true, result.error)
  const { agent } = result
  assert.equal(agent.id, 'xiaoyin')
  assert.equal(agent.name, '小印')
  assert.equal(agent.session.agentPreset, 'private-print-assistant')
  assert.equal(agent.session.sessionTitle, '语音浮窗')
  assert.equal(agent.persona.kind, 'preset')
  assert.equal(agent.persona.preset, 'private-print-assistant')
  assert.equal(agent.settings.ledgerDb.endsWith('ledger.db'), true)
  assert.ok(agent.sidebar && agent.sidebar.module.endsWith(path.join('xiaoyin', 'sidebar.js')))
  // 业务示例在包里，壳里一个字都不该有
  assert.match(agent.voiceNotes(), /张三/)
})

test('voiceNotes 按 mtime 热更新：改文件不用重启插件', async () => {
  const { root, dir } = makeAgent('notes', {
    schemaVersion: 1,
    id: 'notes',
    name: '笔记助手',
    persona: { kind: 'none' },
    voiceNotes: 'voice.md',
  }, { 'voice.md': '- 第一版\n' })
  try {
    const { agent } = loadAgent('notes', { agentsDir: root, log: silence })
    assert.equal(agent.voiceNotes(), '- 第一版')
    fs.writeFileSync(path.join(dir, 'voice.md'), '- 第二版\n', 'utf8')
    // Windows 的 mtime 精度足够区分这两次写；保险起见把时间推后一点再读
    const later = new Date(Date.now() + 2000)
    fs.utimesSync(path.join(dir, 'voice.md'), later, later)
    assert.equal(agent.voiceNotes(), '- 第二版')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('markdown 人设：读文件本身，不需要 preset', () => {
  const { root } = makeAgent('md', {
    schemaVersion: 1,
    id: 'md',
    name: '文档助手',
    persona: { kind: 'markdown', file: 'persona.md' },
  }, { 'persona.md': '# 你是谁\n\n你是文档助手。\n' })
  try {
    const result = loadAgent('md', { agentsDir: root, log: silence })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.agent.persona.kind, 'markdown')
    assert.match(result.agent.persona.text, /你是文档助手/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('坏包只报一句话、不抛异常', () => {
  const cases = [
    [{ schemaVersion: 1, id: 'x', name: '' }, /缺少 name/],
    [{ schemaVersion: 99, id: 'x', name: 'X' }, /schemaVersion/],
    [{ schemaVersion: 1, id: 'x', name: 'X', persona: { kind: 'markdown' } }, /没有给 file/],
    [{ schemaVersion: 1, id: 'x', name: 'X', persona: { kind: 'markdown', file: 'nope.md' } }, /人设文件是空的/],
    [{ schemaVersion: 1, id: 'x', name: 'X', sidebar: { module: 'nope.js' } }, /侧栏模块不存在/],
    [{ schemaVersion: 1, id: 'bad id!', name: 'X' }, /id 不合法/],
  ]
  for (const [manifest, pattern] of cases) {
    const result = normalizeAgent(manifest.id || 'x', path.join(os.tmpdir(), 'nowhere'), manifest, { log: silence })
    assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(manifest)}`)
    assert.match(result.error, pattern)
  }
})

test('resolveActiveAgent：点名的包坏了就退回小印，而不是整个壳起不来', () => {
  const { agent, error } = resolveActiveAgent({ requested: 'not-installed', agentsDir, log: silence })
  assert.ok(agent, '退回失败')
  assert.equal(agent.id, 'xiaoyin')
  assert.match(error, /读不出来/)
})

test('listAgents 跳过坏包、保留好包', () => {
  const { root } = makeAgent('good', { schemaVersion: 1, id: 'good', name: '好的' })
  try {
    fs.mkdirSync(path.join(root, 'broken'), { recursive: true })
    fs.writeFileSync(path.join(root, 'broken', 'agent.json'), '{ not json', 'utf8')
    const agents = listAgents({ agentsDir: root, log: silence })
    assert.deepEqual(agents.map((item) => item.id), ['good'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('小印侧栏模块把 5 条台账路由原样挂回去（路径不许变，页面那半边还在壳里）', async () => {
  const mod = await import('../agents/xiaoyin/sidebar.js')
  const paths = []
  const disposers = []
  const webCtx = {
    webServer: { register(spec) { paths.push(spec.path); return () => {} } },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
  }
  const dispose = mod.mount({ webCtx, dataDir: os.tmpdir(), log: silence, config: () => ({ dbPath: '', logDir: '' }) })
  assert.deepEqual(paths, [
    '/__dsh-voice-copilot/ledger/chats',
    '/__dsh-voice-copilot/ledger/exclude',
    '/__dsh-voice-copilot/ledger/policy',
    '/__dsh-voice-copilot/ledger/policy/apply',
    '/__dsh-voice-copilot/ledger/policy/undo',
  ])
  assert.equal(disposers.length, 5)
  dispose()
})
