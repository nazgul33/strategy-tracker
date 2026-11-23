import { describe, test, expect, spyOn } from 'bun:test'
import { broadcastNotice, WEB_ONLY_CHAT_ID, type NoticeLog } from '../src/wire/broadcast'

function harness(allowedChatIds: string[], fail: { send?: string[]; insert?: string[] } = {}) {
  const rows: Array<{ runId: number | null; chatId: string; text: string }> = []
  const sent: Array<{ chatId: string; text: string }> = []
  const events: string[] = []
  const deps = {
    allowedChatIds,
    send: async (chatId: string, text: string) => {
      events.push(`send:${chatId}`)
      // fail.send holds a chat id (every send to it fails) or '<chatId>:<text>' (that one message fails)
      if (fail.send?.includes(chatId) || fail.send?.includes(`${chatId}:${text}`)) throw new Error('telegram-down')
      sent.push({ chatId, text })
    },
    notificationRepo: {
      insert: async (n: { runId: number | null; chatId: string; text: string }) => {
        events.push(`insert:${n.chatId}`)
        if (fail.insert?.includes(n.chatId)) throw new Error('db-down')
        rows.push(n)
      },
    },
  }
  return { deps, rows, sent, events }
}

const PARTS = { record: 'p1\n\np2', send: ['p1', 'p2'] }
const chatIds = (xs: Array<{ chatId: string }>) => xs.map((x) => x.chatId)
const flat = (xs: Array<{ chatId: string; text: string }>) => xs.map((x) => `${x.chatId}:${x.text}`)

describe('broadcastNotice', () => {
  test('no allowed chat: one web row, nothing sent', async () => {
    const h = harness([])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, null, 'hi', { kind: 'closed' })
      expect(WEB_ONLY_CHAT_ID).toBe('web')
      expect(h.rows).toEqual([{ runId: null, chatId: 'web', text: 'hi' }])
      expect(h.sent).toEqual([])
      expect(errors).not.toHaveBeenCalled()
    } finally { errors.mockRestore() }
  })

  test('every chat is recorded first, then sent', async () => {
    const h = harness(['a', 'b'])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, 'hi', { kind: 'digest' })
      expect(h.events).toEqual(['insert:a', 'insert:b', 'send:a', 'send:b'])
      expect(h.rows).toEqual([{ runId: 7, chatId: 'a', text: 'hi' }, { runId: 7, chatId: 'b', text: 'hi' }])
    } finally { errors.mockRestore() }
  })

  test('a failing send keeps the row and the other chats', async () => {
    const h = harness(['a', 'b'], { send: ['a'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, 'hi', { kind: 'digest' })
      expect(chatIds(h.rows)).toEqual(['a', 'b'])
      expect(chatIds(h.sent)).toEqual(['b'])
      expect(errors.mock.calls).toEqual([['notice failed:', 'digest', { runId: 7, chatId: 'a' }, 'Error: telegram-down']])
    } finally { errors.mockRestore() }
  })

  test('a failing insert still sends to that chat', async () => {
    const h = harness(['a', 'b'], { insert: ['a'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, 'hi', { kind: 'digest' })
      expect(chatIds(h.sent)).toEqual(['a', 'b'])
      expect(chatIds(h.rows)).toEqual(['b'])
      expect(errors.mock.calls).toEqual([['notice failed:', 'digest', { runId: 7, chatId: 'a' }, 'Error: db-down']])
    } finally { errors.mockRestore() }
  })

  test('insert and send both failing for a chat logs both and moves on', async () => {
    const h = harness(['a', 'b'], { insert: ['a'], send: ['a'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, 'hi', { kind: 'digest' })
      expect(errors).toHaveBeenCalledTimes(2)
      expect(errors.mock.calls.map((c) => (c[2] as { chatId: string }).chatId)).toEqual(['a', 'a'])
      expect(chatIds(h.rows)).toEqual(['b'])
      expect(chatIds(h.sent)).toEqual(['b'])
    } finally { errors.mockRestore() }
  })

  test('a failing web-only insert is logged, not thrown', async () => {
    const h = harness([], { insert: ['web'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, null, 'hi', { kind: 'conflict' })
      expect(errors.mock.calls).toEqual([['notice failed:', 'conflict', { runId: null, chatId: 'web' }, 'Error: db-down']])
    } finally { errors.mockRestore() }
  })

  test('label and extra shape the log line', async () => {
    const h = harness(['a'], { send: ['a'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, 'hi', { kind: 'sell-attributed', label: 'booking notice failed:', extra: { orderId: 12 } })
      expect(errors.mock.calls[0]).toEqual(['booking notice failed:', 'sell-attributed', { runId: 7, orderId: 12, chatId: 'a' }, 'Error: telegram-down'])
    } finally { errors.mockRestore() }
  })

  test('parts: one row per chat, every part sent in order', async () => {
    const h = harness(['a', 'b'])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, PARTS, { kind: 'digest' })
      expect(h.events).toEqual(['insert:a', 'insert:b', 'send:a', 'send:a', 'send:b', 'send:b'])
      expect(h.rows).toEqual([
        { runId: 7, chatId: 'a', text: 'p1\n\np2' },
        { runId: 7, chatId: 'b', text: 'p1\n\np2' },
      ])
      expect(flat(h.sent)).toEqual(['a:p1', 'a:p2', 'b:p1', 'b:p2'])
    } finally { errors.mockRestore() }
  })

  test('a part that cannot be sent does not stop the later parts or chats', async () => {
    const h = harness(['a', 'b'], { send: ['a:p1'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, PARTS, { kind: 'digest' })
      expect(flat(h.sent)).toEqual(['a:p2', 'b:p1', 'b:p2'])
      expect(h.rows).toHaveLength(2)
      expect(errors.mock.calls).toEqual([['notice failed:', 'digest', { runId: 7, chatId: 'a', part: 1 }, 'Error: telegram-down']])
    } finally { errors.mockRestore() }
  })

  test('parts with no allowed chat: one web row holding the recorded text', async () => {
    const h = harness([])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, PARTS, { kind: 'digest' })
      expect(h.rows).toEqual([{ runId: 7, chatId: 'web', text: 'p1\n\np2' }])
      expect(h.sent).toEqual([])
    } finally { errors.mockRestore() }
  })

  test('a single part logs without a part number', async () => {
    const h = harness(['a'], { send: ['a'] })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await broadcastNotice(h.deps, 7, { record: 'p1', send: ['p1'] }, { kind: 'digest' })
      expect(errors.mock.calls).toEqual([['notice failed:', 'digest', { runId: 7, chatId: 'a' }, 'Error: telegram-down']])
    } finally { errors.mockRestore() }
  })
})

