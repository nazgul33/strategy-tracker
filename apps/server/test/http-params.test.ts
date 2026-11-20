import { test, expect } from 'bun:test'
import { parseId } from '../src/http/params'

test.each([['1', 1], ['42', 42], ['9007199254740991', 9007199254740991]])('parseId(%p) = %p', (raw, id) => expect(parseId(raw as string)).toBe(id as number))

test.each(['0', '01', '0x1', '1e0', '1e2', '+1', '-1', '1.0', ' 1', '1 ', '', 'abc', '9007199254740993'])('parseId(%p) is null', (raw) => expect(parseId(raw)).toBeNull())
