import { describe, test, expect } from 'bun:test'
import { formatUsd, parseUsd } from '@st/core/money'
import type { RawFill } from '@st/ingest'
import { knownOrderPrice, matchVrFills, type VrExisting } from '../src/domain/vr/capture-match'

const D = '2026-11-09'
const TODAY = '2026-11-10'
const ex = (kind: VrExisting['kind'], shares: number, price: string, op: string | null = null, over: Partial<VrExisting> = {}): VrExisting =>
  ({ kind, side: 'buy', shares, price: parseUsd(price), filledOn: D, orderPrice: op === null ? null : parseUsd(op), ...over })
const inc = (shares: number, price: string, op?: string, over: Partial<RawFill> = {}): RawFill =>
  ({ side: 'buy', ticker: 'TQQQ', shares, price, date: D, ...(op === undefined ? {} : { orderPrice: op }), ...over })
// [shares, price, order price, cited price] per kept row, in screenshot order
const run = (existing: VrExisting[], incoming: RawFill[]) => {
  const m = matchVrFills(existing, incoming, TODAY)
  return { dropped: m.dropped, rows: m.rows.map((r) => [r.fill.shares, r.fill.price, r.fill.orderPrice ?? null, r.dupPrice === null ? null : formatUsd(r.dupPrice)]) }
}
const perms = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))

describe('the spec table, one entry against one fill', () => {
  type Cell = 'drop' | 'mark' | 'plain'
  const ops: Record<string, [string | null, string | undefined]> = {
    equal: ['44.39', '44.39'], entryUnknown: [null, '44.39'], fillUnknown: ['44.39', undefined], bothUnknown: [null, undefined], different: ['44.39', '43.66'],
  }
  const shapes: Record<string, [number, string]> = { samePS: [3, '44.39'], sharesOtherPrice: [3, '44.40'], otherShares: [8, '44.39'] }
  // [booked or waiting, rejected]
  const table: Record<string, Record<string, [Cell, Cell]>> = {
    samePS: { equal: ['drop', 'drop'], entryUnknown: ['drop', 'drop'], fillUnknown: ['drop', 'drop'], bothUnknown: ['drop', 'drop'], different: ['mark', 'mark'] },
    sharesOtherPrice: { equal: ['mark', 'mark'], entryUnknown: ['mark', 'plain'], fillUnknown: ['mark', 'plain'], bothUnknown: ['mark', 'plain'], different: ['plain', 'plain'] },
    otherShares: { equal: ['mark', 'mark'], entryUnknown: ['plain', 'plain'], fillUnknown: ['plain', 'plain'], bothUnknown: ['plain', 'plain'], different: ['plain', 'plain'] },
  }
  const cases = (['booked', 'waiting', 'rejected'] as const).flatMap((kind) =>
    Object.keys(shapes).flatMap((shape) => Object.keys(ops).map((op) => [kind, shape, op, table[shape]![op]![kind === 'rejected' ? 1 : 0]] as const)))

  test.each(cases)('%s entry, %s, order prices %s -> %s', (kind, shape, op, cell) => {
    const [entryOp, fillOp] = ops[op]!
    const [shares, price] = shapes[shape]!
    const got = run([ex(kind, 3, '44.39', entryOp)], [inc(shares, price, fillOp)])
    if (cell === 'drop') expect(got).toEqual({ dropped: 1, rows: [] })
    else expect(got).toEqual({ dropped: 0, rows: [[shares, price, fillOp ?? null, cell === 'mark' ? '44.39' : null]] })
  })
})

