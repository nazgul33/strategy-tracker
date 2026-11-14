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
