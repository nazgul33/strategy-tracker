// Typed client for the VR routes under /api/vr (apps/server/src/http/routes/vr*.ts). Same wire rules as api.ts.
import { getToken } from './api';
import { call, type Http } from './api.call';
import type { RunStatus } from './api.types';
import type {
  VrCashDto,
  VrCashEdit,
  VrCashInput,
  VrCreateInput,
  VrCycleDto,
  VrFillDto,
  VrFillInput,
  VrRunDetailDto,
  VrRunSummaryDto,
  VrSettingsDto,
} from './api.vr.types';

export type * from './api.vr.types';

export interface VrApi {
  listRuns(): Promise<VrRunSummaryDto[]>;
  createRun(input: VrCreateInput): Promise<{ id: number }>;
  getRun(id: number): Promise<VrRunDetailDto>;
  setStatus(id: number, status: RunStatus): Promise<void>;
  saveSettings(id: number, s: VrSettingsDto): Promise<void>;
  listCycles(id: number): Promise<VrCycleDto[]>;
  listFills(id: number): Promise<VrFillDto[]>;
  addFill(id: number, f: VrFillInput): Promise<{ id: number }>;
  updateFill(id: number, fillId: number, f: VrFillInput): Promise<void>;
  deleteFill(id: number, fillId: number): Promise<void>;
  listCash(id: number): Promise<VrCashDto[]>;
  addCash(id: number, c: VrCashInput): Promise<{ id: number }>;
  updateCash(id: number, cashId: number, c: VrCashEdit): Promise<void>;
  deleteCash(id: number, cashId: number): Promise<void>;
}

const CREATE_KEYS = ['initialStockCents', 'g', 'formula', 'bandPpm', 'spendLimitPpm', 'cycleDepositCents', 'costPpm'] as const;

function createBody(input: VrCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name.trim(),
    ticker: input.ticker.trim().toUpperCase(),
    cashCents: input.cashCents,
  };
  for (const key of CREATE_KEYS) if (input[key] !== undefined) body[key] = input[key];
  return body;
}

function fillBody(f: VrFillInput): Record<string, unknown> {
  const body: Record<string, unknown> = { side: f.side, shares: f.shares, price: f.price, filledOn: f.filledOn };
  if (f.fee !== undefined && f.fee !== '') body.fee = f.fee;
  return body;
}

function cashBody(c: VrCashEdit & { kind?: VrCashInput['kind'] }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (c.kind !== undefined) body.kind = c.kind;
  body.amountCents = c.amountCents;
  body.movedOn = c.movedOn;
  if (c.note !== undefined) body.note = c.note;
  return body;
}

export function createVrApi(http: Http, opts: { getToken: () => string | null } = { getToken }): VrApi {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const out: Record<string, string> = { ...extra };
    const token = opts.getToken();
    if (token) out.Authorization = `Bearer ${token}`;
    return out;
  };
  const get = <T>(url: string): Promise<T> => call<T>(http, url, { headers: headers() });
  const send = <T>(method: string, url: string, body?: unknown): Promise<T> =>
    call<T>(http, url, {
      method,
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    });
  const base = (id: number) => `/api/vr/runs/${id}`;

  return {
    listRuns: () => get<VrRunSummaryDto[]>('/api/vr/runs'),
    createRun: (input) => send<{ id: number }>('POST', '/api/vr/runs', createBody(input)),
    getRun: (id) => get<VrRunDetailDto>(base(id)),
    setStatus: (id, status) => send<unknown>('PATCH', base(id), { status }).then(() => undefined),
    saveSettings: (id, s) =>
      send<unknown>('POST', `${base(id)}/settings`, {
        g: s.g,
        formula: s.formula,
        bandPpm: s.bandPpm,
        spendLimitPpm: s.spendLimitPpm,
        cycleDepositCents: s.cycleDepositCents,
      }).then(() => undefined),
    listCycles: (id) => get<VrCycleDto[]>(`${base(id)}/cycles`),
    listFills: (id) => get<VrFillDto[]>(`${base(id)}/fills`),
    addFill: (id, f) => send<{ id: number }>('POST', `${base(id)}/fills`, fillBody(f)),
    updateFill: (id, fillId, f) => send<unknown>('PUT', `${base(id)}/fills/${fillId}`, fillBody(f)).then(() => undefined),
    deleteFill: (id, fillId) => send<unknown>('DELETE', `${base(id)}/fills/${fillId}`).then(() => undefined),
    listCash: (id) => get<VrCashDto[]>(`${base(id)}/cash`),
    addCash: (id, c) => send<{ id: number }>('POST', `${base(id)}/cash`, cashBody(c)),
    updateCash: (id, cashId, c) => send<unknown>('PUT', `${base(id)}/cash/${cashId}`, cashBody(c)).then(() => undefined),
    deleteCash: (id, cashId) => send<unknown>('DELETE', `${base(id)}/cash/${cashId}`).then(() => undefined),
  };
}

export const vrApi = createVrApi((url, init) => fetch(url, init));
