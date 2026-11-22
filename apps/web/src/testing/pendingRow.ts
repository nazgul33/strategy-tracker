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
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

// Needs a registered DOM (window) at call time, not at import time.
export function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
