/**
 * Screenshot-retention steps of the operator e2e. The rule under test is invisible in the UI
 * and irreversible when wrong: a corrected-and-kept screenshot survives indefinitely, and every
 * other screenshot is deleted the moment its capture's last pending fill resolves.
 *
 * Three captures, each a distinct photo (distinct bytes, so the duplicate guard stays out of it)
 * of one NVDA buy that no booked or pending fill matches:
 *   A  price corrected, keepImage true   -> survives, listed with detected != final, then discarded
 *   B  confirmed untouched               -> bytes and record swept
 *   C  price corrected, keepImage false  -> bytes and record swept (a correction alone keeps nothing)
 * and a fourth photo of two fills, the second with neither a fee nor a date from vision:
 *   D  first fill kept, second confirmed beside it with the date filled in and the fee left derived
 *      -> the derived fee is not marked as the operator's, the missed date is a recorded edit
 */
import { jsonOf, type E2eCtx } from './e2e-ctx'

const photoOf = (text: string, mime: string) => ({ base64: Buffer.from(text).toString('base64'), mime })
const buy = (shares: number, price: string) => ({ side: 'buy', ticker: 'NVDA', shares, price, fee: '0.50' })
const feelessBuy = (shares: number, price: string) => ({ side: 'buy', ticker: 'NVDA', shares, price })

const imageOf = (c: E2eCtx, captureId: number) => c.req('GET', `/captures/${captureId}/image`, undefined, c.token)
const entriesOf = async (c: E2eCtx): Promise<any[]> =>
  (await jsonOf(await c.req('GET', '/vision-reviews', undefined, c.token))).entries

// Runs the capture and returns the one pending row it created (none exist beforehand).
async function capturePending(c: E2eCtx, shares: number, price: string, image: { base64: string; mime: string }): Promise<any> {
  await c.photo([buy(shares, price)], image)
  const rows = (await jsonOf(await c.req('GET', '/pending', undefined, c.token))) as any[]
  c.ok(rows.length === 1 && rows[0].shares === shares && rows[0].captureId != null,
    `capture of ${shares} sh @ ${price} left exactly one pending row with a capture id: ${JSON.stringify(rows.map((r) => [r.id, r.shares, r.captureId]))}`)
  return rows[0]
}

// Direct count of a capture's frozen vision_reviews rows; unlike the HTTP list it also sees unkept captures.
export interface VisionReviewDb { reviewRowCount(captureId: number): Promise<number> }

