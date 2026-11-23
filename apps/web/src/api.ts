// Typed client for the Hono JSON API (apps/server/src/http). Bigint fields
// arrive as decimal *strings* (jsonBig), cents/fees as numbers. Prices and
// fees the client *sends* are USD strings ("12.34"), parsed via ./usd (which wraps @st/core).
import type { NoticePageDto } from './api.notices';
import { simConfigBody } from './api.sim';
import type {
  CorrectionDto,
  CreateRunInput,
  FillDto,
  ManualFillInput,
  NotificationDto,
  OrderDto,
  PendingFillDto,
  PendingOverrides,
  PriceHistoryDto,
  RunDetailDto,
  RunDto,
  RunStatus,
  SettingsDto,
  SimDetailDto,
  SimInput,
  SimRunDto,
  SimUpdateInput,
  VisionReviewEntryDto,
} from './api.types';

export type * from './api.types';
export type * from './api.notices';
export { usdOrNull, usdFeeOrNull, ungroupUsd, usdToCents } from './usd';

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

/** Server error codes (Hono routes + domain errors) plus the `http-${status}`
 * fallback for responses without a JSON `{error}` body. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'not-found'
  | 'no-run'
  | 'not-pending'
  | 'ticker-mismatch'
  | 'order-not-found'
  | 'order-not-open'
  | 'invalid-reason'
  | 'invalid-body'
  | 'not-last'
  | 'no-bucket-for-sell'
  | 'no-empty-bucket'
  | 'no-fill'
  | 'invalid-fill'
  | 'immutable-field'
  | 'bucket-not-empty'
  | 'bucket-not-found'
  | 'bucket-not-held'
  | 'invalid-bucket'
  | 'invalid-shares'
  | 'too-many-shares'
  | 'correction-not-found'
  | 'correction-not-open'
  | 'correction-stale'
  | 'sim-finalized'
  | 'pipeline-error'
  | `http-${number}`;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode) {
    super(code);
  }
}

/** The request never got an answer (server down, offline, DNS). The browser's message is kept. */
export class NetworkError extends Error {
  override name = 'NetworkError';
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

// --------------------------------------------------------------------- api
/** PUT body for editing a booked fill (buy-only server-side). The route requires
 * `feeCents` on the wire: an integer >= 0, or null = recompute the fee from the
 * run's cost ppm; the client normalizes an omitted value to null (auto-fee).
 * `filledOn` is an optional new trade date (ISO YYYY-MM-DD). */
export interface FillUpdatePayload {
  qty: number;
  priceCents: number;
  feeCents?: number | null;
  filledOn?: string;
}

export interface Api {
  login(password: string): Promise<string>;
  listRuns(): Promise<RunDto[]>;
  createRun(input: CreateRunInput): Promise<{ id: number }>;
  getRun(id: number): Promise<RunDetailDto>;
  setRunStatus(id: number, status: RunStatus): Promise<void>;
  bulkSetRunStatus(ids: number[], status: RunStatus): Promise<number>;
  setPool(id: number, amountCents: number): Promise<void>;
  setGaps(id: number, input: { buyGapPpm: number; sellGapPpm: number; cutLossPpm: number }): Promise<void>;
  priceHistory(id: number, start?: string): Promise<PriceHistoryDto>;
  listOrders(id: number, date?: string): Promise<OrderDto[]>;
  cancelOrder(runId: number, orderId: number, reason: string): Promise<void>;
  listFills(id: number): Promise<FillDto[]>;
  listNotifications(id: number): Promise<NotificationDto[]>;
  /** The global notice feed, newest first; `before` is the previous page's `nextBefore`. */
  listNotices(before?: number): Promise<NoticePageDto>;
  addManualFill(runId: number, fill: ManualFillInput): Promise<void>;
  updateFill(runId: number, fillId: number, body: FillUpdatePayload): Promise<{ ok: true; deltaCents: number }>;
  deleteFill(runId: number, fillId: number): Promise<{ ok: true; deletedFillId: number; deltaCents: number }>;
  /** Recompute run state from booked fills: 200 `{ok:true,deltaCents,fillCount}`,
   * 404 `no-run`, 422 domain error kind. */
  recalcRun(runId: number): Promise<{ ok: true; deltaCents: number; fillCount: number }>;
  triggerMorning(): Promise<string>;
  listPending(): Promise<PendingFillDto[]>;
  /** `keepImage` archives the screenshot as evidence; it is sent only when true. */
  confirmPending(id: number, overrides?: PendingOverrides, keepImage?: boolean): Promise<{ archived: boolean }>;
  rejectPending(id: number, keepImage?: boolean): Promise<{ archived: boolean }>;
  /** Kept screenshots with the fills resolved from them, newest first. */
  listVisionReviews(): Promise<VisionReviewEntryDto[]>;
  /** Discards a kept screenshot and its review rows; 404 `not-found` when not kept. */
  deleteVisionReview(captureId: number): Promise<void>;
  /** `<img src>` for a stored screenshot. Raw bytes, so it never goes through `call()`. */
  captureImageUrl(captureId: number): string;
  listCorrections(): Promise<CorrectionDto[]>;
  /** 200 `{ok:true,deltaCents}`; 404 `correction-not-found`, 409 `correction-not-open` | `correction-stale`. */
  applyCorrection(id: number): Promise<void>;
  dismissCorrection(id: number): Promise<void>;
  getSettings(): Promise<SettingsDto>;
  saveSettings(values: Partial<Pick<SettingsDto, 'visionBaseUrl' | 'visionModel' | 'digestLang'>> & {
    visionApiKey?: string;
  }): Promise<void>;
  runSim(input: SimInput): Promise<{ id: number; dayCount: number }>;
  /** Apply: recompute a draft in place. 409 `sim-finalized` once saved, 404 when unknown. */
  updateSimRun(id: number, input: SimUpdateInput): Promise<{ id: number; dayCount: number }>;
  /** Save: put a draft into the append-only history (204). 409 `sim-finalized` if already saved. */
  saveSimRun(id: number): Promise<void>;
  /** Discard: delete a draft (204). 409 `sim-finalized` for a saved sim. */
  deleteSimRun(id: number): Promise<void>;
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
      if (input.buyGapPpm !== undefined) body.buyGapPpm = input.buyGapPpm;
      if (input.sellGapPpm !== undefined) body.sellGapPpm = input.sellGapPpm;
      if (input.cutLossPpm !== undefined) body.cutLossPpm = input.cutLossPpm;
      if (input.bucketCount !== undefined) body.params = { bucketCount: input.bucketCount };
      if (input.seed !== undefined) body.seed = input.seed;
      return send<{ id: number }>('POST', '/api/runs', body);
    },
    getRun: (id) => get<RunDetailDto>(`/api/runs/${id}`),
    setRunStatus: (id, status) => send<{ ok: true }>('PATCH', `/api/runs/${id}`, { status }).then(() => undefined),
    bulkSetRunStatus: (ids, status) =>
      send<{ updated: number }>('POST', '/api/runs/bulk-status', { ids, status }).then((r) => r.updated),
    setPool: (id, amountCents) => send<{ ok: true }>('POST', `/api/runs/${id}/pool`, { amountCents }).then(() => undefined),
    setGaps: (id, input) => send<{ ok: true }>('POST', `/api/runs/${id}/gaps`, input).then(() => undefined),
    priceHistory: (id, start) => get<PriceHistoryDto>(`/api/runs/${id}/price-history${start ? `?start=${start}` : ''}`),
    listOrders: (id, date) => get<OrderDto[]>(`/api/runs/${id}/orders${date ? `?date=${date}` : ''}`),
    cancelOrder: (runId, orderId, reason) =>
      send<{ ok: true }>('POST', `/api/runs/${runId}/orders/${orderId}/cancel`, { reason }).then(() => undefined),
    listFills: (id) => get<FillDto[]>(`/api/runs/${id}/fills`),
    listNotifications: (id) => get<NotificationDto[]>(`/api/runs/${id}/notifications`),
    listNotices: (before) =>
      get<NoticePageDto>(`/api/notifications${before === undefined ? '' : `?before=${before}`}`),
    addManualFill: (runId, fill) => {
      const body: Record<string, unknown> = {
        side: fill.side,
        shares: fill.shares,
        price: fill.price,
        filledOn: fill.filledOn,
      };
      if (fill.fee !== undefined && fill.fee !== '') body.fee = fill.fee;
      if (fill.bucketIdx !== undefined) body.bucketIdx = fill.bucketIdx;
      return send<{ ok: true }>('POST', `/api/runs/${runId}/fills`, body).then(() => undefined);
    },
    updateFill: (runId, fillId, body) =>
      send<{ ok: true; deltaCents: number }>(
        'PUT',
        `/api/runs/${runId}/fills/${fillId}`,
        { ...body, feeCents: body.feeCents ?? null },
      ),
    deleteFill: (runId, fillId) =>
      send<{ ok: true; deletedFillId: number; deltaCents: number }>('DELETE', `/api/runs/${runId}/fills/${fillId}`),
    recalcRun: (runId) => send<{ ok: true; deltaCents: number; fillCount: number }>('POST', `/api/runs/${runId}/recalc`),
    triggerMorning: () => send<{ result: string }>('POST', '/api/trigger/morning').then((r) => r.result),
    listPending: () => get<PendingFillDto[]>('/api/pending'),
    confirmPending: (id, overrides, keepImage) =>
      send<{ ok: true; archived?: boolean }>('POST', `/api/pending/${id}/confirm`, {
        ...(overrides ? { overrides } : {}),
        ...(keepImage ? { keepImage: true } : {}),
      }).then((r) => ({ archived: r.archived !== false })),
    rejectPending: (id, keepImage) =>
      send<{ ok: true; archived?: boolean }>('POST', `/api/pending/${id}/reject`, keepImage ? { keepImage: true } : {}).then(
        (r) => ({ archived: r.archived !== false }),
      ),
    listVisionReviews: () => get<{ entries: VisionReviewEntryDto[] }>('/api/vision-reviews').then((r) => r.entries),
    deleteVisionReview: (captureId) =>
      send<{ ok: true }>('DELETE', `/api/vision-reviews/${captureId}`).then(() => undefined),
    captureImageUrl: (captureId) => `/api/captures/${captureId}/image`,
    listCorrections: () => get<CorrectionDto[]>('/api/corrections'),
    applyCorrection: (id) => send<{ ok: true }>('POST', `/api/corrections/${id}/apply`).then(() => undefined),
    dismissCorrection: (id) => send<{ ok: true }>('POST', `/api/corrections/${id}/dismiss`).then(() => undefined),
    getSettings: () => get<SettingsDto>('/api/settings'),
    saveSettings: (values) => {
      const body: Record<string, string> = {};
      for (const key of ['visionBaseUrl', 'visionModel', 'digestLang', 'visionApiKey'] as const) {
        const v = values[key];
        if (v !== undefined) body[key] = v;
      }
      return send<{ ok: true }>('PUT', '/api/settings', body).then(() => undefined);
    },
    runSim: (input) =>
      send<{ id: number; dayCount: number }>('POST', '/api/sim', {
        ticker: input.ticker.trim().toUpperCase(),
        ...simConfigBody(input),
      }),
    updateSimRun: (id, input) => send<{ id: number; dayCount: number }>('PUT', `/api/sim/${id}`, simConfigBody(input)),
    saveSimRun: (id) => send<unknown>('POST', `/api/sim/${id}/save`).then(() => undefined),
    deleteSimRun: (id) => send<unknown>('DELETE', `/api/sim/${id}`).then(() => undefined),
    listSimRuns: () => get<SimRunDto[]>('/api/sim'),
    getSimRun: (id) => get<SimDetailDto>(`/api/sim/${id}`),
  };
}

async function call<T>(http: Http, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await http(url, init);
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e), { cause: e });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : `http-${res.status}`;
    throw new ApiError(res.status, code as ApiErrorCode);
  }
  return body as T;
}

/** Shared client for the app (pages/hooks). Tests build their own via createApi. */
export const api = createApi((url, init) => fetch(url, init));
