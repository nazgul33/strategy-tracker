import { describe, expect, test } from 'bun:test';
import type { PendingFillDto } from './api';
import { missingFields, pendingIssue } from './pendingvalues';
import { PENDING_ROW } from './testing/pendingRow';

const pendingRow = (over: Partial<PendingFillDto> = {}): PendingFillDto => ({ ...PENDING_ROW, ...over });
const row = () => pendingRow();

describe('missingFields', () => {
  test('lists all, pendingIssue still names the first', () => {
    const r = pendingRow({ side: '', price: '' });
    expect(missingFields(r)).toEqual(['side', 'price']);
    expect(pendingIssue(r)).toEqual({ field: 'side' });
  });

  test('a complete row misses nothing', () => {
    expect(missingFields(row())).toEqual([]);
  });
});
