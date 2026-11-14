/**
 * Shared fetch stub for web tests. Tests describe routes declaratively;
 * the helper installs global fetch, records non-GET calls, and restores the
 * original fetch on `restoreFetch()`.
 *
 * Route `status` and `json` are re-read on every request, so mutating a route
 * object mid-test changes later responses — the same trick the per-file stubs
 * used for flag variables.
 */

export interface Route {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Substring of the request URL; routes are matched in declaration order. */
  url: string;
  /** Defaults to 200. */
  status?: number;
  /** Response body, serialised on every matched request. */
  json: unknown;
}

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

/** Recorded non-GET calls — a real array so `calls.length`/`filter`/`map` read naturally. */
export interface FetchCalls extends Array<FetchCall> {
  /** Forget recorded calls; the stub stays installed and routes keep working. */
  reset(): void;
}

let savedFetch: typeof fetch | undefined;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Low-level builder for stubs that need per-request logic or error bodies. */
export function json(data: unknown, status = 200): Response {
  return response(status, data);
}

export function installFetchStub(routes: Route[]): FetchCalls {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  savedFetch = original;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      let body: unknown = {};
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method, url, body });
    }
    const route = routes.find(
      (r) => url.includes(r.url) && (r.method ?? 'GET') === method,
    );
    return Promise.resolve(route ? response(route.status ?? 200, route.json) : response(200, []));
  }) as typeof fetch;
  return Object.assign(calls, {
    reset(): void {
      calls.length = 0;
    },
  }) as FetchCalls;
}

export function restoreFetch(): void {
  if (savedFetch) {
    globalThis.fetch = savedFetch;
    savedFetch = undefined;
  }
}
