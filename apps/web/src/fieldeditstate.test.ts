import { describe, expect, test } from 'bun:test';
import type { DetectedDto, PendingFillDto } from './api';
import { fieldEditState, type RowField, type RowValues } from './pendingvalues';

// costPpm 40 makes the derived fee 7 cents for 10 sh @ 178.40 (the `detected` snapshot below).
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
const FIELDS: RowField[] = ['filledOn', 'side', 'shares', 'price', 'fee'];

describe('fieldEditState', () => {
  test('an untouched row gives null for every field', () => {
    for (const field of FIELDS) expect(fieldEditState(row(), same, field)).toBeNull();
  });

  test('a changed quantity is changed', () => {
    expect(fieldEditState(row(), { ...same, shares: '11' }, 'shares')).toBe('changed');
    expect(fieldEditState(row(), { ...same, shares: '11' }, 'price')).toBeNull();
  });

  test('a cleared fee vision read is erased', () => {
    expect(fieldEditState(row(), { ...same, fee: '' }, 'fee')).toBe('erased');
  });

  test('a cleared derived fee on a feeless row is erased', () => {
    expect(fieldEditState(row(feeless), { ...same, fee: '' }, 'fee')).toBe('erased');
  });

  test('a cleared fee that cannot be derived is not erased', () => {
    expect(fieldEditState(row(feeless), { ...same, fee: '', shares: '' }, 'fee')).toBeNull();
  });

  test('a typed fee on a feeless row is filled', () => {
    expect(fieldEditState(row(feeless), { ...same, fee: '1.00' }, 'fee')).toBe('filled');
  });

  test('a cleared price is erased', () => {
    expect(fieldEditState(row(), { ...same, price: '' }, 'price')).toBe('erased');
  });

  test('a cleared date vision read is erased', () => {
    expect(fieldEditState(row(), { ...same, filledOn: '' }, 'filledOn')).toBe('erased');
  });

  test('a legacy row compares against its own values', () => {
    const legacy = pendingRow({ fee: 50, price: '1784000', shares: 10 });
    expect(fieldEditState(legacy, { ...same, fee: '' }, 'fee')).toBe('erased');
    expect(fieldEditState(legacy, { ...same, shares: '11' }, 'shares')).toBe('changed');
  });

  test('a field vision missed has no hint while blank, while the standing issue owns it', () => {
    const missed = row({ ...detected, filledOn: null });
    expect(fieldEditState(missed, { ...same, filledOn: '' }, 'filledOn')).toBeNull();
  });

  test('a missed field that is filled in reads as filled', () => {
    const missed = row({ ...detected, filledOn: null });
    expect(fieldEditState(missed, { ...same, filledOn: '2026-11-03' }, 'filledOn')).toBe('filled');
  });

  test('a changed field vision did read stays changed', () => {
    expect(fieldEditState(row(), { ...same, shares: '11' }, 'shares')).toBe('changed');
  });

  test('a legacy row never claims a field was unread: its edits read changed', () => {
    const legacy = pendingRow({ fee: 50, price: '1784000', shares: 10 });
    expect(fieldEditState(legacy, { ...same, price: '179.00' }, 'price')).toBe('changed');
    expect(fieldEditState(legacy, { ...same, filledOn: '2026-11-03' }, 'filledOn')).toBe('changed');
  });
});
