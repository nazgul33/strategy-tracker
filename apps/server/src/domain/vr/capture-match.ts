import type { ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { RawFill } from '@st/ingest'

// Matches the fills of a VR screenshot against what the run already has, by side, date, shares, price and the order price
// the single-day view shows (see the spec, "VR intake" rule 2). A fill is dropped only when nothing tells it apart from an
// entry; a mark is the safe direction (Confirm all never books a marked row). Pure: no repository, no mean reversion code.
//  - Only drops use an entry up. Marks never do, so several fills can be marked against one entry and a duplicate cannot
//    come back unmarked because another fill took the entry first.
//  - Drops are decided in a canonical order of the fills, never in screenshot order, so the result does not depend on
//    the order of the rows (the kept rows still come back in screenshot order).
//  - A rejected entry marks only where both order prices are known, so a rejected fill read again with a misread cannot
//    return as a plain row, while an unknown order price never marks against it.

export interface VrExisting {
  kind: 'booked' | 'waiting' | 'rejected'
  side: 'buy' | 'sell'; shares: number; price: bigint; filledOn: ISODate
  orderPrice: bigint | null
}
export interface VrMatch { rows: { fill: RawFill; dupPrice: bigint | null }[]; dropped: number }

/** An order price that is present and not zero (a market order shows 0); anything else is unknown. */
export function knownOrderPrice(v: string | bigint | null | undefined): bigint | null {
  if (v === null || v === undefined || v === '') return null
  let p: bigint
  if (typeof v === 'bigint') p = v
  else {
    try { p = parseUsd(v) } catch { return null }
  }
  return p > 0n ? p : null
}

interface Entry extends VrExisting { used: boolean }
interface Incoming { fill: RawFill; side: 'buy' | 'sell'; shares: number; price: bigint; date: ISODate; op: bigint | null; out: 'drop' | bigint | null | undefined }

const KIND_ORDER = { booked: 0, waiting: 1, rejected: 2 } as const

export function matchVrFills(existing: readonly VrExisting[], incoming: readonly RawFill[], today: ISODate): VrMatch {
  const entries: Entry[] = existing.map((e) => ({ ...e, orderPrice: knownOrderPrice(e.orderPrice), used: false }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  const all: Incoming[] = incoming.map((fill) => ({
    fill, side: fill.side, shares: fill.shares, price: parseUsd(fill.price), date: fill.date ?? today, op: knownOrderPrice(fill.orderPrice), out: undefined,
  }))
  const key = (x: Incoming) => JSON.stringify([x.side, x.date, x.fill.date == null, x.shares, x.price.toString(), x.op?.toString() ?? '', x.fill.fee ?? ''])
  const canonical = [...all].sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0 })

  const sameDay = (x: Incoming, e: Entry) => e.side === x.side && e.filledOn === x.date
  const sameFill = (x: Incoming, e: Entry) => sameDay(x, e) && e.shares === x.shares && e.price === x.price
  const drops: ((x: Incoming, e: Entry) => boolean)[] = [
    (x, e) => sameFill(x, e) && x.op !== null && e.orderPrice === x.op,
    (x, e) => sameFill(x, e) && x.op !== null && e.orderPrice === null,
    (x, e) => sameFill(x, e) && x.op === null,
  ]
  for (const pass of drops) {
    for (const x of canonical) {
      if (x.out !== undefined) continue
      const e = entries.find((c) => !c.used && pass(x, c))
      if (e) { e.used = true; x.out = 'drop' }
    }
  }

  // A rejected entry takes part only where both order prices are known.
  const kindOk = (e: Entry, bothKnown: boolean) => e.kind !== 'rejected' || bothKnown
  const markA = (x: Incoming, e: Entry) => kindOk(e, true) && sameDay(x, e) && x.op !== null && e.orderPrice === x.op
  const markB = (x: Incoming, e: Entry) =>
    kindOk(e, true) && !e.used && sameFill(x, e) && x.op !== null && e.orderPrice !== null && e.orderPrice !== x.op
  const markC = (x: Incoming, e: Entry) =>
    kindOk(e, false) && !e.used && sameDay(x, e) && e.shares === x.shares && e.price !== x.price && (x.op === null || e.orderPrice === null)
  for (const x of all) {
    if (x.out !== undefined) continue
    const cite = entries.find((e) => markA(x, e)) ?? entries.find((e) => markB(x, e)) ?? entries.find((e) => markC(x, e))
    x.out = cite ? cite.price : null
  }

  return {
    rows: all.filter((x) => x.out !== 'drop').map((x) => ({ fill: x.fill, dupPrice: x.out as bigint | null })),
    dropped: all.filter((x) => x.out === 'drop').length,
  }
}
