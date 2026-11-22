import { describe, expect, test } from 'bun:test';
import { emptyState, parseUsd, type Run } from '@st/core';
import { computeOrders } from '@st/strategies';

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
  // codes come from running the planner itself, so a non-literal code is seen
  // when a scenario reaches it; the push-site counts below flag a notice that
  // no scenario covers. The guard covers both `mean-reversion.ts` and the
  // morning pipeline's `day.ts`, whose codes are read as literals from source.
  test('every notice code the planner or the morning pipeline emits resolves in both catalogs', async () => {
    const run: Run = {
      id: 0,
      name: 'x',
      ticker: 'T',
      strategyKey: 'mean-reversion',
      costPpm: 0,
      buyGapPpm: 0,
      sellGapPpm: 0,
      cutLossPpm: 0,
      poolCents: 0,
      status: 'active',
    };
    const full = emptyState(1);
    full.buckets[0] = { index: 0, state: 'held', shares: 10, buyPrice: parseUsd('100'), buyFeeCents: 0, filledOn: '2026-11-02' };
    const planA = computeOrders({ ...run, cutLossPpm: 30_000, poolCents: 1_000_000 }, full, { lastClose: parseUsd('90') });
    const planB = computeOrders({ ...run, cutLossPpm: 0, poolCents: 100 }, emptyState(10), { lastClose: parseUsd('100') });
    const plannerCodes = [...new Set([...planA.notices, ...planB.notices].map((n) => n.code))].sort();
    expect(plannerCodes).toEqual(['cut-loss-immediate', 'no-bucket-available', 'shares-zero']);

    const source = await Bun.file(new URL('../../../packages/strategies/src/mean-reversion.ts', import.meta.url)).text();
    // Name the call site: a bare `expected 1, got 0` does not say which file lost a push.
    expect({ 'mean-reversion.ts pushes': source.match(/notices\.push\(/g)?.length ?? 0 }).toEqual({
      'mean-reversion.ts pushes': plannerCodes.length,
    });

    const daySource = await Bun.file(new URL('../../../apps/server/src/pipeline/day.ts', import.meta.url)).text();
    const dayPushes = daySource.match(/notices\.push\(/g)?.length ?? 0;
    const dayCodes = [...new Set([...daySource.matchAll(/notices\.push\(\{\s*code:\s*'([\w-]+)'/g)].map((m) => m[1]!))].sort();
    expect({ 'day.ts pushes': dayPushes }).toEqual({
      'day.ts pushes': [...daySource.matchAll(/notices\.push\(\{\s*code:\s*'([\w-]+)'/g)].length,
    });
    expect(dayCodes).toEqual(['unconfirmed']);

    const codes = [...new Set([...plannerCodes, ...dayCodes])].sort();

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
