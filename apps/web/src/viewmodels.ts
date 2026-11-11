import { parseUsd } from '@st/core/money';
import type { BucketDto, PendingFillDto, RunStatus, SimEvent } from './api';

/**
 * Presentation logic worth unit testing: bucket cells, badge tones, form
 * validation. Display-only math on *already booked* values — realized P&L
 * itself comes from the server (`progressView.realizedCents`), never here.
 */

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const RUN_STATUSES: RunStatus[] = ['active', 'paused', 'closed', 'done'];

// "buy_loc" → `${prefix}BuyLoc` — catalog keys for wire-level enum values.
export function enumLabelKey(prefix: string, value: string): string {
  const camel = value.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
  return prefix + camel[0].toUpperCase() + camel.slice(1);
}

// "no-bucket" + "orderReason" → "orderReasonNoBucket"; "force-age" + "historyReason" → "historyReasonForceAge"
export function reasonKey(prefix: string, reason: string): string {
  return enumLabelKey(prefix, reason);
}

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as string[]).includes(value);
}

/** Suggested next status per the run lifecycle (`done` is terminal). */
export function nextStatus(status: RunStatus): RunStatus | null {
  if (status === 'active') return 'paused';
  if (status === 'paused') return 'active';
  if (status === 'closed') return 'done';
  return null;
}

export function runStatusTone(status: RunStatus): BadgeTone {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  if (status === 'closed') return 'info';
  return 'neutral';
}

export function orderKindTone(kind: string): BadgeTone {
  if (kind === 'buy_loc') return 'info';
  if (kind === 'sell_loc') return 'primary';
  if (kind === 'market_sell') return 'danger';
  return 'neutral';
}

export function orderStatusTone(status: string): BadgeTone {
  if (status === 'open') return 'primary';
  if (status === 'filled') return 'success';
  if (status === 'skipped' || status === 'stale' || status === 'expired') return 'neutral';
  return 'warning';
}

export function fillSourceTone(source: string): BadgeTone {
  if (source === 'manual') return 'warning';
  if (source === 'seed') return 'info';
  return 'success';
}

/** Money sign tone for P&L numbers (cents are integers, never floats). */
export type PnlTone = 'positive' | 'negative' | 'neutral';

export function toneFor(cents: number | null | undefined): PnlTone {
  if (cents === null || cents === undefined || !Number.isFinite(cents) || cents === 0) return 'neutral';
  return cents > 0 ? 'positive' : 'negative';
}

export function pnlBadgeTone(tone: PnlTone): BadgeTone {
  if (tone === 'positive') return 'success';
  if (tone === 'negative') return 'danger';
  return 'neutral';
}

/** USD *decimal text* ("349.99") → cents (rounded half-up), or null on bad input. */
export function priceToCents(priceUsd: string | null | undefined): number | null {
  if (!priceUsd) return null;
  try {
    const myriadths = parseUsd(priceUsd);
    return Number((myriadths + 50n) / 100n);
  } catch {
    return null;
  }
}

/** Myriadths wire string ("3499900") → USD decimal text ("349.99"); null on bad input. */
export function myriadthsToUsdText(raw: string | null | undefined): string | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const v = BigInt(raw);
  return `${v / 10000n}.${(v % 10000n).toString().padStart(4, '0')}`;
}

/** USD decimal text × shares → cents, half-up. Returns `null` on bad input. */
export function notionalCents(priceUsd: string, shares: number): number | null {
  if (!Number.isInteger(shares) || shares <= 0) return null;
  try {
    const value = parseUsd(priceUsd);
    return Number((value * BigInt(shares) + 50n) / 100n);
  } catch {
    return null;
  }
}

/** A bucket card: empty slots are rendered too, so the grid shows capacity. */
export interface BucketCell {
  index: number;
  filled: boolean;
  state: 'empty' | 'held' | 'force_sell';
  shares: number;
  buyPrice: string | null;
  buyFeeCents: number | null;
  notionalCents: number | null;
  ageDays: number | null;
  forceSell: boolean;
}

export function bucketCells(
  buckets: BucketDto[],
  ages: Record<string, number>,
  bucketCount: number,
  maxAgeDays: number,
): BucketCell[] {
  const cells: BucketCell[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const bucket = buckets[index];
    const filled = Boolean(bucket && bucket.shares > 0);
    const rawAge = ages[String(index)];
    const ageDays = filled && typeof rawAge === 'number' ? rawAge : null;
    // Wire prices are myriadths strings; `notionalCents` takes USD decimal text.
    const notional =
      filled && bucket?.buyPrice ? notionalCents(myriadthsToUsdText(bucket.buyPrice) ?? '', bucket.shares) : null;
    cells.push({
      index,
      filled,
      state: filled ? (bucket.state === 'force_sell' ? 'force_sell' : 'held') : 'empty',
      shares: filled ? bucket.shares : 0,
      buyPrice: filled ? (bucket.buyPrice ?? null) : null,
      buyFeeCents: filled ? (bucket.buyFeeCents ?? null) : null,
      notionalCents: notional,
      ageDays,
      // `@st/strategies` force-closes when age + 1 > maxAgeDays → age >= maxAgeDays is last day.
      forceSell: ageDays !== null && ageDays >= maxAgeDays,
    });
  }
  return cells;
}

export interface PendingIssue {
  /** Field the user must fix before confirming; `null` when nothing is missing. */
  field: 'ticker' | 'side' | 'shares' | 'price' | 'filledOn' | null;
}

/**
 * Fields `confirmPendingFill` needs present (on the row or as an override);
 * surfacing them turns a server 400 into an actionable hint.
 */
export function pendingIssue(row: PendingFillDto): PendingIssue {
  if (!row.ticker) return { field: 'ticker' };
  if (row.side !== 'buy' && row.side !== 'sell') return { field: 'side' };
  if (!Number.isInteger(row.shares) || row.shares <= 0) return { field: 'shares' };
  if (!row.price) return { field: 'price' };
  if (!row.filledOn) return { field: 'filledOn' };
  return { field: null };
}

/** Whole days between two ISO dates (0 on bad input). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export type SimGroup = 'buy' | 'target' | 'force' | 'skipped';

/**
 * Sell fills on the *last* sim day are the forced liquidation; every other
 * sell is the take-profit target. Skips keep their own group.
 */
export function simEventGroup(event: SimEvent, isLastDay: boolean): SimGroup {
  if (event.type === 'skipped') return 'skipped';
  if (event.side === 'buy') return 'buy';
  return isLastDay ? 'force' : 'target';
}
