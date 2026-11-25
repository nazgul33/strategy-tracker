import type { PendingFillDto } from '../api.types';

// One valid, complete pending row (no override highlight).
export const PENDING_ROW: PendingFillDto = {
  id: 9,
  runId: 7,
  captureId: 3,
  bucketIdx: null,
  side: 'buy',
  ticker: 'AAPL',
  shares: 10,
  price: '123450000', // myriadths → $12,345
  fee: 100,
  filledOn: '2026-11-10',
  status: 'pending',
  createdAt: '2026-11-10T14:30:00Z',
  hasImage: true,
  costPpm: 40,
  heldBuckets: [],
  mergeableBuckets: [],
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

// The same fill as a sell of a run that holds two buckets, read from a stop-market order.
export const PENDING_SELL: PendingFillDto = {
  ...PENDING_ROW,
  side: 'sell',
  heldBuckets: [
    { index: 0, shares: 10 },
    { index: 3, shares: 4 },
  ],
  detected: {
    ...PENDING_ROW.detected!,
    side: 'sell',
    orderType: '매도/STOP(시장가)',
    orderPrice: '0',
    orderedShares: 1,
  },
};
