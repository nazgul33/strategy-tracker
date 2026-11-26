// Typed client for GET /api/dashboard (apps/server/src/http/routes/dashboard.ts). Same wire rules as api.ts.
import { getToken } from './api';
import { ApiError, call, type Http } from './api.call';

export type DashboardStrategy = 'mean-reversion' | 'value-rebalancing';

export interface DashboardRowDto {
  id: number;
  name: string;
  ticker: string;
  status: 'active' | 'paused';
  shares: number;
  /** myriadths as a string (jsonBig); null when shares is 0 or no close is stored */
  close: string | null;
  closeDate: string | null;
  closeMark: 'missing' | 'older' | null;
  /** null only when closeMark is 'missing' */
  stockCents: number | null;
  cashCents: number;
  valueCents: number;
  waiting: number;
}

export interface DashboardGroupDto {
  strategy: DashboardStrategy;
  totalCents: number;
  incomplete: boolean;
  olderClose: boolean;
  runs: DashboardRowDto[];
}

export interface DashboardDto {
  today: string;
  closeDate: string | null;
  /** the newest stored close is more than one session behind today */
  closesBehind: boolean;
  groups: [DashboardGroupDto, DashboardGroupDto];
}

export interface DashboardApi {
  get(): Promise<DashboardDto>;
}

/** A 200 that is not the dashboard (an empty or HTML body from a proxy) is a failed request, so the page shows its error card. */
function isDashboard(body: unknown): body is DashboardDto {
  if (typeof body !== 'object' || body === null) return false;
  const groups = (body as { groups?: unknown }).groups;
  return (
    Array.isArray(groups) &&
    groups.length === 2 &&
    groups.every((g) => typeof g === 'object' && g !== null && Array.isArray((g as { runs?: unknown }).runs))
  );
}

export function createDashboardApi(http: Http, opts: { getToken: () => string | null } = { getToken }): DashboardApi {
  return {
    get: async () => {
      const headers: Record<string, string> = {};
      const token = opts.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const body = await call<unknown>(http, '/api/dashboard', { headers });
      if (!isDashboard(body)) throw new ApiError(200, 'http-200');
      return body;
    },
  };
}

export const dashboardApi = createDashboardApi((url, init) => fetch(url, init));
