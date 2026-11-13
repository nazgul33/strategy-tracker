import { test, expect, describe } from 'bun:test';
import { dayInfo, isTradingDay } from '@st/calendar';

describe('2028 calendar', () => {
  test('Thanksgiving 2028-11-23 is closed', () => {
    expect(dayInfo('2028-11-23').open).toBe(false);
    expect(isTradingDay('2028-11-23')).toBe(false);
  });
  test('Christmas 2028-12-25 is closed', () => {
    expect(dayInfo('2028-12-25').open).toBe(false);
  });
  test('2028-11-22 is open', () => {
    expect(isTradingDay('2028-11-22')).toBe(true);
  });
});
