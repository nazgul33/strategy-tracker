import { describe, test, expect } from 'bun:test'
import { CATALOG, bucketNo } from '../src/i18n'

const placeholders = (value: string): string[] => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort()

describe('telegram catalog', () => {
  test('bucketNo turns the stored 0-based index into the number shown to the operator', () => {
    expect(bucketNo(0)).toBe(1)
    expect(bucketNo(9)).toBe(10)
  })

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
