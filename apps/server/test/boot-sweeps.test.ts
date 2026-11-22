import { describe, test, expect, spyOn } from 'bun:test'
import { runBootSweeps } from '../src/wire/boot-sweeps'
import { makeFakes } from './http-fakes'

const now = new Date('2026-11-20T12:00:00Z')

// the zone the process started in — the DST test below must leave it exactly there, whatever it was
const offsetAtLoad = new Date('2026-07-01T12:00:00Z').getTimezoneOffset()

const noReviews = { listUnfrozenKept: async () => [], insertIgnore: async () => {} }

function unfrozen(id: number) {
  return {
    id, runId: 1, ticker: 'AAPL', captureId: id * 10, status: 'confirmed' as const, side: 'buy', shares: 2, price: 1_000_000n, fee: null, filledOn: '2026-11-04',
    detectedSide: 'buy', detectedShares: 2, detectedPrice: 1_000_000n, detectedFilledOn: '2026-11-04', detectedFee: null, detectedAt: '2026-11-04 00:00:00',
  }
}

function makeRepos(over: { sweepDrafts?: (d: Date) => Promise<number>; sweepOrphans?: () => Promise<number[]>; listUnfrozenKept?: () => Promise<any[]> } = {}) {
  const draftArgs: Date[] = []
  const inserted: number[] = []
  const calls: string[] = []
  let orphanCalls = 0
  const repos = {
    visionReviewRepo: {
      listUnfrozenKept: async () => {
        calls.push('listUnfrozenKept')
        return over.listUnfrozenKept ? over.listUnfrozenKept() : []
      },
      insertIgnore: async (row: { pendingFillId: number }) => { inserted.push(row.pendingFillId) },
    },
    simRepo: {
      sweepDrafts: async (d: Date) => {
        calls.push('sweepDrafts')
        draftArgs.push(d)
        return over.sweepDrafts ? over.sweepDrafts(d) : 0
      },
    },
    captureImageRepo: {
      sweepOrphans: async () => {
        calls.push('sweepOrphans')
        orphanCalls++
        return over.sweepOrphans ? over.sweepOrphans() : []
      },
    },
  }
  return { repos, draftArgs, inserted, calls, orphanCalls: () => orphanCalls }
}

const DAY_MS = 86_400_000
const draftConfig = {
  ticker: 'A', fromDate: '2026-11-02', toDate: '2026-11-06', poolCents: 1_000_000, costPpm: 30,
  buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, paramsJson: '{}',
}

// seeds one draft per age (ms before `at`) in the fake sim repo, runs the boot sweep, returns the ids and survivors
async function sweepDraftsAged(at: Date, agesMs: number[]) {
  const f = makeFakes()
  const ids: number[] = []
  for (const age of agesMs) {
    const id = await f.repos.simRepo.insertRun(draftConfig)
    f.simRuns.find((r) => r.id === id)!.createdAt = new Date(at.getTime() - age).toISOString()
    ids.push(id)
  }
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runBootSweeps({ simRepo: f.repos.simRepo, captureImageRepo: { sweepOrphans: async () => [] }, visionReviewRepo: noReviews }, at)
  } finally {
    log.mockRestore()
  }
  return { ids, survivors: f.simRuns.map((r) => r.id) }
}

describe('runBootSweeps', () => {
  test('the draft window keeps 6 d and 7 d − 1 s, and sweeps 7 d + 1 s and 8 d', async () => {
    const { ids, survivors } = await sweepDraftsAged(new Date('2026-11-18T17:00:00Z'), [
      6 * DAY_MS, 7 * DAY_MS - 1000, 7 * DAY_MS + 1000, 8 * DAY_MS,
    ])
    expect(survivors).toEqual([ids[0]!, ids[1]!])
  })

  test('the window is 168 elapsed hours even across the fall-back change', async () => {
    // 2026-11-03 12:00 EST minus seven New York calendar days is 2026-10-27 12:00 EDT, 169 h back: a draft 168.5 h old
    // is past the real 168 h window (swept) but inside a calendar-day window (it would be kept)
    // the default runner zone is UTC, which has no fall-back change; calendar-day arithmetic only differs in a zone that does
    const prevTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const { ids, survivors } = await sweepDraftsAged(new Date('2026-11-03T17:00:00Z'), [168.5 * 3_600_000, 167.5 * 3_600_000])
      expect(survivors).toEqual([ids[1]!])
    } finally {
      // the runner defaults to UTC without setting TZ, so deleting the variable would fall back to the machine's zone
      process.env.TZ = prevTz ?? 'Etc/UTC'
    }
  })

  test('the DST test restores the zone the process started in', () => {
    expect(new Date('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(offsetAtLoad)
  })

  test('both sweeps run; the draft cutoff is exactly seven days before now', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos, draftArgs, orphanCalls } = makeRepos({ sweepDrafts: async () => 2 })
      await runBootSweeps(repos, now)
      expect(draftArgs).toEqual([new Date(now.getTime() - 7 * 86_400_000)])
      expect(orphanCalls()).toBe(1)
      expect(log).toHaveBeenCalledWith('[main] swept 2 stale sim draft(s) older than 7 days')
    } finally {
      log.mockRestore()
    }
  })

  test('a failing draft sweep still runs the screenshot sweep, and neither throws', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos, orphanCalls } = makeRepos({ sweepDrafts: async () => { throw new Error('lock timeout') } })
      await expect(runBootSweeps(repos, now)).resolves.toBeUndefined()
      expect(err).toHaveBeenCalledTimes(1)
      expect(orphanCalls()).toBe(1)
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })

  test('a failing screenshot sweep is logged, not thrown', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos } = makeRepos({ sweepOrphans: async () => { throw new Error('db down') } })
      await expect(runBootSweeps(repos, now)).resolves.toBeUndefined()
      expect(err).toHaveBeenCalledTimes(1)
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })

  test('swept capture ids are logged', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos } = makeRepos({ sweepOrphans: async () => [3, 9] })
      await runBootSweeps(repos, now)
      const lines = log.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('3, 9'))).toBe(true)
    } finally {
      log.mockRestore()
    }
  })

  test('nothing is logged about screenshots when none were swept', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos } = makeRepos()
      await runBootSweeps(repos, now)
      expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('screenshots'))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  test('the review rebuild runs after both sweeps and logs the ids it rebuilt', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos, inserted, orphanCalls, calls } = makeRepos({ listUnfrozenKept: async () => [unfrozen(5), unfrozen(8)] })
      await runBootSweeps(repos, now)
      expect(calls).toEqual(['sweepDrafts', 'sweepOrphans', 'listUnfrozenKept'])
      expect(orphanCalls()).toBe(1)
      expect(inserted).toEqual([5, 8])
      expect(log).toHaveBeenCalledWith('[main] rebuilt review records for pending fill ids: 5, 8')
    } finally {
      log.mockRestore()
    }
  })

  test('nothing is logged about the rebuild when no record was missing', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos } = makeRepos()
      await runBootSweeps(repos, now)
      expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('rebuilt'))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  test('a failing review rebuild is logged, not thrown, and the sweeps still ran', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { repos, orphanCalls } = makeRepos({ listUnfrozenKept: async () => { throw new Error('db down') } })
      await expect(runBootSweeps(repos, now)).resolves.toBeUndefined()
      expect(err).toHaveBeenCalledTimes(1)
      expect(String(err.mock.calls[0]![0])).toContain('review record rebuild failed (continuing):')
      expect(orphanCalls()).toBe(1)
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })
})
