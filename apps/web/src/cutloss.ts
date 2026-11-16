// Cut-loss display math shared by the run edit dialog: bigint only, mirrors the server.
import { floorCents } from '@st/core/money';
import type { BucketDto } from './api';

/**
 * Held buckets whose cut-loss trigger would already be at or above the latest
 * close, i.e. stops that fire at the next open. Mirrors the server's
 * `stopPrice` (buy × (1 − cut loss), truncated to whole cents) and its `>=`
 * test; bigint only. 0 when cut-loss is off or the close is unknown.
 */
export function underwaterStopCount(
  buckets: readonly BucketDto[],
  cutLossPpm: number,
  latestClose: string | null,
): number {
  if (cutLossPpm === 0 || latestClose === null) return 0;
  const close = BigInt(latestClose);
  let n = 0;
  for (const b of buckets) {
    if (b.state !== 'held' || b.buyPrice === null) continue;
    const stop = floorCents((BigInt(b.buyPrice) * (1_000_000n - BigInt(cutLossPpm))) / 1_000_000n);
    if (stop >= close) n++;
  }
  return n;
}

/**
 * True when the underwater check *would* matter (cut-loss on, a bucket held)
 * but cannot run because the latest close is unknown. The caller says so
 * instead of staying silent: a missing safety warning must not read as "all clear".
 */
export function stopCheckUnavailable(
  buckets: readonly BucketDto[],
  cutLossPpm: number,
  latestClose: string | null,
): boolean {
  return cutLossPpm > 0 && latestClose === null && buckets.some((b) => b.state === 'held' && b.buyPrice !== null);
}
