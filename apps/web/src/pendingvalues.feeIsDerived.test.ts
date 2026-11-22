import { describe, expect, test } from 'bun:test';
import type { DetectedDto, PendingFillDto } from './api';
import { feeIsDerived, type RowValues } from './pendingvalues';

// costPpm 40 makes the derived fee 7 cents for 10 sh @ 178.40 (the `detected` snapshot below),
// 9 cents for 12 sh, 8 cents for 10 sh @ 200.00, and 14 cents for the legacy row's 10 sh @ 349.99.
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
    hasImage: true,
    costPpm: 40,
    heldBuckets: [],
    detected: null,
    ...over,
  };
}

const detected: DetectedDto = { side: 'buy', shares: 10, price: '1784000', filledOn: '2026-11-02', fee: 50 };
const feeless: DetectedDto = { ...detected, fee: null };
const row = (d: DetectedDto | null = detected) => pendingRow({ detected: d });
const same: RowValues = { side: 'buy', shares: '10', price: '178.40', filledOn: '2026-11-02', fee: '0.50', feeTouched: false };

describe('feeIsDerived', () => {
  const fl = row(feeless);

  test('a feeless capture holding exactly the derived fee is marked', () => {
    expect(feeIsDerived(fl, { ...same, fee: '0.07' })).toBe(true);
  });

  test('a typed fee that differs is not', () => {
    expect(feeIsDerived(fl, { ...same, fee: '0.09' })).toBe(false);
  });

  test('a stale derived fee is not, once qty has moved on', () => {
    expect(feeIsDerived(fl, { ...same, shares: '12', fee: '0.07', feeTouched: true })).toBe(false);
  });

  test('a blank fee shows nothing to mark', () => {
    expect(feeIsDerived(fl, { ...same, fee: '' })).toBe(false);
  });

  test('a fee vision read is never marked as derived', () => {
    expect(feeIsDerived(row(), same)).toBe(false);
    expect(feeIsDerived(row(), { ...same, fee: '0.07' })).toBe(false);
  });

  test('a legacy row is marked only when it stored no fee', () => {
    expect(feeIsDerived(row(null), { ...same, price: '349.99', fee: '0.14' })).toBe(true);
    expect(feeIsDerived(pendingRow({ detected: null, fee: 14 }), { ...same, price: '349.99', fee: '0.14' })).toBe(false);
  });
});
