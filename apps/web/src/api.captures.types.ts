// Wire shapes of POST /api/captures (apps/server/src/wire/capture-route.ts).
// Prices and fees are the USD strings the server formats ('180.50'), not myriadths.
export interface CapturePendingRowDto { id: number; runId: number; captureId: number | null; side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee: string | null; filledOn: string; detectedFilledOn: string | null; status: string; needsBucket: boolean; dateAfterToday: boolean; mergeHint: boolean }

interface CaptureConflictBaseDto { side: 'buy' | 'sell'; ticker: string; shares: number; extractedPrice: string; extractedFee: string | null; filledOn: string }

export type CaptureConflictDto =
  | (CaptureConflictBaseDto & { matchedKind: 'booked'; bookedId: number; bookedPrice: string; correction: { id: number; status: 'open' | 'dismissed' } | { id: null; status: 'fill-gone' } | null })
  | (CaptureConflictBaseDto & { matchedKind: 'pending'; pendingId: number; pendingPrice: string });

export type CaptureOutcomeDto = 'duplicate' | 'rejected' | { pending?: CapturePendingRowDto[]; conflicts?: CaptureConflictDto[]; bookedEarlier?: true };

/** VR take-in (apps/server/src/domain/vr/capture.ts): 'duplicate' = this screenshot was already taken in for the run. */
export type VrCaptureOutcomeDto = 'duplicate' | { waiting: number; dropped: number; possibleDuplicates: number };

export type VisionSourceDto = 'settings' | 'env';
export interface VisionInUseDto { model: string; modelSource: VisionSourceDto; baseUrl: string; baseUrlSource: VisionSourceDto; keySource: VisionSourceDto | 'none' }

export type CaptureEventDto =
  | { type: 'bad-extract'; reason: 'http' | 'unparseable' | 'incompatible'; detail: string; vision: VisionInUseDto }
  | { type: 'bad-extract'; reason: 'empty'; detail: string }
  | { type: 'pin-nomatch'; runId: number; ticker: string }
  | { type: 'pin-skipped'; runId: number; tickers: string[] }
  | { type: 'no-run'; ticker: string }
  | { type: 'ambiguous'; ticker: string }
  | { type: 'outcome'; runId: number; ticker: string; outcome: CaptureOutcomeDto }
  | { type: 'vr-outcome'; runId: number; ticker: string; outcome: VrCaptureOutcomeDto };
