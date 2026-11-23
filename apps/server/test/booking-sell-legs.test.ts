import { describe, test, expect } from 'bun:test'
import { sellSetup, sellAt, sellTyped, orderOf, lastFill } from './sell-fixture'
import { ev } from './sell-attribute-fixture'

const STOP = ev('stop')
const TARGET = ev('target')

describe('sell matching with target and stop legs', () => {
  test('exact target match still wins', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' }, { idx: 1, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await sellTyped(runId, 10, '103.00', deps, ev('target', '103.00'))
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(orderOf(f, 0, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 1, 'sell_loc').status).toBe('open')
  })

  test('a target fill books to a target, not to a loose stop on another bucket', async () => {
    // bucket 0: buy 100.00, stop trigger 97.00; bucket 9: buy 90.00, target limit 91.00. 91.50 is also <= 97.00.
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 9, shares: 10, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 9, kind: 'sell_loc', price: '91.00' }, { idx: 9, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await sellTyped(runId, 10, '91.50', deps, TARGET)
    expect(lastFill(f).bucketIdx).toBe(9)
    expect(orderOf(f, 9, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
  })

  test('with several targets at or below the fill price, the highest limit wins', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '80.00' }, { idx: 1, shares: 10, buy: '90.00' }, { idx: 2, shares: 10, buy: '95.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '82.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' },
        { idx: 2, kind: 'sell_loc', price: '97.00' },
      ],
    )
    await sellTyped(runId, 10, '93.00', deps, TARGET)
    expect(lastFill(f).bucketIdx).toBe(1)
  })

  test('a fill that no bucket target reaches matches no target', async () => {
    // 94.00 is below bucket 1's 103.00 target limit, so it is not a target fill; it is at or under the 95.00 stop trigger, so the stop takes it.
    const { f, deps, runId } = await sellSetup(
      [{ idx: 1, shares: 10, buy: '100.00' }],
      [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '95.00' }],
    )
    await sellAt(runId, 10, '94.00', deps)
    expect(orderOf(f, 1, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 1, 'sell_loc').status).toBe('cancelled')
  })

  test('a stop fill books to the closest trigger at or above it', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 3, kind: 'sell_loc', price: '99.00' }, { idx: 3, kind: 'stop_sell', price: '93.00' },
      ],
    )
    await sellTyped(runId, 10, '92.50', deps, STOP)
    expect(lastFill(f).bucketIdx).toBe(3)
    expect(orderOf(f, 3, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
  })

  test('identical triggers resolve to the lowest bucket index', async () => {
    // Inserted high bucket first so insertion order cannot be what decides it.
    const { f, deps, runId } = await sellSetup(
      [{ idx: 2, shares: 10, buy: '100.00' }, { idx: 5, shares: 10, buy: '100.00' }, { idx: 7, shares: 10, buy: '100.00' }],
      [
        { idx: 7, kind: 'stop_sell', price: '97.00' },
        { idx: 5, kind: 'stop_sell', price: '97.00' },
        { idx: 2, kind: 'stop_sell', price: '97.00' },
      ],
    )
    await sellTyped(runId, 10, '96.00', deps, STOP)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(orderOf(f, 2, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 5, 'stop_sell').status).toBe('open')
  })

  test('identical target limits resolve to the lowest bucket index', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 4, shares: 10, buy: '90.00' }, { idx: 6, shares: 10, buy: '90.00' }],
      [{ idx: 6, kind: 'sell_loc', price: '92.00' }, { idx: 4, kind: 'sell_loc', price: '92.00' }],
    )
    await sellTyped(runId, 10, '92.50', deps, TARGET)
    expect(lastFill(f).bucketIdx).toBe(4)
  })

  test('a stale stop dated on the fill day matches like an open one', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [{ idx: 3, kind: 'stop_sell', price: '93.00', status: 'stale' }],
    )
    await sellAt(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(3)
    expect(orderOf(f, 3, 'stop_sell').status).toBe('filled')
  })

  test('orders of another run or another trade date never match', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [
        { idx: 3, kind: 'stop_sell', price: '93.00', runId: 999 },
        { idx: 3, kind: 'sell_loc', price: '92.00', tradeDate: '2026-11-11' },
      ],
    )
    await expect(sellTyped(runId, 10, '92.50', deps, STOP)).rejects.toMatchObject({ kind: 'choose-bucket' })
    expect(f._stores.fills).toHaveLength(0)
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
  })

  test('a candidate whose bucket holds fewer shares than the fill is skipped', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 1, shares: 5, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 1, kind: 'stop_sell', price: '97.00', shares: 5 }, { idx: 2, kind: 'stop_sell', price: '97.00' }],
    )
    await sellAt(runId, 10, '96.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
  })

  test('market_sell still matches at any price', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 2, kind: 'market_sell', price: '0' }],
    )
    await sellAt(runId, 10, '50.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(orderOf(f, 2, 'market_sell').status).toBe('filled')
  })

  test('a target-typed fill is read as the target, not as a looser stop on another bucket', async () => {
    // Bucket 0's stop trigger (105.00) is looser than bucket 1's target (92.00); a 93.00 fill must be read as the target.
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '110.00' }, { idx: 1, shares: 10, buy: '90.00' }],
      [{ idx: 0, kind: 'stop_sell', price: '105.00' }, { idx: 1, kind: 'sell_loc', price: '92.00' }],
    )
    await sellTyped(runId, 10, '93.00', deps, TARGET)
    expect(lastFill(f).bucketIdx).toBe(1)
  })
})
