import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createCourses,
  formatDay,
  normalizePart,
  readMonitorHealth,
  resolveWhen,
  splitPartFromWhen,
  ymd,
} from '../courses.js'

// 用固定的「现在」跑：2026-11-18 周三 21:00（本地时间，和实机一致）。
const NOW = new Date(2026, 10, 18, 21, 0, 0).getTime()

function dayFixture(overrides = {}) {
  return {
    date: '2026-11-19',
    weekday: '周四',
    week: 13,
    term: '2026-3',
    term_start: '2026-08-24',
    status: 'ok',
    note: '',
    snapshot_at: '2026-11-18 20:40:00',
    part: '全天',
    courses: [
      { part: '上午', period: '1-2节', periods: '1-2', time: '', course: '数据结构与算法设计', teacher: '王老师', room: 'A101', building: '综合楼', weeks: '1-5周', kind_name: '理论' },
      { part: '下午', period: '5-6节', periods: '5-6', time: '', course: '大学英语3', teacher: '李老师', room: 'F#208', building: '综合楼', weeks: '1-16周', kind_name: '理论' },
    ],
    ...overrides,
  }
}

test('resolveWhen：相对日期按天推', () => {
  assert.equal(ymd(resolveWhen('今天', NOW).date), '2026-11-18')
  assert.equal(ymd(resolveWhen('明天', NOW).date), '2026-11-19')
  assert.equal(ymd(resolveWhen('后天', NOW).date), '2026-11-20')
  assert.equal(ymd(resolveWhen('昨天', NOW).date), '2026-11-17')
  assert.equal(ymd(resolveWhen('', NOW).date), '2026-11-18')
})

test('resolveWhen：周几取最近的那个（今天也算）', () => {
  // 2026-11-18 是周三
  assert.equal(ymd(resolveWhen('周三', NOW).date), '2026-11-18')
  assert.equal(ymd(resolveWhen('周四', NOW).date), '2026-11-19')
  assert.equal(ymd(resolveWhen('星期二', NOW).date), '2026-11-24')
  assert.equal(ymd(resolveWhen('周六', NOW).date), '2026-11-21')
})

test('resolveWhen：显式日期与中文月日', () => {
  assert.equal(ymd(resolveWhen('2026-11-27', NOW).date), '2026-11-27')
  assert.equal(ymd(resolveWhen('2026/12/1', NOW).date), '2026-12-01')
  assert.equal(ymd(resolveWhen('11月20日', NOW).date), '2026-11-20')
  assert.equal(ymd(resolveWhen('12月3号', NOW).date), '2026-12-03')
  // 年底说「1月5号」指明年
  assert.equal(ymd(resolveWhen('1月5日', NOW).date), '2027-01-05')
})

test('resolveWhen：看不懂就说出来，不静默兜底成今天', () => {
  assert.throws(() => resolveWhen('下周某个时候', NOW), /看不懂的日期/)
})

test('splitPartFromWhen：日期串里的时段拆出来', () => {
  assert.deepEqual(splitPartFromWhen('今天下午'), { when: '今天', part: '下午' })
  assert.deepEqual(splitPartFromWhen('明天早上'), { when: '明天', part: '上午' })
  assert.deepEqual(splitPartFromWhen('晚上'), { when: '', part: '晚上' })
  assert.deepEqual(splitPartFromWhen('明天'), { when: '明天', part: '' })
  assert.deepEqual(splitPartFromWhen(''), { when: '', part: '' })
})

test('normalizePart：口语落到四个时段', () => {
  assert.equal(normalizePart('早上'), '上午')
  assert.equal(normalizePart('中午'), '下午')
  assert.equal(normalizePart('晚自习'), '晚上')
  assert.equal(normalizePart('下午'), '下午')
  assert.equal(normalizePart('瞎写'), '全天')
  assert.equal(normalizePart(''), '全天')
})

