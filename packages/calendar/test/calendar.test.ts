import { test, expect } from 'bun:test';
import { dayInfo, isTradingDay, prevTradingDay, nextTradingDay, calendarCrossCheck } from '@st/calendar';

test('sat closed no name', () => {
  const d = dayInfo('2026-11-07');
  expect(d.open).toBe(false);
  expect(d.holidayName).toBeUndefined();
});

test('thanksgiving', () => {
  const d = dayInfo('2026-11-26');
  expect(d.open).toBe(false);
  expect(d.holidayName!.en).toBe('Thanksgiving');
});

test('july 3 closed', () => {
  expect(dayInfo('2026-07-03').open).toBe(false);
});

test('veterans day open', () => {
  expect(dayInfo('2026-11-11').open).toBe(true);
});

test('july 2 open no early close', () => {
  expect(dayInfo('2026-07-02').open).toBe(true);
  expect(dayInfo('2026-07-02').earlyCloseET).toBeUndefined();
});

test('nov 27 early close', () => {
  expect(dayInfo('2026-11-27').earlyCloseET).toBe('13:00');
  expect(dayInfo('2026-11-27').open).toBe(true);
});

test('prev trading', () => {
  expect(prevTradingDay('2026-11-09')).toBe('2026-11-06');
});

test('carter day', () => {
  expect(isTradingDay('2025-01-09')).toBe(false);
});

test('prevTradingDay 11-27', () => {
  expect(prevTradingDay('2026-11-27')).toBe('2026-11-25');
});

test('nextTradingDay 11-26', () => {
  expect(nextTradingDay('2026-11-26')).toBe('2026-11-27');
});

test('isTradingDay seq', () => {
  expect(isTradingDay('2026-11-20')).toBe(true);
  expect(isTradingDay('2026-11-21')).toBe(false);
  expect(isTradingDay('2026-11-26')).toBe(false);
  expect(isTradingDay('2026-12-25')).toBe(false);
  expect(isTradingDay('2026-12-28')).toBe(true);
});

test('2027-12-31 open', () => {
  expect(dayInfo('2027-12-31').open).toBe(true);
});

test('weekday consistency', () => {
  for (const y of ['2025','2026','2027']) {
    for (const h of (require('../src/nyse-data').NYSE_YEARS[y].holidays)) {
      const wd = new Date(h.date + 'T12:00:00Z').getUTCDay();
      expect(wd).not.toBe(0);
      expect(wd).not.toBe(6);
      expect(dayInfo(h.date).open).toBe(false);
    }
  }
});

test('crosscheck garbage', async () => {
  const r = await calendarCrossCheck('2026-11-07', (async () => ({ ok: false, json: async () => { throw new Error('x'); } })) as any);
  expect(r.agree).toBe(true);
  expect(r.error).toBeDefined();
});

test('crosscheck ok', async () => {
  const r = await calendarCrossCheck('2026-11-07', (async () => ({ ok: true, json: async () => ({ tradingDay: false }) })) as any);
  expect(r.remoteOpen).toBe(false);
  expect(r.agree).toBe(dayInfo('2026-11-07').open === false);
});
