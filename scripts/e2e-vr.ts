/**
 * Value Rebalancing step of the operator e2e, on runs of their own (tickers VRTQ and VRTI) so earlier state stays untouched:
 *   VRTQ  create -> morning buy instruction -> opening buy -> cycle 1 and its ladder -> a rung bought -> refused oversell
 *         -> deposit and adjust -> paused -> closed
 *   VRTI  holds no shares, so an active run is told to buy every morning; that makes its silence once paused a real proof.
 * The morning pipeline is the real one. `storingCloses` stores the checked close as main.ts does; the shared script setup does not.
 */
import { prevTradingDay } from '../packages/calendar/src/index'
import { formatUsd } from '../packages/core/src/money'
import { buyLot, sellLot } from '../packages/strategies/src/value-rebalancing'
import type { DayDeps } from '../apps/server/src/pipeline/day'
import { jsonOf, type E2eCtx } from './e2e-ctx'

type CloseStore = { upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]): Promise<number> }

export const storingCloses = (d: DayDeps, ph: CloseStore): DayDeps =>
  ({ ...d, persistClose: async (ticker, tradeDate, close) => { await ph.upsertMany([{ ticker, tradeDate, close }]) } })

const CENT = 100n // a price in myriadths is a whole cent when it divides by 100

export async function checkVr(c: E2eCtx, today: string, runMorning: () => Promise<unknown>, sent: readonly { text: string }[]): Promise<void> {
  const prev = prevTradingDay(today)
  const msgsOf = (ticker: string) => sent.filter((s) => s.text.includes(ticker))
  const post = (path: string, body: unknown) => c.req('POST', path, body, c.token)
  const patch = (id: number, status: string) => c.req('PATCH', `/vr/runs/${id}`, { status }, c.token)
  const list = async () => (await jsonOf(await c.req('GET', '/vr/runs', undefined, c.token))) as any[]
  const create = async (name: string, ticker: string, cashCents: number): Promise<number> => {
    const res = await post('/vr/runs', { name, ticker, cashCents })
    c.ok(res.status === 201, `POST /api/vr/runs ${ticker} -> 201`)
    return ((await jsonOf(res)) as { id: number }).id
  }

  // ---- 1. create: listed under /vr/runs, never under /runs ------------------
  const id = await create('E2E VR', 'VRTQ', 1_000_000)
  const detail = async () => jsonOf(await c.req('GET', `/vr/runs/${id}`, undefined, c.token))
  const listed = (await list()).find((r) => r.id === id)
  c.ok(listed?.ticker === 'VRTQ' && listed.status === 'active' && listed.initialVCents === 500_000 && listed.shares === 0 && listed.poolCents === 1_000_000 && listed.vCents === null,
    `GET /api/vr/runs lists the new run: V 5000.00 from half the cash, Pool 10000.00, no cycle: ${JSON.stringify(listed)}`)
  const mrRuns = (await jsonOf(await c.req('GET', '/runs', undefined, c.token))) as any[]
  c.ok(!mrRuns.some((r) => r.id === id), 'GET /api/runs (mean reversion) does not list the VR run')

  // ---- 2. morning: one buy instruction, no cycle yet -------------------------
  const quietBefore = msgsOf('VRTQ').length
  c.ok((await runMorning()) === 'sent', 'morning pipeline ran with the VR run active')
  const first = msgsOf('VRTQ').slice(quietBefore)
  c.ok(first.length === 1 && first[0]!.text.includes('E2E VR  VRTQ — VR buy instruction') && first[0]!.text.includes('Buy 27 sh (target $5000.00 ÷ last close)'),
    `one new VR message: the buy instruction for 27 sh against a 5000.00 target: ${JSON.stringify(first.map((m) => m.text))}`)
  const d1 = await detail()
  c.ok(d1.cycle === null && d1.buyInstruction?.shares === 27 && d1.buyInstruction.targetCents === 500_000 && d1.lastClose?.date === prev && d1.lastClose.close === '1800000',
    'run detail: no cycle yet, buyInstruction 27 sh / 500000c, last close 180.00 of the previous trading day')

  // ---- 3. book the opening buy (dated before the cycle opens), then cycle 1 --
  const opening = await post(`/vr/runs/${id}/fills`, { side: 'buy', shares: 27, price: '180.00', fee: '0.50', filledOn: prev })
  c.ok(opening.status === 201, 'POST /api/vr/runs/:id/fills opening buy 27 sh @ 180.00 -> 201')
  const cycleBefore = msgsOf('VRTQ').length
  c.ok((await runMorning()) === 'sent', 'morning pipeline ran after the opening buy')
  const opened = msgsOf('VRTQ').slice(cycleBefore)
  c.ok(opened.length === 1 && opened[0]!.text.includes(`E2E VR  VRTQ — VR cycle 1: ${today} to`), `one new VR message: the cycle 1 digest: ${JSON.stringify(opened.map((m) => m.text.slice(0, 60)))}`)
  const d3 = await detail()
  const cy = d3.cycle
  c.ok(cy?.seq === 1 && cy.vCents === 500_000 && cy.bandMinCents === 425_000 && cy.bandMaxCents === 575_000 && cy.openShares === 27,
    'cycle 1: V 5000.00, band 4250.00 to 5750.00, 27 shares at the start')
  c.ok(cy.buyLot === buyLot(27) && cy.sellLot === sellLot(27), `cycle 1 lots equal buyLot(27)=${buyLot(27)} and sellLot(27)=${sellLot(27)}`)
  const { buy, sell } = d3.ladder
  c.ok(buy.length >= 1 && buy.length <= 30 && sell.length >= 1 && sell.length <= 30 && d3.ladder.buyTotal === buy.length && d3.ladder.sellTotal === sell.length,
    `ladder has ${buy.length} buy and ${sell.length} sell rungs, each side within 1..30`)
  const wholeCents = [...buy, ...sell].every((r: any) => BigInt(r.price) % CENT === 0n)
  const firstBuy = BigInt(Math.floor(cy.bandMinCents / cy.openShares)) * CENT
  const firstSell = BigInt(Math.floor((cy.bandMaxCents + cy.openShares - 1) / cy.openShares)) * CENT
  c.ok(wholeCents && BigInt(buy[0].price) === firstBuy && BigInt(sell[0].price) === firstSell,
    `rung prices are whole cents; first buy ${buy[0].price} = floor(bandMin / shares), first sell ${sell[0].price} = ceil(bandMax / shares)`)
  c.ok(d3.budgetLeftCents === 256_975 && d3.books.shares === 27 && d3.books.poolCents === 513_950,
    'budget left 2569.75 (half of the 5139.50 Pool); books 27 sh, Pool 5139.50 (opening buy dated before the cycle spends no budget)')

  // ---- 4. buy the first rung ----------------------------------------------
  const rung = buy[0]
  const rungPrice = BigInt(rung.price)
  const bought = await post(`/vr/runs/${id}/fills`, { side: 'buy', shares: rung.shares, price: formatUsd(rungPrice), fee: '0.10', filledOn: today })
  c.ok(bought.status === 201, `POST fills: buy ${rung.shares} sh @ ${formatUsd(rungPrice)} (the first rung) -> 201`)
  const d4 = await detail()
  const spent = Number((rungPrice * BigInt(rung.shares)) / 100n)
  c.ok(d4.books.shares === d3.books.shares + cy.buyLot && d4.budgetLeftCents === d3.budgetLeftCents - spent,
    `shares up by the lot (${d4.books.shares}); budget left down by shares x price (${spent}c) to ${d4.budgetLeftCents}c`)
  c.ok(JSON.stringify(d4.ladder.buy) === JSON.stringify(d3.ladder.buy.slice(1)) && d4.ladder.buyTotal === d3.ladder.buyTotal,
    'the first buy rung is gone; the rest are unchanged and still counted in buyTotal')
  c.ok(JSON.stringify(d4.ladder.sell) === JSON.stringify(d3.ladder.sell), 'the sell side is unchanged by a buy')

  // ---- 5. a sell larger than the holding is refused ------------------------
  const fillsBefore = ((await jsonOf(await c.req('GET', `/vr/runs/${id}/fills`, undefined, c.token))) as any[]).length
  const over = await post(`/vr/runs/${id}/fills`, { side: 'sell', shares: d4.books.shares + 1, price: '180.00', fee: '0.10', filledOn: today })
  c.ok(over.status === 422 && (await jsonOf(over)).error === 'vr-negative-shares', 'a sell of more than the holding -> 422 vr-negative-shares')
  const d5 = await detail()
  const fillsAfter = ((await jsonOf(await c.req('GET', `/vr/runs/${id}/fills`, undefined, c.token))) as any[]).length
  c.ok(d5.books.shares === d4.books.shares && fillsAfter === fillsBefore, 'the refused sell wrote nothing: same shares, same fill count')

  // ---- 6. cash: a deposit moves Pool and net invested, an adjust only the Pool
  const deposit = await post(`/vr/runs/${id}/cash`, { kind: 'deposit', amountCents: 100_000, movedOn: today })
  c.ok(deposit.status === 201, 'POST /api/vr/runs/:id/cash deposit 1000.00 -> 201')
  const d6 = await detail()
  c.ok(d6.books.poolCents === d5.books.poolCents + 100_000 && d6.books.netInvestedCents === d5.books.netInvestedCents + 100_000,
    `deposit raised the Pool and net invested by 100000c each (Pool ${d6.books.poolCents}, net ${d6.books.netInvestedCents})`)
  const adjust = await post(`/vr/runs/${id}/cash`, { kind: 'adjust', amountCents: 2_500, movedOn: today })
  c.ok(adjust.status === 201, 'POST cash adjust 25.00 -> 201')
  const d7 = await detail()
  c.ok(d7.books.poolCents === d6.books.poolCents + 2_500 && d7.books.netInvestedCents === d6.books.netInvestedCents,
    `adjust raised the Pool by 2500c (${d7.books.poolCents}) and left net invested at ${d7.books.netInvestedCents}`)

  // ---- 7. pause: an active run with no shares is told every morning, a paused one is not; then close
  const idleId = await create('E2E VR idle', 'VRTI', 100_000)
  const idleBefore = msgsOf('VRTI').length
  await runMorning()
  c.ok(msgsOf('VRTI').length === idleBefore + 1, 'an active VR run without shares gets its buy instruction in the morning')
  const pause = await patch(idleId, 'paused')
  c.ok(pause.status === 200 && (await jsonOf(pause)).ok === true, 'PATCH /api/vr/runs/:id paused -> 200')
  const pausedPatch = await patch(id, 'paused')
  c.ok(pausedPatch.status === 200, 'the run with a cycle is paused too -> 200')
  const quiet = msgsOf('VRTI').length + msgsOf('VRTQ').length
  c.ok((await runMorning()) === 'sent', 'morning pipeline ran with both VR runs paused')
  c.ok(msgsOf('VRTI').length + msgsOf('VRTQ').length === quiet, 'no VR message was added while both runs were paused')
  const closed = [await patch(idleId, 'closed'), await patch(id, 'closed')]
  c.ok(closed.every((r) => r.status === 200), 'both paused runs close -> 200')
  const after = await list()
  c.ok([id, idleId].every((rid) => after.find((r) => r.id === rid)?.status === 'closed'), 'GET /api/vr/runs lists both runs as closed')
}
