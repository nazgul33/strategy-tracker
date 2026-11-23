import { describe, test, expect, spyOn } from 'bun:test'
import { makeCaptureHandlers, type CaptureDeps } from '../src/wire/capture'
import { makeFakes } from './http-fakes'

const IMAGE = { base64: 'aGVsbG8=', mime: 'image/png' }
const TEXT = 'Could not read fills from this image — http 500. Book the fill manually in the web UI.'
// The vision endpoint answers 500, so the extract fails with detail 'http 500'.
const vision500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch

// events lists every insert and send in the order they happened, as 'insert:<chatId>' / 'send:<chatId>'.
function setup(over: Partial<CaptureDeps> = {}) {
  const f = makeFakes()
  const events: string[] = []
  const sent: string[] = []
  const insert = f.repos.notificationRepo.insert
  f.repos.notificationRepo.insert = async (n) => { events.push(`insert:${n.chatId}`); await insert(n) }
  const handlers = makeCaptureHandlers({
    repos: f.repos,
    vision: { baseUrl: 'https://vision.example/v1', model: 'm' },
    getVisionApiKey: async () => 'k',
    today: () => '2026-11-10',
    allowedChatIds: ['111', '222'],
    fetchImpl: vision500,
    send: async (chatId, text) => { events.push(`send:${chatId}`); sent.push(text) },
    ...over,
  })
  return { f, handlers, events, sent }
}
const rows = (f: ReturnType<typeof makeFakes>) => f.notifications.map((n) => [n.runId, n.chatId, n.text])

describe('could not read fills replies', () => {
  test('a failed extract is recorded first, then sent, to the asking chat only', async () => {
    const { f, handlers, events, sent } = setup()
    await handlers.onPhoto('777', IMAGE)
    expect(events).toEqual(['insert:777', 'send:777'])
    expect(rows(f)).toEqual([[null, '777', TEXT]])
    expect(sent).toEqual([TEXT])
  })

  test('Telegram refusing the reply: the row is kept and the handler resolves', async () => {
    const { f, handlers } = setup({ send: async () => { throw new Error('telegram-down') } })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await handlers.onPhoto('777', IMAGE)
      expect(rows(f)).toEqual([[null, '777', TEXT]])
      expect(errors.mock.calls).toEqual([['notice failed:', 'capture-bad-extract', { runId: null, chatId: '777' }, 'Error: telegram-down']])
    } finally {
      errors.mockRestore()
    }
  })

  test('the database refusing the row: the reply is still sent and the handler resolves', async () => {
    const { f, handlers, sent } = setup()
    f.repos.notificationRepo.insert = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await handlers.onPhoto('777', IMAGE)
      expect(sent).toEqual([TEXT])
      expect(rows(f)).toEqual([])
      expect(errors.mock.calls).toEqual([['notice failed:', 'capture-bad-extract', { runId: null, chatId: '777' }, 'Error: db-down']])
    } finally {
      errors.mockRestore()
    }
  })

  test('the reply is recorded in Korean when the bot speaks Korean', async () => {
    const { f, handlers } = setup({ lang: 'ko' })
    await handlers.onPhoto('777', IMAGE)
    expect(rows(f)).toEqual([[null, '777', '이미지에서 체결을 읽을 수 없습니다 — http 500. 웹 UI에서 직접 예약해 주세요.']])
  })

  // The empty auto-route group and the 'rejected' outcome cannot be reached through the handlers
  // (see extractFills and ingestCapture), so their wiring is pinned on the source.
  test('every "could not read fills" reply goes through the one recording helper', async () => {
    const src = await Bun.file(new URL('../src/wire/capture.ts', import.meta.url)).text()
    expect(src.match(/t\('capture-bad-extract'/g)).toHaveLength(1)
    expect(src.match(/await tellBadExtract\(chatId, /g)).toHaveLength(3)
    expect(src.match(/await tellBadExtract\(chatId, 'no fills recognized'\)/g)).toHaveLength(2)
  })
})
