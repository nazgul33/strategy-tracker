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

export async function checkWebUpload(c: E2eCtx, today: string): Promise<void> {
  const pinRun = await createRun(c, 'E2E web pin', 'WUPA')
  const autoRun = await createRun(c, 'E2E web auto', 'WUPB')

  // ---- pinned: the other ticker is skipped, the pinned one goes pending -----
  const pinnedBytes = Buffer.from('e2e-web-upload-pinned')
  const pinned = await c.upload(
    [{ side: 'buy', ticker: 'WUPA', shares: 2, price: '50.00', fee: '0.10', date: today }, { side: 'buy', ticker: 'WUPB', shares: 1, price: '20.00', date: today }],
    formOf(new File([pinnedBytes], 'pinned.png', { type: 'image/png' }), String(pinRun)),
  )
  c.ok(pinned.status === 200, `pinned upload -> 200 (got ${pinned.status})`)
  const pinnedEvents = ((await jsonOf(pinned)) as { events: any[] }).events
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
  const autoFill = [{ side: 'buy', ticker: 'WUPB', shares: 3, price: '21.00', date: today }]
  const auto = await c.upload(autoFill, formOf(pngOf('e2e-web-upload-auto', 'auto.png')))
  const autoEvents = ((await jsonOf(auto)) as { events: any[] }).events
  c.ok(auto.status === 200 && autoEvents.length === 1 && autoEvents[0].type === 'outcome' && autoEvents[0].runId === autoRun &&
    autoEvents[0].outcome.pending?.length === 1,
    `auto-routed upload: one outcome on the WUPB run with one pending row: ${JSON.stringify(autoEvents)}`)

  const repeat = await c.upload(autoFill, formOf(pngOf('e2e-web-upload-auto', 'auto.png')))
  const repeatEvents = ((await jsonOf(repeat)) as { events: any[] }).events
  c.ok(repeat.status === 200 && JSON.stringify(repeatEvents) === JSON.stringify([{ type: 'outcome', runId: autoRun, ticker: 'WUPB', outcome: 'duplicate' }]),
    `same bytes uploaded again -> single duplicate outcome: ${JSON.stringify(repeatEvents)}`)
  const wupb = ((await jsonOf(await c.req('GET', '/pending', undefined, c.token))) as any[]).filter((r) => r.ticker === 'WUPB')
  c.ok(wupb.length === 1, `the repeat created no second WUPB pending row: ${JSON.stringify(wupb.map((r) => [r.id, r.shares]))}`)

  // ---- cross-path: a bot photo, then the same bytes over the web -----------
  const botText = 'e2e-web-upload-bot'
  const botFill = [{ side: 'buy', ticker: 'WUPB', shares: 4, price: '22.00', date: today }]
  await c.photo(botFill, { base64: Buffer.from(botText).toString('base64'), mime: 'image/png' })
  const cross = await c.upload(botFill, formOf(pngOf(botText, 'bot.png')))
  const crossEvents = ((await jsonOf(cross)) as { events: any[] }).events
  c.ok(cross.status === 200 && crossEvents.length === 1 && crossEvents[0].outcome === 'duplicate',
    `bytes already captured by the bot -> web upload is a duplicate: ${JSON.stringify(crossEvents)}`)

  // ---- errors --------------------------------------------------------------
  const noRun = await c.upload(autoFill, formOf(pngOf('e2e-web-upload-norun', 'norun.png'), '999999'))
  c.ok(noRun.status === 404 && (await jsonOf(noRun)).error === 'no-run', 'unknown pinned run -> 404 no-run')
  const text = await c.upload(autoFill, formOf(new File([Buffer.from('not an image')], 'note.txt', { type: 'text/plain' })))
  c.ok(text.status === 415 && (await jsonOf(text)).error === 'unsupported-image', 'text/plain upload -> 415 unsupported-image')

  // ---- cleanup: later steps start with nothing pending from this step -------
  const mine = ((await jsonOf(await c.req('GET', '/pending', undefined, c.token))) as any[])
    .filter((r) => r.runId === pinRun || r.runId === autoRun)
  for (const row of mine) {
    const rej = await c.req('POST', `/pending/${row.id}/reject`, {}, c.token)
    c.ok(rej.status === 200, `reject web-upload pending row ${row.id} -> 200`)
  }
}
