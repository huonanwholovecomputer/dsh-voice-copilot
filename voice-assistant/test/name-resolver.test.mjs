import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  aliasPeople,
  createNameResolver,
  decide,
  normalizeContacts,
  normalizeSessions,
  parseWeChatTime,
  rankPeople,
  readAliasBook,
  recencyScore,
} from '../name-resolver.js'
import { bestWindow, syllableSimilarity, syllablesOf } from '../pinyin-match.js'

const NOW = new Date(2026, 10, 18, 21, 30, 0).getTime()

function syllables(text) {
  return syllablesOf(text).map((item) => item.syllable)
}

function score(heard, name) {
  return bestWindow(syllables(heard), syllables(name)).score
}

test('按声母/韵母归类：听混的声母与鼻音尾不再被判成零', () => {
  // 实机案例：用户说「拓亦乐」，转写成「他一乐」→ 三个音节里两个同音，ta/tuo 声母同组
  assert.ok(Math.abs(score('他一乐', '拓亦乐') - 5 / 6) < 1e-9)
  // 同音就是满分
  assert.equal(score('马洪陶', '马宏涛'), 1)
  assert.equal(score('拓异乐', '拓亦乐'), 1)
  // f/h 不分：皇甫韩心 常被听成「黄虎」
  assert.ok(score('黄虎', '皇甫韩心') > 0.9)
  // en/eng 平卷：程丹 ↔ 陈丹
  assert.ok(score('陈丹', '程丹') > 0.93)
  // 完全不像的不能给分
  assert.ok(score('王五', '李科延') < 0.35)
  // 中间漏听一个字：子序列对齐能救回来（连续窗口会两段都不像）
  assert.ok(score('拓乐', '拓亦乐') > 0.8)
  assert.ok(score('尹龙', '尹建龙') > 0.8)
  // 班级前缀不参与、也不算「漏听」
  assert.equal(score('张雨果', '软工2301 张雨果'), 1)
  // 音节级：hu vs fu 同组声母，得分明显高于纯字母距离的 0.5
  assert.ok(syllableSimilarity('hu', 'fu') > 0.8)
})

test('parseWeChatTime 认得微信会话列表里的几种写法', () => {
  assert.equal(parseWeChatTime('21:21', NOW), new Date(2026, 10, 18, 21, 21).getTime())
  // 钟点比现在晚，就是昨天那个点
  assert.equal(parseWeChatTime('23:10', NOW), new Date(2026, 10, 17, 23, 10).getTime())
  assert.equal(parseWeChatTime('昨天 12:30', NOW), new Date(2026, 10, 17, 12, 30).getTime())
  assert.equal(parseWeChatTime('前天 09:05', NOW), new Date(2026, 10, 16, 9, 5).getTime())
  // 2026-11-18 是星期三，按周一算得往前 2 天
  assert.equal(parseWeChatTime('星期一 08:00', NOW), new Date(2026, 10, 16, 8, 0).getTime())
  assert.equal(parseWeChatTime('11月3日 19:48', NOW), new Date(2026, 10, 3, 19, 48).getTime())
  assert.equal(parseWeChatTime('2025年9月6日', NOW), new Date(2025, 8, 6, 12, 0).getTime())
  assert.equal(parseWeChatTime('看不懂的时间'), null)
  assert.equal(parseWeChatTime('', NOW), null)
})

test('recencyScore 分档：一小时内的最高，越久越低但始终有底', () => {
  assert.equal(recencyScore(NOW - 20 * 60_000, NOW).score, 1)
  assert.equal(recencyScore(NOW - 3 * 3_600_000, NOW).score, 0.85)
  assert.equal(recencyScore(NOW - 20 * 3_600_000, NOW).score, 0.7)
  assert.equal(recencyScore(NOW - 2 * 86_400_000, NOW).score, 0.45)
  assert.equal(recencyScore(NOW - 5 * 86_400_000, NOW).score, 0.25)
  assert.equal(recencyScore(NOW - 90 * 86_400_000, NOW).score, 0.05)
  // 从没聊过 / 时间认不出来：给底，不丢候选
  assert.equal(recencyScore(null, NOW).score, 0.05)
})

