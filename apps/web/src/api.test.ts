import { describe, expect, test } from 'bun:test';

import { ApiError, createApi, usdToCents } from './api';
import type { ApiErrorCode, Http } from './api';

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
  });

  test('runSim carries cutLossPpm when set', async () => {
    const { calls, api } = recorder();
    await api.runSim({ ...config, name: 'S', ticker: 'qqq' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ ticker: 'QQQ', cutLossPpm: 35_000 });
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
