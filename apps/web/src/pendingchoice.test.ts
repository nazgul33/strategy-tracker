import { describe, expect, it } from 'bun:test';
import { bucketRequired, dateAfterToday, orderLine } from './pendingchoice';
import type { RowValues } from './pendingvalues';
import { PENDING_ROW } from './testing/pendingRow';

const VALUES: RowValues = {
  filledOn: '2026-11-10',
  side: 'sell',
  shares: '10',
  price: '12345.00',
  fee: '1.00',
  feeTouched: false,
};

describe('dateAfterToday', () => {
  const row = { ...PENDING_ROW, today: '2026-11-12' };

  it('is false when the server sent no date', () => {
    expect(dateAfterToday(PENDING_ROW, { ...VALUES, filledOn: '2030-01-01' })).toBe(false);
  });

  it('is false for the same day and earlier days', () => {
    expect(dateAfterToday(row, { ...VALUES, filledOn: '2026-11-12' })).toBe(false);
    expect(dateAfterToday(row, { ...VALUES, filledOn: '2026-11-11' })).toBe(false);
  });

  it('is true for a later day', () => {
    expect(dateAfterToday(row, { ...VALUES, filledOn: '2026-11-13' })).toBe(true);
  });

  it("follows the entered date, not the row's stored one", () => {
    const future = { ...row, filledOn: '2026-12-01' };
    expect(dateAfterToday(future, { ...VALUES, filledOn: '2026-11-12' })).toBe(false);
    expect(dateAfterToday({ ...row, filledOn: '2026-11-01' }, { ...VALUES, filledOn: '2026-11-13' })).toBe(true);
  });

  it('is false while the date is blank', () => {
    expect(dateAfterToday(row, { ...VALUES, filledOn: '' })).toBe(false);
  });
});

describe('bucketRequired', () => {
  const needs = { ...PENDING_ROW, needsBucket: true };
  const calm = { ...PENDING_ROW, needsBucket: false };

  it('is only ever true for a sell on automatic', () => {
    expect(bucketRequired(needs, VALUES, '', false)).toBe(true);
    expect(bucketRequired(needs, { ...VALUES, side: 'buy' }, '', false)).toBe(false);
    expect(bucketRequired(needs, { ...VALUES, side: '' }, '', true)).toBe(false);
    expect(bucketRequired(needs, VALUES, '3', false)).toBe(false);
    expect(bucketRequired(needs, VALUES, '0', true)).toBe(false);
  });

  it('follows the dry run or a refused confirm', () => {
    expect(bucketRequired(calm, VALUES, '', false)).toBe(false);
    expect(bucketRequired(calm, VALUES, '', true)).toBe(true);
    expect(bucketRequired(PENDING_ROW, VALUES, '', false)).toBe(false);
    expect(bucketRequired(PENDING_ROW, VALUES, '', true)).toBe(true);
    expect(bucketRequired(needs, VALUES, '', true)).toBe(true);
  });
});

describe('orderLine', () => {
  it('is null without a snapshot', () => {
    expect(orderLine(null)).toBeNull();
  });

  it('is null when the snapshot read none of the three', () => {
    expect(orderLine(PENDING_ROW.detected)).toBeNull();
    expect(orderLine({ ...PENDING_ROW.detected!, orderType: null, orderPrice: null, orderedShares: null })).toBeNull();
  });

  it('returns what was read, with nulls for the rest', () => {
    const base = PENDING_ROW.detected!;
    expect(orderLine({ ...base, orderType: '매도/STOP(시장가)', orderPrice: '0', orderedShares: 1 })).toEqual({
      type: '매도/STOP(시장가)',
      shares: 1,
      price: '0',
    });
    expect(orderLine({ ...base, orderedShares: 4 })).toEqual({ type: null, shares: 4, price: null });
    expect(orderLine({ ...base, orderPrice: '640700' })).toEqual({ type: null, shares: null, price: '640700' });
  });
});
