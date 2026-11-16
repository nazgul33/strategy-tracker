import { describe, expect, test } from 'bun:test';

import {
  centsToUsdText,
  formFromRun,
  parseSimParams,
  parseSimTicker,
  simFieldFlags,
  validateSimConfig,
} from './simconfig';
import type { SimConfigForm } from './simconfig';

// Identity translator: the returned error is the catalog key, so the tests pin
// which rule fired without depending on copy.
const t = (key: string) => key;

const good: SimConfigForm = {
  from: '2026-01-02',
  to: '2026-06-30',
  pool: '100000',
  cost: '0.070',
  buyGap: '0.5',
  sellGap: '2',
  cutLoss: '3.5',
  bucketCount: '8',
  maxAge: '30',
};

describe('validateSimConfig', () => {
  test('accepts the shared rules and converts percents to ppm', () => {
    expect(validateSimConfig(good, t)).toEqual({
      ok: true,
      input: {
        from: '2026-01-02',
        to: '2026-06-30',
        poolCents: 10_000_000,
        costPpm: 700,
        buyGapPpm: 5000,
        sellGapPpm: 20_000,
        cutLossPpm: 35_000,
        params: { bucketCount: 8, maxAgeDays: 30 },
      },
    });
  });

  test('blank gaps and cut-loss are explicit 0; blank params are omitted', () => {
    const res = validateSimConfig({ ...good, buyGap: '', sellGap: '', cutLoss: '', bucketCount: '', maxAge: '' }, t);
    expect(res).toEqual({
      ok: true,
      input: {
        from: '2026-01-02',
        to: '2026-06-30',
        poolCents: 10_000_000,
        costPpm: 700,
        buyGapPpm: 0,
        sellGapPpm: 0,
        cutLossPpm: 0,
      },
    });
  });

  test('accepts the boundary values', () => {
    const res = validateSimConfig(
      { ...good, pool: '0.01', cost: '100', buyGap: '100', sellGap: '0.0001', cutLoss: '50', bucketCount: '20', maxAge: '250' },
      t,
    );
    expect(res).toMatchObject({
      ok: true,
      input: { poolCents: 1, costPpm: 1_000_000, buyGapPpm: 1_000_000, sellGapPpm: 1, cutLossPpm: 500_000 },
    });
    expect(validateSimConfig({ ...good, bucketCount: '2', maxAge: '1' }, t)).toMatchObject({
      ok: true,
      input: { params: { bucketCount: 2, maxAgeDays: 1 } },
    });
  });

  test.each([
    ['from after to', { from: '2026-07-01' }, 'simInvalidRange'],
    ['from equal to', { from: '2026-06-30' }, 'simInvalidRange'],
    ['a malformed date', { to: '30/06/2026' }, 'simInvalidDate'],
    ['pool 0', { pool: '0' }, 'simInvalidPool'],
    ['a malformed pool', { pool: 'abc' }, 'simInvalidPool'],
    ['a blank cost', { cost: '' }, 'runInvalidCostPpm'],
    ['cost with four decimals', { cost: '0.0701' }, 'runInvalidCostPpm'],
    ['cost over 100', { cost: '100.001' }, 'runInvalidCostPpm'],
    ['buy gap over 100', { buyGap: '101' }, 'simInvalidGap'],
    ['sell gap with five decimals', { sellGap: '0.00001' }, 'simInvalidGap'],
    ['cut loss 3.55', { cutLoss: '3.55' }, 'simInvalidCutLoss'],
    ['cut loss 51', { cutLoss: '51' }, 'simInvalidCutLoss'],
    ['cut loss -1', { cutLoss: '-1' }, 'simInvalidCutLoss'],
    ['buckets 1', { bucketCount: '1' }, 'runInvalidBucketCount'],
    ['buckets 21', { bucketCount: '21' }, 'runInvalidBucketCount'],
    ['buckets 2.5', { bucketCount: '2.5' }, 'runInvalidBucketCount'],
    ['max age 0', { maxAge: '0' }, 'runInvalidMaxAge'],
    ['max age 251', { maxAge: '251' }, 'runInvalidMaxAge'],
  ] as [string, Partial<SimConfigForm>, string][])('rejects %s', (_label, patch, key) => {
    const res = validateSimConfig({ ...good, ...patch }, t);
    expect(res).toEqual({ ok: false, error: key });
    expect('input' in res).toBe(false);
  });

  test('trims whitespace around numeric text', () => {
    expect(validateSimConfig({ ...good, cost: ' 0.070 ', cutLoss: ' 3.5 ', bucketCount: ' 8 ' }, t)).toMatchObject({
      ok: true,
      input: { costPpm: 700, cutLossPpm: 35_000, params: { bucketCount: 8 } },
    });
  });
});

