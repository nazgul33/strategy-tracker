import type { VisionReviewEntryDto, VisionReviewFillDto } from '../api.types';

export const READ = { side: 'buy', shares: 10, price: '1234500', filledOn: '2026-11-10', fee: 100 };

// Vision read the price as $123.45 and missed the fee; the operator corrected the price to
// $125.50 and left the fee alone, so the $1.00 booked is the one the system derived.
export const EDITED: VisionReviewFillDto = {
  id: 11,
  outcome: 'confirmed',
  edited: true,
  feeOverridden: false,
  detected: { ...READ, fee: null },
  final: { ...READ, price: '1255000', fee: 100 },
};
export const UNEDITED: VisionReviewFillDto = {
  id: 12,
  outcome: 'confirmed',
  edited: false,
  feeOverridden: false,
  detected: READ,
  final: READ,
};
export const REJECTED: VisionReviewFillDto = {
  id: 13,
  outcome: 'rejected',
  edited: false,
  feeOverridden: false,
  detected: READ,
  final: null,
};
// The common case: vision read no fee, nothing was edited, the booked fee is the derived one.
export const FEELESS: VisionReviewFillDto = {
  id: 14,
  outcome: 'confirmed',
  edited: false,
  feeOverridden: false,
  detected: { ...READ, fee: null },
  final: READ,
};
// Vision read no fee and the operator typed one.
export const TYPED_FEE: VisionReviewFillDto = {
  id: 15,
  outcome: 'confirmed',
  edited: true,
  feeOverridden: true,
  detected: { ...READ, fee: null },
  final: { ...READ, fee: 250 },
};

export function entry(captureId: number, fills: VisionReviewFillDto[], ticker = 'AAPL'): VisionReviewEntryDto {
  return { captureId, runId: 7, ticker, createdAt: '2026-11-10 14:30:00', mime: 'image/png', byteLen: 20480, fills };
}
