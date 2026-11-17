import { describe, expect, test } from 'bun:test';

import en from './i18n/en.json';
import ko from './i18n/ko.json';

const enEntries = Object.entries(en as Record<string, string>);
const koEntries = Object.entries(ko as Record<string, string>);

const keysOf = (entries: [string, string][]) => entries.map(([key]) => key).sort();
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

// The ko catalog is machine-translated, so a regression to untranslated text
// (or a dropped/enlarged placeholder) is a real risk, not a hypothetical.
describe('i18n catalogs', () => {
  test('ko values contain no untranslated Chinese characters', () => {
    const offenders = koEntries.filter(([, value]) => /[\u4e00-\u9fff]/.test(value)).map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  test('en and ko expose exactly the same keys', () => {
    expect(keysOf(koEntries)).toEqual(keysOf(enEntries));
  });

  // Flat catalogs stay alphabetically ordered so scanning for a key (or
  // slotting a new one in) is predictable; localeCompare matches reading order.
  test('both catalogs list their keys in localeCompare order', () => {
    for (const [name, entries] of [['en', enEntries], ['ko', koEntries]] as const) {
      const keys = entries.map(([key]) => key);
      const offenders: string[] = [];
      for (let i = 1; i < keys.length; i++) {
        if (keys[i - 1]!.localeCompare(keys[i]!) > 0) offenders.push(`${keys[i - 1]} must come after ${keys[i]}`);
      }
      expect(offenders, `${name} catalog` ).toEqual([]);
    }
  });

  // Key *parity* cannot see a notice code that is missing from both files, and
  // `lookup` renders the bare key when it is absent — which is how
  // `digest.cut-loss-immediate` reached the sim replay as literal text. The
  // notice codes are read out of the strategy source, so a new
  // `notices.push({ code })` fails here until both catalogs carry it.
  test('every notice code computeOrders can emit resolves in both catalogs', async () => {
    const source = await Bun.file(new URL('../../../packages/strategies/src/mean-reversion.ts', import.meta.url)).text();
    const codes = [...source.matchAll(/notices\.push\(\{\s*code:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(codes).toEqual(['no-bucket-available', 'shares-zero', 'cut-loss-immediate']);
    const enKeys = new Set(Object.keys(en as Record<string, string>));
    const koKeys = new Set(Object.keys(ko as Record<string, string>));
    const missing = codes.flatMap((code) => [
      ...(enKeys.has(`digest.${code}`) ? [] : [`en:digest.${code}`]),
      ...(koKeys.has(`digest.${code}`) ? [] : [`ko:digest.${code}`]),
    ]);
    expect(missing).toEqual([]);
  });

  test('every key interpolates the same placeholders in both languages', () => {
    const koValues = new Map(koEntries);
    const mismatches = enEntries
      .filter(([key, value]) => {
        const koValue = koValues.get(key);
        return koValue === undefined || JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(koValue));
      })
      .map(([key]) => key);
    expect(mismatches).toEqual([]);
  });
});
