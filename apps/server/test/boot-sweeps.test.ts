import { describe, test, expect, spyOn } from 'bun:test'
import { runBootSweeps } from '../src/wire/boot-sweeps'

const now = new Date('2026-11-20T12:00:00Z')

function makeRepos(over: { sweepDrafts?: (d: Date) => Promise<number>; sweepOrphans?: () => Promise<number[]> } = {}) {
  const draftArgs: Date[] = []
  let orphanCalls = 0
  const repos = {
    simRepo: {
      sweepDrafts: async (d: Date) => {
        draftArgs.push(d)
        return over.sweepDrafts ? over.sweepDrafts(d) : 0
      },
    },
    captureImageRepo: {
      sweepOrphans: async () => {
        orphanCalls++
        return over.sweepOrphans ? over.sweepOrphans() : []
      },
    },
  }
  return { repos, draftArgs, orphanCalls: () => orphanCalls }
}

describe('runBootSweeps', () => {
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
})
