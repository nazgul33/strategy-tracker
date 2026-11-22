/**
 * Holds the next request that matches `method` and `urlPart` until `release()`, then
 * answers it from whatever fetch was installed before (normally the fetchStub). Call it
 * after `installFetchStub`; `restoreFetch()` still puts the original fetch back.
 */
export function holdNext(method: string, urlPart: string): { release: () => void } {
  const inner = globalThis.fetch;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken = false;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const matches = (init?.method ?? 'GET').toUpperCase() === method && String(input).includes(urlPart);
    if (!taken && matches) {
      taken = true;
      return gate.then(() => inner(input, init));
    }
    return inner(input, init);
  }) as typeof fetch;
  return { release };
}
