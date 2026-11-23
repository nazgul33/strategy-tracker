/**
 * Order-type attribution and future-date steps of the operator e2e, each on a run of its own
 * (own ticker) so the NVDA state later steps rely on stays untouched:
 *   OTWO  two held buckets: bucket 0 (bought 178.50, stop 172.25) and bucket 1 (bought 150.00,
 *         target above 150.30). A sell at 160.00 fits bucket 0's stop AND bucket 1's target,
 *         the issue-74 shape, so an untyped sell is the operator's choice.
 *   OTYP  one held bucket, for a captured stop-market sell and what the pending list says of it.
 * The morning plan that creates the orders is the real pipeline, run once after both runs exist.
 */
import { prevTradingDay } from '../packages/calendar/src/index'
import { CUT_LOSS_PPM } from './e2e-cutloss'
import { jsonOf, type E2eCtx } from './e2e-ctx'

const photoOf = (text: string) => ({ base64: Buffer.from(text).toString('base64'), mime: 'image/png' })
const nextDay = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

const createRun = async (c: E2eCtx, name: string, ticker: string, buckets: { shares: number; buyPrice: string; filledOn: string }[]): Promise<number> => {
  const res = await c.req('POST', '/runs', {
    name, ticker, poolCents: 1_000_000, costPpm: 1_000, cutLossPpm: CUT_LOSS_PPM,
    seed: { cashCents: 800_000, buckets },
  }, c.token)
  c.ok(res.status === 201, `POST /api/runs ${ticker} (seeded, ${buckets.length} bucket(s)) -> 201`)
  return ((await jsonOf(res)) as { id: number }).id
}

const pendingOf = async (c: E2eCtx, runId: number): Promise<any[]> =>
  ((await jsonOf(await c.req('GET', '/pending', undefined, c.token))) as any[]).filter((p) => p.runId === runId)

export async function checkOrderType(c: E2eCtx, today: string, prev: string, runMorning: () => Promise<unknown>): Promise<void> {
  const twoId = await createRun(c, 'E2E two buckets', 'OTWO', [
    { shares: 10, buyPrice: '178.50', filledOn: prev },
    { shares: 10, buyPrice: '150.00', filledOn: prevTradingDay(prev) },
  ])
  const oneId = await createRun(c, 'E2E stop market', 'OTYP', [{ shares: 3, buyPrice: '44.80', filledOn: prev }])
  c.ok((await runMorning()) === 'sent', 'morning pipeline planned the order-type runs')

  const orders = (await jsonOf(await c.req('GET', `/runs/${twoId}/orders?date=${today}`, undefined, c.token))) as any[]
  const legOf = (kind: string, bucket: number) => orders.find((o) => o.kind === kind && o.bucketIdx === bucket)
  c.ok(legOf('stop_sell', 0)?.limitPrice === '1722500' && BigInt(legOf('sell_loc', 1)?.limitPrice) < 1_600_000n && BigInt(legOf('sell_loc', 0)?.limitPrice) > 1_600_000n && BigInt(legOf('stop_sell', 1)?.limitPrice) < 1_600_000n,
    `160.00 fits bucket 0's stop (172.25) and bucket 1's target, not bucket 0's target or bucket 1's stop: ${JSON.stringify(orders.map((o) => [o.kind, o.bucketIdx, o.limitPrice]))}`)

  // ---- a fill dated after today is refused and writes nothing ---------------
  const fillsBefore = (await jsonOf(await c.req('GET', `/runs/${twoId}/fills`, undefined, c.token))) as any[]
  const future = await c.req('POST', `/runs/${twoId}/fills`, { side: 'sell', shares: 5, price: '160.00', fee: '0.50', bucketIdx: 1, filledOn: nextDay(today) }, c.token)
  c.ok(future.status === 422 && (await jsonOf(future)).error === 'fill-date-in-future', 'manual fill dated the day after today -> 422 fill-date-in-future')
  const fillsAfter = (await jsonOf(await c.req('GET', `/runs/${twoId}/fills`, undefined, c.token))) as any[]
  const stateAfter = (await jsonOf(await c.req('GET', `/runs/${twoId}`, undefined, c.token))).state
  c.ok(fillsAfter.length === fillsBefore.length && stateAfter.buckets[1].shares === 10 && stateAfter.cashCents === 800_000,
    'the refused future-dated fill added no fill and left bucket 1 and the cash alone')

  // ---- captured stop-market sell: the three order values reach the pending list ----
  await c.photo([{ side: 'sell', ticker: 'OTYP', shares: 1, price: '43.25', fee: '0.03', date: today, orderType: '매도/STOP(시장가)', orderPrice: '0.0000', orderedShares: 1 }], photoOf('e2e-order-type-stop'))
  const [stopRow, ...restStop] = await pendingOf(c, oneId)
  c.ok(!!stopRow && restStop.length === 0, 'the stop-market capture left exactly one pending row')
  c.ok(stopRow.detected?.orderType === '매도/STOP(시장가)' && stopRow.detected?.orderPrice === '0' && stopRow.detected?.orderedShares === 1,
    `pending detected carries orderType, orderPrice '0' (0.0000 stored as 0) and orderedShares: ${JSON.stringify(stopRow.detected)}`)
  c.ok(typeof stopRow.needsBucket === 'boolean' && stopRow.today === today, `pending row carries a boolean needsBucket and today: ${JSON.stringify([stopRow.needsBucket, stopRow.today])}`)
  c.ok(stopRow.needsBucket === false, 'one held bucket: the stop-market sell needs no bucket choice')
  const rejectStop = await c.req('POST', `/pending/${stopRow.id}/reject`, { keepImage: false }, c.token)
  c.ok(rejectStop.status === 200, 'rejecting the stop-market row -> 200 (nothing left pending)')

  // ---- untyped sell that fits two buckets: the operator chooses ------------------
  await c.photo([{ side: 'sell', ticker: 'OTWO', shares: 5, price: '160.00', fee: '0.50', date: today }], photoOf('e2e-order-type-untyped'))
  const [untyped, ...restUntyped] = await pendingOf(c, twoId)
  c.ok(!!untyped && restUntyped.length === 0, 'the untyped capture left exactly one pending row')
  c.ok(untyped.needsBucket === true && untyped.detected?.orderType === null,
    `untyped sell fitting two buckets is listed with needsBucket true: ${JSON.stringify([untyped.needsBucket, untyped.detected])}`)
  const refused = await c.req('POST', `/pending/${untyped.id}/confirm`, { keepImage: false }, c.token)
  c.ok(refused.status === 422 && (await jsonOf(refused)).error === 'choose-bucket', 'confirm without a bucket -> 422 choose-bucket')
  c.ok((await pendingOf(c, twoId)).length === 1 && (await jsonOf(await c.req('GET', `/runs/${twoId}`, undefined, c.token))).state.buckets[1].shares === 10,
    'the refusal kept the row pending and booked nothing')
  const chosen = await c.req('POST', `/pending/${untyped.id}/confirm`, { overrides: { bucketIdx: 1 }, keepImage: false }, c.token)
  c.ok(chosen.status === 200, 'the same confirm with overrides.bucketIdx 1 -> 200')
  const booked = (await jsonOf(await c.req('GET', `/runs/${twoId}`, undefined, c.token))).state
  c.ok(booked.buckets[1].shares === 5 && booked.buckets[0].shares === 10 && (await pendingOf(c, twoId)).length === 0,
    'the sell took 5 sh from the chosen bucket 1; bucket 0 untouched; nothing pending')
}
