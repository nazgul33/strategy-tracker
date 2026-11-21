import { describe, expect, test } from 'bun:test';
import { emptyState, type Run } from '@st/core';
import { computeOrders } from '@st/strategies';
import type { BucketDto } from './api';
import { stopCheckUnavailable, underwaterStopCount } from './cutloss';

describe('underwaterStopCount', () => {
  const held = (index: number, buyPrice: string): BucketDto => ({
    index,
    state: 'held',
    shares: 10,
    buyPrice,
    buyFeeCents: 0,
    filledOn: '2026-11-02',
  });
  const buckets: BucketDto[] = [
    held(0, '1000000'), // 100.00
    held(1, '900000'), // 90.00
    { index: 2, state: 'empty', shares: 0, buyPrice: null, buyFeeCents: 0, filledOn: null },
    { ...held(3, '1000000'), state: 'force_sell' },
  ];

  test('counts held buckets whose trigger is at or above the latest close', () => {
    // 3.0% => 97.00 / 87.30 against a 92.00 close: only the first is underwater.
    expect(underwaterStopCount(buckets, 30_000, '920000')).toBe(1);
    // 10% => 90.00 / 81.00 are both below a 92.00 close.
    expect(underwaterStopCount(buckets, 100_000, '920000')).toBe(0);
    // 0.5% => 99.50 / 89.50: both are above a 85.00 close.
    expect(underwaterStopCount(buckets, 5_000, '850000')).toBe(2);
  });

  test('a trigger exactly at the close counts (the server uses >=)', () => {
    expect(underwaterStopCount(buckets, 100_000, '900000')).toBe(1);
    expect(underwaterStopCount(buckets, 100_000, '900100')).toBe(0);
  });

  test('truncates the trigger down to whole cents like the server', () => {
    // 100.01 at 3.0% = 97.0097 -> 97.00; a 97.0050 close is above it.
    expect(underwaterStopCount([held(0, '1000100')], 30_000, '970050')).toBe(0);
    expect(underwaterStopCount([held(0, '1000100')], 30_000, '970000')).toBe(1);
  });

  test('is zero when cut-loss is off or the close is unknown', () => {
    expect(underwaterStopCount(buckets, 0, '1')).toBe(0);
    expect(underwaterStopCount(buckets, 30_000, null)).toBe(0);
  });

  describe('agrees with the stops the planner places', () => {
    const cases: [string, number, bigint][] = [
      ['1000100', 30_000, 970000n],
      ['999999', 35_000, 964900n],
      ['1234567', 500_000, 617200n],
    ];

    for (const [buy, ppm, stop] of cases) {
      test(`buy ${buy} at ${ppm} ppm stops at ${stop}`, () => {
        const run: Run = {
          id: 0,
          name: 'x',
          ticker: 'T',
          strategyKey: 'mean-reversion',
          costPpm: 0,
          buyGapPpm: 0,
          sellGapPpm: 0,
          cutLossPpm: ppm,
          poolCents: 1_000_000,
          status: 'active',
        };
        const state = emptyState(2);
        state.buckets[0] = { index: 0, state: 'held', shares: 10, buyPrice: BigInt(buy), buyFeeCents: 0, filledOn: '2026-11-02' };
        const plan = computeOrders(run, state, { lastClose: BigInt(buy) });
        const planned = plan.orders.find((o) => o.kind === 'stop_sell' && o.bucketIndex === 0);
        expect(planned?.limitPrice).toBe(stop);
        expect(underwaterStopCount([held(0, buy)], ppm, String(stop))).toBe(1);
        expect(underwaterStopCount([held(0, buy)], ppm, String(stop + 1n))).toBe(0);
      });
    }
  });
});

describe('stopCheckUnavailable', () => {
  const held: BucketDto = { index: 0, state: 'held', shares: 10, buyPrice: '1000000', buyFeeCents: 0, filledOn: '2026-11-02' };
  const empty: BucketDto = { index: 1, state: 'empty', shares: 0, buyPrice: null, buyFeeCents: 0, filledOn: null };

  test('is true only when cut-loss is on, a bucket is held and the close is unknown', () => {
    expect(stopCheckUnavailable([held, empty], 30_000, null)).toBe(true);
    expect(stopCheckUnavailable([held, empty], 30_000, '920000')).toBe(false);
    expect(stopCheckUnavailable([held, empty], 0, null)).toBe(false);
    expect(stopCheckUnavailable([empty], 30_000, null)).toBe(false);
    expect(stopCheckUnavailable([], 30_000, null)).toBe(false);
  });
});
