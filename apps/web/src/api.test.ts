import { describe, expect, test } from 'bun:test';

import { createApi, usdToCents } from './api';
import type { Http } from './api';

// Users naturally type comma-grouped amounts ("1,000"); core's parseUsd
// rejects commas, so the web layer strips standard grouping before parsing.
describe('usdToCents', () => {
  test('accepts comma-grouped amounts', () => {
    expect(usdToCents('1,000')).toBe(100000);
    expect(usdToCents('12,345,678.90')).toBe(1234567890);
  });

  test('rejects malformed grouping', () => {
    expect(usdToCents('1,00')).toBeNull();
  });

  test('plain amounts keep working', () => {
    expect(usdToCents('12.345')).toBe(1235);
    expect(usdToCents('bogus')).toBeNull();
  });
});

// Bulk lifecycle: the client must POST the batch body and surface the server's
// updated count (zero-eligible is a 200 {updated:0}, not an error).
describe('bulkSetRunStatus', () => {
  test('posts ids + status to /api/runs/bulk-status and returns the updated count', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ updated: 2 });
    };
    const api = createApi(http, { getToken: () => null });
    await expect(api.bulkSetRunStatus([4, 7], 'closed')).resolves.toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/runs/bulk-status');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ ids: [4, 7], status: 'closed' }));
  });
});
