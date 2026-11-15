// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CorrectionDto } from './api.types';
import { installFetchStub, restoreFetch } from './testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { App } = await import('./App');
const { setToken } = await import('./api');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function runDto(id: number, name: string) {
  return {
    id,
    strategyKey: 'mean-reversion',
    ticker: 'SOXL',
    name,
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
}

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

function stubFetch() {
  installFetchStub([
    { method: 'POST', url: '/api/corrections/1/apply', status: 500, json: { error: 'apply-exploded' } },
    { url: '/api/corrections', json: [CORRECTION] },
    // Sub-resources before the bare run routes: matching is by substring.
    { url: '/price-history', json: { start: '2026-11-04', bars: [] } },
    { url: '/orders', json: [] },
    { url: '/fills', json: [] },
    { url: '/api/runs/1', json: runDto(1, 'First run') },
    { url: '/api/runs/2', json: runDto(2, 'Second run') },
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

describe('App run route', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    stubFetch();
    setToken('test-token');
    window.location.hash = '#/runs/1';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(App)));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
    setToken(null);
    window.location.hash = '';
  });

  it('navigating from run 1 to run 2 remounts the page: no stale Corrections error or tab', async () => {
    expect(document.body.textContent).toContain('First run');

    await act(async () => {
      buttonByText('Pending').click();
    });
    await flush();
    await act(async () => {
      buttonByText('Apply').click();
    });
    await flush();
    expect(document.body.textContent).toContain('apply-exploded');

    await act(async () => {
      window.location.hash = '#/runs/2';
      window.dispatchEvent(new window.Event('hashchange'));
    });
    await flush();

    expect(document.body.textContent).toContain('Second run');
    expect(document.body.textContent).not.toContain('First run');
    expect(document.body.textContent).not.toContain('apply-exploded');
    // A fresh page opens on the Orders tab, not the Pending tab left on run 1.
    expect(document.body.textContent).not.toContain('Corrections');
  });
});
