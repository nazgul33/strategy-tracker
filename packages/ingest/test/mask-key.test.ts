import { expect, test } from 'bun:test';
import { maskKey } from '../src/mask-key';

const K = 'sk-LEAKCHECK-7f3a9c2e'

test('the whole key keeps its first and last 4 around four dots', () => {
  expect(maskKey(K, K)).toBe('sk-L....9c2e')
})
test('in place, inside a word and next to punctuation', () => {
  expect(maskKey(`Bearer:${K}, rejected`, K)).toBe('Bearer:sk-L....9c2e, rejected')
  expect(maskKey(`xx${K}yy`, K)).toBe('xxsk-L....9c2eyy')
})
test('the key twice, apart and adjacent', () => {
  expect(maskKey(`${K} and ${K}`, K)).toBe('sk-L....9c2e and sk-L....9c2e')
  expect(maskKey(K + K, K)).toBe('sk-L....9c2esk-L....9c2e')
})
test('partial echoes of 8+ characters: prefix, suffix, middle, all but the last character', () => {
  expect(maskKey('key sk-LEAKCHECK rejected', K)).toBe('key sk-L.... rejected')
  expect(maskKey('key ending CHECK-7f3a9c2e rejected', K)).toBe('key ending ....9c2e rejected')
  expect(maskKey('id AKCHECK-7f here', K)).toBe('id .... here')
  expect(maskKey('sk-LEAKCHECK-7f3a9c2', K)).toBe('sk-L....9c2')
})
test('touching masked stretches become one set of four dots', () => {
  expect(maskKey('AKCHECK-7fEAKCHECK', K)).toBe('....')
})
test('a 7-character run and the service\'s own masked form are kept', () => {
  expect(maskKey('key ending 7f3a9c2 rejected', K)).toBe('key ending 7f3a9c2 rejected')
  expect(maskKey('masked sk-LEA*********9c2e', K)).toBe('masked sk-LEA*********9c2e')
})
test('a 9-character key has one middle character; 8 or fewer are never masked', () => {
  expect(maskKey('token abcdXefgh ok', 'abcdXefgh')).toBe('token abcd....efgh ok')
  expect(maskKey('token abcdefgh ok', 'abcdefgh')).toBe('token abcdefgh ok')
  expect(maskKey("model 'qwen2.5-vl:latest' not found", 'test')).toBe("model 'qwen2.5-vl:latest' not found")
  expect(maskKey('anything', '')).toBe('anything')
})
test('a word-like placeholder key dots an 8-character run of itself', () => {
  expect(maskKey('API key required', 'sk-no-key-required')).toBe('API key ....ired')
})
test('a run that aligns with the key at several positions is masked if any alignment is middle', () => {
  expect(maskKey('xx abababab yy', 'ab'.repeat(6))).toBe('xx .... yy')
})
