// The server's default cost, fetched once per page load. The default is
// env-only on the server (the Settings page cannot change it), so the memo
// never needs invalidating; only a failed load is forgotten so the next mount
// asks again.
import { api } from './api';
import { costInputText } from './format';

let inflight: Promise<string> | undefined;
let resolved: string | undefined;

export function loadDefaultCostText(): Promise<string> {
  if (inflight) return inflight;
  const request = api.getSettings().then((s) => {
    const text = costInputText(s.defaultCostPpm);
    if (text === '') throw new Error('default cost is not a finite number');
    if (inflight === request) resolved = text;
    return text;
  });
  inflight = request;
  request.catch(() => {
    if (inflight === request) inflight = undefined;
  });
  return request;
}

/** The resolved text, if any, so a later mount can seed state without a blank first frame. */
export function peekDefaultCostText(): string | undefined {
  return resolved;
}

export function resetDefaultCostMemo(): void {
  inflight = undefined;
  resolved = undefined;
}
