// Plain bun test — no happy-dom needed: the stub only touches globalThis.fetch
// and the Response global.
import { afterEach, describe, expect, it } from 'bun:test';

import { installFetchStub, json, restoreFetch } from './fetchStub';

const realFetch = globalThis.fetch;

async function call(url: string, init?: { method?: string; body?: string }) {
  const res = await globalThis.fetch(url, init as RequestInit | undefined);
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    data: await res.json(),
  };
}

afterEach(() => {
  restoreFetch();
});

describe('installFetchStub', () => {
  it('matches routes in order and replies with their json', async () => {
    installFetchStub([
      { url: '/api/runs/1', json: { tag: 'exact' } },
      { url: '/api/runs', json: { tag: 'prefix' } },
    ]);

    expect(await call('/api/runs/1')).toEqual({
      status: 200,
      type: 'application/json',
      data: { tag: 'exact' },
    });
    // The later, broader route still serves anything the first one missed.
    expect((await call('/api/runs/2')).data).toEqual({ tag: 'prefix' });
  });

  it('filters routes by method, defaulting to GET', async () => {
    installFetchStub([
      { url: '/api/runs', method: 'POST', status: 201, json: { created: true } },
      { url: '/api/runs', json: { listed: true } },
    ]);

    expect(await call('/api/runs')).toEqual({
      status: 200,
      type: 'application/json',
      data: { listed: true },
    });
    expect(await call('/api/runs', { method: 'POST', body: '{}' })).toEqual({
      status: 201,
      type: 'application/json',
      data: { created: true },
    });
  });

  it('answers unmatched requests with 200 []', async () => {
    installFetchStub([{ url: '/nope', json: { tag: 'never' } }]);

    expect(await call('/api/something-else')).toEqual({
      status: 200,
      type: 'application/json',
      data: [],
    });
  });

  it('records non-GET requests with parsed bodies; reset() empties the log', async () => {
    const calls = installFetchStub([
      { url: '/api/runs', method: 'POST', json: { id: 7 } },
      { url: '/api/runs/3', method: 'DELETE', json: { ok: true } },
    ]);

    await call('/api/runs', { method: 'POST', body: JSON.stringify({ ticker: 'QQQ' }) });
    await call('/api/runs/3', { method: 'DELETE' });
    await call('/api/runs'); // GET is never recorded

    expect(calls.length).toBe(2);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/runs');
    expect(calls[0]!.body).toEqual({ ticker: 'QQQ' });
    expect(calls[1]!.method).toBe('DELETE');
    expect(calls[1]!.body).toEqual({});

    calls.reset();
    expect(calls.length).toBe(0);

    await call('/api/runs', { method: 'POST', body: '{}' });
    expect(calls.length).toBe(1);
  });

  it('reads route status and json at request time so tests can mutate a route', async () => {
    const route = { url: '/api/pending/9/confirm', method: 'POST', status: 409, json: { error: 'ticker-mismatch' } };
    installFetchStub([route]);

    expect(await call('/api/pending/9/confirm', { method: 'POST', body: '{}' })).toEqual({
      status: 409,
      type: 'application/json',
      data: { error: 'ticker-mismatch' },
    });

    route.status = 200;
    route.json = { ok: true };
    expect(await call('/api/pending/9/confirm', { method: 'POST', body: '{}' })).toEqual({
      status: 200,
      type: 'application/json',
      data: { ok: true },
    });
  });

  it('exposes an array so existing assertions keep working', async () => {
    const calls = installFetchStub([{ url: '/api/sim', method: 'POST', json: { id: 3 } }]);
    await call('/api/sim', { method: 'POST', body: '{}' });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('/api/sim');
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
  });
});

describe('json + restoreFetch', () => {
  it('json() builds a JSON Response with a default 200 status', async () => {
    const res = json({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ a: 1 });

    const err = json({ error: 'not-last' }, 422);
    expect(err.status).toBe(422);
    expect(await err.json()).toEqual({ error: 'not-last' });
  });

  it('restoreFetch() puts the original globalThis.fetch back', async () => {
    installFetchStub([]);
    expect(globalThis.fetch).not.toBe(realFetch);

    restoreFetch();
    expect(globalThis.fetch).toBe(realFetch);
  });
});
