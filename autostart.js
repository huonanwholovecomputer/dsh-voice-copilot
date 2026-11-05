/**
 * 小印随 DSH 启动：DSH 桌面端加载本插件时，把浮窗拉起来。
 *
 * 现在的浮窗是 desktop/ 下的 Electron 程序（和 dsh-pet 一个路子：插件宿主 + 自带 helper 进程）。
 * 老的 Python 版（app/main.py）保留成回退路线：找不到 Electron 时还能用。
 *
 * 只负责「启动」，不负责「随 DSH 退出杀掉」：浮窗是常驻托盘程序，DSH 关了它还能待着。
 * 重复启动有三道闸：
 *   1. 这里先看 dataDir/app.pid，pid 还活着就不拉；
 *   2. 浮窗自己 requestSingleInstanceLock（Electron 官方单实例，比命名互斥量省事）；
 *   3. pid 文件丢了也不会起两个。
 *
 * 关掉自启：插件 config 里写 autoStart: false。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))

// 老浮窗（Python）在 app/，新浮窗（Electron）在 desktop/。
export const APP_DIR = path.join(PACKAGE_DIR, 'app')
export const DESKTOP_DIR = path.join(PACKAGE_DIR, 'desktop')

export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'voice-copilot')
}

/** 进程还在不在。EPERM 说明进程在、只是没权限碰它。 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** app.pid 里既可能是 {"pid":123,...}，也可能是纯数字；读不懂就当没有。 */
export function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim()
    if (!raw) return 0
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw)
      return Number(parsed && parsed.pid) || 0
    }
    return Number.parseInt(raw, 10) || 0
  } catch {
    return 0
  }
}

/** 找 pythonw.exe：显式配置优先，否则在 %LOCALAPPDATA%\\Programs\\Python 里挑最高版本。 */
export function findPythonw(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit
  const root = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python')
  let releases = []
  try {
    releases = fs.readdirSync(root).filter((name) => /^Python3\d+$/.test(name))
  } catch {
    return ''
  }
  releases.sort((a, b) => Number(b.slice('Python'.length)) - Number(a.slice('Python'.length)))
  for (const name of releases) {
    const exe = path.join(root, name, 'pythonw.exe')
    if (fs.existsSync(exe)) return exe
  }
  return ''
}

/**
 * 找 electron.exe：显式配置 > 插件自己带的一份 > ~/.dsh/electron（dsh-pet 下载的那份） > 系统里登记的 Electron。
 * 只做存在性判断，不校验版本。
 */
export function findElectron(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_VOICE_COPILOT_ELECTRON) candidates.push(process.env.DSH_VOICE_COPILOT_ELECTRON)
  candidates.push(
    path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(os.homedir(), '.dsh', 'electron', 'electron.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH NEXT', 'DSH NEXT.exe'),
  )
  for (const exe of candidates) {
    if (exe && fs.existsSync(exe)) return exe
  }
  return ''
}

/**
 * 拉起浮窗（Electron 优先，Python 回退）。
 * 返回 { started, engine, reason, pid?, exe? }，永不抛异常。
 * options: { appDir, desktopDir, electron, pythonw, dataDir, log }
 */
export function startFloatingWindow(options = {}) {
  if (process.platform !== 'win32') return { started: false, reason: 'not-windows' }

  const dataDir = options.dataDir || defaultDataDir()
  const pidFile = path.join(dataDir, 'app.pid')
  const runningPid = readPid(pidFile)
  if (isProcessAlive(runningPid)) return { started: false, engine: 'unknown', reason: 'already-running', pid: runningPid }

  const desktopDir = options.desktopDir || DESKTOP_DIR
  const electron = findElectron(options.electron)

  if (electron && fs.existsSync(path.join(desktopDir, 'main.js'))) {
    return spawnHelper(electron, [desktopDir], desktopDir, { engine: 'electron', dataDir, pidFile, log: options.log })
  }

  const appDir = options.appDir || APP_DIR
  const mainPy = path.join(appDir, 'main.py')
  if (!fs.existsSync(mainPy)) {
    return { started: false, engine: 'none', reason: electron ? 'desktop-missing' : 'no-electron', mainPy }
  }
  const pythonw = findPythonw(options.pythonw)
  if (!pythonw) return { started: false, engine: 'none', reason: 'no-pythonw' }
  return spawnHelper(pythonw, [mainPy], appDir, { engine: 'python', dataDir, pidFile, log: options.log })
}

function spawnHelper(exe, args, cwd, { engine, dataDir, pidFile, log }) {
  // 本机 shell 环境里带着 ELECTRON_RUN_AS_NODE=1（某些工具链留下的），
  // 不删掉的话 electron.exe 会退化成 node，直接报 Cannot find module 'electron'。
  const env = { ...process.env, PYTHONUTF8: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  // 让浮窗用和 pid 文件同一个目录，免得两边各算各的
  env.XIAOYIN_DATA_DIR = dataDir

  let child
  try {
    child = spawn(exe, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    return { started: false, engine, reason: 'spawn-failed', error: message }
  }

  child.once('error', (error) => {
    log?.(`floating window spawn error: ${error}`)
  })
  // 浮窗退出时顺手清掉自己那行 pid，下次 DSH 启动才能重新拉起。
  child.once('exit', (code) => {
    try {
      if (readPid(pidFile) === child.pid) fs.unlinkSync(pidFile)
    } catch { /* 文件可能已经不在了 */ }
    log?.(`floating window exited engine=${engine} code=${code}`)
  })
  child.unref()

  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, engine, startedAt: Date.now() }), 'utf8')
  } catch { /* pid 文件写不了也不影响浮窗运行 */ }

  return { started: true, engine, pid: child.pid, exe }
}
