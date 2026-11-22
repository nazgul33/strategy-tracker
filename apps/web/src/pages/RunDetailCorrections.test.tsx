// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CorrectionDto } from '../api.types';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunDetailPage } = await import('./RunDetail');
const { PENDING_ROW, setInputValue } = await import('../testing/pendingRow');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const RUN = {
  id: 1,
  strategyKey: 'mean-reversion',
  ticker: 'SOXL',
  name: 'Test run',
  poolCents: 100_000,
  costPpm: 3_000,
  buyGapPpm: 25_000,
  sellGapPpm: 10_000,
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
  progressView: { heldCount: 0, cashCents: 100_000, exposureCents: 0, realizedCents: 0, winRate: null },
  state: { buckets: [], cashCents: 100_000, closed: [], ages: {} },
};

const CORRECTION: CorrectionDto = {
  id: 1,
  runId: 1,
  fillId: 2,
  captureId: null,
  side: 'sell',
  ticker: 'SOXL',
  bookedShares: 44,
  bookedFilledOn: '2026-11-11',
  bookedPrice: '660300',
  bookedFee: 0,
  proposedPrice: '640700',
  proposedFee: 203,
  status: 'open',
  createdAt: '2026-11-15 00:00:00',
  stale: false,
};

let calls: FetchCalls;
let runGets = 0;
let correctionGets = 0;
let pendingGets = 0;

function stubFetch() {
  runGets = 0;
  correctionGets = 0;
  pendingGets = 0;
  calls = installFetchStub([
    { method: 'POST', url: '/api/corrections/1/apply', json: { ok: true, deltaCents: 5 } },
    {
      url: '/api/corrections',
      get json() {
        correctionGets += 1;
        return [CORRECTION];
      },
    },
    // Sub-resources before the bare run route: matching is by substring.
    { url: '/price-history', json: { start: '2026-11-04', bars: [] } },
    { url: '/orders', json: [] },
    {
      url: '/api/pending',
      get json() {
        pendingGets += 1;
        return [{ ...PENDING_ROW, runId: 1 }];
      },
    },
    {
      url: '/api/runs/1',
      get json() {
        runGets += 1;
        return RUN;
      },
    },
  ]);
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

describe('RunDetailPage pending tab corrections', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    stubFetch();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      buttonByText('Pending').click();
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('applying a correction reloads the list once and refreshes the run', async () => {
    expect(correctionGets).toBe(1);
    const runBefore = runGets;

    await act(async () => {
      buttonByText('Apply').click();
    });
    await flush();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/corrections/1/apply']);
    expect(correctionGets).toBe(2);
    expect(runGets).toBe(runBefore + 1);
  });

  it('applying a correction re-reads the pending list exactly once (refreshKey)', async () => {
    const pendingBefore = pendingGets;
    expect(pendingBefore).toBeGreaterThan(0);

    await act(async () => {
      buttonByText('Apply').click();
    });
    await flush();

    expect(pendingGets).toBe(pendingBefore + 1);
  });

  it('applying a correction keeps an edit typed in the pending table', async () => {
    const qty = () => document.querySelector('input[aria-label="Qty"]') as HTMLInputElement;
    await act(async () => setInputValue(qty(), '11'));
    expect(qty().value).toBe('11');

    await act(async () => {
      buttonByText('Apply').click();
    });
    await flush();

    expect(correctionGets).toBe(2);
    expect(qty().value).toBe('11');
  });

  it('re-clicking the Pending tab reloads the corrections list once', async () => {
    expect(correctionGets).toBe(1);

    await act(async () => {
      buttonByText('Pending').click();
    });
    await flush();

    expect(correctionGets).toBe(2);
  });
});
