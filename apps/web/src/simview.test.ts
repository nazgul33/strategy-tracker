import { describe, expect, test } from 'bun:test';
import type { SimPlanDto } from './api';
import { morningAge, simEventGroup, skipReasons } from './simview';

describe('morningAge', () => {
  test('previous end-of-day age plus the overnight advanceDay bump', () => {
    expect(morningAge({ '1': 6 }, 1)).toBe(7);
    expect(morningAge({ '1': 6 }, 0)).toBeUndefined();
    expect(morningAge(undefined, 1)).toBeUndefined();
    expect(morningAge({}, 0)).toBeUndefined();
  });
});

describe('simEventGroup', () => {
  const buy = { type: 'fill', side: 'buy', bucketIndex: 0, shares: 10, price: '1', feeCents: 0 } as const;
  const sell = { type: 'fill', side: 'sell', bucketIndex: 0, shares: 10, price: '1', feeCents: 0 } as const;
  const skipped = { type: 'skipped', bucketIndex: 0, reason: 'no-quote' } as const;

  test('fills group by side, last-day sells are the forced liquidation', () => {
    expect(simEventGroup(skipped, true)).toBe('skipped');
    expect(simEventGroup(buy, false)).toBe('buy');
    expect(simEventGroup(sell, true)).toBe('force');
    expect(simEventGroup(sell, false)).toBe('target');
  });
});

describe('skipReasons', () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    key === 'digest.sell-capped' ? `sell capped (price ${vars?.price})` : key;

  test('pairs a skip with the first unconsumed notice for its bucket', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 3, limitPrice: '0', shares: 10 }],
      notices: [
        { code: 'sell-capped', params: { bucket: 3, price: 340 } },
      ],
    } as unknown as SimPlanDto;
    const { reasons, visibleNotices } = skipReasons(plan, t);
    // Keyed by skip-row index (index into plan.skips), not bucketIndex.
    expect(reasons.get(0)).toBe('sell capped (price 340)');
    expect(visibleNotices).toEqual([]);
  });

  test('pairing matches on bucket regardless of notice code — first wins', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 3, limitPrice: '0', shares: 10 }],
      notices: [
        { code: 'other', params: { bucket: 3 } },
        { code: 'sell-capped', params: { bucket: 3, price: 340 } },
      ],
    } as unknown as SimPlanDto;
    // Pins renderDigest semantics (digest.ts:22): findIndex takes the first
    // *unconsumed* notice with a matching bucket param, whatever its code.
    const { reasons, visibleNotices } = skipReasons(plan, t);
    expect(reasons.get(0)).toBe('digest.other');
    // The consumed winner is suppressed; the unconsumed loser stays visible.
    expect(visibleNotices).toEqual([{ code: 'sell-capped', params: { bucket: 3, price: 340 } }]);
  });

  test('pairs skips with notices whose bucket param is a string (legacy stored plans)', () => {
    // The old sell-cap producer wrote params.bucket as String(b.index) while
    // skip.bucketIndex is a number; plans persisted by that code store the
    // mismatch, so pairing must compare both sides as strings.
    const plan = {
      orders: [],
      skips: [
        { kind: 'sell_loc', bucketIndex: 1, limitPrice: '164.5', shares: 700 },
        { kind: 'sell_loc', bucketIndex: 2, limitPrice: '150.7007', shares: 100 },
      ],
      notices: [
        { code: 'sell-capped', params: { bucket: '1', price: 164.5 } },
        { code: 'sell-capped', params: { bucket: '2', price: 150.7007 } },
      ],
    } as unknown as SimPlanDto;
    const { reasons, visibleNotices } = skipReasons(plan, t);
    expect(reasons.get(0)).toBe('sell capped (price 164.5)');
    expect(reasons.get(1)).toBe('sell capped (price 150.7007)');
    expect(visibleNotices).toEqual([]);
  });

  test('a skip with no matching notice gets no reason', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 1, limitPrice: '0', shares: 10 }],
      notices: [{ code: 'sell-capped', params: { bucket: 5, price: 340 } }],
    } as unknown as SimPlanDto;
    const { reasons, visibleNotices } = skipReasons(plan, t);
    expect(reasons.has(0)).toBe(false);
    expect(visibleNotices).toEqual(plan.notices);
  });

  test('a consumed notice is dropped from visibleNotices; the rest keep their order', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 3, limitPrice: '0', shares: 10 }],
      notices: [
        { code: 'no-bucket-available', params: { bucket: 2 } },
        { code: 'sell-capped', params: { bucket: 3, price: 340 } },
        { code: 'unconfirmed', params: { bucket: 4, count: 1, date: '2026-11-10' } },
      ],
    } as unknown as SimPlanDto;
    // Pins renderDigest suppression (digest.ts:31-34): a notice consumed as a
    // skip's reason must not also render in the notices block — in order.
    const { reasons, visibleNotices } = skipReasons(plan, t);
    expect(reasons.get(0)).toBe('sell capped (price 340)');
    expect(visibleNotices).toEqual([
      { code: 'no-bucket-available', params: { bucket: 2 } },
      { code: 'unconfirmed', params: { bucket: 4, count: 1, date: '2026-11-10' } },
    ]);
  });
});

// Cancel-reason display: `cancelReason` wins the shared reason cell; a legacy
// `cancelled` row that carries only a `skipReason` keeps rendering its skip
// label byte-for-byte, and a row with neither renders '' (the table supplies
// the em dash). Status is deliberately not consulted.
