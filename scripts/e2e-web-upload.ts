/**
 * Web screenshot upload step of the operator e2e: POST /api/captures through the real route and
 * the shared capture core. Covers a pinned upload (other tickers skipped), an auto-routed one,
 * the hash duplicate guard for a repeat and across the bot and the web, and the error answers.
 * Leaves nothing pending behind.
 */
import { jsonOf, type E2eCtx } from './e2e-ctx'

const pngOf = (text: string, name: string) => new File([Buffer.from(text)], name, { type: 'image/png' })

function formOf(image: File, runId?: string): FormData {
  const form = new FormData()
  form.append('image', image)
  if (runId !== undefined) form.append('runId', runId)
  return form
}

async function createRun(c: E2eCtx, name: string, ticker: string): Promise<number> {
  const resp = await c.req('POST', '/runs', { name, ticker, poolCents: 1_000_000, costPpm: 1_000 }, c.token)
  c.ok(resp.status === 201, `POST /api/runs '${name}' (${ticker}) -> 201`)
  return ((await jsonOf(resp)) as { id: number }).id
}

async function eventsOf(c: E2eCtx, resp: Response, label: string): Promise<any[]> {
  c.ok(resp.status === 200, `${label} -> 200 (got ${resp.status})`)
  return ((await jsonOf(resp)) as { events: any[] }).events
}

async function pendingOf(c: E2eCtx, runIds: number[]): Promise<any[]> {
  const resp = await c.req('GET', '/pending', undefined, c.token)
  c.ok(resp.status === 200, `GET /api/pending -> 200 (got ${resp.status})`)
  return ((await jsonOf(resp)) as any[]).filter((r) => runIds.includes(r.runId))
}

