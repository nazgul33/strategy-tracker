import { describe, expect, test } from 'bun:test';

import { usdToCents } from './api';

// Users naturally type comma-grouped amounts ("1,000"); core's parseUsd
// rejects commas, so the web layer strips standard grouping before parsing.
describe('usdToCents', () => {
  test('accepts comma-grouped amounts', () => {
    expect(usdToCents('1,000')).toBe(100000);
    expect(usdToCents('12,345,678.90')).toBe(1234567890);
  });

  test('rejects malformed grouping', () => {
    expect(usdToCents('1,00')).toBeNull();
  });

  test('plain amounts keep working', () => {
    expect(usdToCents('12.345')).toBe(1235);
    expect(usdToCents('bogus')).toBeNull();
  });
});
