import { test, expect } from 'bun:test'
import { VERSION } from '@st/core'

test('smoke', () => {
  expect(VERSION).toBe('0.0.1')
})
