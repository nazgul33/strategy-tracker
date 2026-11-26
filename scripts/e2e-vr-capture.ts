/**
 * VR screenshot intake step of the operator e2e, through the real HTTP app and the shared capture core, on runs of their own:
 *   VRCA  a pinned upload leaves three fills waiting (books untouched) -> the same screenshot is a duplicate -> confirm one,
 *         reject one, edit and confirm one (the screenshot goes with the last decision) -> the same screenshot is still a
 *         duplicate, a different one whose fills are all known drops them
 *   VRCB  a waiting fill holds the morning cycle step on a run with an opening buy and no cycle; confirm all leaves the
 *         undated row waiting; rejecting it lets the next morning run open cycle 1
 *   VRCM  one active mean-reversion run and one active VR run on a ticker: an un-pinned upload is "several active runs"
 * The script's date is fixed, so the hold is exercised on cycle 1, not on a roll. The morning pipeline is the real one.
 */
import { prevTradingDay } from '../packages/calendar/src/index'
import { formatUsd } from '../packages/core/src/money'
import { VR_CYCLE_DAYS, addDays } from '../packages/strategies/src/value-rebalancing'
import { t } from '../packages/telegram/src/i18n'
import { jsonOf, type E2eCtx, type VisionFill } from './e2e-ctx'

const pngOf = (text: string, name: string) => new File([Buffer.from(text)], name, { type: 'image/png' })

function formOf(image: File, runId?: string): FormData {
  const form = new FormData()
  form.append('image', image)
  if (runId !== undefined) form.append('runId', runId)
  return form
}