test('formatDay：有课时给出结论 + 明细', () => {
  const out = formatDay(dayFixture(), { label: '明天', part: '全天', now: NOW })
  assert.equal(out.status, 'ok')
  assert.equal(out.courses.length, 2)
  assert.equal(out.stale, false)
  assert.match(out.text, /^明天 11月19日（周四，第 13 周）·2 门课/)
  assert.match(out.text, /· 上午 1-2节 数据结构与算法设计｜王老师｜A101/)
  assert.match(out.text, /· 下午 5-6节 大学英语3｜李老师｜F#208/)
  assert.match(out.say, /^明天有 2 门课/)
  assert.match(out.say, /数据结构与算法设计（王老师，A101）/)
})

test('formatDay：按时段过滤（kbmon 的 --json 不做过滤，得自己来）', () => {
  const out = formatDay(dayFixture(), { label: '明天', part: '下午', now: NOW })
  assert.equal(out.courses.length, 1)
  assert.match(out.say, /明天下午有 1 门课，下午5-6节 大学英语3/)
  assert.doesNotMatch(out.text, /数据结构与算法设计/)
})

test('formatDay：问某个没课的时段，把这一天另外的课带上', () => {
  const out = formatDay(dayFixture(), { label: '明天', part: '晚上', now: NOW })
  assert.equal(out.courses.length, 0)
  assert.equal(out.dropped.length, 2)
  assert.match(out.say, /明天晚上没课，另外/)
  assert.match(out.text, /这一天另外还有：/)
})

test('formatDay：各种 status 都说人话', () => {
  const empty = formatDay(dayFixture({ date: '2026-11-21', weekday: '周六', status: 'empty', note: '今天没课', courses: [] }), { label: '周六', now: NOW })
  assert.equal(empty.status, 'empty')
  assert.match(empty.say, /^周六没课/)
  assert.match(empty.text, /没课/)

  const before = formatDay(dayFixture({ status: 'before', note: '还没开学：第 1 周从 2026-08-24（周一）开始', courses: [] }), { label: '9月1日', now: NOW })
  assert.match(before.say, /还没开学/)

  const after = formatDay(dayFixture({ status: 'after', note: '课表只排到第 17 周', courses: [] }), { label: '3月10日', now: NOW })
  assert.match(after.say, /只排到第 17 周/)

  const noStart = formatDay(dayFixture({ status: 'no-start', note: '没配置 2026-3 的开学日期', courses: [] }), { label: '明天', now: NOW })
  assert.match(noStart.say, /没配置/)
})

test('formatDay：监视器停了要提醒（快照旧但刚查过不算）', () => {
  const stopped = formatDay(dayFixture({ snapshot_at: '2026-11-16 17:31:22' }), {
    label: '明天',
    part: '全天',
    now: NOW,
    health: { lastTimetableOk: '2026-11-16 18:00:00' },
  })
  assert.equal(stopped.stale, true)
  assert.match(stopped.say, /不过课表监视器 11-16 18:00 之后就没成功检查过（已经 \d+ 小时），可能有新调课/)
  assert.match(stopped.text, /之后没再成功检查过/)

  // 快照 11-16 的，但监视器 11-18 刚检查过（课表没变化，所以没写新快照）——不该报旧
  const fresh = formatDay(dayFixture({ snapshot_at: '2026-11-16 17:31:22' }), {
    label: '明天',
    part: '全天',
    now: NOW,
    health: { lastTimetableOk: '2026-11-18 20:40:00' },
  })
  assert.equal(fresh.stale, false)
  assert.doesNotMatch(fresh.say, /没成功检查过/)
  assert.match(fresh.text, /课表快照 11-16 17:31，监视器 11-18 20:40 检查过/)
})

test('readMonitorHealth：没有 monitor.db 时返回 null', () => {
  assert.equal(readMonitorHealth(path.join(os.tmpdir(), 'no-such-kbmon-98765')), null)
  assert.equal(readMonitorHealth(''), null)
})

test('formatDay：标签本身就是星期几时不重复', () => {
  const out = formatDay(dayFixture({ date: '2026-11-21', weekday: '周六' }), { label: '周六', now: NOW })
  assert.match(out.text, /^周六 11月21日（第 13 周）/)
  assert.doesNotMatch(out.text, /周六（周六/)
})

test('createCourses：跑子命令并过滤时段，结果进缓存', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    return { stdout: JSON.stringify(dayFixture()) }
  }
  const courses = createCourses({ dir: process.cwd(), python: 'py312', run })
  const first = await courses.today({ when: '明天', part: '上午', now: NOW })
  assert.equal(first.ok, true)
  assert.equal(first.date, '2026-11-19')
  assert.equal(first.part, '上午')
  assert.equal(first.courses.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].part, '上午')
  assert.equal(calls[0].date, '2026-11-19')

  await courses.today({ when: '明天', part: '上午', now: NOW + 1000 })
  assert.equal(calls.length, 1, '同一个日期+时段应该命中缓存')

  await courses.today({ when: '明天', part: '上午', now: NOW + 60_000 })
  assert.equal(calls.length, 2, '超过 TTL 要重新跑')
})

