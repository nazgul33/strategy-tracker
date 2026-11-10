import { test, expect } from 'bun:test'
import { VERSION } from '@st/core'
import { VERSION as VERSION_FROM_MONEY } from '@st/core/money'

test('smoke', () => {
  expect(VERSION).toBe('0.0.1')
  expect(VERSION_FROM_MONEY).toBe('0.0.1')
})
