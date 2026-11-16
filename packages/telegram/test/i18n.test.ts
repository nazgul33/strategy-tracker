import { describe, test, expect } from 'bun:test'
import { CATALOG } from '../src/i18n'

const placeholders = (value: string): string[] => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort()

describe('telegram catalog', () => {
  test('every entry has non-empty en and ko text', () => {
    const empty = Object.entries(CATALOG)
      .filter(([, e]) => e.en.trim() === '' || e.ko.trim() === '')
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  test('en and ko interpolate the same {placeholder} set for every key', () => {
    const drift = Object.entries(CATALOG)
      .filter(([, e]) => JSON.stringify(placeholders(e.en)) !== JSON.stringify(placeholders(e.ko)))
      .map(([key, e]) => `${key}: en ${JSON.stringify(placeholders(e.en))} vs ko ${JSON.stringify(placeholders(e.ko))}`)
    expect(drift).toEqual([])
  })
})
