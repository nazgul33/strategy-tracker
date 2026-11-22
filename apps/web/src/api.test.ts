import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError, createApi } from './api';
import type { ApiErrorCode, Http } from './api';

describe('call() transport failures', () => {
  test('a fetch that throws becomes a NetworkError with its message', async () => {
    const api = createApi(() => Promise.reject(new TypeError('Failed to fetch')), { getToken: () => null });
    const err = await api.listRuns().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).message).toBe('Failed to fetch');
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
    await api.createRun({ ...base, buyGapPpm: 100, sellGapPpm: 200, cutLossPpm: 35_000 });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body.buyGapPpm).toBe(100);
    expect(body.sellGapPpm).toBe(200);
    expect(body.cutLossPpm).toBe(35_000);
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
    expect('cutLossPpm' in body).toBe(false);
  });
});

// runSim mirrors createRun: gaps ride along only when set.
describe('runSim gaps', () => {
  const base = { ticker: 'abc', from: '2026-01-02', to: '2026-06-30', poolCents: 1000, costPpm: 200 };

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

// Sim drafts: Apply is a PUT without the ticker, Save/Discard are body-less,
// and the 409 refusal surfaces as a typed error code.
describe('sim draft endpoints', () => {
  const config = { from: '2026-01-02', to: '2026-06-30', poolCents: 1000, costPpm: 200, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 35_000 };

  function recorder(status = 200, body: unknown = { id: 4, dayCount: 9 }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
    };
    return { calls, api: createApi(http, { getToken: () => 't' }) };
  }

  test('updateSimRun PUTs the config with cut-loss and never a ticker', async () => {
    const { calls, api } = recorder();
    await expect(api.updateSimRun(4, { ...config, params: { bucketCount: 6 } })).resolves.toEqual({ id: 4, dayCount: 9 });
    expect(calls[0]!.url).toBe('/api/sim/4');
    expect(calls[0]!.init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toMatchObject({ ...config, params: { bucketCount: 6 } });
    expect('ticker' in body).toBe(false);
    expect('name' in body).toBe(false);
  });

  test('runSim carries cutLossPpm when set', async () => {
    const { calls, api } = recorder();
    await api.runSim({ ...config, ticker: 'qqq' });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toMatchObject({ ticker: 'QQQ', cutLossPpm: 35_000 });
    expect('name' in body).toBe(false);
  });

  test('saveSimRun POSTs /save and deleteSimRun DELETEs, both resolving on 204', async () => {
    const { calls, api } = recorder(204);
    await expect(api.saveSimRun(4)).resolves.toBeUndefined();
    await expect(api.deleteSimRun(4)).resolves.toBeUndefined();
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ['POST', '/api/sim/4/save'],
      ['DELETE', '/api/sim/4'],
    ]);
  });

  test('a 409 sim-finalized is an ApiError with that code', async () => {
    const { api } = recorder(409, { error: 'sim-finalized' });
    const err = await api.saveSimRun(4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('sim-finalized');
  });
});

// Gap edit: POST /api/runs/:id/gaps, all three values sent, 204 no-content.
describe('setGaps', () => {
  test('posts the three ppm values and resolves on 204', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    };
    const api = createApi(http, { getToken: () => 't' });
    await expect(api.setGaps(7, { buyGapPpm: 100, sellGapPpm: 200, cutLossPpm: 30_000 })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/runs/7/gaps');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200, cutLossPpm: 30_000 }));
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

// Typed error codes: ApiError.code is an ApiErrorCode union (server codes +
// `http-${status}` fallback), not a bare string. Runtime behavior is unchanged;
// the compile-time contract is what these tests pin down.
describe('ApiErrorCode', () => {
  test('server error code rides back unchanged', async () => {
    const http: Http = async () => Response.json({ error: 'not-last' }, { status: 409 });
    const api = createApi(http, { getToken: () => null });
    const err = await api.addManualFill(1, { side: 'buy', shares: 1, price: '1', filledOn: '2026-01-02' }).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.code).toBe('not-last');
  });

  test('non-JSON error body falls back to http-${status}', async () => {
    const http: Http = async () => new Response('boom', { status: 500 });
    const api = createApi(http, { getToken: () => null });
    const err = await api.getRun(1).then(() => null, (e: unknown) => e as ApiError);
    expect(err?.code).toBe('http-500');
  });

  // Compile-time assertions: `const code: ApiErrorCode = err.code` only
  // typechecks once the property is typed as the union (a bare `string` fails),
  // and the literal fallback only typechecks via the `http-${number}` arm.
  test('code narrows to the union (compile-time)', () => {
    const err = new ApiError(409, 'not-last');
    const code: ApiErrorCode = err.code;
    const fallback: ApiErrorCode = 'http-500';
    expect([code, fallback]).toBeTruthy();
  });
});

// Fill/recalc mutations report the cash delta they booked so the UI can show
// the consequence (server wave A responses).
describe('fill mutation deltas', () => {
  test('updateFill resolves with deltaCents', async () => {
    const http: Http = async () => Response.json({ ok: true, deltaCents: -120 });
    const api = createApi(http, { getToken: () => null });
    await expect(api.updateFill(1, 2, { qty: 10, priceCents: 5000 })).resolves.toEqual({ ok: true, deltaCents: -120 });
  });

  test('deleteFill resolves with deletedFillId and deltaCents', async () => {
    const http: Http = async () => Response.json({ ok: true, deletedFillId: 7, deltaCents: 80 });
    const api = createApi(http, { getToken: () => null });
    await expect(api.deleteFill(1, 7)).resolves.toEqual({ ok: true, deletedFillId: 7, deltaCents: 80 });
  });

  test('recalcRun resolves with deltaCents and fillCount', async () => {
    const http: Http = async () => Response.json({ ok: true, deltaCents: 250, fillCount: 4 });
    const api = createApi(http, { getToken: () => null });
    await expect(api.recalcRun(1)).resolves.toEqual({ ok: true, deltaCents: 250, fillCount: 4 });
  });
});
// A sell can name the bucket it is booked to; omitted means automatic.
describe('bucketIdx', () => {
  const sell = { side: 'sell' as const, shares: 5, price: '10', filledOn: '2026-01-02' };

  test('addManualFill sends bucketIdx only when given', async () => {
    const bodies: Record<string, unknown>[] = [];
    const http: Http = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    };
    const api = createApi(http, { getToken: () => null });
    await api.addManualFill(1, { ...sell, bucketIdx: 2 });
    await api.addManualFill(1, sell);
    expect(bodies[0]!.bucketIdx).toBe(2);
    expect('bucketIdx' in bodies[1]!).toBe(false);
  });
});
