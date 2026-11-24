import { describe, expect, test } from 'bun:test';

import { clampPage, pageCount, pageOfIndex, slicePage } from './paging';

describe('pageCount', () => {
  test('rounds up and never drops below one page', () => {
    expect(pageCount(0, 5)).toBe(1);
    expect(pageCount(5, 5)).toBe(1);
    expect(pageCount(6, 5)).toBe(2);
    expect(pageCount(21, 10)).toBe(3);
  });
});

describe('clampPage', () => {
  test('keeps the page within 0..count-1', () => {
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(1, 3)).toBe(1);
    expect(clampPage(7, 3)).toBe(2);
  });
});

describe('pageOfIndex', () => {
  test('maps an item index to its zero-based page, and a missing index to page 0', () => {
    expect(pageOfIndex(0, 5)).toBe(0);
    expect(pageOfIndex(4, 5)).toBe(0);
    expect(pageOfIndex(5, 5)).toBe(1);
    expect(pageOfIndex(12, 10)).toBe(1);
    expect(pageOfIndex(-1, 5)).toBe(0);
  });
});

describe('slicePage', () => {
  test('returns the items on the given page', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(slicePage(items, 0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(slicePage(items, 1, 5)).toEqual([6, 7]);
    expect(slicePage(items, 0, 10)).toEqual(items);
  });
});
