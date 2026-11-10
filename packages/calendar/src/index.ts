import { NYSE_YEARS } from './nyse-data';

export type ISODate = string;

export interface DayInfo {
  date: ISODate;
  open: boolean;
  holidayName?: { en: string; ko: string };
  earlyCloseET?: string;
}

function weekday(d: ISODate): number {
  return new Date(d + 'T12:00:00Z').getUTCDay();
}

function lookup(date: ISODate) {
  const year = date.slice(0, 4);
  const data = NYSE_YEARS[year];
  if (!data) return undefined;
  const hol = data.holidays.find((h) => h.date === date);
  const ec = data.earlyCloses.find((e) => e.date === date);
  return { hol, ec };
}

export function dayInfo(date: ISODate): DayInfo {
  const wd = weekday(date);
  const weekend = wd === 0 || wd === 6;
  const found = lookup(date);
  const hol = found?.hol;
  const ec = found?.ec;
  if (weekend) {
    return { date, open: false, holidayName: hol ? { en: hol.en, ko: hol.ko } : undefined, earlyCloseET: ec?.et };
  }
  if (hol) {
    return { date, open: false, holidayName: { en: hol.en, ko: hol.ko }, earlyCloseET: ec?.et };
  }
  return { date, open: true, holidayName: undefined, earlyCloseET: ec?.et };
}

export function isTradingDay(d: ISODate): boolean {
  return dayInfo(d).open;
}

function addDays(d: ISODate, n: number): ISODate {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function prevTradingDay(d: ISODate): ISODate {
  let cur = addDays(d, -1);
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cur)) return cur;
    cur = addDays(cur, -1);
  }
  throw new Error('no trading day found');
}

export function nextTradingDay(d: ISODate): ISODate {
  let cur = addDays(d, 1);
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cur)) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error('no trading day found');
}

export { NYSE_YEARS } from './nyse-data';

export * from './crosscheck';
