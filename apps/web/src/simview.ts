// Presentation logic for the sim replay: event grouping, bucket ages and
// the cancellation reasons paired with skipped orders.
import type { SimEvent, SimPlanDto } from './api';

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