describe('the reviewer sequences', () => {
  const waiting = [ex('waiting', 3, '44.39', '44.39'), ex('waiting', 3, '43.66', '43.66'), ex('waiting', 3, '42.95', '42.95')]

  test('(a) a second screenshot of a ladder day: one dropped, two plain', () => {
    expect(run(waiting, [inc(3, '42.95', '42.95'), inc(3, '42.26', '42.26'), inc(3, '41.59', '41.59')]))
      .toEqual({ dropped: 1, rows: [[3, '42.26', '42.26', null], [3, '41.59', '41.59', null]] })
  })

  test('(a) the same fills without order prices: one dropped, two marked, both citing the first unused entry', () => {
    const expected = { dropped: 1, rows: [[3, '42.26', null, '44.39'], [3, '41.59', null, '44.39']] }
    expect(run(waiting, [inc(3, '42.95'), inc(3, '42.26'), inc(3, '41.59')])).toEqual(expected)
    expect(run(waiting.map((w) => ({ ...w, orderPrice: null })), [inc(3, '42.95'), inc(3, '42.26'), inc(3, '41.59')])).toEqual(expected)
  })

  test('(b) a gap open: another order price is kept and marked, the same order price is dropped', () => {
    const gap = [ex('waiting', 3, '42.00', '44.39'), ex('waiting', 3, '42.00', '43.66')]
    expect(run(gap, [inc(3, '42.00', '42.95')])).toEqual({ dropped: 0, rows: [[3, '42.00', '42.95', '42.00']] })
    expect(run(gap, [inc(3, '42.00', '43.66')])).toEqual({ dropped: 1, rows: [] })
  })

  test('(c) the same order read with other shares is marked when its order price is known, plain when not', () => {
    const booked = [ex('booked', 3, '44.39', '44.39')]
    expect(run(booked, [inc(8, '44.39', '44.39')])).toEqual({ dropped: 0, rows: [[8, '44.39', '44.39', '44.39']] })
    expect(run(booked, [inc(8, '44.39')])).toEqual({ dropped: 0, rows: [[8, '44.39', null, null]] })
  })

  test('(d) a rejected entry drops an equal fill, with or without an order price', () => {
    const rejected = [ex('rejected', 3, '44.39', '44.39')]
    expect(run(rejected, [inc(3, '44.39', '44.39')])).toEqual({ dropped: 1, rows: [] })
    expect(run(rejected, [inc(3, '44.39')])).toEqual({ dropped: 1, rows: [] })
  })

  test('(d) with both order prices known, a rejected entry marks a fill that differs in order price, price or shares', () => {
    const rejected = [ex('rejected', 3, '44.39', '44.39')]
    expect(run(rejected, [inc(3, '44.39', '44.30')]).rows).toEqual([[3, '44.39', '44.30', '44.39']])
    expect(run(rejected, [inc(3, '44.40', '44.39')]).rows).toEqual([[3, '44.40', '44.39', '44.39']])
    expect(run(rejected, [inc(8, '44.39', '44.39')]).rows).toEqual([[8, '44.39', '44.39', '44.39']])
  })

  test('(d) with an unknown order price a rejected entry never marks', () => {
    expect(run([ex('rejected', 3, '44.39')], [inc(3, '44.40', '44.39'), inc(8, '44.39', '44.39')]).rows)
      .toEqual([[3, '44.40', '44.39', null], [8, '44.39', '44.39', null]])
    expect(run([ex('rejected', 3, '44.39', '44.39')], [inc(3, '44.40')]).rows).toEqual([[3, '44.40', null, null]])
  })

  test('(e) two equal entries cancel two equal fills and a third is kept: plain without order prices', () => {
    expect(run([ex('booked', 3, '44.39'), ex('booked', 3, '44.39')], [inc(3, '44.39'), inc(3, '44.39'), inc(3, '44.39')]))
      .toEqual({ dropped: 2, rows: [[3, '44.39', null, null]] })
  })

  test('(e) the same with one known order price: the third is marked, never booked unseen', () => {
    expect(run([ex('booked', 3, '44.39', '44.39'), ex('booked', 3, '44.39', '44.39')], [inc(3, '44.39', '44.39'), inc(3, '44.39', '44.39'), inc(3, '44.39', '44.39')]))
      .toEqual({ dropped: 2, rows: [[3, '44.39', '44.39', '44.39']] })
  })

  test('(e2) two leftover fills that both match one entry are both marked', () => {
    const booked = [ex('booked', 3, '42.00', '44.39')]
    expect(run(booked, [inc(3, '42.00', '46.00'), inc(3, '42.00', '45.15')]).rows).toEqual([[3, '42.00', '46.00', '42.00'], [3, '42.00', '45.15', '42.00']])
    expect(run(booked, [inc(3, '42.80', '44.39'), inc(3, '42.00', '45.15')]).rows).toEqual([[3, '42.80', '44.39', '42.00'], [3, '42.00', '45.15', '42.00']])
  })

  test('a row repeated by vision is dropped once and its twin is marked', () => {
    expect(run([ex('booked', 3, '44.39', '44.39')], [inc(3, '44.39', '44.39'), inc(3, '44.30', '44.39')]))
      .toEqual({ dropped: 1, rows: [[3, '44.30', '44.39', '44.39']] })
  })

  test('(g) an order price of zero counts as unknown, in any spelling', () => {
    for (const zero of ['0', '0.0000', '0.00', '']) expect(run([ex('booked', 3, '44.39', '44.39')], [inc(3, '44.39', zero)])).toEqual({ dropped: 1, rows: [] })
    expect(run([ex('booked', 3, '44.39', null, { orderPrice: 0n })], [inc(3, '44.39', '43.66')])).toEqual({ dropped: 1, rows: [] })
    expect(run([ex('booked', 3, '44.39', '44.39')], [inc(3, '44.39', 'n/a')])).toEqual({ dropped: 1, rows: [] })
  })

  test('(g) an order price in four decimals equals the stored one', () => {
    expect(run([ex('booked', 3, '44.39', '44.39')], [inc(8, '44.39', '44.3900')]).rows).toEqual([[8, '44.39', '44.3900', '44.39']])
  })

  test('(h) a fill with no date uses today, and does not match yesterday', () => {
    expect(run([ex('booked', 3, '44.39', '44.39', { filledOn: TODAY })], [inc(3, '44.39', '44.39', { date: undefined })])).toEqual({ dropped: 1, rows: [] })
    expect(run([ex('booked', 3, '44.39', '44.39', { filledOn: D })], [inc(3, '44.39', '44.39', { date: undefined })]))
      .toEqual({ dropped: 0, rows: [[3, '44.39', '44.39', null]] })
  })
})

