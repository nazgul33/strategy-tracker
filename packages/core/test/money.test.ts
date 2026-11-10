import { test, expect } from 'bun:test'
import { parseUsd, formatUsd, roundDiv, centsFromUsd, feeCents, TICK_USD } from '@st/core/money'

test('TICK_USD', () => {
  expect(TICK_USD).toBe(100n)
})

test('parseUsd', () => {
  expect(parseUsd('340.23')).toBe(3402300n)
  expect(parseUsd('0.1')).toBe(1000n)
  expect(() => parseUsd('1.00001')).toThrow()
  expect(() => parseUsd('')).toThrow()
  expect(() => parseUsd('abc')).toThrow()
  expect(() => parseUsd('340.23456')).toThrow()
  expect(parseUsd('340')).toBe(3400000n)
  expect(parseUsd('-1.23')).toBe(-12300n)
})

test('formatUsd', () => {
  expect(formatUsd(3402300n)).toBe('340.23')
  expect(formatUsd(3400000n)).toBe('340.00')
  expect(formatUsd(3402310n)).toBe('340.231')
  expect(formatUsd(-3402300n)).toBe('-340.23')
  expect(formatUsd(0n)).toBe('0.00')
  expect(formatUsd(5n)).toBe('0.0005')
})

test('roundDiv', () => {
  expect(roundDiv(5n, 2n)).toBe(3n)
  expect(roundDiv(-5n, 2n)).toBe(-3n)
  expect(roundDiv(4n, 2n)).toBe(2n)
  expect(roundDiv(1n, 3n)).toBe(0n)
  expect(roundDiv(2n, 3n)).toBe(1n)
  expect(roundDiv(-1n, 3n)).toBe(0n)
  expect(roundDiv(-2n, 3n)).toBe(-1n)
})

test('feeCents', () => {
  expect(feeCents(3402300n, 100, 1)).toBe(3)
  expect(feeCents(3402300n, 100, 30)).toBe(102)
  expect(feeCents(23456n, 7, 1)).toBe(0)
})

test('centsFromUsd', () => {
  expect(centsFromUsd(12345n)).toBe(123)
  expect(centsFromUsd(123456n)).toBe(1235)
  expect(centsFromUsd(-12345n)).toBe(-123)
})