test('createCourses：日期看不懂时直接说，不去跑子进程', async () => {
  let called = 0
  const courses = createCourses({ dir: process.cwd(), run: async () => { called += 1; return { stdout: '{}' } } })
  const out = await courses.today({ when: '随便什么时候' })
  assert.equal(out.ok, false)
  assert.match(out.error, /看不懂的日期/)
  assert.equal(called, 0)
})

test('createCourses：目录不存在 → 提示配置 kbmonDir', async () => {
  const missing = path.join(os.tmpdir(), 'no-such-kbmon-dir-12345')
  const courses = createCourses({ dir: missing })
  const out = await courses.today({ when: '明天', now: NOW })
  assert.equal(out.ok, false)
  assert.match(out.error, /找不到教务监视器目录/)
})

test('createCourses：没有 python / 子进程报错 → 说清楚怎么修', async () => {
  const enoent = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' })
  const courses = createCourses({ dir: process.cwd(), run: async () => { throw enoent } })
  const out = await courses.today({ when: '明天', now: NOW })
  assert.equal(out.ok, false)
  assert.match(out.error, /没找到 python/)

  const broken = createCourses({ dir: process.cwd(), run: async () => { throw Object.assign(new Error('boom'), { detail: 'ModuleNotFoundError: kbmon' }) } })
  const out2 = await broken.today({ when: '明天', now: NOW })
  assert.equal(out2.ok, false)
  assert.match(out2.error, /教务监视器没给出课表：ModuleNotFoundError/)
})

test('createCourses：渲染给模型的文本带明细和口语结论', async () => {
  const courses = createCourses({ dir: process.cwd(), run: async () => ({ stdout: JSON.stringify(dayFixture()) }) })
  const tool = courses.tool()
  assert.equal(tool.name, 'voice_courses')
  assert.deepEqual(tool.parameters.required, [])
  const value = await tool.execute({ when: '明天' })
  const rendered = tool.output.render({ when: '明天' }, value)[0].text
  assert.match(rendered, /数据结构与算法设计｜王老师｜A101/)
  assert.match(rendered, /可以说：明天有 2 门课/)
})

test('createCourses：真实 kbmon 没配目录时也能给出 ok=false 而不抛异常', async () => {
  const courses = createCourses({})
  const out = await courses.today({ when: '今天', now: NOW })
  assert.equal(out.ok, false)
  assert.match(out.error, /还没配置教务监视器目录/)
})

test('model 报错的路径：渲染失败结果也不炸', () => {
  const tool = createCourses({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kbmon-test-')) }).tool()
  const rendered = tool.output.render({}, { ok: false, error: '没找到' })[0].text
  assert.match(rendered, /查课表失败：没找到/)
})
