import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError } from './api';
import type { Http } from './api';
import { createVrApi, type VrApi } from './api.vr';

function recorder(status = 200, body: unknown = { id: 4 }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, init });
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
  return { calls, api: createVrApi(http, { getToken: () => 't' }) };
}

const SETTINGS = { g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 } as const;
const FILL = { side: 'buy', shares: 3, price: '45.15', fee: '0.09', filledOn: '2026-12-08' } as const;
const CASH = { kind: 'deposit', amountCents: 5000, movedOn: '2026-12-01', note: 'top up' } as const;
const FULL_CREATE = {
  name: 'R',
  ticker: 'TQQQ',
  cashCents: 1_000_000,
  initialStockCents: 500_000,
  g: 10,
  formula: 'skill',
  bandPpm: 150_000,
  spendLimitPpm: 500_000,
  cycleDepositCents: -2500,
  costPpm: 700,
} as const;

type Row = [label: string, call: (api: VrApi) => Promise<unknown>, method: string | undefined, url: string, body?: unknown];

const ROWS: Row[] = [
  ['listRuns', (a) => a.listRuns(), undefined, '/api/vr/runs'],
  ['createRun', (a) => a.createRun({ name: 'R', ticker: 'tqqq', cashCents: 1000 }), 'POST', '/api/vr/runs', { name: 'R', ticker: 'TQQQ', cashCents: 1000 }],
  ['getRun', (a) => a.getRun(5), undefined, '/api/vr/runs/5'],
  ['setStatus', (a) => a.setStatus(5, 'paused'), 'PATCH', '/api/vr/runs/5', { status: 'paused' }],
  ['saveSettings', (a) => a.saveSettings(5, SETTINGS), 'POST', '/api/vr/runs/5/settings', SETTINGS],
  ['listCycles', (a) => a.listCycles(5), undefined, '/api/vr/runs/5/cycles'],
  ['listFills', (a) => a.listFills(5), undefined, '/api/vr/runs/5/fills'],
  ['addFill', (a) => a.addFill(5, FILL), 'POST', '/api/vr/runs/5/fills', { side: 'buy', shares: 3, price: '45.15', fee: '0.09', filledOn: '2026-12-08' }],
  ['updateFill', (a) => a.updateFill(5, 12, FILL), 'PUT', '/api/vr/runs/5/fills/12', { side: 'buy', shares: 3, price: '45.15', fee: '0.09', filledOn: '2026-12-08' }],
  ['deleteFill', (a) => a.deleteFill(5, 12), 'DELETE', '/api/vr/runs/5/fills/12', {}],
  ['listCash', (a) => a.listCash(5), undefined, '/api/vr/runs/5/cash'],
  ['addCash', (a) => a.addCash(5, CASH), 'POST', '/api/vr/runs/5/cash', { kind: 'deposit', amountCents: 5000, movedOn: '2026-12-01', note: 'top up' }],
  ['updateCash', (a) => a.updateCash(5, 21, { amountCents: 6000, movedOn: '2026-12-02' }), 'PUT', '/api/vr/runs/5/cash/21', { amountCents: 6000, movedOn: '2026-12-02' }],
  ['deleteCash', (a) => a.deleteCash(5, 21), 'DELETE', '/api/vr/runs/5/cash/21', {}],
  ['listPending', (a) => a.listPending(5), undefined, '/api/vr/runs/5/pending'],
  ['updatePending', (a) => a.updatePending(5, 31, FILL), 'PUT', '/api/vr/runs/5/pending/31', { side: 'buy', shares: 3, price: '45.15', fee: '0.09', filledOn: '2026-12-08' }],
  ['confirmPending', (a) => a.confirmPending(5, 31), 'POST', '/api/vr/runs/5/pending/31/confirm', {}],
  ['rejectPending', (a) => a.rejectPending(5, 31), 'POST', '/api/vr/runs/5/pending/31/reject', {}],
  ['confirmAllPending', (a) => a.confirmAllPending(5), 'POST', '/api/vr/runs/5/pending/confirm-all', {}],
];

describe('VrApi verbs, URLs and bodies', () => {
  for (const [label, call, method, url, body] of ROWS) {
    test(label, async () => {
      const { calls, api } = recorder();
      await call(api);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(url);
      expect(calls[0]!.init?.method).toBe(method);
      if (body === undefined) expect(calls[0]!.init?.body).toBeUndefined();
      else expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(body);
    });
  }

  test('sends the bearer token', async () => {
    const { calls, api } = recorder();
    await api.listRuns();
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer t');
  });

  test('GETs resolve to the parsed body', async () => {
    const { api } = recorder(200, [{ id: 5 }]);
    await expect(api.listRuns()).resolves.toEqual([{ id: 5 }] as never);
  });
});