describe('broadcastNotice result', () => {
  async function failedOf(allowed: string[], fail: Parameters<typeof harness>[1], text: Parameters<typeof broadcastNotice>[2] = 'hi') {
    const h = harness(allowed, fail)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      return await broadcastNotice(h.deps, 7, text, { kind: 'digest' })
    } finally { errors.mockRestore() }
  }

  test('all ok: no failure', async () => {
    expect(await failedOf(['a', 'b'], {})).toEqual({ failed: 0 })
  })

  test('one failing send counts 1', async () => {
    expect(await failedOf(['a', 'b'], { send: ['a'] })).toEqual({ failed: 1 })
  })

  test('insert and send failing for one chat count 2', async () => {
    expect(await failedOf(['a', 'b'], { insert: ['a'], send: ['a'] })).toEqual({ failed: 2 })
  })

  test('a failing web-only insert counts 1', async () => {
    expect(await failedOf([], { insert: ['web'] })).toEqual({ failed: 1 })
  })

  test('one failing part of two counts 1', async () => {
    expect(await failedOf(['a', 'b'], { send: ['a:p1'] }, PARTS)).toEqual({ failed: 1 })
  })
})

describe('NoticeLog.extra', () => {
  test('cannot carry the keys the logger sets itself', () => {
    // @ts-expect-error chatId would be shadowed by the logged chat
    const shadowsChat: NoticeLog = { kind: 'digest', extra: { chatId: 'x' } }
    // @ts-expect-error runId would be shadowed by the broadcast's run id
    const shadowsRun: NoticeLog = { kind: 'digest', extra: { runId: 1 } }
    // @ts-expect-error part would be shadowed by the failed part number
    const shadowsPart: NoticeLog = { kind: 'digest', extra: { part: 1 } }
    const ok: NoticeLog = { kind: 'digest', extra: { orderId: 1 } }
    expect([shadowsChat, shadowsRun, shadowsPart, ok]).toHaveLength(4)
  })
})
