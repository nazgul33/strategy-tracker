import { describe, expect, test } from 'bun:test';
import { autoFeeUsd } from './autofee';

describe('autoFeeUsd', () => {
  test('a comma-grouped price derives the same fee as the plain one', () => {
    expect(autoFeeUsd('10', '12345.00', 40)).toBe('4.94');
    expect(autoFeeUsd('10', '12,345.00', 40)).toBe(autoFeeUsd('10', '12345.00', 40));
    expect(autoFeeUsd('10', '12,34.00', 40)).toBe('');
  });
});
