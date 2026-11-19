import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import {
  applyLiveDisplayNames,
  insertMissingChats,
  liveContactsToNames,
  liveSessionsToMap,
} from '../agents/xiaoyin/lib/ledger-groups.js'

test('liveContactsToNames 按 备注 > 昵称 > 微信号 取显示名', () => {
  const names = liveContactsToNames({
    contacts: [
      { username: 'wxid_a', displayName: '软工2301 皇甫韩心', remark: '软工2301 皇甫韩心', nickname: 'hfhx.' },
      { username: 'wxid_b', displayName: '', remark: '', nickname: 'Estrella', alias: 'x_test_alias' },
      { username: 'wxid_c', displayName: 'wxid_c' },
      { username: '' },
      null,
    ],
  })
  assert.equal(names.get('wxid_a'), '软工2301 皇甫韩心')
  assert.equal(names.get('wxid_b'), 'Estrella')
  assert.equal(names.has('wxid_c'), false, '显示名等于 wxid 时不算有效名字')
  assert.equal(names.size, 2)
})

test('applyLiveDisplayNames 用实时名覆盖台账名，只数真正改动的行', () => {
  const chats = [
    { username: 'wxid_a', name: '皇甫韩心' },
    { username: 'wxid_b', name: '软工2302 马宏涛' },
    { username: 'wxid_c', name: '某个陌生人' },
  ]
  const applied = applyLiveDisplayNames(
    chats,
    new Map([
      ['wxid_a', '软工2301 皇甫韩心'],
      ['wxid_b', '软工2302 马宏涛'],
    ]),
  )
  assert.equal(applied, 1)
  assert.equal(chats[0].name, '软工2301 皇甫韩心')
  assert.equal(chats[1].name, '软工2302 马宏涛')
  assert.equal(chats[2].name, '某个陌生人', '实时接口没给的人保持台账名')
})

test('实时名字为空时不动任何行', () => {
  const chats = [{ username: 'wxid_a', name: '旧名字' }]
  assert.equal(applyLiveDisplayNames(chats, new Map()), 0)
  assert.equal(applyLiveDisplayNames(chats, null), 0)
  assert.equal(chats[0].name, '旧名字')
})

test('liveSessionsToMap 读出实时会话的 username/isGroup/预览', () => {
  const sessions = liveSessionsToMap({
    sessions: [
      { username: 'wxid_new', name: '囍', lastMessage: 'OK', unreadCount: 2, isGroup: false },
      { id: '123@chatroom', name: '打印群', isGroup: true, enterpriseName: '' },
      { name: '没有 username' },
      null,
    ],
  })
  assert.equal(sessions.size, 2)
  assert.equal(sessions.get('wxid_new').name, '囍')
  assert.equal(sessions.get('wxid_new').unread, 2)
  assert.equal(sessions.get('123@chatroom').isGroup, true)
})

test('insertMissingChats 只补台账没有的会话，用实时名并默认纳入', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE chats (
      username TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', is_group INTEGER NOT NULL DEFAULT 0,
      is_enterprise INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
      last_preview TEXT NOT NULL DEFAULT '', unread INTEGER NOT NULL DEFAULT 0,
      last_message_raw TEXT NOT NULL DEFAULT '', last_seen_ts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.prepare("INSERT INTO chats (username, name, excluded) VALUES (?, ?, 1)").run('wxid_old', '旧备注')
  const sessions = liveSessionsToMap({
    sessions: [
      { username: 'wxid_old', name: '旧备注' },
      { username: 'wxid_new', name: '囍', lastMessage: 'OK' },
    ],
  })
  const added = insertMissingChats(db, sessions, new Map([['wxid_new', '软工2304 新同学']]))
  assert.equal(added, 1)
  const rows = db.prepare('SELECT username, name, excluded, last_preview FROM chats ORDER BY username').all()
  assert.deepEqual(rows.map((r) => r.username), ['wxid_new', 'wxid_old'])
  assert.equal(rows[0].name, '软工2304 新同学', '优先用实时备注名')
  assert.equal(rows[0].excluded, 0, '新会话默认纳入')
  assert.equal(rows[1].excluded, 1, '已有行的排除标记不动')
  assert.equal(insertMissingChats(db, sessions, null), 0, '再跑一次不重复插入')
  db.close()
})
