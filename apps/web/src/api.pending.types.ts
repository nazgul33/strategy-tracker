// The pending-fill DTOs of `GET /api/pending`; api.types.ts re-exports them.

/** A non-empty bucket a sell can be booked to. */
export interface HeldBucketDto {
  index: number;
  shares: number;
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
  /** A screenshot is still stored for this row (it is shown beside the row). */
  hasImage: boolean;
  /** The run's cost in ppm: the fee the server derives when none is supplied is `feeCents(price, shares, costPpm)`. */
  costPpm: number;
  /** The row's own run's non-empty buckets; the choices a confirmed sell can be booked to. */
  heldBuckets: HeldBucketDto[];
  /** The held buckets a confirmed buy can be added to (not force-sell, not partly sold). */
  mergeableBuckets: HeldBucketDto[];
  /** What vision read. `null` = the row predates the snapshot; a null field = vision missed it. */
  detected: DetectedDto | null;
  /** A dry run says this sell could belong to several buckets right now; never true for a buy. */
  needsBucket?: boolean;
  /** The server's New York date (`YYYY-MM-DD`); the only clock a fill date is compared against. */
  today?: string;
}

/**
 * A frozen snapshot of the fields vision read; `price` is myriadths as string, `fee` cents.
 * The order fields are what the broker screen said about the order (a stop-market reads `'0'`).
 */
export interface DetectedDto {
  side: string | null;
  shares: number | null;
  price: string | null;
  filledOn: string | null;
  fee: number | null;
  orderType?: string | null;
  orderPrice?: string | null;
  orderedShares?: number | null;
}
