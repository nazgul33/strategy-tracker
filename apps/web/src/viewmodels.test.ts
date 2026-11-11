import { describe, expect, test } from 'bun:test';
import type { BucketDto, PendingFillDto } from './api';
import {
  bucketCells,
  daysBetween,
  enumLabelKey,
  fillSourceTone,
  isRunStatus,
  myriadthsToUsdText,
  nextStatus,
  notionalCents,
  orderKindTone,
  orderStatusTone,
  pendingIssue,
  pnlBadgeTone,
  priceToCents,
  reasonKey,
  runStatusTone,
  simEventGroup,
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
  });

  test('nextStatus walks the lifecycle, done is terminal', () => {
    expect(nextStatus('active')).toBe('paused');
    expect(nextStatus('paused')).toBe('active');
    expect(nextStatus('closed')).toBe('done');
    expect(nextStatus('done')).toBeNull();
  });

  test('badge tones per status', () => {
    expect(runStatusTone('active')).toBe('success');
    expect(runStatusTone('done')).toBe('neutral');
    expect(orderKindTone('market_sell')).toBe('danger');
    expect(orderStatusTone('cancelled')).toBe('warning');
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
