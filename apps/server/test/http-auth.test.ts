import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeToken } from '../src/http/auth'
import { makeFakes, makeDeps, PASSWORD, SECRET } from './http-fakes'

describe('http auth', () => {
  test('wrong password 401 no cookie', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  test('right password sets cookie + token', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBeTruthy()
    expect(res.headers.get('set-cookie')).toContain('st_session')
  })
  test('health is public', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  test('protected 401 without token', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/runs')
    expect(res.status).toBe(401)
  })
  test('protected 200 with cookie', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const cookie = lr.headers.get('set-cookie')!
    const res = await app.request('/api/runs', { headers: { Cookie: cookie.split(';')[0]! } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
  test('protected 200 with bearer', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const body = await lr.json()
    const res = await app.request('/api/runs', { headers: { Authorization: `Bearer ${body.token}` } })
    expect(res.status).toBe(200)
  })
  test('tampered token 401', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const body = await lr.json()
    const token = body.token as string
    // flip a payload byte
    const parts = token.split('.')
    const arr = parts[0]!.split('')
    arr[0] = arr[0] === 'A' ? 'B' : 'A'
    const tampered = arr.join('') + '.' + parts[1]
    const res = await app.request('/api/runs', { headers: { Authorization: `Bearer ${tampered}` } })
    expect(res.status).toBe(401)
  })
  test('expired token 401', async () => {
    const token = makeToken(Date.now() - 1000, SECRET)
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/runs', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })
})