describe('order of the passes', () => {
  test('a fill with a known order price takes an entry without one before a fill without one does', () => {
    expect(run([ex('waiting', 3, '42.00'), ex('waiting', 3, '42.00', '44.39')], [inc(3, '42.00'), inc(3, '42.00', '43.66')])).toEqual({ dropped: 2, rows: [] })
  })

  test('the kept rows come back in screenshot order, as the same objects', () => {
    const x = inc(4, '43.00'), y = inc(3, '44.39'), z = inc(5, '41.00')
    const m = matchVrFills([ex('booked', 3, '44.39')], [x, y, z], TODAY)
    expect(m.dropped).toBe(1)
    expect(m.rows.map((r) => r.fill)).toEqual([x, z])
    expect(m.rows[0]!.fill).toBe(x)
    expect(m.rows[1]!.fill).toBe(z)
  })

  test('a booked entry is cited before a waiting one, a waiting one before a rejected one', () => {
    const entries = [ex('rejected', 3, '44.00', '44.39'), ex('waiting', 3, '43.00', '44.39'), ex('booked', 3, '42.00', '44.39')]
    expect(run(entries, [inc(8, '44.39', '44.39')]).rows).toEqual([[8, '44.39', '44.39', '42.00']])
  })

  test('the entries are sorted by kind by the matcher itself, not by the caller', () => {
    expect(run([ex('waiting', 3, '42.00'), ex('booked', 3, '42.00', '44.39')], [inc(3, '42.00', '44.39')])).toEqual({ dropped: 1, rows: [] })
    expect(run([ex('rejected', 3, '42.00', '44.39'), ex('booked', 3, '41.00', '44.39')], [inc(8, '42.00', '44.39')]).rows).toEqual([[8, '42.00', '44.39', '41.00']])
  })
})

