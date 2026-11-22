// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RunDetailDto } from '../api.types';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunDetailPage } = await import('./RunDetail');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const RUN: RunDetailDto = {
  id: 1,
  strategyKey: 'mean-reversion',
  ticker: 'QQQ',
  name: 'Test run',
  poolCents: 100_000,
  costPpm: 3_000,
  buyGapPpm: 25_000,
  sellGapPpm: 10_000,
  cutLossPpm: 35_000,
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
  progressView: { heldCount: 0, cashCents: 100_000, exposureCents: 0, realizedCents: 0, winRate: null },
  state: { buckets: [], cashCents: 100_000, closed: [], ages: {} },
};

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('RunDetailPage header cost', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    // Sub-resource GETs come before the bare run route: the stub matches by substring.
    installFetchStub([
      { url: '/price-history', json: { start: '2026-11-04', bars: [] } },
      { url: '/orders', json: [] },
      { url: '/fills', json: [] },
      { url: '/notifications', json: [] },
      { url: '/closed', json: [] },
      { url: '/api/runs/1', json: RUN },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('shows the run cost as a percent in the header', () => {
    expect(container.textContent).toContain('0.300%');
  });
});
