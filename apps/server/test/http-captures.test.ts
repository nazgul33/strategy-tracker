import { describe, expect, spyOn, test } from 'bun:test'
import { createApp, type HttpDeps } from '../src/http/app'
import { declaredTooLarge, MAX_UPLOAD_BODY_BYTES } from '../src/http/routes/captures'
import { MAX_IMAGE_BYTES } from '../src/domain/capture-image'
import { makeCaptureRouting, type CaptureEvent, type RouteCaptureRequest } from '../src/wire/capture-route'
import type { PendingFillRow } from '../src/domain/booking'
import { loginAs, makeDeps, makeFakes } from './http-fakes'
import { keyEchoFetch, keyParts, LEAK_KEY } from './wire-capture-fakes'

type App = ReturnType<typeof createApp>

const PENDING_ROW: PendingFillRow = {
  id: 1, runId: 7, captureId: 1, side: 'buy', ticker: 'NVDA', shares: 30, price: '179.50', fee: '0.50',
  filledOn: '2026-11-10', detectedFilledOn: '2026-11-10', status: 'pending', needsBucket: false, dateAfterToday: false,
}

function png(size = 4): File {
  return new File([new Uint8Array(size)], 'f.png', { type: 'image/png' })
}

function form(fields: Array<[string, string | File]>): FormData {
  const body = new FormData()
  for (const [k, v] of fields) body.append(k, v)
  return body
}

function post(app: App, auth: Record<string, string>, body: FormData, headers: Record<string, string> = {}) {
  return app.request('/api/captures', { method: 'POST', body, headers: { ...auth, ...headers } })
}

// A fake routing core: records each request, then emits the scripted events (and optionally throws).
function setup(opts: { events?: CaptureEvent[]; throwAfter?: Error; defaults?: Partial<HttpDeps['defaultSettings']> } = {}) {
  const f = makeFakes()
  const calls: RouteCaptureRequest[] = []
  const base = makeDeps(f)
  const deps: HttpDeps = {
    ...base,
    defaultSettings: { ...base.defaultSettings, ...opts.defaults },
    routeCapture: async (req, emit) => {
      calls.push(req)
      for (const e of opts.events ?? []) await emit(e)
      if (opts.throwAfter) throw opts.throwAfter
    },
  }
  return { f, calls, app: createApp(deps) }
}

