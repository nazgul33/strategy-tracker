// Typed client for the Hono JSON API (apps/server/src/http). Bigint fields
// arrive as decimal *strings* (jsonBig), cents/fees as numbers. Prices and
// fees the client *sends* are USD strings ("12.34"), parsed via @st/core.
import { parseUsd } from '@st/core/money';

import type {
  CreateRunInput,
  FillDto,
  ManualFillInput,
  NotificationDto,
  OrderDto,
  PendingFillDto,
  RunDetailDto,
  RunDto,
  RunStatus,
  SettingsDto,
  SimDetailDto,
  SimInput,
  SimRunDto,
} from './api.types';

export type * from './api.types';

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------- auth token
let memoryToken: string | null = null;

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem('st_token', token);
    else sessionStorage.removeItem('st_token');
  } catch {
    /* private mode */
  }
}

export function getToken(): string | null {
  if (memoryToken !== null) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem('st_token');
  } catch {
    /* ignore */
  }
  return memoryToken;
}

/** Parses a USD amount string; returns null when malformed or not > 0. */
export function usdOrNull(value: string): string | null {
  const s = value.trim();
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return null;
  try {
    return parseUsd(s) > 0n ? s : null;
  } catch {
    return null;
  }
}

/** Parses a USD fee ("0" allowed); returns null when malformed or negative. */
export function usdFeeOrNull(value: string): string | null {
  const s = value.trim();
  if (s === '') return null;
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return null;
  try {
    return parseUsd(s) >= 0n ? s : null;
  } catch {
    return null;
  }
}

/** "12.345" USD → integer cents, half-up; null on bad input. */
export function usdToCents(value: string): number | null {
  // Accept comma-grouped input ("1,000", "12,345,678.90") by stripping only
  // strictly well-formed grouping; core's parseUsd rejects commas outright.
  const raw = value.trim();
  const s = /^\d+(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw;
  try {
    const v = parseUsd(s);
    if (v < 0n) return null;
    return Number((v + 50n) / 100n);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- api
export interface Api {
  login(password: string): Promise<string>;
  listRuns(): Promise<RunDto[]>;
  createRun(input: CreateRunInput): Promise<{ id: number }>;
  getRun(id: number): Promise<RunDetailDto>;
  setRunStatus(id: number, status: RunStatus): Promise<void>;
  bulkSetRunStatus(ids: number[], status: RunStatus): Promise<number>;
  setPool(id: number, amountCents: number): Promise<void>;
  listOrders(id: number, date?: string): Promise<OrderDto[]>;
  listFills(id: number): Promise<FillDto[]>;
  listNotifications(id: number): Promise<NotificationDto[]>;
  addManualFill(runId: number, fill: ManualFillInput): Promise<void>;
  triggerMorning(): Promise<string>;
  listPending(): Promise<PendingFillDto[]>;
  confirmPending(id: number, overrides?: { shares?: number; price?: string; filledOn?: string }): Promise<void>;
  rejectPending(id: number): Promise<void>;
  getSettings(): Promise<SettingsDto>;
  saveSettings(values: Partial<Pick<SettingsDto, 'visionBaseUrl' | 'visionModel' | 'digestLang'>> & {
    visionApiKey?: string;
  }): Promise<void>;
  runSim(input: SimInput): Promise<{ id: number; dayCount: number }>;
  listSimRuns(): Promise<SimRunDto[]>;
  getSimRun(id: number): Promise<SimDetailDto>;
}

export function createApi(http: Http, opts: { getToken: () => string | null } = { getToken }): Api {
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

  return {
    login: (password) =>
      send<{ token: string }>('POST', '/api/login', { password }).then((r) => r.token),
    listRuns: () => get<RunDto[]>('/api/runs'),
    createRun: (input) => {
      const body: Record<string, unknown> = {
        name: input.name.trim(),
        ticker: input.ticker.trim().toUpperCase(),
        costPpm: input.costPpm,
        poolCents: input.poolCents,
      };
      if (input.bucketCount !== undefined) body.params = { bucketCount: input.bucketCount };
      if (input.seed !== undefined) body.seed = input.seed;
      return send<{ id: number }>('POST', '/api/runs', body);
    },
    getRun: (id) => get<RunDetailDto>(`/api/runs/${id}`),
    setRunStatus: (id, status) => send<{ ok: true }>('PATCH', `/api/runs/${id}`, { status }).then(() => undefined),
    bulkSetRunStatus: (ids, status) =>
      send<{ updated: number }>('POST', '/api/runs/bulk-status', { ids, status }).then((r) => r.updated),
    setPool: (id, amountCents) => send<{ ok: true }>('POST', `/api/runs/${id}/pool`, { amountCents }).then(() => undefined),
    listOrders: (id, date) => get<OrderDto[]>(`/api/runs/${id}/orders${date ? `?date=${date}` : ''}`),
    listFills: (id) => get<FillDto[]>(`/api/runs/${id}/fills`),
    listNotifications: (id) => get<NotificationDto[]>(`/api/runs/${id}/notifications`),
    addManualFill: (runId, fill) => {
      const body: Record<string, unknown> = {
        side: fill.side,
        ticker: fill.ticker.trim().toUpperCase(),
        shares: fill.shares,
        price: fill.price,
        filledOn: fill.filledOn,
      };
      if (fill.fee !== undefined && fill.fee !== '') body.fee = fill.fee;
      return send<{ ok: true }>('POST', `/api/runs/${runId}/fills`, body).then(() => undefined);
    },
    triggerMorning: () => send<{ result: string }>('POST', '/api/trigger/morning').then((r) => r.result),
    listPending: () => get<PendingFillDto[]>('/api/pending'),
    confirmPending: (id, overrides) =>
      send<{ ok: true }>('POST', `/api/pending/${id}/confirm`, overrides ? { overrides } : {}).then(() => undefined),
    rejectPending: (id) => send<{ ok: true }>('POST', `/api/pending/${id}/reject`).then(() => undefined),
    getSettings: () => get<SettingsDto>('/api/settings'),
    saveSettings: (values) => {
      const body: Record<string, string> = {};
      for (const key of ['visionBaseUrl', 'visionModel', 'digestLang', 'visionApiKey'] as const) {
        const v = values[key];
        if (v !== undefined) body[key] = v;
      }
      return send<{ ok: true }>('PUT', '/api/settings', body).then(() => undefined);
    },
    runSim: (input) => {
      const body: Record<string, unknown> = {
        name: input.name.trim(),
        ticker: input.ticker.trim().toUpperCase(),
        from: input.from,
        to: input.to,
        poolCents: input.poolCents,
        costPpm: input.costPpm,
      };
      if (input.params && Object.keys(input.params).length > 0) body.params = input.params;
      return send<{ id: number; dayCount: number }>('POST', '/api/sim', body);
    },
    listSimRuns: () => get<SimRunDto[]>('/api/sim'),
    getSimRun: (id) => get<SimDetailDto>(`/api/sim/${id}`),
  };
}

async function call<T>(http: Http, url: string, init?: RequestInit): Promise<T> {
  const res = await http(url, init);
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? `http-${res.status}`));
  return body as T;
}

/** Shared client for the app (pages/hooks). Tests build their own via createApi. */
export const api = createApi((url, init) => fetch(url, init));
