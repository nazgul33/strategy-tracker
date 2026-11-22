// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RunDto } from '../api.types';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunsListPage } = await import('./RunsList');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

// The list filters to `active` by default, so the fixture must be active to be listed.
const RUN: RunDto = {
  id: 1,
  strategyKey: 'mean-reversion',
  ticker: 'QQQ',
  name: 'Test run',
  poolCents: 100_000,
  costPpm: 700,
  buyGapPpm: 25_000,
  sellGapPpm: 10_000,
  cutLossPpm: 35_000,
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
};

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('RunsListPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    installFetchStub([{ url: '/api/runs', json: [RUN] }]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunsListPage)));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it("shows each run's cost as a percent", () => {
    expect(container.textContent).toContain('Test run');
    expect(container.textContent).toContain('0.070%');
  });
});
