import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// autoFeeUsd is re-exported by FillDialog; load it after register() like the
// sibling FillDialog suites do.
const { autoFeeUsd } = await import('./FillDialog');

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('autoFeeUsd', () => {
  it('computes the fee in whole cents from price, shares and ppm', () => {
    expect(autoFeeUsd('100', '340.23', 30)).toBe('1.02');
  });

  it('rounds an exact half cent up', () => {
    // 5 × $1.00 × 1000 ppm = 0.5¢ → 1¢
    expect(autoFeeUsd('5', '1.00', 1000)).toBe('0.01');
  });

  it('rounds half-up from a 4-decimal price rather than flooring', () => {
    // 1000 × $340.2345 × 30 ppm = 1020.7035¢ → 1021¢ (floor would give 10.20)
    expect(autoFeeUsd('1000', '340.2345', 30)).toBe('10.21');
  });

  it('returns 0.00 when cost is 0 ppm', () => {
    expect(autoFeeUsd('100', '340.23', 0)).toBe('0.00');
  });

  it('returns empty when costPpm is undefined', () => {
    expect(autoFeeUsd('100', '340.23', undefined)).toBe('');
  });

  it.each([['abc'], [''], ['0'], ['-5'], ['1.5']])('returns empty for invalid shares %p', (shares) => {
    expect(autoFeeUsd(shares, '340.23', 30)).toBe('');
  });

  it.each([['abc'], [''], ['0'], ['-1'], ['1.23456']])('returns empty for invalid price %p', (price) => {
    expect(autoFeeUsd('100', price, 30)).toBe('');
  });

  it.each([[1.5], [Number.NaN], [-30], [Number.POSITIVE_INFINITY]])(
    'returns empty instead of throwing for unusable costPpm %p',
    (costPpm) => {
      expect(autoFeeUsd('100', '340.23', costPpm)).toBe('');
    },
  );

  it('returns empty when the fee would exceed what the fee field accepts', () => {
    // 1e21 shares → toFixed would switch to exponent notation
    expect(autoFeeUsd('1e21', '340.23', 30)).toBe('');
    // largest accepted fee is 999999999.99; this one is just above it
    expect(autoFeeUsd('1000000', '999999999', 1_000_000)).toBe('');
  });

  it('keeps a large fee that the fee field still accepts', () => {
    // 1 × $999999999 × 1_000_000 ppm = $999999999.00
    expect(autoFeeUsd('1', '999999999', 1_000_000)).toBe('999999999.00');
  });
});
