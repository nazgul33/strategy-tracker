import { Hono } from 'hono'
import type { HttpDeps } from '../app'

export function settingsRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/settings', async (c) => {
    const db = await deps.repos.settingsRepo.getAll()
    const out: any = {
      visionBaseUrl: db.visionBaseUrl ?? deps.defaultSettings.visionBaseUrl,
      visionModel: db.visionModel ?? deps.defaultSettings.visionModel,
      digestLang: db.digestLang ?? deps.defaultSettings.digestLang,
      hasVisionApiKey: Object.prototype.hasOwnProperty.call(db, 'visionApiKey'),
    }
    // ensure no key value leaked
    return c.json(out)
  })
  r.put('/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const allowed = ['visionBaseUrl', 'visionModel', 'digestLang', 'visionApiKey']
    // validate digestLang
    if (body?.digestLang != null && body.digestLang !== 'en' && body.digestLang !== 'ko') {
      return c.json({ error: 'invalid digestLang' }, 400)
    }
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body ?? {}, k)) {
        const v = body[k]
        if (k === 'visionApiKey') {
          // empty values clear settings except visionApiKey, which is ignored when empty
          if (v === '' || v == null) continue
          await deps.repos.settingsRepo.set(k, String(v))
        } else {
          await deps.repos.settingsRepo.set(k, String(v ?? ''))
        }
      }
    }
    return c.json({ ok: true })
  })
  return r
}