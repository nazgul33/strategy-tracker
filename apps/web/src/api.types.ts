// DTO types mirroring the Hono JSON API responses (apps/server/src/http).
// api.ts re-exports everything here (`export type *`) so every existing
// `import type { … } from '../api'` site keeps working unchanged.

// ------------------------------------------------------------------- DTOs
export type RunStatus = 'active' | 'paused' | 'closed';

export interface RunDto {
  id: number;
  strategyKey: string;
  ticker: string;
  name: string;
  poolCents: number;
  costPpm: number;
  status: RunStatus;
  stateJson: string;
  createdAt: string;
}

export interface ProgressViewDto {
  heldCount: number;
  cashCents: number;
  exposureCents: number;
  realizedCents: number;
  winRate: number | null;
}

export interface BucketDto {
  index: number;
  state: 'empty' | 'held' | 'force_sell';
  shares: number;
  buyPrice: string | null; // myriadths as string
  buyFeeCents: number;
  filledOn: string | null;
}

export interface ClosedBucketDto {
  index: number;
  shares: number;
  buyPrice: string;
  soldPrice: string;
  buyFeeCents: number;
  sellFeeCents: number;
  openedOn: string;
  closedOn: string;
}

export interface RunStateDto {
  buckets: BucketDto[];
  cashCents: number;
  closed: ClosedBucketDto[];
  ages: Record<string, number>;
}

export interface RunDetailDto extends RunDto {
  progressView: ProgressViewDto;
  state: RunStateDto;
}

export interface OrderDto {
  id: number;
  runId: number;
  tradeDate: string;
  kind: 'buy_loc' | 'sell_loc' | 'market_sell';
  bucketIdx: number;
  limitPrice: string; // myriadths as string
  shares: number;
  status: 'open' | 'filled' | 'stale' | 'cancelled';
  skipReason: string | null;
}

export interface FillDto {
  id: number;
  runId: number;
  bucketIdx: number;
  side: 'buy' | 'sell';
  ticker: string;
  shares: number;
  price: string; // myriadths as string
  fee: number; // cents
  filledOn: string;
  source: 'capture' | 'manual' | 'seed';
  createdAt: string;
}

export interface NotificationDto {
  id: number;
  runId: number | null;
  chatId: string;
  text: string;
  sentAt: string;
}

export interface PendingFillDto {
  id: number;
  runId: number;
  captureId: number | null;
  bucketIdx: number | null;
  side: string;
  ticker: string;
  shares: number;
  price: string; // myriadths as string
  fee: number | null; // cents
  filledOn: string;
  status: string;
  createdAt: string;
}

export interface SettingsDto {
  visionBaseUrl: string;
  visionModel: string;
  digestLang: string;
  hasVisionApiKey: boolean;
}

export interface SimRunDto {
  id: number;
  ticker: string;
  fromDate: string;
  toDate: string;
  poolCents: number;
  costPpm: number;
  paramsJson: string;
  createdAt: string;
}

export type SimEvent =
  | { type: 'fill'; side: 'buy' | 'sell'; bucketIndex: number; shares: number; price: string; feeCents: number }
  | { type: 'skipped'; bucketIndex: number; reason: string };

export interface SimOrderDto {
  kind: string;
  bucketIndex: number;
  limitPrice: string;
  shares: number;
}

export interface SimPlanDto {
  orders: SimOrderDto[];
  skips: SimOrderDto[];
  notices: { code: string; params?: Record<string, string | number> }[];
}

export interface SimDayDto {
  id: number;
  simRunId: number;
  tradeDate: string;
  planJson: SimPlanDto;
  stateJson: RunStateDto;
  eventsJson: SimEvent[];
}

export interface SimDetailDto {
  run: SimRunDto;
  days: SimDayDto[];
}

// ------------------------------------------------------------------ inputs
export interface CreateRunInput {
  name: string;
  ticker: string;
  costPpm: number; // integer ppm ≥ 0
  poolCents: number; // integer cents > 0
  bucketCount?: number; // omitted → server default (10)
  seed?: { cashCents?: number; buckets?: { shares: number; buyPrice: string; filledOn: string }[] };
}

/** Body of POST /runs/:id/fills — RawFill & { filledOn }, USD strings. */
export interface ManualFillInput {
  side: 'buy' | 'sell';
  ticker: string;
  shares: number;
  price: string; // "12.34"
  fee?: string; // "0.50" or omitted
  filledOn: string; // YYYY-MM-DD
}

export interface SimInput {
  name: string;
  ticker: string;
  from: string;
  to: string;
  poolCents: number;
  costPpm: number;
  params?: { bucketCount?: number; maxAgeDays?: number };
}
