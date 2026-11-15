import type { CorrectionRepo, CorrectionRow } from '../src/domain/correction-types'

// Array-backed correctionRepo with the same semantics as the real one; shared by
// the booking, wire and http fakes so they expose the store as `corrections`.
// Reads return shallow copies, like rows read from a database, so a later
// decide() never mutates a row a caller already holds.
export function fakeCorrectionRepo(): { repo: CorrectionRepo; store: CorrectionRow[] } {
  const store: CorrectionRow[] = []
  let seq = 1
  const repo: CorrectionRepo = {
    async insert(c) {
      const id = seq++
      store.push({ ...c, captureId: c.captureId ?? null, proposedFee: c.proposedFee ?? null, id, status: 'open', createdAt: '2026-11-15 00:00:00' })
      return id
    },
    async get(id) {
      const row = store.find((x) => x.id === id)
      return row ? { ...row } : null
    },
    async listOpen() { return store.filter((x) => x.status === 'open').map((x) => ({ ...x })) },
    async decide(id, status) {
      const c = store.find((x) => x.id === id)
      if (!c || c.status !== 'open') return false
      c.status = status
      return true
    },
    async listBlocking(fillId, proposedPrice) {
      return store.filter((x) => x.fillId === fillId && x.proposedPrice === proposedPrice && (x.status === 'open' || x.status === 'dismissed')).map((x) => ({ ...x }))
    },
    async hasOpenForCapture(captureId) {
      return store.some((x) => x.captureId === captureId && x.status === 'open')
    },
  }
  return { repo, store }
}
