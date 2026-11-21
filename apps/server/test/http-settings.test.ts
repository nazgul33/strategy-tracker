import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD, json, loginAs } from './http-fakes'

describe('http settings', () => {
  test('get masks key, put validates digestLang, reflects db', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    await f.repos.settingsRepo.set('visionApiKey', 'sk-123')
    const g = await app.request('/api/settings', { headers: auth })
    const gb = await g.json()
    expect(gb.hasVisionApiKey).toBe(true)
    expect(JSON.stringify(gb)).not.toContain('sk-123')
    // invalid digestLang
    const bad = await app.request('/api/settings', { method: 'PUT', body: JSON.stringify({ digestLang: 'fr' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(bad.status).toBe(400)
    // put then get
    const put = await app.request('/api/settings', { method: 'PUT', body: JSON.stringify({ visionModel: 'newmodel', digestLang: 'ko' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(put.status).toBe(200)
    const g2 = await app.request('/api/settings', { headers: auth })
    const gb2 = await g2.json()
    expect(gb2.visionModel).toBe('newmodel')
    expect(gb2.digestLang).toBe('ko')
  })

  test('GET exposes the env-owned defaultCostPpm; PUT cannot change it', async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.defaultSettings.defaultCostPpm = 1250
    const app = createApp(deps)
    const auth = await loginAs(app)
    expect((await (await app.request('/api/settings', { headers: auth })).json()).defaultCostPpm).toBe(1250)
    const put = await app.request('/api/settings', { method: 'PUT', body: JSON.stringify({ defaultCostPpm: 50, digestLang: 'ko' }), headers: { ...json, ...auth } })
    expect(put.status).toBe(200)
    expect(Object.keys(f.settings)).not.toContain('defaultCostPpm')
    const after = await (await app.request('/api/settings', { headers: auth })).json()
    expect(after.defaultCostPpm).toBe(1250)
    expect(after.digestLang).toBe('ko')
  })
})
