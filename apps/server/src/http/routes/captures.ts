import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { parseId } from '../params'
import { ALLOWED_MIMES, MAX_IMAGE_BYTES } from '../../domain/capture-image'
import type { CaptureEvent } from '../../wire/capture-route'

export const CAPTURE_VISION_TIMEOUT_MS = 50_000
// Room for the multipart framing and the runId field around a full-size image.
export const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024

// A declared length over the cap is refused before the body is read; a missing or
// unparsable header falls through to the size check after parsing.
export function declaredTooLarge(contentLength: string | undefined): boolean {
  if (contentLength === undefined) return false
  const n = Number(contentLength)
  return Number.isFinite(n) && n > MAX_UPLOAD_BODY_BYTES
}

type ParsedUpload = { file: File; pinnedRunId: number | null }

async function parseUpload(req: { formData(): Promise<FormData> }): Promise<ParsedUpload | null> {
  let body: FormData
  try {
    body = await req.formData()
  } catch {
    return null
  }
  const images = body.getAll('image')
  if (images.length !== 1) return null
  const file = images[0]
  if (!(file instanceof File)) return null
  const rawRunId = body.get('runId')
  if (rawRunId === null) return { file, pinnedRunId: null }
  if (typeof rawRunId !== 'string') return null
  const pinnedRunId = parseId(rawRunId)
  return pinnedRunId === null ? null : { file, pinnedRunId }
}

export function capturesRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.post('/captures', async (c) => {
    if (!deps.defaultSettings.visionBaseUrl || !deps.defaultSettings.visionModel) {
      return c.json({ error: 'vision-not-configured' }, 503)
    }
    if (declaredTooLarge(c.req.header('content-length'))) return c.json({ error: 'image-too-large' }, 413)
    const upload = await parseUpload(c.req)
    if (!upload) return c.json({ error: 'invalid-body' }, 400)
    const { file, pinnedRunId } = upload
    if (!ALLOWED_MIMES.has(file.type)) return c.json({ error: 'unsupported-image' }, 415)
    if (file.size > MAX_IMAGE_BYTES) return c.json({ error: 'image-too-large' }, 413)

    const image = { base64: Buffer.from(await file.arrayBuffer()).toString('base64'), mime: file.type }
    const events: CaptureEvent[] = []
    try {
      await deps.routeCapture({ image, pinnedRunId, visionTimeoutMs: CAPTURE_VISION_TIMEOUT_MS }, async (e) => { events.push(e) })
    } catch (e) {
      console.error('capture upload failed:', String(e))
      return c.json({ error: 'capture-failed' }, 500)
    }
    if (events[0]?.type === 'unknown-run') return c.json({ error: 'no-run' }, 404)
    return c.json(jsonBig({ events }))
  })
  return r
}
