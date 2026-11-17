/**
 * Cut-loss steps of the operator e2e: the percent survives run creation and storage, the
 * morning pipeline plans a stop_sell per held bucket at the trigger, and a sell booked at a
 * trigger lands in that bucket and cancels its sibling sell_loc.
 *
 * Expected triggers are derived here by hand, never through the strategy helper:
 *   trigger = floor-to-cent(buyPrice * (1_000_000 - cutLossPpm) / 1_000_000), in myriadths.
 */
import { formatUsd } from '../packages/core/src/money'
import { CATALOG } from '../packages/telegram/src/i18n'
import { jsonOf, type E2eCtx } from './e2e-ctx'

export const CUT_LOSS_PPM = 35_000
const CENT = 100n // one cent in myriadths

export function expectedTrigger(buyPriceMyriadths: bigint): bigint {
  return ((buyPriceMyriadths * (1_000_000n - BigInt(CUT_LOSS_PPM))) / 1_000_000n / CENT) * CENT
}

const ordersOf = async (c: E2eCtx, runId: number, date: string): Promise<any[]> =>
  jsonOf(await c.req('GET', `/runs/${runId}/orders?date=${date}`, undefined, c.token))

// Seed bucket 0 (32 sh @ 178.50) and the captured bucket 1 (30 sh @ 179.50) are both held.
// 178.50 * 0.965 = 172.2525 -> 172.25 ; 179.50 * 0.965 = 173.2175 -> 173.21
export async function checkPlannedStops(c: E2eCtx, runId: number, today: string): Promise<void> {
  const run = await jsonOf(await c.req('GET', `/runs/${runId}`, undefined, c.token))
  c.ok(run.cutLossPpm === CUT_LOSS_PPM, `run stores cutLossPpm ${CUT_LOSS_PPM} (3.5 %)`)
  const stops = (await ordersOf(c, runId, today)).filter((o) => o.kind === 'stop_sell').sort((a, b) => a.bucketIdx - b.bucketIdx)
  c.ok(stops.length === 2 && stops.every((o) => o.status === 'open'), `morning plan holds exactly two open stop_sell orders: ${JSON.stringify(stops.map((o) => [o.bucketIdx, o.status]))}`)
  c.ok(stops[0].bucketIdx === 0 && stops[0].shares === 32 && stops[0].limitPrice === '1722500' && BigInt(stops[0].limitPrice) === expectedTrigger(1_785_000n),
    `stop_sell bucket 0: 32 sh, trigger 172.25 (1722500 myriadths): ${JSON.stringify(stops[0])}`)
  c.ok(stops[1].bucketIdx === 1 && stops[1].shares === 30 && stops[1].limitPrice === '1732100' && BigInt(stops[1].limitPrice) === expectedTrigger(1_795_000n),
    `stop_sell bucket 1: 30 sh, trigger 173.21 (1732100 myriadths): ${JSON.stringify(stops[1])}`)
}

// Bucket 0's sell_loc was already cancelled by the operator earlier in the flow, so its stop is
// the only live leg there: a fill at bucket 1's trigger must still pick bucket 1 (173.21 > 172.25).
export async function checkStopBooking(
  c: E2eCtx,
  runId: number,
  today: string,
  sends: { chat: string; text: string }[],
): Promise<void> {
  const before = await ordersOf(c, runId, today)
  const sellLoc1 = before.find((o) => o.kind === 'sell_loc' && o.bucketIdx === 1)
  c.ok(sellLoc1?.status === 'open', 'bucket 1 sell_loc is open before the stop fill')
  const sendsBefore = sends.length

  const book = await c.req('POST', `/runs/${runId}/fills`, { side: 'sell', shares: 30, price: '173.21', fee: '0.50', filledOn: today }, c.token)
  c.ok(book.status === 200, 'POST manual sell 30 sh @ 173.21 (the bucket 1 trigger) -> 200')

  const state = (await jsonOf(await c.req('GET', `/runs/${runId}`, undefined, c.token))).state
  c.ok(state.buckets[1].state === 'empty' && state.buckets[0].state === 'held' && state.buckets[0].shares === 32,
    'sell emptied bucket 1; bucket 0 still holds 32 sh')
  c.ok(state.cashCents === 161_450 + 519_630 - 50, 'cash = 161450 + proceeds 519630 (30 x 173.21) - fee 50 = 681030')
  const fills = (await jsonOf(await c.req('GET', `/runs/${runId}/fills`, undefined, c.token))) as any[]
  const sell = fills.find((f) => f.side === 'sell')
  c.ok(fills.filter((f) => f.side === 'sell').length === 1 && sell.bucketIdx === 1 && sell.shares === 30 && sell.price === '1732100' && sell.filledOn === today,
    `exactly one sell fill, in bucket 1 @ 1732100: ${JSON.stringify(sell)}`)

  const after = await ordersOf(c, runId, today)
  const pick = (kind: string, bucket: number) => after.find((o) => o.kind === kind && o.bucketIdx === bucket)
  c.ok(pick('stop_sell', 1).status === 'filled', 'bucket 1 stop_sell flipped to filled')
  const sibling = pick('sell_loc', 1)
  c.ok(sibling.status === 'cancelled' && sibling.cancelReason === 'broker-filled', `bucket 1 sibling sell_loc cancelled with reason broker-filled: ${JSON.stringify(sibling)}`)
  c.ok(pick('stop_sell', 0).status === 'open', 'bucket 0 stop_sell untouched (still open)')
  c.ok(pick('sell_loc', 0).cancelReason === 'stale-price', 'bucket 0 sell_loc keeps the operator cancel reason')
  c.ok(after.filter((o) => o.status === 'cancelled').length === 2, 'exactly two cancelled orders overall (operator + sibling)')

  const expected = CATALOG['sibling-cancelled'].en
    .replace('{kind}', 'sell_loc').replace('{bucket}', '1').replace('{price}', formatUsd(BigInt(sellLoc1.limitPrice)))
  const added = sends.slice(sendsBefore)
  c.ok(added.length === 1 && added[0]!.chat === 'chat-1' && added[0]!.text === expected, `one sibling-cancel push to the allowed chat: ${JSON.stringify(added)}`)
  const notifs = (await jsonOf(await c.req('GET', `/runs/${runId}/notifications`, undefined, c.token))) as any[]
  c.ok(notifs.filter((n) => n.text === expected).length === 1, 'sibling-cancel notification row recorded once')
}