test('rankPeople：拼音是主角，活跃度只用来分先后', () => {
  const people = [
    { username: 'a', names: [{ text: '软工2301 拓亦乐', kind: 'display' }] },
    { username: 'b', names: [{ text: '软工2301 王一菲', kind: 'display' }] },
    { username: 'c', names: [{ text: '李科延', kind: 'display' }] },
  ]
  const sessions = new Map([
    ['a', { lastAt: NOW - 12 * 60_000, preview: '订单号 HN20260000-0000' }],
    ['b', { lastAt: NOW - 2 * 3_600_000, preview: '在吗' }],
  ])
  const ranked = rankPeople({ heard: '他一乐', people, sessions, now: NOW })
  assert.equal(ranked[0].username, 'a')
  assert.ok(ranked[0].phonetic > 0.8)
  assert.equal(ranked[0].minutes, 12)
  // 完全不像的人在 MIN_PHONETIC 下面就被丢掉
  assert.equal(ranked.some((item) => item.username === 'c'), false)
})

test('rankPeople：近音时最近聊过的人排在前面', () => {
  const people = [
    { username: 'x', names: [{ text: '李华', kind: 'display' }] },
    { username: 'y', names: [{ text: '李花', kind: 'display' }] },
  ]
  const cold = rankPeople({ heard: '李华', people, now: NOW })
  assert.equal(cold[0].username, 'x', '字面完全一致优先')
  const warm = rankPeople({
    heard: '李虎',
    people: [
      { username: 'x', names: [{ text: '李华', kind: 'display' }] },
      { username: 'y', names: [{ text: '李花', kind: 'display' }] },
    ],
    sessions: new Map([['y', { lastAt: NOW - 60_000 }]]),
    now: NOW,
  })
  assert.equal(warm[0].username, 'y', '同音候选里刚聊过的那个胜出')
})

test('decide：够像且领先才敢下结论，否则问一句', () => {
  assert.equal(decide([]).decision, 'none')
  assert.equal(decide([
    { score: 0.86, phonetic: 0.83 },
    { score: 0.61, phonetic: 0.57 },
  ]).decision, 'confident')
  assert.equal(decide([
    { score: 0.86, phonetic: 0.83 },
    { score: 0.85, phonetic: 0.82 },
  ]).decision, 'ask', '两个一样像就得问')
  assert.equal(decide([
    { score: 0.72, phonetic: 0.70 },
    { score: 0.1, phonetic: 0.05 },
  ]).decision, 'ask', '拼音不够像时不下结论')
})

test('normalizeContacts 去掉系统账号与公众号，群默认不进候选', () => {
  const people = normalizeContacts({
    contacts: [
      { username: 'wxid_a', displayName: '软工2301 拓亦乐', nickname: '🍸' },
      { username: 'filehelper', displayName: '文件传输助手' },
      { username: 'gh_1234', displayName: '某某公众号' },
      { username: '123@chatroom', displayName: '软工2301 班级群', type: 'group' },
      { username: 'wxid_b', displayName: '', remark: '王老师', nickname: '老师' },
      { username: '' },
      null,
    ],
  })
  const users = people.map((person) => person.username)
  assert.deepEqual(users, ['wxid_a', '123@chatroom', 'wxid_b'])
  assert.equal(people.find((person) => person.username === '123@chatroom').isGroup, true)
  // 备注也算一种写法，昵称同样是
  const teacher = people.find((person) => person.username === 'wxid_b')
  assert.deepEqual(teacher.names.map((name) => name.text), ['王老师', '老师'])
})

test('normalizeSessions 取最后说话时间，解析不出来的留 null', () => {
  const sessions = normalizeSessions({
    sessions: [
      { username: 'wxid_a', lastMessage: '好的', lastMessageTime: '21:21' },
      { username: 'wxid_b', lastMessage: '?', lastMessageTime: '很久以前' },
    ],
  }, NOW)
  assert.equal(sessions.get('wxid_a').lastAt, new Date(2026, 10, 18, 21, 21).getTime())
  assert.equal(sessions.get('wxid_a').preview, '好的')
  assert.equal(sessions.get('wxid_b').lastAt, null)
})

function fakeLive(payloadByUrl) {
  return async (url) => {
    const key = url.includes('/contacts') ? 'contacts' : url.includes('/sessions') ? 'sessions' : ''
    if (!key || !payloadByUrl[key]) throw new Error(`unexpected url ${url}`)
    return payloadByUrl[key]
  }
}

const CONTACTS = {
  contacts: [
    { username: 'wxid_tuo', displayName: '软工2301 拓亦乐', remark: '软工2301 拓亦乐', nickname: '🍸', type: 'friend' },
    { username: 'wxid_wang', displayName: '软工2301 王一菲', nickname: 'w', type: 'friend' },
    { username: 'wxid_li', displayName: '软工2303 刘浩东', type: 'friend' },
  ],
}

