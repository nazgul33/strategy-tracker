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

// Per-run gaps: createRun must carry them when set and omit them entirely
// when unset (server treats absent as 0; an explicit null would 400).
describe('createRun gaps', () => {
  const base = { name: 'R', ticker: 'abc', costPpm: 200, poolCents: 1000 };

  test('includes buyGapPpm/sellGapPpm when provided', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ id: 1 });
    };
    const api = createApi(http, { getToken: () => null });
    await api.createRun({ ...base, buyGapPpm: 100, sellGapPpm: 200 });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body.buyGapPpm).toBe(100);
    expect(body.sellGapPpm).toBe(200);
  });

  test('omits gap keys entirely when not provided', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ id: 1 });
    };
    const api = createApi(http, { getToken: () => null });
    await api.createRun(base);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect('buyGapPpm' in body).toBe(false);
    expect('sellGapPpm' in body).toBe(false);
  });
});

// runSim mirrors createRun: gaps ride along only when set.
describe('runSim gaps', () => {
  const base = { name: 'S', ticker: 'abc', from: '2026-01-02', to: '2026-06-30', poolCents: 1000, costPpm: 200 };

  test('includes gaps when provided, omits when not', async () => {
    const bodies: unknown[] = [];
    const http: Http = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 1, dayCount: 0 });
    };
    const api = createApi(http, { getToken: () => null });
    await api.runSim({ ...base, buyGapPpm: 300, sellGapPpm: 400 });
    expect(bodies[0]).toMatchObject({ buyGapPpm: 300, sellGapPpm: 400 });
    await api.runSim(base);
    expect('buyGapPpm' in (bodies[1] as object)).toBe(false);
    expect('sellGapPpm' in (bodies[1] as object)).toBe(false);
  });
});

// Gap edit: POST /api/runs/:id/gaps, both values required, 204 no-content.
describe('setGaps', () => {
  test('posts both ppm values and resolves on 204', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    };
    const api = createApi(http, { getToken: () => 't' });
    await expect(api.setGaps(7, { buyGapPpm: 100, sellGapPpm: 200 })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/runs/7/gaps');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200 }));
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer t' });
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

// Order cancel: POST the chosen reason to the run-scoped cancel route; the
// server's error codes ride back as ApiError(status, code) for the modal.
describe('cancelOrder', () => {
  test('posts the reason to /api/runs/:id/orders/:orderId/cancel', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    };
    const api = createApi(http, { getToken: () => null });
    await api.cancelOrder(4, 9, 'stale-price');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/runs/4/orders/9/cancel');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ reason: 'stale-price' }));
  });

  test('surfaces the server error code as ApiError', async () => {
    const http: Http = async () => Response.json({ error: 'invalid-reason' }, { status: 400 });
    const api = createApi(http, { getToken: () => null });
    await expect(api.cancelOrder(4, 9, 'bogus')).rejects.toMatchObject({ status: 400, code: 'invalid-reason' });
  });
});