describe('VrApi void methods', () => {
  test.each([
    ['setStatus', (a: VrApi) => a.setStatus(5, 'closed')],
    ['saveSettings', (a: VrApi) => a.saveSettings(5, SETTINGS)],
    ['updateFill', (a: VrApi) => a.updateFill(5, 12, FILL)],
    ['deleteFill', (a: VrApi) => a.deleteFill(5, 12)],
    ['updateCash', (a: VrApi) => a.updateCash(5, 21, { amountCents: 1, movedOn: '2026-12-02' })],
    ['deleteCash', (a: VrApi) => a.deleteCash(5, 21)],
    ['updatePending', (a: VrApi) => a.updatePending(5, 31, FILL)],
    ['rejectPending', (a: VrApi) => a.rejectPending(5, 31)],
  ])('%s resolves to undefined on a 204', async (_label, call) => {
    const { api } = recorder(204);
    await expect(call(api)).resolves.toBeUndefined();
  });

  test('setStatus resolves to undefined even when the server answers {ok:true}', async () => {
    const { api } = recorder(200, { ok: true });
    await expect(api.setStatus(5, 'paused')).resolves.toBeUndefined();
  });
});

describe('VrApi createRun', () => {
  test('trims the name and upper-cases the ticker', async () => {
    const { calls, api } = recorder();
    await api.createRun({ name: ' My run ', ticker: ' tqqq ', cashCents: 1000 });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: 'My run', ticker: 'TQQQ', cashCents: 1000 });
  });

  test('a full input sends every key', async () => {
    const { calls, api } = recorder();
    await api.createRun(FULL_CREATE);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(FULL_CREATE);
  });

  test('a value of 0 is still sent', async () => {
    const { calls, api } = recorder();
    await api.createRun({ name: 'R', ticker: 'T', cashCents: 1000, spendLimitPpm: 0, cycleDepositCents: 0 });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: 'R', ticker: 'T', cashCents: 1000, spendLimitPpm: 0, cycleDepositCents: 0 });
  });

  test('resolves to the new id', async () => {
    const { api } = recorder(201, { id: 9 });
    await expect(api.createRun({ name: 'R', ticker: 'T', cashCents: 1000 })).resolves.toEqual({ id: 9 });
  });
});

describe('VrApi optional body keys', () => {
  test('addFill sends no fee key when the fee is undefined or blank', async () => {
    const { calls, api } = recorder();
    await api.addFill(5, { ...FILL, fee: undefined });
    await api.addFill(5, { ...FILL, fee: '' });
    await api.addFill(5, FILL);
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect('fee' in bodies[0]!).toBe(false);
    expect('fee' in bodies[1]!).toBe(false);
    expect(bodies[2]!.fee).toBe('0.09');
  });

  test('updateFill follows the same fee rule', async () => {
    const { calls, api } = recorder(204);
    await api.updateFill(5, 12, { ...FILL, fee: '' });
    expect('fee' in JSON.parse(String(calls[0]!.init?.body))).toBe(false);
  });

  test('updatePending follows the same fee rule', async () => {
    const { calls, api } = recorder(204);
    await api.updatePending(5, 31, { ...FILL, fee: '' });
    await api.updatePending(5, 31, { ...FILL, fee: undefined });
    for (const c of calls) expect('fee' in JSON.parse(String(c.init?.body))).toBe(false);
  });

  test('cash bodies omit the note unless given', async () => {
    const { calls, api } = recorder();
    await api.addCash(5, { kind: 'withdraw', amountCents: -100, movedOn: '2026-12-01' });
    await api.updateCash(5, 21, { amountCents: 1, movedOn: '2026-12-02' });
    await api.updateCash(5, 21, { amountCents: 1, movedOn: '2026-12-02', note: '' });
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect('note' in bodies[0]!).toBe(false);
    expect('note' in bodies[1]!).toBe(false);
    expect(bodies[2]!.note).toBe('');
  });
});

describe('VrApi pending results', () => {
  test('confirmPending resolves to { fillId }', async () => {
    const { api } = recorder(201, { fillId: 44 });
    await expect(api.confirmPending(5, 31)).resolves.toEqual({ fillId: 44 });
  });

  test('confirmAllPending resolves to the result', async () => {
    const result = { confirmed: 2, refused: [{ id: 34, error: 'fill-date-in-future' }], skippedDuplicates: 1, skippedUndated: 0 };
    const { api } = recorder(200, result);
    await expect(api.confirmAllPending(5)).resolves.toEqual(result);
  });

  test('listPending resolves to the rows', async () => {
    const { api } = recorder(200, [{ id: 31 }]);
    await expect(api.listPending(5)).resolves.toEqual([{ id: 31 }] as never);
  });
});

describe('VrApi failures', () => {
  test('a 409 vr-not-pending on confirmPending becomes an ApiError with its code', async () => {
    const { api } = recorder(409, { error: 'vr-not-pending' });
    await expect(api.confirmPending(5, 31)).rejects.toMatchObject({ status: 409, code: 'vr-not-pending' });
  });

  test('a 409 vr-name-taken becomes an ApiError with its code', async () => {
    const { api } = recorder(409, { error: 'vr-name-taken' });
    await expect(api.createRun({ name: 'R', ticker: 'T', cashCents: 1000 })).rejects.toMatchObject({
      status: 409,
      code: 'vr-name-taken',
    });
    await expect(api.createRun({ name: 'R', ticker: 'T', cashCents: 1000 })).rejects.toBeInstanceOf(ApiError);
  });

  test('a fetch that throws becomes a NetworkError', async () => {
    const api = createVrApi(() => Promise.reject(new TypeError('Failed to fetch')), { getToken: () => null });
    await expect(api.listRuns()).rejects.toBeInstanceOf(NetworkError);
  });
});