export async function checkWebUpload(c: E2eCtx, today: string): Promise<void> {
  const pinRun = await createRun(c, 'E2E web pin', 'WUPA')
  const autoRun = await createRun(c, 'E2E web auto', 'WUPB')

  // ---- pinned: the other ticker is skipped, the pinned one goes pending -----
  const pinnedBytes = Buffer.from('e2e-web-upload-pinned')
  const pinned = await c.upload(
    [{ side: 'buy', ticker: 'WUPA', shares: 2, price: '50.00', fee: '0.10', date: today }, { side: 'buy', ticker: 'WUPB', shares: 1, price: '20.00', date: today }],
    formOf(new File([pinnedBytes], 'pinned.png', { type: 'image/png' }), String(pinRun)),
  )
  const pinnedEvents = await eventsOf(c, pinned, 'pinned upload')
  c.ok(JSON.stringify(pinnedEvents.map((e) => e.type)) === JSON.stringify(['pin-skipped', 'outcome']),
    `pinned upload events are pin-skipped then outcome: ${JSON.stringify(pinnedEvents)}`)
  c.ok(JSON.stringify(pinnedEvents[0].tickers) === JSON.stringify(['WUPB']), 'pin-skipped names the ignored ticker WUPB')
  const pinnedOutcome = pinnedEvents[1]
  c.ok(pinnedOutcome.runId === pinRun && pinnedOutcome.outcome.pending?.length === 1 && pinnedOutcome.outcome.pending[0].price === '50.00',
    `pinned outcome: one pending WUPA row @ 50.00 on the pinned run: ${JSON.stringify(pinnedOutcome)}`)
  const pinnedCapture = pinnedOutcome.outcome.pending[0].captureId as number
  const img = await c.req('GET', `/captures/${pinnedCapture}/image`, undefined, c.token)
  c.ok(img.status === 200 && Buffer.from(await img.arrayBuffer()).equals(pinnedBytes),
    'GET /captures/:id/image serves the uploaded bytes exactly')

  // ---- auto-routed by ticker, then the same bytes again -------------------
  // The second read of the same bytes answers a different fill, so fill-level dedup cannot
  // report the duplicate: only the image-hash guard can.
  const autoEvents = await eventsOf(c,
    await c.upload([{ side: 'buy', ticker: 'WUPB', shares: 3, price: '21.00', date: today }], formOf(pngOf('e2e-web-upload-auto', 'auto.png'))),
    'auto-routed upload')
  c.ok(autoEvents.length === 1 && autoEvents[0].type === 'outcome' && autoEvents[0].runId === autoRun &&
    autoEvents[0].outcome.pending?.length === 1,
    `auto-routed upload: one outcome on the WUPB run with one pending row: ${JSON.stringify(autoEvents)}`)

  const repeatEvents = await eventsOf(c,
    await c.upload([{ side: 'buy', ticker: 'WUPB', shares: 7, price: '23.50', date: today }], formOf(pngOf('e2e-web-upload-auto', 'auto.png'))),
    'repeat upload')
  c.ok(JSON.stringify(repeatEvents) === JSON.stringify([{ type: 'outcome', runId: autoRun, ticker: 'WUPB', outcome: 'duplicate' }]),
    `same bytes uploaded again (vision reads another fill) -> single duplicate outcome: ${JSON.stringify(repeatEvents)}`)
  const afterRepeat = await pendingOf(c, [autoRun])
  c.ok(afterRepeat.length === 1, `the repeat created no second WUPB pending row: ${JSON.stringify(afterRepeat.map((r) => [r.id, r.shares]))}`)

  // ---- cross-path: a bot photo, then the same bytes over the web -----------
  const botText = 'e2e-web-upload-bot'
  await c.photo([{ side: 'buy', ticker: 'WUPB', shares: 4, price: '22.00', date: today }], { base64: Buffer.from(botText).toString('base64'), mime: 'image/png' })
  const afterBot = await pendingOf(c, [autoRun])
  c.ok(afterBot.length === 2 && afterBot.some((r) => r.ticker === 'WUPB' && r.shares === 4),
    `the bot photo left a WUPB pending row of 4 shares: ${JSON.stringify(afterBot.map((r) => [r.id, r.shares]))}`)
  const crossEvents = await eventsOf(c,
    await c.upload([{ side: 'buy', ticker: 'WUPB', shares: 9, price: '24.25', date: today }], formOf(pngOf(botText, 'bot.png'))),
    'cross-path upload')
  c.ok(crossEvents.length === 1 && crossEvents[0].outcome === 'duplicate',
    `bytes already captured by the bot (vision reads another fill) -> web upload is a duplicate: ${JSON.stringify(crossEvents)}`)
  const afterCross = await pendingOf(c, [autoRun])
  c.ok(afterCross.length === 2, `the cross-path upload created no new pending row: ${JSON.stringify(afterCross.map((r) => [r.id, r.shares]))}`)

  // ---- errors --------------------------------------------------------------
  const errFill = [{ side: 'buy', ticker: 'WUPB', shares: 3, price: '21.00', date: today }]
  const noRun = await c.upload(errFill, formOf(pngOf('e2e-web-upload-norun', 'norun.png'), '999999'))
  c.ok(noRun.status === 404, `unknown pinned run -> 404 (got ${noRun.status})`)
  c.ok((await jsonOf(noRun)).error === 'no-run', 'unknown pinned run -> error no-run')
  const text = await c.upload(errFill, formOf(new File([Buffer.from('not an image')], 'note.txt', { type: 'text/plain' })))
  c.ok(text.status === 415, `text/plain upload -> 415 (got ${text.status})`)
  c.ok((await jsonOf(text)).error === 'unsupported-image', 'text/plain upload -> error unsupported-image')

  // ---- cleanup: later steps start with nothing pending from this step -------
  // One WUPA row (pinned), two WUPB rows (auto-routed upload and bot photo).
  const mine = await pendingOf(c, [pinRun, autoRun])
  c.ok(mine.length === 3, `the step left exactly 3 pending rows on its runs: ${JSON.stringify(mine.map((r) => [r.id, r.ticker, r.shares]))}`)
  for (const row of mine) {
    const rej = await c.req('POST', `/pending/${row.id}/reject`, {}, c.token)
    c.ok(rej.status === 200, `reject web-upload pending row ${row.id} -> 200`)
  }
  const left = await pendingOf(c, [pinRun, autoRun])
  c.ok(left.length === 0, `no pending rows remain on the step's runs: ${JSON.stringify(left.map((r) => r.id))}`)
}