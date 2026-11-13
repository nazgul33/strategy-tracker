import { describe, expect, test } from 'bun:test';

import type { PriceHistoryBar } from './api.types';
import { computeHistoryWindow } from './priceHistory';

const bar = (tradeDate: string, close = '1000000'): PriceHistoryBar => ({ tradeDate, close });

describe('computeHistoryWindow', () => {
  test('with fills, the window starts one trading day before the first buy', () => {
    const today = '2026-11-13'; // Friday
    const w = computeHistoryWindow(['2026-11-11', '2026-11-12'], today);
    expect(w).toEqual({ from: '2026-11-10', to: '2026-11-12', start: '2026-11-10' });
  });

  test('a Monday first buy pulls in the preceding Friday and weekend gap', () => {
    const w = computeHistoryWindow(['2026-11-09'], '2026-11-13');
    expect(w).toEqual({ from: '2026-11-06', to: '2026-11-12', start: '2026-11-06' });
  });

  test('runs without fills fall back to thirty calendar days', () => {
    const w = computeHistoryWindow([], '2026-11-13');
    expect(w).toEqual({ from: '2026-10-13', to: '2026-11-12', start: null });
  });

  test('sells alone never anchor the window', () => {
    const w = computeHistoryWindow([], '2026-11-13');
    expect(w).toEqual({ from: '2026-10-13', to: '2026-11-12', start: null });
  });

  test('a today-only fill (no settled bar yet) uses the fallback window', () => {
    const w = computeHistoryWindow(['2026-11-13'], '2026-11-13');
    expect(w).toEqual({ from: '2026-10-13', to: '2026-11-12', start: null });
  });
});
