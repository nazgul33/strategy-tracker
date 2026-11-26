import { describe, expect, it } from 'bun:test';

import { vrFillChecks } from './vrFillChecks';

const t = (key: string) => key;
const OK = { side: 'buy' as const, shares: '3', price: '45.15', fee: '0.09', filledOn: '2026-12-08' };

describe('vrFillChecks', () => {
  it('returns the checked values', () => {
    expect(vrFillChecks(t, OK)).toEqual({
      value: { side: 'buy', shares: 3, price: '45.15', fee: '0.09', filledOn: '2026-12-08' },
    });
  });

  it('ungroups and trims the price and the share count', () => {
    expect(vrFillChecks(t, { ...OK, side: 'sell', shares: ' 5 ', price: ' 1,234.50 ' })).toEqual({
      value: { side: 'sell', shares: 5, price: '1234.50', fee: '0.09', filledOn: '2026-12-08' },
    });
  });

  it('leaves the fee undefined when it is blank, and accepts a fee of zero', () => {
    expect(vrFillChecks(t, { ...OK, fee: '  ' })).toEqual({
      value: { side: 'buy', shares: 3, price: '45.15', fee: undefined, filledOn: '2026-12-08' },
    });
    expect(vrFillChecks(t, { ...OK, fee: '0' })).toEqual({
      value: { side: 'buy', shares: 3, price: '45.15', fee: '0', filledOn: '2026-12-08' },
    });
  });

  const BAD = { price: 'abc', shares: '0', fee: '-1', filledOn: '2026-13' };

  it('words each failure with its own key', () => {
    expect(vrFillChecks(t, { ...OK, price: 'abc' })).toEqual({ error: 'manualInvalidPrice' });
    expect(vrFillChecks(t, { ...OK, price: '0' })).toEqual({ error: 'manualInvalidPrice' });
    expect(vrFillChecks(t, { ...OK, shares: '0' })).toEqual({ error: 'manualInvalidQty' });
    expect(vrFillChecks(t, { ...OK, shares: '1.5' })).toEqual({ error: 'manualInvalidQty' });
    expect(vrFillChecks(t, { ...OK, shares: '' })).toEqual({ error: 'manualInvalidQty' });
    expect(vrFillChecks(t, { ...OK, shares: '2147483648' })).toEqual({ error: 'vr.invalidSharesLarge' });
    expect(vrFillChecks(t, { ...OK, shares: '2147483647' })).toHaveProperty('value');
    expect(vrFillChecks(t, { ...OK, fee: '-1' })).toEqual({ error: 'manualInvalidFee' });
    expect(vrFillChecks(t, { ...OK, filledOn: '2026-13' })).toEqual({ error: 'manualInvalidDate' });
    expect(vrFillChecks(t, { ...OK, filledOn: '' })).toEqual({ error: 'manualInvalidDate' });
  });

  it('reports the first failure in the order price, shares, share limit, fee, date', () => {
    expect(vrFillChecks(t, { ...OK, ...BAD })).toEqual({ error: 'manualInvalidPrice' });
    expect(vrFillChecks(t, { ...OK, ...BAD, price: '45.15' })).toEqual({ error: 'manualInvalidQty' });
    expect(vrFillChecks(t, { ...OK, ...BAD, price: '45.15', shares: '2147483648' })).toEqual({ error: 'vr.invalidSharesLarge' });
    expect(vrFillChecks(t, { ...OK, ...BAD, price: '45.15', shares: '3' })).toEqual({ error: 'manualInvalidFee' });
    expect(vrFillChecks(t, { ...OK, ...BAD, price: '45.15', shares: '3', fee: '' })).toEqual({ error: 'manualInvalidDate' });
  });
});