describe('days of a ladder', () => {
  const rungs = ['44.39', '43.66', '42.95', '42.26', '41.59', '40.93', '40.28', '39.64', '39.01', '38.39', '37.78', '37.18', '36.59']
  const rung = (p: string, side: 'buy' | 'sell' = 'buy') => inc(3, p, p, { side })
  const entry = (p: string) => ex('waiting', 3, p, p)

  test('ten rows on an empty run are all plain', () => {
    expect(run([], rungs.slice(0, 10).map((p) => rung(p)))).toEqual({ dropped: 0, rows: rungs.slice(0, 10).map((p) => [3, p, p, null]) })
  })

  test('a successor screenshot repeating five rows and adding three: five dropped, three plain, none marked', () => {
    expect(run(rungs.slice(0, 10).map(entry), [...rungs.slice(5, 10), ...rungs.slice(10, 13)].map((p) => rung(p))))
      .toEqual({ dropped: 5, rows: rungs.slice(10, 13).map((p) => [3, p, p, null]) })
  })

  test('a sell ladder behaves the same', () => {
    const sells = rungs.slice(0, 3).map((p) => ex('waiting', 2, p, p, { side: 'sell' }))
    expect(run(sells, ['42.95', '42.26', '41.59'].map((p) => inc(2, p, p, { side: 'sell' }))))
      .toEqual({ dropped: 1, rows: [[2, '42.26', '42.26', null], [2, '41.59', '41.59', null]] })
  })

  test('a sell does not meet a buy of the same lot and price', () => {
    expect(run([ex('booked', 3, '44.39', '44.39')], [inc(3, '44.39', '44.39', { side: 'sell' })])).toEqual({ dropped: 0, rows: [[3, '44.39', '44.39', null]] })
  })

  describe('a gap open: five rungs all fill at 42.00', () => {
    const ops = ['44.39', '43.66', '42.95', '42.26', '41.59', '40.93']
    const at = (i: number) => inc(3, '42.00', ops[i])
    const seen = ops.slice(0, 3).map((o) => ex('waiting', 3, '42.00', o))

    test('rows 3 to 5 after rows 1 to 3: the repeated row is dropped, the two new ones are marked', () => {
      expect(run(seen, [at(2), at(3), at(4)])).toEqual({ dropped: 1, rows: [[3, '42.00', '42.26', '42.00'], [3, '42.00', '41.59', '42.00']] })
    })
    test('rows 1 to 5 after rows 1 to 3: three dropped, two plain', () => {
      expect(run(seen, [0, 1, 2, 3, 4].map(at))).toEqual({ dropped: 3, rows: [[3, '42.00', '42.26', null], [3, '42.00', '41.59', null]] })
    })
    test('rows 3 to 6: one dropped, three marked, whatever the order of the rows', () => {
      for (const order of perms([2, 3, 4, 5])) {
        const got = run(seen, order.map(at))
        expect(got.dropped).toBe(1)
        expect(got.rows).toHaveLength(3)
        expect(got.rows.every((r) => r[3] === '42.00')).toBe(true)
      }
    })
  })

  describe('the multi-day view has no order prices', () => {
    const ops = ['44.39', '43.66', '42.95', '42.26', '41.59']
    test('single-day first, multi-day after: five dropped', () => {
      expect(run(ops.map((o) => ex('waiting', 3, '42.00', o)), ops.map(() => inc(3, '42.00')))).toEqual({ dropped: 5, rows: [] })
    })
    test('multi-day first, single-day after: five dropped', () => {
      expect(run(ops.map(() => ex('waiting', 3, '42.00')), ops.map((o) => inc(3, '42.00', o)))).toEqual({ dropped: 5, rows: [] })
    })
    test('two multi-day entries and three single-day rows: two dropped, the row with the last order price is kept plain', () => {
      expect(run([ex('waiting', 3, '42.00'), ex('waiting', 3, '42.00')], ['44.39', '43.66', '42.95'].map((o) => inc(3, '42.00', o))))
        .toEqual({ dropped: 2, rows: [[3, '42.00', '44.39', null]] })
    })
  })
})

describe('a typed fill has no order price', () => {
  const typed = [ex('booked', 3, '44.39')]
  test('the same fill read from a screenshot is dropped', () => {
    expect(run(typed, [inc(3, '44.39', '44.39')])).toEqual({ dropped: 1, rows: [] })
  })
  test('another rung of the same lot is marked, citing the typed fill', () => {
    expect(run(typed, [inc(3, '43.66', '43.66')])).toEqual({ dropped: 0, rows: [[3, '43.66', '43.66', '44.39']] })
  })
  test('with its own row in the same screenshot the typed fill is consumed and the other rung is plain', () => {
    expect(run(typed, [inc(3, '44.39', '44.39'), inc(3, '43.66', '43.66')])).toEqual({ dropped: 1, rows: [[3, '43.66', '43.66', null]] })
  })
})

