import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  LEASE_TTL_MS,
  acquireLease,
  consumeTakeover,
  detectProduct,
  isLeaseFresh,
  readLease,
  releaseLease,
  renewLease,
  requestTakeover,
} from '../lease.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyin-lease-'))

// 拿一个确定已经退出的 pid：随便编的 999999 在这台机器上可能真的存在，
// 那样 busy / stale 就测不到点子上。
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
}

const A = 'instance-a'
const B = 'instance-b'

test('空目录：第一个申请者拿到 free，并写出可读的租约', () => {
  const dataDir = tempDir()
  const result = acquireLease({ dataDir, instanceId: A, hostPid: process.pid, product: 'stable', exePath: 'x.exe' })
  assert.equal(result.ok, true)
  assert.equal(result.owner, true)
  assert.equal(result.reason, 'free')

  const lease = readLease(dataDir)
  assert.equal(lease.instanceId, A)
  assert.equal(lease.hostPid, process.pid)
  assert.equal(lease.product, 'stable')
  assert.equal(lease.exePath, 'x.exe')
  assert.ok(isLeaseFresh(lease))
  assert.equal(fs.existsSync(path.join(dataDir, 'lease.lock')), false, '抢完锁要删掉')
})

test('同一实例再申请 = renewed，不动 startedAt', () => {
  const dataDir = tempDir()
  const first = acquireLease({ dataDir, instanceId: A, hostPid: process.pid, now: 1_000 })
  const second = acquireLease({ dataDir, instanceId: A, hostPid: process.pid, now: 5_000 })
  assert.equal(second.reason, 'renewed')
  assert.equal(second.lease.startedAt, 1_000)
  assert.equal(second.lease.heartbeat, 5_000)
  assert.equal(readLease(dataDir).startedAt, first.lease.startedAt)
})

test('持有者活着且心跳新：第二个实例拿到 busy，并且带回 holder', () => {
  const dataDir = tempDir()
  acquireLease({ dataDir, instanceId: A, hostPid: process.pid, product: 'stable' })
  const result = acquireLease({ dataDir, instanceId: B, hostPid: deadPid() })
  assert.equal(result.ok, true)
  assert.equal(result.owner, false)
  assert.equal(result.reason, 'busy')
  assert.equal(result.holder.instanceId, A)
  assert.equal(readLease(dataDir).instanceId, A, 'busy 时不能覆盖别人的租约')
})

test('心跳过期：就算 pid 还活着，也允许接管（stale），并告诉你是谁留下的', () => {
  const dataDir = tempDir()
  const now = Date.now()
  acquireLease({ dataDir, instanceId: A, hostPid: process.pid, now: now - 3 * LEASE_TTL_MS })
  const result = acquireLease({ dataDir, instanceId: B, hostPid: deadPid(), now })
  assert.equal(result.owner, true)
  assert.equal(result.reason, 'stale')
  assert.equal(result.previous, A)
  assert.equal(readLease(dataDir).instanceId, B)
})

test('进程不在了：即使心跳还很新也能接管', () => {
  const dataDir = tempDir()
  acquireLease({ dataDir, instanceId: A, hostPid: deadPid() })
  const result = acquireLease({ dataDir, instanceId: B, hostPid: process.pid })
  assert.equal(result.reason, 'stale')
})

test('renew 只认自己的租约：被别人拿走后 lost=true', () => {
  const dataDir = tempDir()
  acquireLease({ dataDir, instanceId: A, hostPid: process.pid })
  assert.equal(renewLease({ dataDir, instanceId: A }).lost, false)
  // 模拟「已经被接管」：直接换掉租约的主人。走 acquireLease 不行 —— A 的心跳是新的，
  // B 只会拿到 busy；这里要测的是 renew 的归属判断，不是抢占本身。
  const current = readLease(dataDir)
  fs.writeFileSync(
    path.join(dataDir, 'lease.json'),
    JSON.stringify({ ...current, instanceId: B, hostPid: process.pid, heartbeat: Date.now() }),
    'utf8',
  )
  const lost = renewLease({ dataDir, instanceId: A })
  assert.equal(lost.ok, false)
  assert.equal(lost.lost, true)
  assert.equal(lost.holder, B)
})

test('release 只删自己的：别人的租约原封不动', () => {
  const dataDir = tempDir()
  acquireLease({ dataDir, instanceId: A, hostPid: process.pid })
  const denied = releaseLease({ dataDir, instanceId: B })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'not-owner')
  assert.equal(readLease(dataDir).instanceId, A)

  const released = releaseLease({ dataDir, instanceId: A })
  assert.equal(released.ok, true)
  assert.equal(readLease(dataDir), null)

  const free = acquireLease({ dataDir, instanceId: B, hostPid: process.pid })
  assert.equal(free.reason, 'free')
})

test('lease.json 被写坏：当成没人持有', () => {
  const dataDir = tempDir()
  fs.writeFileSync(path.join(dataDir, 'lease.json'), '{ not json', 'utf8')
  assert.equal(readLease(dataDir), null)
  const result = acquireLease({ dataDir, instanceId: A, hostPid: process.pid })
  assert.equal(result.reason, 'free')
  assert.equal(readLease(dataDir).instanceId, A)
})

test('没有 instanceId 不进临界区', () => {
  const dataDir = tempDir()
  const result = acquireLease({ dataDir, instanceId: '', hostPid: process.pid })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-instance')
})

test('让位请求：写一次只消费一次', () => {
  const dataDir = tempDir()
  requestTakeover({ dataDir, from: B, now: 123 })
  assert.deepEqual(consumeTakeover(dataDir), { from: B, at: 123 })
  assert.equal(consumeTakeover(dataDir), null, '第二次读已经空了')
})

test('isLeaseFresh 按 TTL 判', () => {
  const now = 100_000
  assert.equal(isLeaseFresh({ heartbeat: now }, now), true)
  assert.equal(isLeaseFresh({ heartbeat: now - LEASE_TTL_MS }, now), true)
  assert.equal(isLeaseFresh({ heartbeat: now - LEASE_TTL_MS - 1 }, now), false)
  assert.equal(isLeaseFresh(null, now), false)
})

test('detectProduct 从安装路径认频道', () => {
  const stable = 'C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
  const next = 'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe'
  const other = 'C:\\Program Files\\Other\\electron.exe'
  assert.equal(detectProduct(stable, {}), 'stable')
  assert.equal(detectProduct(next, {}), 'next')
  assert.equal(detectProduct(other, {}), 'unknown')
  assert.equal(detectProduct(other, { DSH_DESKTOP_APP_ROOT: 'C:\\Program Files\\DSH NEXT\\resources' }), 'next')
})
