// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { SimDayDto, SimRunDto } from '../api';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SimRunPage } = await import('./SimRun');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const run: SimRunDto = {
  id: 3,
  ticker: 'QQQ',
  fromDate: '2026-01-02',
  toDate: '2026-01-03',
  poolCents: 10_000_00,
  costPpm: 200,
  buyGapPpm: 5000,
  sellGapPpm: 0,
  cutLossPpm: 35_000,
  paramsJson: '{"bucketCount":2,"maxAgeDays":5}',
  draft: true,
  createdAt: '2026-01-04 09:00:00',
};

const day: SimDayDto = {
  id: 1,
  simRunId: 3,
  tradeDate: '2026-01-02',
  planJson: { orders: [], skips: [], notices: [] },
  stateJson: {
    buckets: [{ index: 0, state: 'empty', shares: 0, buyPrice: null, buyFeeCents: 0, filledOn: null }],
    cashCents: 10_000_00,
    closed: [],
    ages: {},
  },
  eventsJson: [],
};

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('SimRunPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let detailFetches = 0;

  beforeEach(() => {
    detailFetches = 0;
    installFetchStub([
      { method: 'PUT', url: '/api/sim/3', json: { id: 3, dayCount: 1 } },
      { url: '/api/sim/3', json: { run, days: [day] } },
    ]);
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/sim/3') && (init?.method ?? 'GET') === 'GET') detailFetches += 1;
      return stubbed(input, init);
    }) as typeof fetch;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('mounts the config panel above the replay, prefilled from the stored run and its params', async () => {
    await act(async () => {
      root.render(d(SimRunPage, { id: 3 }));
    });
    await flush();

    const panel = document.querySelector('[data-testid="simConfigTicker"]');
    const replay = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Previous day'));
    expect(panel!.textContent).toBe('QQQ');
    expect(replay).toBeDefined();
    // Panel precedes the replay in document order.
    expect(panel!.compareDocumentPosition(replay!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((document.querySelector('[data-testid="bucketCountInput"]') as HTMLInputElement).value).toBe('2');
    expect((document.querySelector('[data-testid="maxAgeInput"]') as HTMLInputElement).value).toBe('5');
    expect((document.querySelector('[data-testid="cutLossInput"]') as HTMLInputElement).value).toBe('3.5');
    expect(detailFetches).toBe(1);
  });

  it('Apply refetches the run so the replay shows the recomputed days', async () => {
    await act(async () => {
      root.render(d(SimRunPage, { id: 3 }));
    });
    await flush();
    await act(async () => {
      (document.querySelector('[data-testid="simApplyBtn"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(detailFetches).toBe(2);
  });
});
