import { describe, test, expect, spyOn } from 'bun:test'
import { makeCaptureHandlers, type CaptureDeps } from '../src/wire/capture'
import { makeFakes } from './http-fakes'
import { LEAK_KEY, keyEchoFetch, keyParts } from './wire-capture-fakes'

const IMAGE = { base64: 'aGVsbG8=', mime: 'image/png' }
const ADVICE_EN = 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.'
const TEXT = [
  'The vision service did not accept the request — http 500.',
  'In use: model m (env), URL https://vision.example/v1 (env), key (env).',
  ADVICE_EN,
].join('\n')
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
    vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'm', modelSource: 'env' },
    getVisionApiKey: async () => ({ key: 'k', source: 'env' as const }),
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
    expect(rows(f)).toEqual([[null, '777', [
      '비전 서비스가 요청을 받아들이지 않았습니다 — http 500.',
      '사용 중: 모델 m (환경변수), URL https://vision.example/v1 (환경변수), 키 (환경변수).',
      '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.',
    ].join('\n')]])
  })

  test('the key value never reaches a reply, a notice or a log line', async () => {
    const leaky = { getVisionApiKey: async () => ({ key: LEAK_KEY, source: 'settings' as const }), fetchImpl: keyEchoFetch }
    const { f, handlers, sent } = setup(leaky)
    f.repos.notificationRepo.insert = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    const warns = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await handlers.onPhoto('777', IMAGE)
      expect(errors.mock.calls.length).toBeGreaterThan(0)
      expect(keyParts(JSON.stringify(sent))).toEqual([])
      expect(keyParts(JSON.stringify(f.notifications))).toEqual([])
      expect(keyParts(JSON.stringify(errors.mock.calls))).toEqual([])
      expect(keyParts(JSON.stringify(logs.mock.calls))).toEqual([])
      expect(keyParts(JSON.stringify(warns.mock.calls))).toEqual([])
      expect(sent[0]!.split('\n')[0]).toBe(
        'The vision service did not accept the request — http 401: Incorrect API key provided: [redacted] masked sk-LEA*********9c2e.',
      )
      expect(sent[0]).toContain('key (Settings)')
    } finally {
      errors.mockRestore()
      logs.mockRestore()
      warns.mockRestore()
    }

    const stored = setup(leaky)
    await stored.handlers.onPhoto('777', IMAGE)
    expect(rows(stored.f).length).toBe(1)
    expect(keyParts(JSON.stringify(rows(stored.f)))).toEqual([])
  })

  // The empty auto-route group and the 'rejected' outcome cannot be reached through the handlers
  // (see extractFills and ingestCapture), so their wiring is pinned on the source of both
  // wire/capture-route.ts (which emits bad-extract) and wire/capture.ts (which replies to it).
  test('every "could not read fills" reply goes through the one recording helper', async () => {
    const src = await Bun.file(new URL('../src/wire/capture.ts', import.meta.url)).text()
    const core = await Bun.file(new URL('../src/wire/capture-route.ts', import.meta.url)).text()
    const msg = await Bun.file(new URL('../src/wire/capture-bad-extract-message.ts', import.meta.url)).text()
    expect(src.match(/badExtractMessage\(/g)).toHaveLength(1)
    expect(src.match(/t\('capture-bad-extract/g)).toBeNull()
    expect(src.match(/await tellBadExtract\(chatId, /g)).toHaveLength(2)
    expect(src.match(/await tellBadExtract\(chatId, event\)/g)).toHaveLength(1)
    expect(src.match(/await tellBadExtract\(chatId, \{ type: 'bad-extract', reason: 'empty', detail: 'no fills recognized' \}\)/g)).toHaveLength(1)
    expect(msg.match(/t\('capture-bad-extract-/g)).toHaveLength(3)
    expect(core.match(/emit\(badExtract\(/g)).toHaveLength(2)
    expect(core.match(/emit\(badExtract\(extract\.reason, extract\.detail, /g)).toHaveLength(1)
    expect(core.match(/emit\(badExtract\('empty', 'no fills recognized', /g)).toHaveLength(1)
    expect(core.match(/emit\(\{ type: 'bad-extract'/g)).toBeNull()
    expect(core).not.toContain('capture-bad-extract')
  })
})
