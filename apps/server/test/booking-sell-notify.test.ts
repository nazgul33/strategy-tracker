import { describe, test, expect, spyOn } from 'bun:test'
import type { ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import {
  confirmPendingFill, manualFill, runBooking,
  type FillBookingDeps, type OrderRow,
} from '../src/domain/booking'
import { withRunLock } from '../src/domain/run-lock'
import { silentNotifier, NO_SNAPSHOT } from './booking-fakes'
import { D, sellSetup, orderOf, bookInput, pair, held1 } from './sell-fixture'

describe('sell matching with target and stop legs', () => {
  describe('notifying the operator of the cancelled leg', () => {
    type Notified = { runId: number; order: OrderRow }
    const withNotifier = (deps: FillBookingDeps, notified: Notified[]): FillBookingDeps => ({
      ...deps,
      notify: { ...silentNotifier, siblingCancelled: async (runId, order) => { notified.push({ runId, order: { ...order } }) } },
    })

    test('a bucket-emptying stop fill notifies once, naming the pulled leg', async () => {
      const { f, deps, runId } = await sellSetup(held1, pair)
      const notified: Notified[] = []
      await manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, withNotifier(deps, notified))
      expect(notified).toHaveLength(1)
      expect(notified[0]!.runId).toBe(runId)
      expect(notified[0]!.order).toMatchObject({ id: orderOf(f, 1, 'sell_loc').id, kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') })
    })

    test('every cancelled leg gets its own notification, lowest id first', async () => {
      const { f, deps, runId } = await sellSetup(held1, [...pair, { idx: 1, kind: 'market_sell', price: '0' }])
      const notified: Notified[] = []
      await runBooking(bookInput(runId, 10, '103.00'), withNotifier(deps, notified))
      expect(notified.map((n) => n.order.kind)).toEqual(['stop_sell', 'market_sell'])
      expect(notified.map((n) => n.order.id)).toEqual([orderOf(f, 1, 'stop_sell').id, orderOf(f, 1, 'market_sell').id])
    })

    // A screenshot of yesterday's fills, confirmed today after the morning re-plan:
    // today's legs are live at the broker against shares the operator no longer holds.
    test('a prior-day fill that empties the bucket also pulls and announces today legs', async () => {
      const yesterday: ISODate = '2026-11-11'
      const { f, deps, runId } = await sellSetup(
        [{ idx: 1, shares: 10, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
        [
          { idx: 1, kind: 'sell_loc', price: '103.00', tradeDate: yesterday },
          { idx: 1, kind: 'stop_sell', price: '97.00', tradeDate: yesterday },
          { idx: 1, kind: 'sell_loc', price: '103.00' },
          { idx: 1, kind: 'stop_sell', price: '97.00' },
          { idx: 2, kind: 'sell_loc', price: '103.00' },
          { idx: 2, kind: 'stop_sell', price: '97.00' },
        ],
      )
      const notified: Notified[] = []
      const legs = (idx: number, tradeDate: string) => f._stores.orders.filter((o: any) => o.bucketIdx === idx && o.tradeDate === tradeDate)
      const matched = legs(1, yesterday).find((o) => o.kind === 'stop_sell')!
      const { cancelledIds: cancelled } = await runBooking(
        { ...bookInput(runId, 10, '96.50'), filledOn: yesterday },
        withNotifier(deps, notified),
      )
      expect(matched.status).toBe('filled')
      const expectedIds = [...legs(1, yesterday).filter((o: any) => o.id !== matched.id), ...legs(1, D)].map((o: any) => o.id)
      expect(cancelled).toEqual(expectedIds)
      for (const o of [...legs(1, yesterday), ...legs(1, D)]) {
        if (o.id !== matched.id) expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
      }
      expect(notified.map((n) => n.order.id)).toEqual(expectedIds)
      expect(legs(2, D).every((o: any) => o.status === 'open')).toBe(true)
    })

    test('a partial fill notifies nobody', async () => {
      const { deps, runId } = await sellSetup(held1, pair)
      const notified: Notified[] = []
      await manualFill(runId, { side: 'sell', shares: 4, price: '96.50', filledOn: D }, withNotifier(deps, notified))
      expect(notified).toHaveLength(0)
    })

    test('a buy, and an emptying sell with no other open leg, notify nobody', async () => {
      const { deps, runId } = await sellSetup(held1, [{ idx: 1, kind: 'market_sell', price: '0' }])
      const notified: Notified[] = []
      const d = withNotifier(deps, notified)
      await manualFill(runId, { side: 'buy', shares: 5, price: '50.00', filledOn: D }, d)
      await manualFill(runId, { side: 'sell', shares: 10, price: '99.00', filledOn: D }, d)
      expect(notified).toHaveLength(0)
    })

    test('confirming a pending sell notifies too', async () => {
      const { f, deps, runId } = await sellSetup(held1, pair)
      const notified: Notified[] = []
      const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })
      await confirmPendingFill(pid, null, withNotifier(deps, notified))
      expect(notified).toHaveLength(1)
      expect(notified[0]!.order).toMatchObject({ kind: 'sell_loc', bucketIdx: 1 })
      expect(notified[0]!.runId).toBe(runId)
    })

    test('the notifier runs after the run lock is released', async () => {
      const { deps, runId } = await sellSetup(held1, pair)
      let seen = 'never called'
      // withRunLock is not reentrant: a probe queued from inside the lock can only wait, so it loses the race.
      const d: FillBookingDeps = {
        ...deps,
        notify: {
          ...silentNotifier,
          siblingCancelled: async (rid) => {
            seen = await Promise.race([withRunLock(rid, async () => 'free'), new Promise<string>((r) => setTimeout(() => r('held'), 100))])
          },
        },
      }
      await manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, d)
      expect(seen).toBe('free')
    })

    test('a failing notifier never fails the booking: fill, ledger row and cancel are all persisted', async () => {
      const { f, deps, runId } = await sellSetup(held1, pair)
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const d: FillBookingDeps = { ...deps, notify: { ...silentNotifier, siblingCancelled: async () => { throw new Error('telegram-down') } } }
        const { cancelledIds: cancelled } = await runBooking(bookInput(runId, 10, '96.50'), d)
        expect(f._stores.fills).toHaveLength(1)
        expect(f._stores.fills[0]).toMatchObject({ runId, bucketIdx: 1, side: 'sell', shares: 10 })
        expect(f._stores.ledger).toHaveLength(1)
        expect(f._stores.ledger[0].kind).toBe('sell')
        expect(orderOf(f, 1, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
        expect(orderOf(f, 1, 'stop_sell').status).toBe('filled')
        expect((await f.repos.bucketRepo.loadState(runId)).buckets[1]!.state).toBe('empty')
        expect(cancelled).toEqual([orderOf(f, 1, 'sell_loc').id])
        expect(errors).toHaveBeenCalledTimes(1)
      } finally { errors.mockRestore() }
    })

    test('a notifier that throws synchronously is swallowed too', async () => {
      const { f, deps, runId } = await sellSetup(held1, pair)
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const d: FillBookingDeps = { ...deps, notify: { ...silentNotifier, siblingCancelled: () => { throw new Error('boom') } } }
        await expect(manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, d)).resolves.toBeUndefined()
        expect(f._stores.fills).toHaveLength(1)
      } finally { errors.mockRestore() }
    })

    test('a failing notification does not stop the next cancelled leg from being notified', async () => {
      const { f, deps, runId } = await sellSetup(held1, [...pair, { idx: 1, kind: 'market_sell', price: '0' }])
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const attempts: number[] = []
        const d: FillBookingDeps = {
          ...deps,
          notify: { ...silentNotifier, siblingCancelled: async (_rid, o) => { attempts.push(o.id); if (attempts.length === 1) throw new Error('flaky') } },
        }
        await runBooking(bookInput(runId, 10, '103.00'), d)
        expect(attempts).toEqual([orderOf(f, 1, 'stop_sell').id, orderOf(f, 1, 'market_sell').id])
        expect(errors).toHaveBeenCalledTimes(1)
      } finally { errors.mockRestore() }
    })

    test('a booking that throws notifies nobody', async () => {
      const { f, deps, runId } = await sellSetup(held1, pair)
      const notified: Notified[] = []
      f.repos.fillRepo.insert = async () => { throw new Error('db-exploded') }
      await expect(manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, withNotifier(deps, notified))).rejects.toThrow('db-exploded')
      expect(notified).toHaveLength(0)
    })
  })
})
