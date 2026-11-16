import { describe, expect, test } from 'bun:test';

import { gapToPpm, isGapText, isPercentText, percentTextToPpm, ppmToPercentText } from './gaps';

describe('isPercentText', () => {
  test('honours the decimal limit', () => {
    expect(isPercentText('0.070', 3)).toBe(true);
    expect(isPercentText('0.0701', 3)).toBe(false);
    expect(isPercentText('3.5', 1)).toBe(true);
    expect(isPercentText('3.55', 1)).toBe(false);
    expect(isPercentText('101', 3)).toBe(false);
  });

  test('rejects malformed text', () => {
    for (const bad of ['', 'abc', '-1', '1.', '.5', '1e2', ' 1']) expect(isPercentText(bad, 3)).toBe(false);
  });

  test('accepts the 0 and 100 boundaries', () => {
    expect(isPercentText('0', 3)).toBe(true);
    expect(isPercentText('100', 3)).toBe(true);
    expect(isPercentText('100.000', 3)).toBe(true);
    expect(isPercentText('100.001', 3)).toBe(false);
  });
});

describe('percentTextToPpm', () => {
  test('is exact at 3 and 1 decimals', () => {
    expect(percentTextToPpm('0.070', 3)).toBe(700);
    expect(percentTextToPpm('0.001', 3)).toBe(10);
    expect(percentTextToPpm('3.5', 1)).toBe(35_000);
    expect(percentTextToPpm('', 1)).toBe(0);
  });

  test('pads short fractions and handles whole numbers', () => {
    expect(percentTextToPpm('0.07', 3)).toBe(700);
    expect(percentTextToPpm('2', 3)).toBe(20_000);
    expect(percentTextToPpm('100', 3)).toBe(1_000_000);
  });

  test('stays integer-exact where float multiply would drift', () => {
    expect(percentTextToPpm('0.57', 3)).toBe(5_700);
    expect(percentTextToPpm('1.005', 3)).toBe(10_050);
  });
});

describe('ppmToPercentText', () => {
  test('round-trips and keeps the old 4-decimal default', () => {
    expect(ppmToPercentText(700, 3)).toBe('0.07');
    expect(ppmToPercentText(5000)).toBe('0.5');
    expect(ppmToPercentText(0)).toBe('');
  });

  test('0 is blank at any precision', () => {
    expect(ppmToPercentText(0, 3)).toBe('');
  });

  test('round-trips through percentTextToPpm', () => {
    for (const ppm of [10, 700, 5_000, 35_000, 1_000_000]) {
      expect(percentTextToPpm(ppmToPercentText(ppm, 3), 3)).toBe(ppm);
    }
  });
});

describe('4-decimal gap wrappers', () => {
  test('isGapText allows four decimals but not five', () => {
    expect(isGapText('0.5')).toBe(true);
    expect(isGapText('0.0001')).toBe(true);
    expect(isGapText('0.00001')).toBe(false);
    expect(isGapText('101')).toBe(false);
  });

  test('gapToPpm keeps 1% = 10_000 and blank = 0', () => {
    expect(gapToPpm('0.5')).toBe(5_000);
    expect(gapToPpm('2')).toBe(20_000);
    expect(gapToPpm('0.0001')).toBe(1);
    expect(gapToPpm('')).toBe(0);
  });
});