describe('a partial fill', () => {
  const part = (shares: number) => inc(shares, '42.95', '42.95')
  const entry = (shares: number, kind: VrExisting['kind'] = 'waiting') => ex(kind, shares, '42.95', '42.95')
  test('both parts in one screenshot on an empty run are plain', () => {
    expect(run([], [part(4), part(6)])).toEqual({ dropped: 0, rows: [[4, '42.95', '42.95', null], [6, '42.95', '42.95', null]] })
  })
  test('both parts again are dropped; only the second part is dropped alone', () => {
    expect(run([entry(4), entry(6)], [part(4), part(6)])).toEqual({ dropped: 2, rows: [] })
    expect(run([entry(4), entry(6)], [part(6)])).toEqual({ dropped: 1, rows: [] })
  })
  test('a mid-day part, then the whole order of 10: the 10 is marked', () => {
    expect(run([entry(4, 'booked')], [part(10)])).toEqual({ dropped: 0, rows: [[10, '42.95', '42.95', '42.95']] })
  })
  test('a mid-day part, then both parts: the 4 is dropped and the 6 is marked', () => {
    expect(run([entry(4, 'booked')], [part(4), part(6)])).toEqual({ dropped: 1, rows: [[6, '42.95', '42.95', '42.95']] })
  })
})

describe('knownOrderPrice', () => {
  test('a positive price is known; zero, empty, missing and unreadable are not', () => {
    expect(knownOrderPrice('44.39')).toBe(443_900n)
    expect(knownOrderPrice('44.3900')).toBe(443_900n)
    expect(knownOrderPrice(443_900n)).toBe(443_900n)
    for (const v of ['0', '0.0000', '', 'abc', 0n, null, undefined]) expect(knownOrderPrice(v)).toBeNull()
  })
})

describe('what is not the matcher to decide', () => {
  test('another side, shares, price or date is kept; only the price can mark', () => {
    const book = [ex('booked', 3, '44.39')]
    const got = run(book, [inc(3, '44.39', undefined, { side: 'sell' }), inc(4, '44.39'), inc(3, '44.40'), inc(3, '44.39', undefined, { date: '2026-11-08' })])
    expect(got.dropped).toBe(0)
    expect(got.rows.map((r) => r[3])).toEqual([null, null, '44.39', null])
  })
  test('nothing existing drops nothing', () => {
    expect(run([], [inc(3, '44.39')])).toEqual({ dropped: 0, rows: [[3, '44.39', null, null]] })
  })
})

describe('the result does not depend on the order of the incoming fills', () => {
  const key = (rows: { fill: RawFill; dupPrice: bigint | null }[]) =>
    rows.map((r) => JSON.stringify([r.fill.shares, r.fill.price, r.fill.orderPrice ?? null, r.fill.fee ?? null, r.fill.date ?? null, r.dupPrice?.toString() ?? null])).sort()
  const inputs: [string, VrExisting[], RawFill[]][] = [
    ['a gap open', [ex('waiting', 3, '42.00', '44.39'), ex('waiting', 3, '42.00', '43.66'), ex('waiting', 3, '42.00', '42.95')],
      [inc(3, '42.00', '42.95'), inc(3, '42.00', '42.26'), inc(3, '42.00', '41.59'), inc(3, '42.00', '40.93')]],
    ['(a) without order prices', [ex('waiting', 3, '44.39', '44.39'), ex('waiting', 3, '43.66', '43.66'), ex('waiting', 3, '42.95', '42.95')],
      [inc(3, '42.95'), inc(3, '42.26'), inc(3, '41.59')]],
    ['a misread order price next to a real rung', [ex('booked', 3, '42.00', '44.39')], [inc(3, '42.00', '46.00'), inc(3, '42.00', '45.15')]],
    ['fills that differ only in the fee', [ex('booked', 3, '42.00')], [inc(3, '42.00', undefined, { fee: '0.10' }), inc(3, '42.00')]],
    ['mixed known and unknown order prices', [ex('waiting', 3, '42.00'), ex('waiting', 3, '42.00', '44.39')], [inc(3, '42.00'), inc(3, '42.00', '43.66')]],
  ]
  test.each(inputs)('%s', (_name, existing, incoming) => {
    const first = matchVrFills(existing, incoming, TODAY)
    for (const p of perms(incoming)) {
      const got = matchVrFills(existing, p, TODAY)
      expect(got.dropped).toBe(first.dropped)
      expect(key(got.rows)).toEqual(key(first.rows))
    }
  })
})
