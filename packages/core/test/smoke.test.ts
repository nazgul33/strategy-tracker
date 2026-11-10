import { test, expect } from 'bun:test'
import { VERSION } from '@st/core'
import { TICK_USD } from '@st/core/money'

test('smoke', () => {
  expect(VERSION).toBe('0.0.1')
  expect(TICK_USD).toBe(100n)
})
