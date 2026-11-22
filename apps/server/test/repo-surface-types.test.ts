import { test, expect } from 'bun:test'
import type { getRepos } from '../src/db/repos'
import type { RepoSurface } from '../src/domain/booking'

export function _dbPins(g: typeof getRepos) {
  // @ts-expect-error the real repositories need a Drizzle database
  g({})
}

export async function _orderPendingPins(r: RepoSurface) {
  // @ts-expect-error an order needs every column
  await r.orderRepo.insertMany([{ runId: 1 }])
  // @ts-expect-error 'closed' is a run status, not an order status
  await r.orderRepo.setStatus(1, 'closed')
  // @ts-expect-error limitPrice is bigint myriadths
  const _lp: string = (await r.orderRepo.get(1))!.limitPrice
  // @ts-expect-error a pending row carries its vision snapshot
  await r.pendingRepo.insert({ runId: 1 })
  // @ts-expect-error price is bigint myriadths
  const _pp: string = (await r.pendingRepo.listPending())[0]!.price
}

test('repository surface type pins compile', () => { expect(true).toBe(true) })
