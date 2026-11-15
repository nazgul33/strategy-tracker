import { describe, expect, test } from 'bun:test'
import { claimCapture, type CaptureClaimRepos } from '../src/domain/capture-claim'

// Deliberately no pendingRepo.listPending: the claim may only ask about one capture.
function fakeClaimRepos(opts: { existing?: boolean; live?: boolean; open?: boolean; confirmed?: boolean }) {
  const calls: string[] = []
  const repos: CaptureClaimRepos = {
    captureRepo: {
      findByHash: async () => (opts.existing ? { id: 7 } : null),
      setStatus: async () => { calls.push('setStatus') },
      insert: async () => ({ inserted: true, id: 9 }),
    },
    pendingRepo: {
      hasLiveForCapture: async (id) => { calls.push(`live:${id}`); return !!opts.live },
      hasConfirmedForCapture: async (id) => { calls.push(`confirmed:${id}`); return !!opts.confirmed },
    },
    correctionRepo: { hasOpenForCapture: async () => !!opts.open },
  }
  return { repos, calls }
}

describe('claimCapture', () => {
  test('new image: inserts, not booked earlier, no confirmed lookup', async () => {
    const { repos, calls } = fakeClaimRepos({})
    expect(await claimCapture(repos, 1, 'h', 'parsed')).toEqual({ id: 9, bookedEarlier: false })
    expect(calls).toEqual([])
  })

  test('live pending row for that capture blocks', async () => {
    const { repos, calls } = fakeClaimRepos({ existing: true, live: true, confirmed: true })
    expect(await claimCapture(repos, 1, 'h', 'parsed')).toBeNull()
    expect(calls).toEqual(['live:7'])
  })

  test('open correction blocks', async () => {
    const { repos } = fakeClaimRepos({ existing: true, open: true })
    expect(await claimCapture(repos, 1, 'h', 'parsed')).toBeNull()
  })

  test('reused capture without a confirmed row is not flagged', async () => {
    const { repos, calls } = fakeClaimRepos({ existing: true })
    expect(await claimCapture(repos, 1, 'h', 'parsed')).toEqual({ id: 7, bookedEarlier: false })
    expect(calls).toEqual(['live:7', 'setStatus', 'confirmed:7'])
  })

  test('reused capture with a confirmed row is flagged bookedEarlier', async () => {
    const { repos } = fakeClaimRepos({ existing: true, confirmed: true })
    expect(await claimCapture(repos, 1, 'h', 'parsed')).toEqual({ id: 7, bookedEarlier: true })
  })
})
