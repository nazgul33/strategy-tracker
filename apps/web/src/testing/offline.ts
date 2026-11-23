/**
 * Makes every later request that matches `method` and `urlPart` fail the way an unreachable
 * server does (fetch rejects with a TypeError). Call it after `installFetchStub`; other requests
 * still reach the stub, and `restoreFetch()` puts the original fetch back.
 */
export function goOffline(method = 'GET', urlPart = ''): void {
  const wrapped = globalThis.fetch;
  const wantedMethod = method.toUpperCase();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestMethod = (init?.method ?? 'GET').toUpperCase();
    if (requestMethod === wantedMethod && String(input).includes(urlPart)) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return wrapped(input, init);
  }) as typeof fetch;
}
