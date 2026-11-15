/**
 * 小印的宿主租约 —— 同时开着官方 dsh 与 DSH NEXT 时，决定谁持有浮窗。
 *
 * 背景：两个桌面端共用 DSH_HOME（~/.dsh），于是共用同一个 desktop profile、
 * 同一个 dataDir。以前只有一个 runtime.json.hostPid：谁最后启动谁覆盖它，
 * 而且任一方退出时都 taskkill 同一个 app.pid —— 先退出的会把另一方的浮窗杀掉。
 *
 * 这里把「谁持有小印」变成一份显式租约（<dataDir>/lease.json）：
 *   - 只有持有者写 runtime.json、消费 queue/、拉起浮窗；
 *   - 持有者每 5s 续一次心跳；心跳过期（默认 20s）且进程也不在，别人可以接管；
 *   - 抢租约在 lease.lock（O_EXCL 原子创建）里做「读-判断-写」，两个宿主同时
 *     启动也只会有一个人写成功；
 *   - 退出时只释放自己的租约，浮窗由「还是不是持有者」决定要不要杀。
 *
 * 租约文件：{ version, instanceId, hostPid, product, exePath, startedAt, heartbeat }
 * 让位请求：control/takeover.json { from, at }（请求方写，持有者下一拍消费）
 */
import fs from 'node:fs'
import path from 'node:path'

import { isProcessAlive } from './autostart.js'

const LEASE_FILE = 'lease.json'
const LOCK_FILE = 'lease.lock'
const CONTROL_DIR = 'control'
const TAKEOVER_FILE = 'takeover.json'

/** 持有者续心跳的间隔。 */
export const LEASE_HEARTBEAT_MS = 5_000
/** 心跳超过这么久没续，且宿主进程也不在，租约就算作废、可以被接管。 */
export const LEASE_TTL_MS = 20_000
/** 抢租约用的锁：超过这么久没释放，按「上一个抢锁的进程已经死了」处理。 */
export const LEASE_LOCK_TTL_MS = 3_000
export const LEASE_VERSION = 1

function paths(dataDir) {
  return {
    leaseFile: path.join(dataDir, LEASE_FILE),
    lockFile: path.join(dataDir, LOCK_FILE),
    controlDir: path.join(dataDir, CONTROL_DIR),
    takeoverFile: path.join(dataDir, CONTROL_DIR, TAKEOVER_FILE),
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 同步睡一下；拿锁失败要退避，但这里没有 await 的余地（acquire 是同步 API）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 极老的 Node 才走到这 */ }
  }
}

/**
 * 在 dataDir 里跑一段「读租约-判断-写租约」的临界区。
 * 拿不到锁（2s 内一直有人占着）返回 null，交给调用方当「这拍没抢到」处理。
 */
