import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError } from './api';
import type { Http } from './api';
import { createDashboardApi } from './api.dashboard';

function recorder(status = 200, body: unknown = { today: '2026-11-26', closeDate: null, groups: [] }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, init });
    return Response.json(body, { status });
  };
  return { calls, api: createDashboardApi(http, { getToken: () => 't' }) };
}

describe('dashboardApi', () => {
  test('get sends GET /api/dashboard with the session header and no body', async () => {
    const { calls, api } = recorder();
    await api.get();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/dashboard');
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(calls[0]!.init?.body).toBeUndefined();
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer t');
  });

  test('get sends no Authorization header without a token', async () => {
    const calls: { init?: RequestInit }[] = [];
    const http: Http = async (_url, init) => {
      calls.push({ init });
      return Response.json({});
    };
    await createDashboardApi(http, { getToken: () => null }).get();
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBeNull();
  });

  test('get resolves to the parsed body, with close left as the string the server sent', async () => {
    const body = {
      today: '2026-11-26',
      closeDate: '2026-11-25',
      groups: [{ strategy: 'mean-reversion', totalCents: 1, incomplete: false, olderClose: false, runs: [{ id: 1, close: '361800' }] }],
    };
    const { api } = recorder(200, body);
    expect(await api.get()).toEqual(body as never);
  });

  test('a 401 rejects with an ApiError the pages turn into the sign-in page', async () => {
    const { api } = recorder(401, { error: 'unauthorized' });
    const err = await api.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  test('a 500 with a plain-text body still rejects with http-500', async () => {
    const http: Http = async () => new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } });
    const err = await createDashboardApi(http, { getToken: () => 't' }).get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, code: 'http-500' });
  });

  test('a fetch that throws rejects with NetworkError', async () => {
    const http: Http = async () => {
      throw new TypeError('offline');
    };
    const err = await createDashboardApi(http, { getToken: () => 't' }).get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });
});
