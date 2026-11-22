import { describe, expect, test } from 'bun:test';

import { ApiError, createApi } from './api';
import type { Http } from './api';

// Wire contract of the fill edit/delete calls: verb, path, JSON body and the
// ApiError the server's 4xx/5xx replies are normalized into.
describe('updateFill / deleteFill wire contract', () => {
  const record = (res: () => Response) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return res();
    };
    return { calls, api: createApi(http, { getToken: () => 't' }) };
  };
  const ok = () => Response.json({ ok: true, deltaCents: 0 });

  test('updateFill PUTs to /api/runs/:id/fills/:fillId with the JSON body and bearer token', async () => {
    const { calls, api } = record(ok);
    await api.updateFill(4, 9, { qty: 10, priceCents: 5000, feeCents: 41 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/runs/4/fills/9');
    expect(calls[0]!.init?.method).toBe('PUT');
    expect(calls[0]!.init?.headers).toMatchObject({ 'content-type': 'application/json', Authorization: 'Bearer t' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ qty: 10, priceCents: 5000, feeCents: 41 });
  });

  test('updateFill passes feeCents 0 through and sends null when the fee is omitted or null', async () => {
    const { calls, api } = record(ok);
    await api.updateFill(1, 2, { qty: 1, priceCents: 100, feeCents: 0 });
    await api.updateFill(1, 2, { qty: 1, priceCents: 100 });
    await api.updateFill(1, 2, { qty: 1, priceCents: 100, feeCents: null });
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect(bodies[0]).toEqual({ qty: 1, priceCents: 100, feeCents: 0 });
    expect(bodies[1]).toEqual({ qty: 1, priceCents: 100, feeCents: null });
    expect(bodies[2]).toEqual({ qty: 1, priceCents: 100, feeCents: null });
  });

  test('updateFill forwards filledOn when given and omits the key otherwise', async () => {
    const { calls, api } = record(ok);
    await api.updateFill(1, 2, { qty: 1, priceCents: 100, feeCents: 5, filledOn: '2026-11-03' });
    await api.updateFill(1, 2, { qty: 1, priceCents: 100, feeCents: 5 });
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect(bodies[0]).toEqual({ qty: 1, priceCents: 100, feeCents: 5, filledOn: '2026-11-03' });
    expect('filledOn' in bodies[1]!).toBe(false);
  });

  test('deleteFill sends DELETE to /api/runs/:id/fills/:fillId with the bearer token', async () => {
    const { calls, api } = record(() => Response.json({ ok: true, deletedFillId: 7, deltaCents: 80 }));
    await api.deleteFill(4, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/runs/4/fills/7');
    expect(calls[0]!.init?.method).toBe('DELETE');
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  test('a 422 {error:"not-last"} becomes ApiError(422, "not-last") on both calls', async () => {
    const { api } = record(() => Response.json({ error: 'not-last' }, { status: 422 }));
    const put = await api.updateFill(1, 2, { qty: 1, priceCents: 100 }).then(() => null, (e: unknown) => e);
    const del = await api.deleteFill(1, 2).then(() => null, (e: unknown) => e);
    for (const err of [put, del]) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 422, code: 'not-last' });
    }
  });

  test('a non-JSON 500 falls back to ApiError(500, "http-500") on both calls', async () => {
    const { api } = record(() => new Response('<html>boom</html>', { status: 500 }));
    const put = await api.updateFill(1, 2, { qty: 1, priceCents: 100 }).then(() => null, (e: unknown) => e);
    const del = await api.deleteFill(1, 2).then(() => null, (e: unknown) => e);
    for (const err of [put, del]) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 500, code: 'http-500' });
    }
  });
});