export async function checkVrCapture(c: E2eCtx, today: string, runMorning: () => Promise<unknown>, sent: readonly { text: string }[]): Promise<void> {
  const prev = prevTradingDay(today)
  const msgsOf = (ticker: string) => sent.filter((s) => s.text.includes(ticker))
  const call = (method: string, path: string, body?: unknown) => c.req(method, path, body, c.token)
  const createVr = async (name: string, ticker: string, cashCents: number): Promise<number> => {
    const res = await call('POST', '/vr/runs', { name, ticker, cashCents })
    c.ok(res.status === 201, `POST /api/vr/runs ${ticker} -> 201`)
    return ((await jsonOf(res)) as { id: number }).id
  }
  const openingBuy = async (id: number, shares: number): Promise<void> => {
    const res = await call('POST', `/vr/runs/${id}/fills`, { side: 'buy', shares, price: '180.00', fee: '0.50', filledOn: today })
    c.ok(res.status === 201, `POST /api/vr/runs/${id}/fills opening buy ${shares} sh @ 180.00 -> 201`)
  }
  const detail = async (id: number) => jsonOf(await call('GET', `/vr/runs/${id}`))
  const pendingOf = async (id: number): Promise<any[]> => jsonOf(await call('GET', `/vr/runs/${id}/pending`))
  const fillsOf = async (id: number): Promise<any[]> => jsonOf(await call('GET', `/vr/runs/${id}/fills`))
  const upload = async (fills: VisionFill[], image: File, runId?: number): Promise<any[]> => {
    const res = await c.upload(fills, formOf(image, runId === undefined ? undefined : String(runId)))
    c.ok(res.status === 200, `upload ${image.name} -> 200 (got ${res.status})`)
    return ((await jsonOf(res)) as { events: any[] }).events
  }
  const outcomeOf = (runId: number, ticker: string, outcome: unknown) => JSON.stringify([{ type: 'vr-outcome', runId, ticker, outcome }])
  const imageStatus = async (captureId: number) => (await call('GET', `/captures/${captureId}/image`)).status

  // ---- setup: VRCA with its opening buy and cycle 1, as e2e-vr does ----------
  const a = await createVr('E2E VR capture', 'VRCA', 10_000_000)
  await openingBuy(a, 277)
  const headsBefore = msgsOf('VRCA').length
  c.ok((await runMorning()) === 'sent', 'morning pipeline ran after the opening buy on VRCA')
  const cycleMsgs = msgsOf('VRCA').slice(headsBefore)
  c.ok(cycleMsgs.length === 1 && cycleMsgs[0]!.text.includes(`E2E VR capture  VRCA — VR cycle 1: ${today} to`), `one new VRCA message: the cycle 1 digest: ${JSON.stringify(cycleMsgs.map((m) => m.text.slice(0, 60)))}`)
  const d0 = await detail(a)
  c.ok(d0.cycle?.seq === 1 && d0.books.shares === 277 && d0.books.poolCents === 5_013_950 && d0.pendingCount === 0 && d0.ladder.buy.length >= 2,
    `VRCA before any screenshot: cycle 1, 277 sh, Pool 5013950c (10000000 - 277 x 18000 - 50), nothing waiting, ${d0.ladder.buy.length} buy rungs`)
  const rung = d0.ladder.buy[0]
  const rungPrice = BigInt(rung.price)

  // ---- 1. a pinned upload: three fills wait, nothing is booked ---------------
  const f1: VisionFill = { side: 'buy', ticker: 'VRCA', shares: rung.shares, price: formatUsd(rungPrice), fee: '0.10', date: today } // the first rung
  const f2: VisionFill = { side: 'buy', ticker: 'VRCA', shares: 2, price: '170.00', fee: '0.05', date: prev } // an unrelated extra buy
  const f3: VisionFill = { side: 'buy', ticker: 'VRCA', shares: 4, price: '175.00' } // no date, no fee
  const readA = [f1, f2, f3]
  const imgA = pngOf('e2e-vr-capture-a', 'vr-a.png')
  const first = await upload(readA, imgA, a)
  c.ok(JSON.stringify(first) === outcomeOf(a, 'VRCA', { waiting: 3, dropped: 0, possibleDuplicates: 0 }), `pinned upload -> vr-outcome waiting 3, dropped 0, possibleDuplicates 0: ${JSON.stringify(first)}`)
  const rows = await pendingOf(a)
  const row = (shares: number) => rows.find((r) => r.shares === shares)
  const capA = rows[0]?.captureId as number
  c.ok(rows.length === 3 && rows.every((r) => r.captureId === capA && r.side === 'buy' && r.dupPrice === null && r.hasImage === true), `GET /api/vr/runs/:id/pending lists 3 waiting buys of one screenshot: ${JSON.stringify(rows.map((r) => [r.id, r.shares]))}`)
  c.ok(row(rung.shares)?.price === rung.price && row(rung.shares)?.fee === 10 && row(rung.shares)?.dateRead === true && row(rung.shares)?.filledOn === today,
    `the rung fill keeps price ${rung.price} (${formatUsd(rungPrice)}), fee 10c, date ${today} read`)
  c.ok(row(2)?.filledOn === prev && row(2)?.fee === 5 && row(2)?.dateRead === true, `the extra buy keeps its date ${prev}, fee 5c, dateRead true`)
  c.ok(row(4)?.dateRead === false && row(4)?.filledOn === today && row(4)?.fee === null && row(4)?.price === '1750000',
    `the undated fill: dateRead false, capture date ${today} used, no fee read, price 1750000`)
  const d1 = await detail(a)
  c.ok(d1.pendingCount === 3 && d1.books.shares === 277 && d1.books.poolCents === 5_013_950 && JSON.stringify(d1.ladder) === JSON.stringify(d0.ladder),
    'run detail: pendingCount 3; shares 277, Pool 5013950c and the ladder unchanged by waiting fills')
  const listed = ((await jsonOf(await call('GET', '/vr/runs'))) as any[]).find((r) => r.id === a)
  c.ok(listed?.pendingCount === 3 && listed.shares === 277, `GET /api/vr/runs: the run's pendingCount is 3, shares 277: ${JSON.stringify(listed)}`)
  c.ok(await imageStatus(capA) === 200, 'GET /api/captures/:id/image -> 200 while fills wait')

  // ---- 2. the same screenshot again ------------------------------------------
  const again = await upload(readA, imgA, a)
  c.ok(JSON.stringify(again) === outcomeOf(a, 'VRCA', 'duplicate'), `the same screenshot again -> vr-outcome duplicate: ${JSON.stringify(again)}`)
  c.ok((await pendingOf(a)).length === 3, 'the duplicate added no waiting row: still 3')

  // ---- 3. confirm the first-rung fill ----------------------------------------
  const confirm1 = await call('POST', `/vr/runs/${a}/pending/${row(rung.shares).id}/confirm`, {})
  const { fillId } = (await jsonOf(confirm1)) as { fillId: number }
  c.ok(confirm1.status === 201 && Number.isInteger(fillId), `confirm the rung fill -> 201 with a fillId (got ${confirm1.status})`)
  const newest = (await fillsOf(a))[0]
  c.ok(newest?.id === fillId && newest.source === 'capture' && newest.shares === rung.shares && newest.price === rung.price && newest.fee === 10 && newest.filledOn === today,
    `the newest fill is the confirmed one: source capture, ${newest?.shares} sh @ ${newest?.price}, fee 10c, ${newest?.filledOn}`)
  const spent = Number((rungPrice * BigInt(rung.shares)) / 100n)
  const d3 = await detail(a)
  c.ok(d3.books.shares === 282 && d3.books.poolCents === 5_013_950 - (spent + 10) && d3.books.poolCents === 4_937_230,
    `books moved by the fill: 282 sh, Pool ${d3.books.poolCents}c = 5013950 - (${spent} + 10)`)
  c.ok(d3.budgetLeftCents === d0.cycle.buyBudgetCents - spent && d3.budgetLeftCents === 2_430_265, `budget left ${d3.budgetLeftCents}c = ${d0.cycle.buyBudgetCents} - ${spent} (shares x price, not the fee)`)
  c.ok(JSON.stringify(d3.ladder.buy) === JSON.stringify(d0.ladder.buy.slice(1)) && d3.ladder.buyTotal === d0.ladder.buyTotal && JSON.stringify(d3.ladder.sell) === JSON.stringify(d0.ladder.sell),
    'the first buy rung is used up; the other buy rungs and the sell side are unchanged')
  c.ok(d3.pendingCount === 2, 'pendingCount is 2 after the confirm')
  const reConfirm = await call('POST', `/vr/runs/${a}/pending/${row(rung.shares).id}/confirm`, {})
  c.ok(reConfirm.status === 409 && (await jsonOf(reConfirm)).error === 'vr-not-pending', 'confirming the same row again -> 409 vr-not-pending')
  c.ok(await imageStatus(capA) === 200, 'the screenshot is kept while two rows wait')

  // ---- 4. reject one, edit and confirm the last: the screenshot goes ---------
  const rej = await call('POST', `/vr/runs/${a}/pending/${row(2).id}/reject`, {})
  c.ok(rej.status === 204, `reject the extra buy -> 204 (got ${rej.status})`)
  const edit = await call('PUT', `/vr/runs/${a}/pending/${row(4).id}`, { side: 'buy', shares: 6, price: '175.00', filledOn: today })
  c.ok(edit.status === 204, `edit the undated fill to 6 sh @ 175.00 -> 204 (got ${edit.status})`)
  const edited = (await pendingOf(a))
  c.ok(edited.length === 1 && edited[0].shares === 6 && edited[0].price === '1750000' && edited[0].fee === null && edited[0].dateRead === false,
    `one row waits: 6 sh @ 1750000, fee still unread, dateRead still false (an edit does not change it): ${JSON.stringify(edited)}`)
  const confirm3 = await call('POST', `/vr/runs/${a}/pending/${edited[0].id}/confirm`, {})
  c.ok(confirm3.status === 201, `confirm the edited fill -> 201 (got ${confirm3.status})`)
  const last = (await fillsOf(a))[0]
  c.ok(last?.source === 'capture' && last.shares === 6 && last.fee === 74, `the confirmed fill takes the automatic fee: 74c = half-up of 73.5 (got ${last?.fee})`)
  const d4 = await detail(a)
  c.ok(d4.books.shares === 288 && d4.books.poolCents === 4_937_230 - (6 * 17_500 + 74) && d4.books.poolCents === 4_832_156,
    `books after the edited fill: 288 sh, Pool ${d4.books.poolCents}c = 4937230 - (105000 + 74)`)
  c.ok(d4.pendingCount === 0 && (await pendingOf(a)).length === 0, 'pendingCount 0 and the pending list is empty')
  c.ok(await imageStatus(capA) === 404, 'GET /api/captures/:id/image -> 404: the last waiting row was decided, so the screenshot was deleted')

  // ---- 5. the same screenshot, then a different one with the known fills -----
  const dup2 = await upload(readA, imgA, a)
  c.ok(JSON.stringify(dup2) === outcomeOf(a, 'VRCA', 'duplicate'), `the same screenshot after every row was decided -> still a duplicate: ${JSON.stringify(dup2)}`)
  const known = await upload([f1, f2], pngOf('e2e-vr-capture-a2', 'vr-a2.png'), a)
  c.ok(JSON.stringify(known) === outcomeOf(a, 'VRCA', { waiting: 0, dropped: 2, possibleDuplicates: 0 }),
    `a different screenshot of the booked fill and the rejected one -> waiting 0, dropped 2: ${JSON.stringify(known)}`)
  const d5 = await detail(a)
  c.ok(d5.pendingCount === 0 && d5.books.shares === 288 && d5.books.poolCents === 4_832_156, 'nothing waits and the books are unchanged: 288 sh, Pool 4832156c')

  // ---- 6. the hold: waiting fills stop the morning cycle step ----------------
  const b = await createVr('E2E VR held', 'VRCB', 1_000_000)
  await openingBuy(b, 27)
  const heldRead: VisionFill[] = [{ side: 'buy', ticker: 'VRCB', shares: 1, price: '179.00' }] // undated: the capture date is used
  const heldEvents = await upload(heldRead, pngOf('e2e-vr-capture-b', 'vr-b.png'), b)
  c.ok(JSON.stringify(heldEvents) === outcomeOf(b, 'VRCB', { waiting: 1, dropped: 0, possibleDuplicates: 0 }), `VRCB upload -> waiting 1: ${JSON.stringify(heldEvents)}`)
  const all = await call('POST', `/vr/runs/${b}/pending/confirm-all`, {})
  const allBody = await jsonOf(all)
  c.ok(all.status === 200 && JSON.stringify(allBody) === JSON.stringify({ confirmed: 0, refused: [], skippedDuplicates: 0, skippedUndated: 1 }),
    `confirm all leaves the row whose date was not read waiting: skippedUndated 1, confirmed 0: ${JSON.stringify(allBody)}`)
  const waitingB = await pendingOf(b)
  c.ok(waitingB.length === 1 && waitingB[0].dateRead === false && (await detail(b)).pendingCount === 1, 'the undated row is still waiting after confirm all (pendingCount 1)')

  const heldBefore = msgsOf('VRCB').length
  const quietA = msgsOf('VRCA').length
  c.ok((await runMorning()) === 'sent', 'morning pipeline ran with a fill waiting on VRCB')
  const heldText = t('vr-cycle-held', 'en', { name: 'E2E VR held', ticker: 'VRCB', n: 1 })
  const heldMsgs = msgsOf('VRCB').slice(heldBefore).map((m) => m.text)
  c.ok(JSON.stringify(heldMsgs) === JSON.stringify([heldText]), `the new VRCB message is the held message, nothing else: ${JSON.stringify(heldMsgs.map((m) => m.slice(0, 70)))}`)
  const dHeld = await detail(b)
  c.ok(dHeld.cycle === null && dHeld.pendingCount === 1 && !msgsOf('VRCB').some((m) => m.text.includes('— VR cycle 1:')), 'no cycle opened on VRCB while the fill waits: cycle null, no cycle digest sent')
  c.ok(msgsOf('VRCA').length === quietA, 'VRCA (mid-cycle, nothing waiting) stayed silent: the hold is per run')

  const rejB = await call('POST', `/vr/runs/${b}/pending/${waitingB[0].id}/reject`, {})
  c.ok(rejB.status === 204, `reject the waiting VRCB fill -> 204 (got ${rejB.status})`)
  const afterRejectB = msgsOf('VRCB').length
  c.ok((await runMorning()) === 'sent', 'morning pipeline ran again after the fill was rejected')
  const head = t('vr-cycle-head', 'en', { name: 'E2E VR held', ticker: 'VRCB', seq: 1, start: today, end: addDays(today, VR_CYCLE_DAYS - 1) })
  const openedB = msgsOf('VRCB').slice(afterRejectB).map((m) => m.text)
  c.ok(openedB.length >= 1 && openedB.some((m) => m.includes(head)) && !openedB.includes(heldText), `one VRCB digest now carries the cycle 1 head and the held message is gone: ${JSON.stringify(openedB.map((m) => m.slice(0, 70)))}`)
  const dOpen = await detail(b)
  const cy = dOpen.cycle
  c.ok(cy?.seq === 1 && cy.scheduledStart === today && cy.startDate === today && cy.openShares === 27 && cy.vCents === 500_000 && cy.openPoolCents === 513_950 && dOpen.pendingCount === 0,
    `VRCB cycle 1 opened: ${today}, 27 sh, V 500000c, Pool 513950c (1000000 - 27 x 18000 - 50)`)
  c.ok(msgsOf('VRCA').length === quietA, 'VRCA is still silent')

  // ---- 7. a ticker traded by one MR run and one VR run -----------------------
  const mr = await call('POST', '/runs', { name: 'E2E MR shared', ticker: 'VRCM', poolCents: 1_000_000, costPpm: 1_000 })
  c.ok(mr.status === 201, 'POST /api/runs mean-reversion VRCM -> 201')
  const mrId = ((await jsonOf(mr)) as { id: number }).id
  const vrId = await createVr('E2E VR shared', 'VRCM', 1_000_000)
  const shared = await c.upload([{ side: 'buy', ticker: 'VRCM', shares: 3, price: '20.00', date: today }], formOf(pngOf('e2e-vr-capture-m', 'vr-m.png')))
  const sharedText = await shared.text()
  c.ok(shared.status === 200 && JSON.stringify(JSON.parse(sharedText).events) === JSON.stringify([{ type: 'ambiguous', ticker: 'VRCM' }]),
    `un-pinned upload for a ticker with one MR and one VR run -> a single ambiguous event: ${sharedText}`)
  c.ok(!sharedText.includes('"fills"') && !sharedText.includes('choose'), 'the browser answer carries no fills and no choose event')
  const mrPending = ((await jsonOf(await call('GET', '/pending'))) as any[]).filter((r) => r.runId === mrId)
  c.ok(mrPending.length === 0 && (await pendingOf(vrId)).length === 0 && (await detail(vrId)).pendingCount === 0, 'nothing waits on either run')

  // ---- tidy up: a step appended later starts quiet ---------------------------
  const closed = await Promise.all([a, b, vrId].map((id) => call('PATCH', `/vr/runs/${id}`, { status: 'closed' })))
  c.ok(closed.every((r) => r.status === 200), 'the three VR runs of this step close -> 200')
}