export async function runVisionReview(c: E2eCtx, db: VisionReviewDb): Promise<void> {
  c.ok((await entriesOf(c)).length === 0, 'no vision-review entries exist before the retention steps')

  // ---- A: corrected and kept ----------------------------------------------
  const photoA = photoOf('e2e-retention-A-png', 'image/png')
  const rowA = await capturePending(c, 3, '175.00', photoA)
  const captureA = rowA.captureId as number
  c.ok(rowA.hasImage === true, 'pending DTO reports hasImage for a fresh capture')
  c.ok(rowA.detected?.price === '1750000' && rowA.detected?.shares === 3, `pending DTO carries the frozen vision snapshot: ${JSON.stringify(rowA.detected)}`)

  const imgA = await imageOf(c, captureA)
  c.ok(imgA.status === 200 && imgA.headers.get('content-type') === 'image/png',
    `GET /captures/:id/image -> 200 image/png (got ${imgA.status} ${imgA.headers.get('content-type')})`)
  c.ok(Buffer.from(await imgA.arrayBuffer()).equals(Buffer.from(photoA.base64, 'base64')), 'served bytes equal the uploaded screenshot')
  c.ok((await imageOf(c, captureA + 1000)).status === 404, 'image of an unknown capture -> 404')

  const confirmA = await c.req('POST', `/pending/${rowA.id}/confirm`, { overrides: { price: '175.25' }, keepImage: true }, c.token)
  c.ok(confirmA.status === 200, 'confirm with an edited price and keepImage -> 200')
  c.ok((await jsonOf(confirmA)).archived === true, 'confirm with keepImage reports archived')
  const keptA = await entriesOf(c)
  c.ok(keptA.length === 1 && keptA[0].captureId === captureA && keptA[0].mime === 'image/png' && keptA[0].fills.length === 1,
    `vision-reviews lists exactly the kept capture: ${JSON.stringify(keptA.map((e) => [e.captureId, e.fills.length]))}`)
  const fillA = keptA[0].fills[0]
  c.ok(fillA.outcome === 'confirmed' && fillA.edited === true, `entry is a confirmed, edited fill: ${JSON.stringify(fillA)}`)
  c.ok(fillA.detected.price === '1750000' && fillA.final.price === '1752500' && fillA.detected.price !== fillA.final.price,
    `detected price 175.00 differs from final 175.25: ${JSON.stringify([fillA.detected.price, fillA.final.price])}`)
  c.ok(fillA.detected.shares === fillA.final.shares && fillA.detected.side === fillA.final.side && fillA.detected.fee === fillA.final.fee,
    'untouched fields (shares, side, fee) are identical in detected and final')
  c.ok((await imageOf(c, captureA)).status === 200, 'the kept screenshot survives its last pending fill resolving')
  c.ok((await db.reviewRowCount(captureA)) === 1, 'the kept capture has its frozen vision_reviews row')

  const discard = await c.req('DELETE', `/vision-reviews/${captureA}`, undefined, c.token)
  c.ok(discard.status === 200, 'DELETE /vision-reviews/:captureId -> 200')
  c.ok((await entriesOf(c)).length === 0, 'discarded entry is gone from the list')
  c.ok((await db.reviewRowCount(captureA)) === 0, 'discarding removed the vision_reviews row')
  c.ok((await imageOf(c, captureA)).status === 404, 'discarded entry took its image with it')
  c.ok((await c.req('DELETE', `/vision-reviews/${captureA}`, undefined, c.token)).status === 404, 'discarding again -> 404')

  // ---- B: confirmed untouched ----------------------------------------------
  const rowB = await capturePending(c, 4, '174.00', photoOf('e2e-retention-B-jpeg', 'image/jpeg'))
  const captureB = rowB.captureId as number
  const imgB = await imageOf(c, captureB)
  c.ok(imgB.status === 200 && imgB.headers.get('content-type') === 'image/jpeg', 'a pending capture serves its image (so the sweep below has something to remove)')
  const confirmB = await c.req('POST', `/pending/${rowB.id}/confirm`, { keepImage: false }, c.token)
  c.ok(confirmB.status === 200, 'untouched confirm -> 200')
  c.ok((await imageOf(c, captureB)).status === 404, 'untouched confirm swept the screenshot bytes')
  c.ok((await db.reviewRowCount(captureB)) === 0, 'untouched confirm swept the frozen vision_reviews row')
  c.ok((await entriesOf(c)).length === 0, 'untouched confirm lists no kept entry (the list shows kept captures only)')

  // ---- C: corrected, not kept -----------------------------------------------
  const rowC = await capturePending(c, 2, '173.00', photoOf('e2e-retention-C-png', 'image/png'))
  const captureC = rowC.captureId as number
  c.ok((await imageOf(c, captureC)).status === 200, 'second pending capture serves its image before the confirm')
  const confirmC = await c.req('POST', `/pending/${rowC.id}/confirm`, { overrides: { price: '173.10' }, keepImage: false }, c.token)
  c.ok(confirmC.status === 200, 'corrected confirm without keep -> 200')
  c.ok((await imageOf(c, captureC)).status === 404, 'a correction alone does not keep the screenshot')
  c.ok((await db.reviewRowCount(captureC)) === 0, 'a correction alone swept the frozen vision_reviews row')
  c.ok((await entriesOf(c)).length === 0, 'a correction alone lists no kept entry')

  // ---- D: no fee and no date from vision, confirmed beside a kept sibling ------
  // Ingest substitutes the capture date for a missing one and the booking path derives a missing
  // fee, so the booked row alone cannot say either was never read. The frozen record must.
  await c.photo([{ ...buy(7, '171.00'), date: '2026-11-09' }, feelessBuy(5, '170.00')], photoOf('e2e-retention-D-png', 'image/png'))
  const rowsD = ((await jsonOf(await c.req('GET', '/pending', undefined, c.token))) as any[]).sort((a, b) => a.id - b.id)
  c.ok(rowsD.length === 2 && rowsD[0].captureId === rowsD[1].captureId && rowsD[0].captureId != null,
    `capture D left two pending rows under one capture: ${JSON.stringify(rowsD.map((r) => [r.id, r.shares, r.captureId]))}`)
  const [siblingD, bareD] = rowsD as [any, any]
  const captureD = bareD.captureId as number
  c.ok(siblingD.shares === 7 && bareD.shares === 5, 'pending rows come back as the read fill then the feeless, dateless one')
  c.ok(bareD.detected?.fee === null && bareD.detected?.filledOn === null && bareD.detected?.price === '1700000',
    `the snapshot keeps the honest nulls for what vision missed: ${JSON.stringify(bareD.detected)}`)
  c.ok(typeof bareD.filledOn === 'string' && bareD.filledOn.length > 0 && bareD.fee == null,
    `...while the row itself carries the substituted date and no fee: ${JSON.stringify([bareD.filledOn, bareD.fee])}`)
  c.ok(bareD.costPpm === 1000 && !('autoFeeCents' in bareD), `the row carries the run's cost ppm so the client can derive the fee: ${bareD.costPpm}`)

  const confirmSibling = await c.req('POST', `/pending/${siblingD.id}/confirm`, { keepImage: true }, c.token)
  c.ok(confirmSibling.status === 200, 'confirming the fill vision read fully, keeping the screenshot -> 200')
  const confirmBare = await c.req('POST', `/pending/${bareD.id}/confirm`, { overrides: { filledOn: '2026-11-09' }, keepImage: false }, c.token)
  c.ok(confirmBare.status === 200, 'confirming the dateless, feeless fill with the date filled in -> 200')

  const keptD = (await entriesOf(c)).filter((e) => e.captureId === captureD)
  c.ok(keptD.length === 1 && keptD[0].fills.length === 2, `capture D is kept with both fills (keep is sticky past the discard): ${JSON.stringify(keptD.map((e) => e.fills.length))}`)
  const [readFill, bareFill] = keptD[0].fills
  c.ok(readFill.edited === false && readFill.feeOverridden === false, `the fully-read sibling is as read: ${JSON.stringify([readFill.edited, readFill.feeOverridden])}`)
  c.ok(bareFill.detected.fee === null && bareFill.final.fee === 85,
    `the derived fee is the run's cost on the booked price (5 sh x 170.00 at 1000 ppm = 85 cents): ${JSON.stringify([bareFill.detected.fee, bareFill.final.fee])}`)
  c.ok(bareFill.feeOverridden === false, 'the derived fee is not recorded as supplied by the operator')
  c.ok(bareFill.detected.filledOn === null && bareFill.final.filledOn === '2026-11-09' && bareFill.edited === true,
    `filling in the date vision missed is a recorded edit: ${JSON.stringify([bareFill.detected.filledOn, bareFill.final.filledOn, bareFill.edited])}`)
  c.ok((await db.reviewRowCount(captureD)) === 2, 'capture D has both frozen vision_reviews rows before the discard')
  c.ok((await c.req('DELETE', `/vision-reviews/${captureD}`, undefined, c.token)).status === 200, 'discarding capture D from the review tab -> 200')
  c.ok((await db.reviewRowCount(captureD)) === 0, 'discarding capture D removed its vision_reviews rows')
}
