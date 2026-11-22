import { test, expect } from 'bun:test'
import type { getRepos } from '../src/db/repos'

export function _dbPins(g: typeof getRepos) {
  // @ts-expect-error the real repositories need a Drizzle database
  g({})
}

test('repository surface type pins compile', () => { expect(true).toBe(true) })