describe('simFieldFlags', () => {
  test('flags only the percent fields that are present and malformed', () => {
    expect(simFieldFlags(good)).toEqual({ cost: false, buyGap: false, sellGap: false, cutLoss: false });
    expect(simFieldFlags({ ...good, buyGap: '', sellGap: '', cutLoss: '' })).toEqual({
      cost: false,
      buyGap: false,
      sellGap: false,
      cutLoss: false,
    });
    expect(simFieldFlags({ ...good, cost: '0.0701', buyGap: 'x', sellGap: '101', cutLoss: '3.55' })).toEqual({
      cost: true,
      buyGap: true,
      sellGap: true,
      cutLoss: true,
    });
  });

  test('agrees with validateSimConfig on every percent field', () => {
    for (const patch of [{ cost: 'x' }, { buyGap: '-1' }, { sellGap: '1e3' }, { cutLoss: '50.1' }, { cutLoss: '50' }]) {
      const form = { ...good, ...patch };
      const anyFlag = Object.values(simFieldFlags(form)).some(Boolean);
      expect(validateSimConfig(form, t).ok).toBe(!anyFlag);
    }
  });
});

describe('parseSimTicker', () => {
  test('uppercases valid tickers and rejects the rest', () => {
    expect(parseSimTicker(' qqq ')).toBe('QQQ');
    expect(parseSimTicker('brk.b')).toBe('BRK.B');
    expect(parseSimTicker('')).toBeNull();
    expect(parseSimTicker('WAYTOOLONGTICK')).toBeNull();
    expect(parseSimTicker('A1')).toBeNull();
  });
});

describe('parseSimParams', () => {
  test('reads both values from paramsJson', () => {
    expect(parseSimParams('{"bucketCount":5,"maxAgeDays":12}', 10)).toEqual({ bucketCount: 5, maxAgeDays: 12 });
  });

  test('falls back when paramsJson is unusable', () => {
    expect(parseSimParams('not json', 7)).toEqual({ bucketCount: 7, maxAgeDays: 20 });
    expect(parseSimParams('{}', 7)).toEqual({ bucketCount: 7, maxAgeDays: 20 });
    expect(parseSimParams('{"bucketCount":0,"maxAgeDays":"x"}', 7)).toEqual({ bucketCount: 7, maxAgeDays: 20 });
    expect(parseSimParams('{"bucketCount":4}', 7)).toEqual({ bucketCount: 4, maxAgeDays: 20 });
  });
});

describe('centsToUsdText', () => {
  test('whole dollars drop the decimals; others keep two', () => {
    expect(centsToUsdText(10_000_000)).toBe('100000');
    expect(centsToUsdText(12_345)).toBe('123.45');
    expect(centsToUsdText(5)).toBe('0.05');
    expect(centsToUsdText(150)).toBe('1.50');
  });
});

describe('formFromRun', () => {
  test('round-trips through validateSimConfig to the same stored values', () => {
    const run = {
      fromDate: '2026-01-02',
      toDate: '2026-06-30',
      poolCents: 12_345,
      costPpm: 700,
      buyGapPpm: 5000,
      sellGapPpm: 0,
      cutLossPpm: 35_000,
    };
    const form = formFromRun(run, { bucketCount: 5, maxAgeDays: 12 });
    expect(form).toEqual({
      from: '2026-01-02',
      to: '2026-06-30',
      pool: '123.45',
      cost: '0.070',
      buyGap: '0.5',
      sellGap: '',
      cutLoss: '3.5',
      bucketCount: '5',
      maxAge: '12',
    });
    expect(validateSimConfig(form, t)).toMatchObject({
      ok: true,
      input: { poolCents: 12_345, costPpm: 700, buyGapPpm: 5000, sellGapPpm: 0, cutLossPpm: 35_000 },
    });
  });
});
