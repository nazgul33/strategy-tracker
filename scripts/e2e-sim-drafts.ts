/**
 * Sim-draft steps of the operator e2e: POST creates a draft, PUT applies a changed cut-loss in
 * place, save finalizes, DELETE discards. The HTTP app is wired with the real read-through bar
 * cache over a counting upstream, so "Apply did not refetch" is an assertion on the call count.
 */
import { parseUsd } from '../packages/core/src/money'
import type { OHLCBar } from '../packages/market-data/src/yahoo'
import { jsonOf, type E2eCtx } from './e2e-ctx'

// Every bar is on or before the last finished session of the e2e "today" (2026-11-09 -> Fri 11-06),
// so the cache stores them all; a bar after that would always go to the upstream.
const FIXTURE: [string, string, string, string, string][] = [
  ['2026-11-02', '100.00', '101.00', '99.00', '100.00'],
  ['2026-11-03', '100.00', '101.00', '99.00', '100.00'],
  ['2026-11-04', '99.50', '99.80', '95.00', '96.00'],
  ['2026-11-05', '96.50', '97.00', '96.00', '96.80'],
  ['2026-11-06', '97.00', '98.00', '96.50', '97.50'],
]
const BARS: OHLCBar[] = FIXTURE.map(([date, o, h, l, c]) => ({ date, open: parseUsd(o), high: parseUsd(h), low: parseUsd(l), close: parseUsd(c) }))

export const SIM_TICKER = 'AAPL'

export function countingUpstream(): { upstream: (t: string, f: string, to: string) => Promise<OHLCBar[]>; calls: [string, string, string][] } {
  const calls: [string, string, string][] = []
  return { calls, upstream: async (t, f, to) => { calls.push([t, f, to]); return BARS } }
}

const BODY = { from: '2026-11-02', to: '2026-11-06', poolCents: 1_000_000 }

const eventsOn = async (c: E2eCtx, id: number, date: string): Promise<any[]> => {
  const { days } = await jsonOf(await c.req('GET', `/sim/${id}`, undefined, c.token))
  return days.find((d: any) => d.tradeDate === date).eventsJson
}
const sellFills = (events: any[]) => events.filter((e) => e.type === 'fill' && e.side === 'sell')

// Day 2 (11-03) buys bucket 0: 10 sh @ 99.99 (close 100.00 - 1 tick). Cut-loss 3.5 % puts the
// trigger at floor-to-cent(99.99 * 0.965 = 96.49035) = 96.49, which the 11-04 low (95.00) reaches
// while its open (99.50) does not gap through it, so the stop fills exactly at 96.49.
export async function checkSimDrafts(c: E2eCtx, calls: [string, string, string][]): Promise<void> {
  const created = await c.req('POST', '/sim', { ...BODY, ticker: SIM_TICKER }, c.token)
  const draft = (await jsonOf(created)) as { id: number; dayCount: number }
  c.ok(created.status === 200 && draft.dayCount === 4, `POST /api/sim -> 200, 4 sim days: ${JSON.stringify(draft)}`)
  c.ok(calls.length === 1 && calls[0]!.join() === `${SIM_TICKER},2026-11-02,2026-11-06`, `create fetched the bars once from the upstream: ${JSON.stringify(calls)}`)

  const first = await jsonOf(await c.req('GET', `/sim/${draft.id}`, undefined, c.token))
  c.ok(first.run.draft === true && first.run.cutLossPpm === 0 && first.run.costPpm === 700 && first.run.ticker === SIM_TICKER,
    'new sim is a draft with cutLossPpm 0 and the default costPpm 700')
  const buy = (await eventsOn(c, draft.id, '2026-11-03')).find((e) => e.type === 'fill' && e.side === 'buy')
  c.ok(buy.bucketIndex === 0 && buy.shares === 10 && buy.price === '999900', `11-03 buys bucket 0: 10 sh @ 99.99: ${JSON.stringify(buy)}`)
  c.ok(sellFills(await eventsOn(c, draft.id, '2026-11-04')).length === 0, 'without cut-loss nothing sells on 11-04')
  const list = (await jsonOf(await c.req('GET', '/sim', undefined, c.token))) as any[]
  c.ok(list[0].id === draft.id && list[0].draft === true && list.every((r, i) => i === 0 || list[i - 1].id > r.id),
    'GET /api/sim lists the draft first (newest first, draft: true)')

  const apply = await c.req('PUT', `/sim/${draft.id}`, { ...BODY, cutLossPpm: 35_000 }, c.token)
  c.ok(apply.status === 200 && (await jsonOf(apply)).id === draft.id, 'PUT /api/sim/:id (cutLossPpm 35000) -> 200, same id')
  c.ok(calls.length === 1, `Apply did not call the bar source again (cache hit): ${calls.length} upstream call(s) in total`)
  const applied = await jsonOf(await c.req('GET', `/sim/${draft.id}`, undefined, c.token))
  c.ok(applied.run.draft === true && applied.run.cutLossPpm === 35_000 && applied.days.length === 4, 'applied draft stays a draft with cutLossPpm 35000')
  const stopFill = sellFills(await eventsOn(c, draft.id, '2026-11-04'))
  c.ok(stopFill.length === 1 && stopFill[0].bucketIndex === 0 && stopFill[0].shares === 10 && stopFill[0].price === '964900',
    `the stop sells bucket 0 on 11-04: 10 sh @ 96.49: ${JSON.stringify(stopFill)}`)

  const save = await c.req('POST', `/sim/${draft.id}/save`, undefined, c.token)
  c.ok(save.status === 204, 'POST /api/sim/:id/save -> 204')
  const saved = ((await jsonOf(await c.req('GET', '/sim', undefined, c.token))) as any[]).find((r) => r.id === draft.id)
  c.ok(saved.draft === false && saved.cutLossPpm === 35_000, 'saved sim appears in the list with draft: false')
  const reApply = await c.req('PUT', `/sim/${draft.id}`, { ...BODY }, c.token)
  c.ok(reApply.status === 409 && (await jsonOf(reApply)).error === 'sim-finalized', 'PUT on a saved sim -> 409 sim-finalized')
  c.ok((await c.req('DELETE', `/sim/${draft.id}`, undefined, c.token)).status === 409, 'DELETE on a saved sim -> 409')

  const second = (await jsonOf(await c.req('POST', '/sim', { ...BODY, ticker: SIM_TICKER }, c.token))) as { id: number }
  c.ok(calls.length === 1, 'a second sim over the same range is also served from the cache')
  const discard = await c.req('DELETE', `/sim/${second.id}`, undefined, c.token)
  c.ok(discard.status === 204 && (await c.req('GET', `/sim/${second.id}`, undefined, c.token)).status === 404, 'DELETE discards a draft: 204, then 404')
}
