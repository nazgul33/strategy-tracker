export type Http = (url: string, init?: RequestInit) => Promise<Response>;

/** Server error codes (Hono routes + domain errors) plus the `http-${status}`
 * fallback for responses without a JSON `{error}` body. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'not-found'
  | 'no-run'
  | 'not-pending'
  | 'ticker-mismatch'
  | 'order-not-found'
  | 'order-not-open'
  | 'invalid-reason'
  | 'invalid-body'
  | 'not-last'
  | 'no-bucket-for-sell'
  | 'no-empty-bucket'
  | 'no-fill'
  | 'invalid-fill'
  | 'immutable-field'
  | 'bucket-not-empty'
  | 'bucket-not-found'
  | 'bucket-not-held'
  | 'invalid-bucket'
  | 'choose-bucket'
  | 'fill-date-in-future'
  | 'invalid-shares'
  | 'too-many-shares'
  | 'correction-not-found'
  | 'correction-not-open'
  | 'correction-stale'
  | 'sim-finalized'
  | 'pipeline-error'
  | 'unsupported-image'
  | 'image-too-large'
  | 'capture-failed'
  | 'vision-not-configured'
  // VR routes (/api/vr)
  | 'vr-name-taken'
  | 'vr-negative-shares'
  | 'vr-too-large'
  | 'vr-open-required'
  | 'invalid-side'
  | 'invalid-price'
  | 'invalid-fee'
  | 'invalid-date'
  | 'invalid-kind'
  | 'invalid-amount'
  | 'invalid-note'
  | 'cash-date-in-future'
  | `http-${number}`;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode) {
    super(code);
  }
}

/** The request never got an answer (server down, offline, DNS). The browser's message is kept. */
export class NetworkError extends Error {
  override name = 'NetworkError';
}

export async function call<T>(http: Http, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await http(url, init);
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e), { cause: e });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : `http-${res.status}`;
    throw new ApiError(res.status, code as ApiErrorCode);
  }
  return body as T;
}