const SESSIONS = {
  sessions: [
    { username: 'wxid_tuo', lastMessage: '订单号: HN20260000-0000', lastMessageTime: '21:21' },
    { username: 'wxid_wang', lastMessage: '在吗', lastMessageTime: '19:10' },
    { username: 'wxid_li', lastMessage: '收到', lastMessageTime: '11月16日 10:00' },
  ],
}

test('resolve：一次调用就定位到人（不再让模型先列名单）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'who-'))
  const resolver = createNameResolver({
    ledgerDb: path.join(dir, 'ledger.db'), // 不存在 → 台账这条来源自动跳过
    fetchJson: fakeLive({ contacts: CONTACTS, sessions: SESSIONS }),
  })
  const out = await resolver.resolve({ heard: '他一乐', context: '帮我打一下他这个东西' })
  assert.equal(out.ok, true)
  assert.equal(out.decision, 'confident')
  assert.equal(out.best.username, 'wxid_tuo')
  assert.equal(out.best.name, '软工2301 拓亦乐')
  assert.ok(out.best.reason.includes('听音'))
  assert.ok(out.say.includes('拓亦乐'))
  assert.equal(out.source.contactsLive, true)
  assert.equal(out.source.ledger, false)
  assert.deepEqual(out.syllables, ['ta', 'yi', 'le'])

  // 完全不像的名字：给 none，而不是硬凑一个
  const miss = await resolver.resolve({ heard: '赵铁柱' })
  assert.equal(miss.decision, 'none')
  assert.equal(miss.best, undefined)

  // 纯拼音/首字母没有汉字可比：直接指回去用 voice_pinyin，不白等网络
  const latin = await resolver.resolve({ heard: 'lfsh' })
  assert.equal(latin.decision, 'none')
  assert.match(latin.say, /voice_pinyin/)
  assert.deepEqual(latin.syllables, [])
})

test('confirm 把听错的写法写进 name_aliases.json，下次字面命中', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'who-'))
  const aliasFile = path.join(dir, 'name_aliases.json')
  const resolver = createNameResolver({
    ledgerDb: path.join(dir, 'ledger.db'),
    fetchJson: fakeLive({ contacts: CONTACTS, sessions: SESSIONS }),
  })

  const saved = await resolver.confirm({ heard: '他一乐', username: 'wxid_tuo' })
  assert.equal(saved.ok, true)
  assert.equal(saved.displayName, '软工2301 拓亦乐')
  assert.deepEqual(saved.aliases, ['他一乐'])

  const book = readAliasBook(aliasFile)
  assert.equal(book.people.wxid_tuo.aliases.includes('他一乐'), true)
  assert.match(book.people.wxid_tuo.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  // 别名表能独立成候选来源（联系人接口挂了也照样认人）
  assert.equal(aliasPeople(book)[0].username, 'wxid_tuo')

  const again = await resolver.resolve({ heard: '他一乐' })
  assert.equal(again.best.username, 'wxid_tuo')
  assert.equal(again.best.matchedKind, 'alias')
  assert.equal(again.best.phonetic, 1)

  // 重复确认不重复记别名
  await resolver.confirm({ heard: '他一乐', username: 'wxid_tuo' })
  assert.deepEqual(readAliasBook(aliasFile).people.wxid_tuo.aliases, ['他一乐'])

  // 只给显示名也能确认
  const byName = await resolver.confirm({ heard: '黄虎', display: '软工2301 王一菲' })
  assert.equal(byName.ok, true)
  assert.equal(byName.username, 'wxid_wang')
  const unknown = await resolver.confirm({ heard: '张三', display: '查无此人' })
  assert.equal(unknown.ok, false)
})

test('voice_who 工具：参数校验与渲染', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'who-'))
  const resolver = createNameResolver({
    ledgerDb: path.join(dir, 'ledger.db'),
    fetchJson: fakeLive({ contacts: CONTACTS, sessions: SESSIONS }),
  })
  const tool = resolver.tool()
  assert.equal(tool.name, 'voice_who')
  assert.deepEqual(tool.parameters.properties.action.enum, ['resolve', 'confirm'])

  const empty = await tool.execute({ action: 'resolve' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /heard/)

  const value = await tool.execute({ action: 'resolve', heard: '他一乐' })
  const [rendered] = tool.output.render({}, value)
  assert.match(rendered.text, /结论：软工2301 拓亦乐/)
  assert.match(rendered.text, /ta yi le/)
  assert.doesNotMatch(rendered.text, /备选/, '结论够硬时不摆备选，避免模型念两个名字')
})
