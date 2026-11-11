import { describe, expect, test } from 'bun:test';
import type { BucketDto, PendingFillDto, SimPlanDto } from './api';
import {
  bucketCells,
  bulkPlan,
  daysBetween,
  enumLabelKey,
  fillSourceTone,
  isRunStatus,
  morningAge,
  myriadthsToUsdText,
  notionalCents,
  orderKindTone,
  orderStatusTone,
  pendingIssue,
  pnlBadgeTone,
  poolAfterTopUp,
  priceToCents,
  reasonKey,
  runActions,
  runStatusTone,
  seedCashErrorKey,
  simEventGroup,
  skipReasons,
  toneFor,
} from './viewmodels';

describe('enumLabelKey / reasonKey', () => {
  test('kebab wire values become camelCatalog keys', () => {
    expect(enumLabelKey('status', 'active')).toBe('statusActive');
    expect(enumLabelKey('orderKind', 'market_sell')).toBe('orderKindMarketSell');
    expect(reasonKey('orderReason', 'no-bucket')).toBe('orderReasonNoBucket');
    expect(reasonKey('historyReason', 'force-age')).toBe('historyReasonForceAge');
  });
});

describe('run status helpers', () => {
  test('isRunStatus accepts only lifecycle statuses', () => {
    expect(isRunStatus('created')).toBe(false);
    expect(isRunStatus('paused')).toBe(true);
    expect(isRunStatus('done')).toBe(false);
  });

  test('runActions per status, closed is terminal', () => {
    expect(runActions('active')).toEqual(['pause', 'close']);
    expect(runActions('paused')).toEqual(['resume', 'close']);
    expect(runActions('closed')).toEqual([]);
  });

  test('bulkPlan buckets selected ids by the transitions they can take', () => {
    const plan = bulkPlan([
      { id: 1, status: 'active' },
      { id: 2, status: 'paused' },
      { id: 3, status: 'closed' },
    ]);
    expect(plan).toEqual({ pause: [1], resume: [2], close: [1, 2] });
  });

  test('badge tones per status', () => {
    expect(runStatusTone('active')).toBe('success');
    expect(runStatusTone('closed')).toBe('info');
    expect(orderKindTone('market_sell')).toBe('danger');
    // `cancelled` is inert like `skipped`/`stale` — it never held money.
    expect(orderStatusTone('cancelled')).toBe('neutral');
    expect(fillSourceTone('seed')).toBe('info');
  });
});

describe('p&L tones', () => {
  test('zero and missing are neutral, sign drives the rest', () => {
    expect(toneFor(0)).toBe('neutral');
    expect(toneFor(null)).toBe('neutral');
    expect(toneFor(-150)).toBe('negative');
    expect(pnlBadgeTone('negative')).toBe('danger');
    expect(pnlBadgeTone(toneFor(250))).toBe('success');
  });
});

describe('money conversions', () => {
  test('USD text → cents rounds half-up', () => {
    expect(priceToCents('349.99')).toBe(34999);
    expect(priceToCents('0.005')).toBe(1);
    expect(priceToCents('oops')).toBeNull();
    expect(priceToCents(null)).toBeNull();
  });

  test('myriadths wire strings keep 4 decimal places', () => {
    expect(myriadthsToUsdText('3499900')).toBe('349.9900');
    expect(myriadthsToUsdText('-1')).toBeNull();
  });

  test('notional = price × shares, integer shares only', () => {
    expect(notionalCents('349.99', 10)).toBe(349990);
    expect(notionalCents('349.99', 0)).toBeNull();
    expect(notionalCents('349.99', 1.5)).toBeNull();
  });

  test('daysBetween is whole days, 0 on bad input', () => {
    expect(daysBetween('2026-11-02', '2026-11-10')).toBe(8);
    expect(daysBetween('nope', '2026-11-10')).toBe(0);
  });
});

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

function pendingRow(over: Partial<PendingFillDto> = {}): PendingFillDto {
  return {
    id: 1,
    runId: 1,
    captureId: null,
    bucketIdx: 0,
    side: 'buy',
    ticker: 'AAPL',
    shares: 10,
    price: '3499900',
    fee: null,
    filledOn: '2026-11-02',
    status: 'pending',
    createdAt: '2026-11-02T14:00:00Z',
    ...over,
  };
}

