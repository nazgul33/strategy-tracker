import type { DetectedDto, PendingFillDto } from './api';
import type { RowValues } from './pendingvalues';

/** The entered date is after the server's New York date; never the browser's clock. */
export function dateAfterToday(row: PendingFillDto, values: RowValues): boolean {
  return row.today !== undefined && values.filledOn > row.today;
}

/** A sell left on automatic that the server said (dry run, or a refused confirm) needs a bucket chosen. */
export function bucketRequired(row: PendingFillDto, values: RowValues, bucket: string, refused: boolean): boolean {
  return values.side === 'sell' && bucket === '' && (refused || row.needsBucket === true);
}

/** What the broker screen said about the order; `price` is the myriadths string as received. */
export function orderLine(
  detected: DetectedDto | null,
): { type: string | null; shares: number | null; price: string | null } | null {
  const type = detected?.orderType ?? null;
  const shares = detected?.orderedShares ?? null;
  const price = detected?.orderPrice ?? null;
  return type === null && shares === null && price === null ? null : { type, shares, price };
}
