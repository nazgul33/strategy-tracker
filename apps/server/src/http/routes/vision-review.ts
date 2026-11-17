import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import type { VisionReviewRow } from '../../domain/vision-review'

// The repo lists newest first, so the cap drops the oldest entries; far above
// what one operator keeps by hand.
const KEPT_LIMIT = 1000

function snapshot(side: string | null, shares: number | null, price: bigint | null, filledOn: string | null, fee: number | null) {
  return { side, shares, price, filledOn, fee }
}

function fillDto(r: VisionReviewRow) {
  return {
    id: r.id,
    outcome: r.outcome,
    edited: r.edited,
    detected: snapshot(r.detectedSide, r.detectedShares, r.detectedPrice, r.detectedFilledOn, r.detectedFee),
    final: r.outcome === 'rejected' ? null : snapshot(r.finalSide, r.finalShares, r.finalPrice, r.finalFilledOn, r.finalFee),
  }
}

const byCreatedThen = <T extends { createdAt: string }>(tie: (a: T, b: T) => number) => (a: T, b: T) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : tie(a, b)

export function visionReviewRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const { captureImageRepo, visionReviewRepo } = deps.repos

  r.get('/vision-reviews', async (c) => {
    const kept = await captureImageRepo.listKept(KEPT_LIMIT)
    const reviews = await visionReviewRepo.listForCaptures(kept.map((k) => k.captureId))
    const entries = kept
      .map((k) => {
        const fills = reviews.filter((v) => v.captureId === k.captureId).sort(byCreatedThen((a, b) => a.id - b.id))
        // A kept image always has a frozen row (the freeze precedes the keep flag); without
        // one there is no run or ticker to show.
        if (!fills.length) return null
        return { captureId: k.captureId, runId: fills[0]!.runId, ticker: fills[0]!.ticker, createdAt: k.createdAt, mime: k.mime, byteLen: k.byteLen, fills: fills.map(fillDto) }
      })
      .filter((e) => e !== null)
    return c.json(jsonBig({ entries }))
  })

  // Only a kept image can be discarded here: an unkept one is still the evidence
  // for a pending row and is swept by the review lifecycle, not by the operator.
  r.delete('/vision-reviews/:captureId', async (c) => {
    const captureId = Number(c.req.param('captureId'))
    if (!Number.isInteger(captureId) || !(await captureImageRepo.isKept(captureId))) return c.json({ error: 'not-found' }, 404)
    await captureImageRepo.deleteFor(captureId)
    await visionReviewRepo.deleteFor(captureId)
    return c.json({ ok: true })
  })

  r.get('/captures/:id/image', async (c) => {
    const id = Number(c.req.param('id'))
    const image = Number.isInteger(id) && id > 0 ? await captureImageRepo.getBytes(id) : null
    if (!image) return c.json({ error: 'not-found' }, 404)
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        'Content-Type': image.mime,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })

  return r
}
