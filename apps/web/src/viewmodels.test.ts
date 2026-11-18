import { describe, expect, test } from 'bun:test';
import type { BucketDto } from './api';
import {
  bucketCells,
  bulkPlan,
  CANCEL_REASONS,
  daysBetween,
  enumLabelKey,
  fillSourceTone,
  isRunStatus,
  myriadthsToUsdText,
  notionalCents,
  orderKindTone,
  orderReasonText,
  orderStatusTone,
  pnlBadgeTone,
  poolAfterTopUp,
  priceToCents,
  reasonKey,
  runActions,
  runStatusTone,
  seedCashErrorKey,
  toneFor,
} from './viewmodels';

describe('enumLabelKey / reasonKey', () => {
  test('stop_sell label key', () => {
    expect(enumLabelKey('orderKind', 'stop_sell')).toBe('orderKindStopSell');
  });

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
    expect(orderKindTone('stop_sell')).toBe('warning');
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

// Cancel-reason display: `cancelReason` wins the shared reason cell; a legacy
// `cancelled` row that carries only a `skipReason` keeps rendering its skip
// label byte-for-byte, and a row with neither renders '' (the table supplies
// the em dash). Status is deliberately not consulted.
describe('orderReasonText', () => {
  test('cancel reason wins, skip reason otherwise, empty when neither', () => {
    const t = (k: string) => `«${k}»`;
    expect(orderReasonText({ status: 'cancelled', skipReason: null, cancelReason: 'stale-price' }, t)).toBe(
      '«cancelReasonStalePrice»',
    );
    expect(orderReasonText({ status: 'cancelled', skipReason: 'sell-capped', cancelReason: null }, t)).toBe(
      '«orderReasonSellCapped»',
    );
    expect(orderReasonText({ status: 'open', skipReason: 'no-bucket', cancelReason: null }, t)).toBe(
      '«orderReasonNoBucket»',
    );
    expect(orderReasonText({ status: 'open', skipReason: null, cancelReason: null }, t)).toBe('');
  });

  test('CANCEL_REASONS lists the four codes in display order', () => {
    expect([...CANCEL_REASONS]).toEqual(['broker-filled', 'strategy-change', 'stale-price', 'other']);
  });
});