describe('POST /api/captures', () => {
  test('needs a session', async () => {
    const { app, calls } = setup()
    const res = await post(app, {}, form([['image', png()]]))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  test('503 vision-not-configured when the base URL or the model is empty', async () => {
    for (const defaults of [{ visionModel: '' }, { visionBaseUrl: '' }]) {
      const { app, calls } = setup({ defaults })
      const res = await post(app, await loginAs(app), form([['image', png()]]))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'vision-not-configured' })
      expect(calls).toHaveLength(0)
    }
  })

  test('400 invalid-body', async () => {
    const bodies: FormData[] = [
      form([]),
      form([['image', 'not-a-file']]),
      form([['image', png()], ['image', png()]]),
      ...['abc', '0', '07', '-1'].map((runId) => form([['image', png()], ['runId', runId]])),
    ]
    for (const body of bodies) {
      const { app, calls } = setup()
      const res = await post(app, await loginAs(app), body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid-body' })
      expect(calls).toHaveLength(0)
    }
  })

  test('415 unsupported-image', async () => {
    for (const type of ['text/plain', 'image/heic', '']) {
      const { app, calls } = setup()
      const file = new File([new Uint8Array(4)], 'f.bin', { type })
      const res = await post(app, await loginAs(app), form([['image', file]]))
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({ error: 'unsupported-image' })
      expect(calls).toHaveLength(0)
    }
  })

  test('413 image-too-large above 8 MB, accepted at exactly 8 MB', async () => {
    const big = setup()
    const tooBig = await post(big.app, await loginAs(big.app), form([['image', png(MAX_IMAGE_BYTES + 1)]]))
    expect(tooBig.status).toBe(413)
    expect(await tooBig.json()).toEqual({ error: 'image-too-large' })
    expect(big.calls).toHaveLength(0)

    const exact = setup()
    const atCap = await post(exact.app, await loginAs(exact.app), form([['image', png(MAX_IMAGE_BYTES)]]))
    expect(atCap.status).toBe(200)
    expect(exact.calls).toHaveLength(1)
  })

  test('declaredTooLarge', () => {
    expect(declaredTooLarge(undefined)).toBe(false)
    expect(declaredTooLarge(String(MAX_UPLOAD_BODY_BYTES))).toBe(false)
    expect(declaredTooLarge(String(MAX_UPLOAD_BODY_BYTES + 1))).toBe(true)
    expect(declaredTooLarge('abc')).toBe(false)
  })

  test("pinned upload: the core gets the run id, the bot's base64 and the 50-second limit", async () => {
    const events: CaptureEvent[] = [{ type: 'outcome', runId: 7, ticker: 'NVDA', outcome: { pending: [PENDING_ROW] } }]
    const { app, calls } = setup({ events })
    const file = new File([new Uint8Array([1, 2, 3])], 'f.png', { type: 'image/png' })
    const res = await post(app, await loginAs(app), form([['image', file], ['runId', '7']]))
    expect(calls).toEqual([{ image: { base64: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/png' }, pinnedRunId: 7, visionTimeoutMs: 50_000 }])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ events })
  })

  test('auto-routed upload passes no run id', async () => {
    const { app, calls } = setup()
    const res = await post(app, await loginAs(app), form([['image', png()]]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ events: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.pinnedRunId).toBeNull()
  })

  test('an unknown pinned run is 404 no-run', async () => {
    const { app } = setup({ events: [{ type: 'unknown-run', id: 9 }] })
    const res = await post(app, await loginAs(app), form([['image', png()], ['runId', '9']]))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no-run' })
  })

  test('a bad-extract is a 200 result and records no notice', async () => {
    const event: CaptureEvent = {
      type: 'bad-extract',
      reason: 'http',
      detail: 'http 500',
      vision: { model: 'm', modelSource: 'settings', baseUrl: 'http://x', baseUrlSource: 'env', keySource: 'none' },
    }
    const { app, f } = setup({ events: [event] })
    const res = await post(app, await loginAs(app), form([['image', png()]]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ events: [event] })
    expect(f.notifications).toEqual([])
    expect(f.sent).toEqual([])
  })

  test('the key value never reaches the upload answer', async () => {
    const f = makeFakes()
    const app = createApp({
      ...makeDeps(f),
      routeCapture: makeCaptureRouting({
        repos: f.repos,
        vision: { baseUrl: 'http://x', baseUrlSource: 'env', model: 'm', modelSource: 'env' },
        getVisionApiKey: async () => ({ key: LEAK_KEY, source: 'settings' }),
        today: () => '2026-11-10',
        fetchImpl: keyEchoFetch,
      }),
    })
    const auth = await loginAs(app)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await post(app, auth, form([['image', png()]]))
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(keyParts(text)).toEqual([])
      const event = JSON.parse(text).events[0]
      expect(event).toMatchObject({ type: 'bad-extract', reason: 'http' })
      expect(event.detail).toContain('[redacted]')
      expect(keyParts(JSON.stringify(errors.mock.calls))).toEqual([])
      expect(f.notifications).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  test('an unexpected throw is 500 capture-failed and logged', async () => {
    const events: CaptureEvent[] = [{ type: 'outcome', runId: 7, ticker: 'NVDA', outcome: { pending: [PENDING_ROW] } }]
    const { app } = setup({ events, throwAfter: new Error('boom') })
    const auth = await loginAs(app)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await post(app, auth, form([['image', png()]]))
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'capture-failed' })
      expect(errors.mock.calls).toEqual([['capture upload failed:', 'Error: boom']])
    } finally {
      errors.mockRestore()
    }
  })
})
