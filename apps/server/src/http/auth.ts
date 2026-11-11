import { createMiddleware } from 'hono/factory'

export function makeToken(expiryMs: number, secret: string): string {
  const payload = base64url(String(expiryMs))
  const sig = hmacHex(payload, secret)
  return `${payload}.${sig}`
}

export function verifyToken(token: string, secret: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [payload, sig] = parts as [string, string]
  if (!payload || !sig) return false
  let expiryStr: string
  try {
    expiryStr = atobUrl(payload)
  } catch {
    return false
  }
  const expiry = Number(expiryStr)
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false
  const expected = hmacHex(payload, secret)
  if (sig.length !== expected.length) return false
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return timingSafeEqualFallback(new Uint8Array(a), new Uint8Array(b))
  }
}

function timingSafeEqualFallback(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

function hmacHex(payload: string, secret: string): string {
  const hasher = new Bun.CryptoHasher('sha256', secret)
  hasher.update(payload)
  return hasher.digest('hex')
}

function base64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function atobUrl(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

export function authMiddleware(secret: string) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path
    if (path === '/api/login' || path === '/api/health') return next()
    if (!path.startsWith('/api/')) return next()
    // extract token
    let token: string | null = null
    const auth = c.req.header('Authorization')
    if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim()
    if (!token) {
      const cookie = c.req.header('Cookie') ?? ''
      const m = cookie.match(/(?:^|;\s*)st_session=([^;]+)/)
      if (m) token = decodeURIComponent(m[1]!)
    }
    if (!token || !verifyToken(token, secret)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })
}