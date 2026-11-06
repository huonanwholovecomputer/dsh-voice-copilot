#!/usr/bin/env node
/**
 * 白名单策略的命令行版：把「订单来源 → 白名单」整套判断跑一遍。
 *
 *   node tools/whitelist-strategy.mjs                  # 预览（默认混合口径，10 天）
 *   node tools/whitelist-strategy.mjs --days 14 --mode orders
 *   node tools/whitelist-strategy.mjs --apply          # 应用（先自动备份，可 --undo）
 *   node tools/whitelist-strategy.mjs --undo           # 撤销上一次应用
 *   node tools/whitelist-strategy.mjs --json           # 把方案打成 JSON
 *
 * 数据来源：
 *   --ledger    台账 ledger.db（默认读 DSH_VOICE_COPILOT_LEDGER_DB）
 *   --log-dir   打印机日志目录（默认 %APPDATA%\HN打印工具\logs，或 DSH_VOICE_COPILOT_PRINTER_LOG_DIR）
 *   --data-dir  备份快照目录（默认 ~/.dsh/voice-copilot）
 *
 * 口径说明见 docs/白名单策略.md。
 */
import os from 'node:os'
import path from 'node:path'

import {
  MODES,
  analyze,
  applyPlan,
  defaultLogDir,
  hasSnapshot,
  saveSnapshot,
  undoSnapshot,
} from '../whitelist-policy.js'

function usage() {
  return [
    '用法: node tools/whitelist-strategy.mjs [选项]',
    '',
    '  --days N          订单窗口天数，默认 10（1–120）',
    `  --mode M          口径：${MODES.join(' / ')}，默认 hybrid`,
    '  --no-pin          不置顶供单群',
    '  --ledger PATH     台账 ledger.db 路径（默认环境变量 DSH_VOICE_COPILOT_LEDGER_DB）',
    '  --log-dir PATH    打印机日志目录（默认 %APPDATA%\\HN打印工具\\logs）',
    '  --data-dir PATH   策略备份目录（默认 ~/.dsh/voice-copilot）',
    '  --apply           应用方案（写 chats.excluded / chats.pinned）',
    '  --undo            撤销上一次应用的方案',
    '  --json            输出方案 JSON（不打印表格）',
    '  -h, --help        显示本帮助',
  ].join('\n')
}

function parseArgs(argv) {
  const out = {
    days: 10,
    mode: 'hybrid',
    pin: true,
    ledger: process.env.DSH_VOICE_COPILOT_LEDGER_DB || '',
    logDir: process.env.DSH_VOICE_COPILOT_PRINTER_LOG_DIR || defaultLogDir(),
    dataDir: path.join(os.homedir(), '.dsh', 'voice-copilot'),
    apply: false,
    undo: false,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`)
      i += 1
      return value
    }
    switch (arg) {
      case '--days': out.days = Number(next()); break
      case '--mode': out.mode = next(); break
      case '--no-pin': out.pin = false; break
      case '--ledger': out.ledger = next(); break
      case '--log-dir': out.logDir = next(); break
      case '--data-dir': out.dataDir = next(); break
      case '--apply': out.apply = true; break
      case '--undo': out.undo = true; break
      case '--json': out.json = true; break
      case '-h': case '--help': out.help = true; break
      default: throw new Error(`不认识的参数：${arg}`)
    }
  }
  return out
}

function fmtPct(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '—'
}

function printPlan(plan, attr) {
  const t = plan.totals
  console.log('')
  console.log(`窗口   近 ${plan.days} 天（${new Date(plan.since).toLocaleString()} 起） · 口径 ${plan.mode}${plan.pinOrderChats ? ' · 置顶供单群' : ''}`)
  console.log(`扫描   打印批次 ${attr.batches || 0}，文件 ${attr.files || 0} 次；其中云端 ${attr.cloud || 0}、私聊 ${attr.private || 0}、群聊 ${attr.group || 0}、店主回传 ${attr.self || 0}、图片 ${attr.image || 0}、未归因 ${attr.unknown || 0}`)
  console.log(`结果   群 ${t.groupsIncluded}/${t.groups} 纳入，私聊 ${t.directsIncluded}/${t.directs} 纳入`)
  console.log(`文件   可见 ${t.visibleFiles}/${t.files}（${fmtPct(t.visibleFiles, t.files)}）`)
  console.log(`改动   ${t.changed} 个会话${t.changed === 0 ? '（当前标记已符合口径）' : ''}`)
  const keep = plan.changes.filter((item) => item.action === 'keep')
  const drop = plan.changes.filter((item) => item.action === 'exclude')
  if (keep.length) {
    console.log('\n将纳入：')
    for (const item of keep.slice(0, 40)) {
      console.log(`  + ${item.isGroup ? '群' : '私聊'} ${item.name} — ${item.reason}`)
    }
    if (keep.length > 40) console.log(`  …另 ${keep.length - 40} 个`)
  }
  if (drop.length) {
    console.log('\n将排除：')
    for (const item of drop.slice(0, 40)) {
      console.log(`  - ${item.isGroup ? '群' : '私聊'} ${item.name} — ${item.reason}`)
    }
    if (drop.length > 40) console.log(`  …另 ${drop.length - 40} 个`)
  }
  console.log('')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error && error.message ? error.message : error))
    console.error(usage())
    process.exit(2)
  }
  if (options.help) { console.log(usage()); return }

  const ledger = String(options.ledger || '').trim()
  if (!ledger) {
    console.error('没有台账路径：用 --ledger 指定，或设置 DSH_VOICE_COPILOT_LEDGER_DB')
    process.exit(2)
  }

  if (options.undo) {
    try {
      if (!hasSnapshot(options.dataDir)) throw new Error(`没有可撤销的备份：${path.join(options.dataDir, 'whitelist-snapshot.json')}`)
      const result = await undoSnapshot(ledger, options.dataDir)
      console.log(`已撤销：恢复 ${result.changed} 个会话（备份时间 ${result.savedAt || '未知'}）`)
      return
    } catch (error) {
      console.error(`撤销失败：${error && error.message ? error.message : error}`)
      process.exit(1)
    }
  }

  let result
  try {
    result = await analyze({
      dbPath: ledger,
      logDir: options.logDir,
      days: options.days,
      mode: options.mode,
      pinOrderChats: options.pin,
    })
  } catch (error) {
    console.error(`分析失败：${error && error.message ? error.message : error}`)
    process.exit(1)
  }

  const { plan, attrTotals, chats } = result
  if (options.json) {
    console.log(JSON.stringify({ plan: { ...plan, items: undefined }, attr: attrTotals }, null, 2))
    return
  }

  printPlan(plan, attrTotals)

  if (!options.apply) {
    console.log('这是预览，没有写台账。确认后加 --apply 应用；应用前会自动备份，可用 --undo 撤销。')
    return
  }

  if (!plan.changes.length) {
    console.log('当前标记已符合策略，无需应用。')
    return
  }
  const snapshot = saveSnapshot(options.dataDir, chats)
  const applied = await applyPlan(ledger, plan)
  console.log(`已应用：${applied.changed} 个会话；备份在 ${snapshot}`)
  console.log('如果要回退：node tools/whitelist-strategy.mjs --undo')
}

main().catch((error) => {
  console.error(`未预期错误：${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
