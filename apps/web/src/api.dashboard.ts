// Typed client for GET /api/dashboard (apps/server/src/http/routes/dashboard.ts). Same wire rules as api.ts.
import { getToken } from './api';
import { call, type Http } from './api.call';

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
  groups: [DashboardGroupDto, DashboardGroupDto];
}

export interface DashboardApi {
  get(): Promise<DashboardDto>;
}

export function createDashboardApi(http: Http, opts: { getToken: () => string | null } = { getToken }): DashboardApi {
  return {
    get: () => {
      const headers: Record<string, string> = {};
      const token = opts.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      return call<DashboardDto>(http, '/api/dashboard', { headers });
    },
  };
}

export const dashboardApi = createDashboardApi((url, init) => fetch(url, init));