function withLock(dataDir, fn) {
  const { lockFile } = paths(dataDir)
  fs.mkdirSync(dataDir, { recursive: true })
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}`) } finally { fs.closeSync(fd) }
      break
    } catch (error) {
      if (!error || error.code !== 'EEXIST') break
      try {
        const stat = fs.statSync(lockFile)
        if (Date.now() - stat.mtimeMs > LEASE_LOCK_TTL_MS) {
          try { fs.unlinkSync(lockFile) } catch { /* 别人先删了 */ }
          continue
        }
      } catch { continue }
      if (Date.now() >= deadline) return null
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    try { fs.unlinkSync(lockFile) } catch { /* 已经没了 */ }
  }
}

/** 读租约；读不懂 / 文件不在都返回 null（当作「没人持有」）。 */
export function readLease(dataDir) {
  try {
    const lease = JSON.parse(fs.readFileSync(path.join(dataDir, LEASE_FILE), 'utf8'))
    if (!lease || typeof lease.instanceId !== 'string' || !lease.instanceId) return null
    return {
      version: Number(lease.version) || 0,
      instanceId: lease.instanceId,
      hostPid: Number(lease.hostPid) || 0,
      product: typeof lease.product === 'string' && lease.product ? lease.product : 'unknown',
      exePath: typeof lease.exePath === 'string' ? lease.exePath : '',
      startedAt: Number(lease.startedAt) || 0,
      heartbeat: Number(lease.heartbeat) || 0,
    }
  } catch {
    return null
  }
}

/** 心跳还在有效期内（只证明「写过」，还要配合 isProcessAlive 才说明宿主真在跑）。 */
export function isLeaseFresh(lease, now = Date.now(), ttlMs = LEASE_TTL_MS) {
  return Boolean(lease && lease.heartbeat > 0 && now - lease.heartbeat <= ttlMs)
}

/**
 * 从进程自己的安装路径推断频道：官方 44.x = stable，Program Files\DSH NEXT = next。
 * 认不出来就返回 unknown —— 优先级配置对 unknown 不生效，退回「先到先得」。
 */
export function detectProduct(execPath = process.execPath, env = process.env) {
  const probes = [execPath, env.DSH_DESKTOP_APP_ROOT, process.resourcesPath]
    .filter(Boolean)
    .map((probe) => String(probe).toLowerCase())
  if (probes.some((probe) => probe.includes('dsh next') || probe.includes('dsh-next'))) return 'next'
  if (probes.some((probe) => probe.includes('deepseek harness') || probe.includes('deepseek-harness'))) return 'stable'
  return 'unknown'
}

function buildLease({ instanceId, hostPid, product, exePath, previous, now }) {
  const sameOwner = previous && previous.instanceId === instanceId
  return {
    version: LEASE_VERSION,
    instanceId,
    hostPid,
    product: product || 'unknown',
    exePath: exePath || '',
    startedAt: sameOwner ? previous.startedAt : now,
    heartbeat: now,
  }
}

/**
 * 申请租约。三种结果都算成功返回，看 owner 字段：
 *   owner:true  reason:'free' | 'renewed' | 'stale'
 *   owner:false reason:'busy'（holder 是当前持有者）
 */
export function acquireLease({
  dataDir,
  instanceId,
  hostPid = process.pid,
  product = 'unknown',
  exePath = '',
  now = Date.now(),
}) {
  if (!instanceId) return { ok: false, owner: false, reason: 'no-instance' }
  const result = withLock(dataDir, () => {
    const { leaseFile } = paths(dataDir)
    const current = readLease(dataDir)
    if (!current) {
      const lease = buildLease({ instanceId, hostPid, product, exePath, previous: null, now })
      writeJson(leaseFile, lease)
      return { ok: true, owner: true, reason: 'free', lease }
    }
    if (current.instanceId === instanceId) {
      const lease = buildLease({ instanceId, hostPid, product, exePath, previous: current, now })
      writeJson(leaseFile, lease)
      return { ok: true, owner: true, reason: 'renewed', lease }
    }
    if (isProcessAlive(current.hostPid) && isLeaseFresh(current, now)) {
      return { ok: true, owner: false, reason: 'busy', holder: current }
    }
    const lease = buildLease({ instanceId, hostPid, product, exePath, previous: current, now })
    writeJson(leaseFile, lease)
    return { ok: true, owner: true, reason: 'stale', lease, previous: current.instanceId }
  })
  return result || { ok: false, owner: false, reason: 'lock-timeout' }
}

/** 续心跳。lost:true 表示租约已经不是自己的了（被接管 / 文件被删）。 */
export function renewLease({ dataDir, instanceId, hostPid = process.pid, now = Date.now() }) {
  if (!instanceId) return { ok: false, lost: true, reason: 'no-instance' }
  const result = withLock(dataDir, () => {
    const current = readLease(dataDir)
    if (!current || current.instanceId !== instanceId) {
      return { ok: false, lost: true, holder: current ? current.instanceId : '' }
    }
    writeJson(paths(dataDir).leaseFile, { ...current, hostPid, heartbeat: now })
    return { ok: true, lost: false }
  })
  return result || { ok: false, lost: false, reason: 'lock-timeout' }
}

/** 释放租约，但只释放自己的；别人的租约一概不动。 */
export function releaseLease({ dataDir, instanceId }) {
  if (!instanceId) return { ok: false, reason: 'no-instance' }
  const result = withLock(dataDir, () => {
    const current = readLease(dataDir)
    if (!current) return { ok: true, reason: 'empty' }
    if (current.instanceId !== instanceId) return { ok: false, reason: 'not-owner', holder: current.instanceId }
    try { fs.unlinkSync(paths(dataDir).leaseFile) } catch { /* 已经没了 */ }
    return { ok: true, reason: 'released' }
  })
  return result || { ok: false, reason: 'lock-timeout' }
}

/** 请求当前持有者让位（对方下一拍会结束浮窗并释放租约）。 */
export function requestTakeover({ dataDir, from, now = Date.now() }) {
  if (!from) return { ok: false, reason: 'no-instance' }
  const { controlDir, takeoverFile } = paths(dataDir)
  fs.mkdirSync(controlDir, { recursive: true })
  writeJson(takeoverFile, { from, at: now })
  return { ok: true, file: takeoverFile }
}

/** 取出并删掉让位请求（多个宿主同时看，只有一个能拿到）。 */
export function consumeTakeover(dataDir) {
  const { takeoverFile } = paths(dataDir)
  try {
    const raw = fs.readFileSync(takeoverFile, 'utf8')
    fs.unlinkSync(takeoverFile)
    const request = JSON.parse(raw)
    if (!request || typeof request.from !== 'string' || !request.from) return null
    return { from: request.from, at: Number(request.at) || 0 }
  } catch {
    return null
  }
}
