import { describe, expect, test } from 'bun:test';

import { createApi } from './api';
import type { Http } from './api';

describe('pending review wire contract', () => {
  const record = (res: () => Response = () => Response.json({ ok: true })) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return res();
    };
    return { calls, api: createApi(http, { getToken: () => 't' }) };
  };
  const body = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body));

  test('confirmPending with no overrides and no keep sends an empty body', async () => {
    const { calls, api } = record();
    await api.confirmPending(3);
    expect(calls[0]!.url).toBe('/api/pending/3/confirm');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(body(calls[0]!)).toEqual({});
  });

  test('confirmPending sends keepImage only when true', async () => {
    const { calls, api } = record();
    await api.confirmPending(3, undefined, true);
    await api.confirmPending(3, undefined, false);
    expect(body(calls[0]!)).toEqual({ keepImage: true });
    expect('keepImage' in body(calls[1]!)).toBe(false);
  });

  test('confirmPending with overrides and keepImage false sends only the overrides', async () => {
    const { calls, api } = record();
    await api.confirmPending(3, { shares: 11 }, false);
    expect(body(calls[0]!)).toEqual({ overrides: { shares: 11 } });
  });

  test('confirmPending carries overrides, including feeCents null, next to keepImage', async () => {
    const { calls, api } = record();
    await api.confirmPending(3, { side: 'sell', price: '178.4', feeCents: null }, true);
    expect(body(calls[0]!)).toEqual({ overrides: { side: 'sell', price: '178.4', feeCents: null }, keepImage: true });
  });

  test('rejectPending sends keepImage only when true', async () => {
    const { calls, api } = record();
    await api.rejectPending(3);
    await api.rejectPending(3, true);
    expect(calls.map((c) => c.url)).toEqual(['/api/pending/3/reject', '/api/pending/3/reject']);
    expect(body(calls[0]!)).toEqual({});
    expect(body(calls[1]!)).toEqual({ keepImage: true });
  });

  test('confirmPending resolves archived from the body, defaulting to true', async () => {
    const failed = record(() => Response.json({ ok: true, archived: false }));
    await expect(failed.api.confirmPending(3, undefined, true)).resolves.toEqual({ archived: false });
    const bare = record(() => Response.json({ ok: true }));
    await expect(bare.api.confirmPending(3)).resolves.toEqual({ archived: true });
  });

  test('rejectPending resolves archived from the body, defaulting to true', async () => {
    const failed = record(() => Response.json({ ok: true, archived: false }));
    await expect(failed.api.rejectPending(3, true)).resolves.toEqual({ archived: false });
    const bare = record(() => Response.json({ ok: true }));
    await expect(bare.api.rejectPending(3)).resolves.toEqual({ archived: true });
  });

  test('listVisionReviews unwraps entries', async () => {
    const entry = { captureId: 5, runId: 1, ticker: 'AAPL', createdAt: '2026-11-02T14:00:00Z', mime: 'image/png', byteLen: 9, fills: [] };
    const { calls, api } = record(() => Response.json({ entries: [entry] }));
    await expect(api.listVisionReviews()).resolves.toEqual([entry]);
    expect(calls[0]!.url).toBe('/api/vision-reviews');
  });

  test('deleteVisionReview DELETEs the capture and maps 404 to ApiError', async () => {
    const { calls, api } = record();
    await expect(api.deleteVisionReview(5)).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe('/api/vision-reviews/5');
    expect(calls[0]!.init?.method).toBe('DELETE');
    const missing = record(() => Response.json({ error: 'not-found' }, { status: 404 }));
    await expect(missing.api.deleteVisionReview(6)).rejects.toMatchObject({ status: 404, code: 'not-found' });
  });

  test('captureImageUrl is a plain path and makes no request', () => {
    const { calls, api } = record();
    expect(api.captureImageUrl(12)).toBe('/api/captures/12/image');
    expect(calls).toHaveLength(0);
  });
});

// A pending confirm can carry a bucket override.
describe('bucketIdx', () => {
  test('confirmPending carries a bucketIdx override', async () => {
    const bodies: unknown[] = [];
    const http: Http = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    };
    const api = createApi(http, { getToken: () => null });
    await api.confirmPending(4, { bucketIdx: 3 });
    expect(bodies[0]).toEqual({ overrides: { bucketIdx: 3 } });
  });
});
