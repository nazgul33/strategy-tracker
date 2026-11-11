import { parseUsd } from '@st/core/money';
import type { BucketDto, PendingFillDto, RunStatus, SimEvent, SimPlanDto } from './api';

/**
 * Presentation logic worth unit testing: bucket cells, badge tones, form
 * validation. Display-only math on *already booked* values — realized P&L
 * itself comes from the server (`progressView.realizedCents`), never here.
 */

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const RUN_STATUSES: RunStatus[] = ['active', 'paused', 'closed'];

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

/** Lifecycle transitions the web can send for a run; `closed` is terminal. */
export type RunAction = 'pause' | 'resume' | 'close';

export function runActions(status: RunStatus): RunAction[] {
  if (status === 'active') return ['pause', 'close'];
  if (status === 'paused') return ['resume', 'close'];
  return [];
}

/** Selected run ids grouped by the bulk transitions they can all take. */
export interface BulkPlan {
  pause: number[];
  resume: number[];
  close: number[];
}

export function bulkPlan(rows: readonly { id: number; status: RunStatus }[]): BulkPlan {
  const plan: BulkPlan = { pause: [], resume: [], close: [] };
  for (const row of rows) {
    if (row.status === 'active') plan.pause.push(row.id);
    if (row.status === 'paused') plan.resume.push(row.id);
    if (row.status !== 'closed') plan.close.push(row.id);
  }
  return plan;
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

// `cancelled` is grouped with `skipped`/`stale`: an order the broker accepted
// and then called off is just as inert — it never held money.
export function orderStatusTone(status: string): BadgeTone {
  if (status === 'open') return 'primary';
  if (status === 'filled') return 'success';
  if (status === 'skipped' || status === 'stale' || status === 'cancelled') return 'neutral';
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

/**
 * Bucket age in trading days as of this morning, from the previous day's
 * end-of-day ages: `advanceDay` bumps every held bucket by one before
 * planning and selling, so this matches the planned orders' stamped `ageDays`
 * — and works for sim data stored before stamping existed.
 */
export function morningAge(
  prevAges: Record<string, number> | undefined,
  bucketIndex: number,
): number | undefined {
  if (!prevAges) return undefined;
  const age = prevAges[bucketIndex] ?? prevAges[String(bucketIndex)];
  return typeof age === 'number' ? age + 1 : undefined;
}

/** `skipReasons` result: reasons keyed by skip-row index, plus the notices
 * that are still worth rendering in the notices block. */
export interface SkipReasonsResult {
  reasons: Map<number, string>;
  visibleNotices: SimPlanDto['notices'];
}

/**
 * Skip rows → their cancellation reason, paired exactly like the Telegram
 * digest: each skip consumes the first unconsumed notice whose `bucket` param
 * matches (0-based). Keys are skip-row indices (index into `plan.skips`), so
 * two skips on one bucket get independent reasons, like the digest loop.
 * Suppression mirrors `renderDigest` (digest.ts:31-34): a consumed notice is
 * removed from `visibleNotices` (original order), and callers must render the
 * notices block from `visibleNotices` — never the full array — or the same
 * text shows up twice, as a skip reason *and* as a notice.
 */
export function skipReasons(
  plan: SimPlanDto,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SkipReasonsResult {
  const reasons = new Map<number, string>();
  const notices = plan.notices ?? [];
  const used = new Set<number>();
  (plan.skips ?? []).forEach((s, si) => {
    // Legacy plans store params.bucket as a string (String(b.index)); compare both sides as strings.
    const idx = notices.findIndex((n, i) => !used.has(i) && String(n.params?.bucket) === String(s.bucketIndex));
    if (idx >= 0) {
      used.add(idx);
      reasons.set(si, t(`digest.${notices[idx].code}`, notices[idx].params));
    }
  });
  return { reasons, visibleNotices: notices.filter((_, i) => !used.has(i)) };
}

/**
 * Shared-pool top-up: the API's `POST /api/runs/:id/pool` sets an **absolute**
 * amount, so the modal must send current pool + the user's addition. Returns
 * the new total in cents, or `null` when the result is not a positive integer
 * that JSON can carry exactly — a float total would silently change the pool.
 */
export function poolAfterTopUp(poolCents: number, addCents: number): number | null {
  if (!Number.isInteger(poolCents) || !Number.isInteger(addCents)) return null;
  if (addCents <= 0) return null;
  const total = poolCents + addCents;
  if (total <= 0 || !Number.isSafeInteger(total)) return null;
  return total;
}

/**
 * Seed-cash validation for the create-run form. A typed value (non-empty text,
 * `cashTyped`; defaults to "parsed a number") must be a non-negative integer
 * number of cents, or null/NaN from `usdToCents` counts as unparsable →
 * `seedCashInvalid`. When seed rows exist but nothing was typed, the cash
 * total is required → `seedCashRequired`. Otherwise null.
 */
export function seedCashErrorKey(rows: readonly unknown[], cashCents: number | null, cashTyped?: boolean): string | null {
  const typed = cashTyped ?? cashCents !== null;
  if (typed && (cashCents === null || !Number.isInteger(cashCents) || cashCents < 0)) return 'seedCashInvalid';
  if (rows.length > 0 && !typed) return 'seedCashRequired';
  return null;
}
