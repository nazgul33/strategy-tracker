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
 */
import { jsonOf, type E2eCtx } from './e2e-ctx'

const photoOf = (text: string, mime: string) => ({ base64: Buffer.from(text).toString('base64'), mime })
const buy = (shares: number, price: string) => ({ side: 'buy', ticker: 'NVDA', shares, price, fee: '0.50' })

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

export async function runVisionReview(c: E2eCtx): Promise<void> {
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

  const discard = await c.req('DELETE', `/vision-reviews/${captureA}`, undefined, c.token)
  c.ok(discard.status === 200, 'DELETE /vision-reviews/:captureId -> 200')
  c.ok((await entriesOf(c)).length === 0, 'discarded entry is gone from the list')
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
  c.ok((await entriesOf(c)).length === 0, 'untouched confirm left no vision-review entry')

  // ---- C: corrected, not kept -----------------------------------------------
  const rowC = await capturePending(c, 2, '173.00', photoOf('e2e-retention-C-png', 'image/png'))
  const captureC = rowC.captureId as number
  c.ok((await imageOf(c, captureC)).status === 200, 'second pending capture serves its image before the confirm')
  const confirmC = await c.req('POST', `/pending/${rowC.id}/confirm`, { overrides: { price: '173.10' }, keepImage: false }, c.token)
  c.ok(confirmC.status === 200, 'corrected confirm without keep -> 200')
  c.ok((await imageOf(c, captureC)).status === 404, 'a correction alone does not keep the screenshot')
  c.ok((await entriesOf(c)).length === 0, 'a correction alone leaves no vision-review entry')
}
