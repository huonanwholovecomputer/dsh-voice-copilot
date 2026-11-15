/**
 * 小印的侧栏页：宿主这半边的路由。
 *
 * 这块以前长在壳（index.js）里，导致「语音壳」认识「微信文件台账」这种业务概念。
 * 现在它跟着 agent 包走：agent.json 的 `sidebar.module` 指到这里，壳只负责
 * 「有 sidebar 就 import 它、把 web 上下文递进去」，不认识台账、也不认识白名单。
 *
 * 页面那半边（client.js 里的 GroupManagerPage）暂时还留在壳的 bundle 里，
 * P1 会随包一起搬走；两端走的是同一组路径，所以现在搬其中一半不改变行为。
 */
import { createLedgerApi } from './lib/ledger-groups.js'

// 路径是小印自己的约定，不是壳的：壳没有为它们留任何常量。
const CHATS_ROUTE = '/__dsh-voice-copilot/ledger/chats' // ui-copy-ignore
const EXCLUDE_ROUTE = '/__dsh-voice-copilot/ledger/exclude' // ui-copy-ignore
const POLICY_ROUTE = '/__dsh-voice-copilot/ledger/policy' // ui-copy-ignore
const POLICY_APPLY_ROUTE = '/__dsh-voice-copilot/ledger/policy/apply' // ui-copy-ignore
const POLICY_UNDO_ROUTE = '/__dsh-voice-copilot/ledger/policy/undo' // ui-copy-ignore

/**
 * @param {object} options
 * @param {object} options.webCtx  注入了 webServer 的 Cordis 上下文（用它的 effect 收尾）
 * @param {() => { dbPath: string, logDir: string }} options.config  每次请求现读，改配置不用重挂
 * @param {string} options.dataDir  插件数据目录（策略快照落到这里）
 * @param {(line: string) => void} [options.log]
 * @returns {() => void} 卸载函数
 */
export function mount({ webCtx, config, dataDir, log = () => {} }) {
  const readConfig = typeof config === 'function' ? config : () => config || {}
  const api = createLedgerApi({
    dbPath: () => readConfig().dbPath || '',
    logDir: () => readConfig().logDir || '',
    dataDir,
    log,
  })
  const routes = [
    [CHATS_ROUTE, (req, res) => { void api.chats(req, res) }, 'ledger chats route'],
    [EXCLUDE_ROUTE, (req, res) => { void api.exclude(req, res) }, 'ledger exclude route'],
    [POLICY_ROUTE, (req, res) => { void api.policyPreview(req, res) }, 'ledger policy route'],
    [POLICY_APPLY_ROUTE, (req, res) => { void api.policyApply(req, res) }, 'ledger policy apply route'],
    [POLICY_UNDO_ROUTE, (req, res) => { void api.policyUndo(req, res) }, 'ledger policy undo route'],
  ]
  const disposers = routes.map(([routePath, handler, label]) => webCtx.effect(
    () => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }),
    `dsh-voice-copilot: ${label}`,
  ))
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 已经随 effect 一起收了 */ }
    }
  }
}
