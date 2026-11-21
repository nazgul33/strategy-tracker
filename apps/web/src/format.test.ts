import { describe, expect, test } from 'bun:test';

import { costInputText, costPercentText, gapText, isoDate, isoDateTime } from './format';

// Date-only wire values must pass through untouched, and the space-separated
// naive timestamps from MySQL DATESTRINGS must never be re-rendered through
// Date (that would apply a bogus timezone shift).
describe('isoDate', () => {
  test('accepts bare date-only values', () => {
    expect(isoDate('2026-01-05')).toBe('2026-01-05');
  });

  test('accepts datetime variants and returns the date part', () => {
    expect(isoDate('2026-01-05T00:00:00.000Z')).toBe('2026-01-05');
    expect(isoDate('2026-01-05 14:30:00')).toBe('2026-01-05');
  });

  test('null or garbage renders as an em dash', () => {
    expect(isoDate(null)).toBe('—');
    expect(isoDate('bogus')).toBe('—');
  });

  test('date-shaped prefix followed by junk is rejected', () => {
    expect(isoDate('2026-01-05xyz')).toBe('—');
  });
});

describe('isoDateTime', () => {
  test('a bare date renders as the date (no fake midnight timestamp)', () => {
    expect(isoDateTime('2026-01-05')).toBe('2026-01-05');
  });

  test('naive server wall-clock values are shown as-is, not timezone-shifted', () => {
    expect(isoDateTime('2026-01-05 14:30:00')).toBe('2026-01-05 14:30');
    expect(isoDateTime('2026-01-05T14:30:00')).toBe('2026-01-05 14:30');
  });

  test('instant values are rendered as date and time in the viewer timezone', () => {
    // The viewer's offset is unknown here, so pin the shape, not the digits.
    expect(isoDateTime('2026-01-05T00:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(isoDateTime('2026-01-05T23:30:00+09:00')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('null or garbage renders as an em dash', () => {
    expect(isoDateTime(null)).toBe('—');
    expect(isoDateTime('bogus')).toBe('—');
  });
});

// gapText takes the i18n lookup, same as the pages do; a tiny stub keeps the
// formatter test free of React context.
const t = (key: string) => (key === 'fmt.gapDefault' ? 'default' : key);

describe('gapText', () => {
  test('a positive percent renders with a percent sign', () => {
    expect(gapText(2.5, t)).toBe('2.5%');
    expect(gapText(0.0001, t)).toBe('0.0001%');
    expect(gapText(100, t)).toBe('100%');
  });

  test('0 means "server decides" and shows the catalog default word', () => {
    expect(gapText(0, t)).toBe('default');
  });

  test('null or undefined renders as an em dash', () => {
    expect(gapText(null, t)).toBe('—');
    expect(gapText(undefined, t)).toBe('—');
  });
});

describe('costPercentText', () => {
  test('always shows three decimals and its own percent sign, no space', () => {
    expect(costPercentText(700)).toBe('0.070%');
    expect(costPercentText(0)).toBe('0.000%');
    expect(costPercentText(10)).toBe('0.001%');
    expect(costPercentText(1250)).toBe('0.125%');
    expect(costPercentText(1_000_000)).toBe('100.000%');
  });

  test('missing or non-finite values render as an em dash', () => {
    expect(costPercentText(null)).toBe('—');
    expect(costPercentText(undefined)).toBe('—');
    expect(costPercentText(Number.NaN)).toBe('—');
  });
});

describe('costInputText', () => {
  test('is the bare three-decimal number an input holds', () => {
    expect(costInputText(700)).toBe('0.070');
    expect(costInputText(0)).toBe('0.000');
  });

  test('non-finite is blank', () => {
    expect(costInputText(Number.NaN)).toBe('');
  });
});