describe('pendingIssue', () => {
  test('first missing field wins', () => {
    expect(pendingIssue(pendingRow({ ticker: '' }))).toEqual({ field: 'ticker' });
    expect(pendingIssue(pendingRow({ side: 'SELL' }))).toEqual({ field: 'side' });
    expect(pendingIssue(pendingRow({ shares: 0 }))).toEqual({ field: 'shares' });
    expect(pendingIssue(pendingRow({ price: '' }))).toEqual({ field: 'price' });
    expect(pendingIssue(pendingRow({ filledOn: '' }))).toEqual({ field: 'filledOn' });
  });

  test('complete row needs no fix', () => {
    expect(pendingIssue(pendingRow())).toEqual({ field: null });
  });
});

describe('bucketCells', () => {
  const held: BucketDto = {
    index: 0,
    state: 'held',
    shares: 10,
    buyPrice: '3499900',
    buyFeeCents: 50,
    filledOn: '2026-11-02',
  };

  test('held bucket computes notional and hits force-sell at max age', () => {
    const cells = bucketCells([held], { '0': 5 }, 2, 5);
    expect(cells.length).toBe(2);
    expect(cells[0].filled).toBe(true);
    expect(cells[0].state).toBe('held');
    expect(cells[0].buyPrice).toBe('3499900');
    expect(cells[0].buyFeeCents).toBe(50);
    expect(cells[0].notionalCents).toBe(349990);
    expect(cells[0].ageDays).toBe(5);
    expect(cells[0].forceSell).toBe(true);
  });

  test('younger than max age is not forced', () => {
    const cells = bucketCells([held], { '0': 2 }, 2, 5);
    expect(cells[0].ageDays).toBe(2);
    expect(cells[0].forceSell).toBe(false);
  });

  test('empty slots render with zero shares and no money', () => {
    const cells = bucketCells([held], { '0': 5 }, 2, 5);
    expect(cells[1]).toEqual({
      index: 1,
      filled: false,
      state: 'empty',
      shares: 0,
      buyPrice: null,
      buyFeeCents: null,
      notionalCents: null,
      ageDays: null,
      forceSell: false,
    });
  });

  test('force_sell wire state carries through', () => {
    const cells = bucketCells([{ ...held, state: 'force_sell' }], {}, 1, 5);
    expect(cells[0].filled).toBe(true);
    expect(cells[0].state).toBe('force_sell');
    expect(cells[0].forceSell).toBe(false); // no age known → no computed force
  });
});

describe('poolAfterTopUp', () => {
  test('the pool API sets an absolute amount: send pool + addition', () => {
    expect(poolAfterTopUp(950000, 50000)).toBe(1000000);
  });

  test('rejects non-positive additions', () => {
    expect(poolAfterTopUp(950000, 0)).toBeNull();
    expect(poolAfterTopUp(950000, -100)).toBeNull();
  });

  test('rejects values JSON cannot carry exactly as integers', () => {
    expect(poolAfterTopUp(100000, 0.5)).toBeNull();
    expect(poolAfterTopUp(Number.NaN, 50000)).toBeNull();
    expect(poolAfterTopUp(950000, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe('seedCashErrorKey', () => {
  test('cash is required when seed rows exist, even when the total is 0', () => {
    expect(seedCashErrorKey([{ bucketIdx: 0, cashCents: 0 }], null)).toBe('seedCashRequired');
  });

  test('valid input passes, invalid cents are rejected', () => {
    expect(seedCashErrorKey([{ bucketIdx: 0, cashCents: 0 }], 250000)).toBeNull();
    expect(seedCashErrorKey([{ bucketIdx: 0, cashCents: 0 }], -100)).toBe('seedCashInvalid');
    expect(seedCashErrorKey([{ bucketIdx: 0, cashCents: 0 }], 1.5)).toBe('seedCashInvalid');
  });

  test('no seed rows → no cash requirement', () => {
    expect(seedCashErrorKey([], null)).toBeNull();
  });

  test('typed-but-unparsable cash is invalid even with no seed rows', () => {
    expect(seedCashErrorKey([], null, true)).toBe('seedCashInvalid');
  });

  test('untouched cash input with no seed rows is fine', () => {
    expect(seedCashErrorKey([], null, false)).toBeNull();
  });

  test('zero cash is valid (form sends {cashCents: 0, buckets: []})', () => {
    expect(seedCashErrorKey([], 0, true)).toBeNull();
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
