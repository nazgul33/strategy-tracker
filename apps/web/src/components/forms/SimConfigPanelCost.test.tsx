// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { SimRunDto } from '../../api';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SimConfigPanel } = await import('./SimConfigPanel');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const DRAFT: SimRunDto = {
  id: 3,
  ticker: 'QQQ',
  fromDate: '2026-01-02',
  toDate: '2026-06-30',
  poolCents: 10_000_000,
  costPpm: 700,
  buyGapPpm: 5000,
  sellGapPpm: 20_000,
  cutLossPpm: 35_000,
  paramsJson: '{"bucketCount":8,"maxAgeDays":30}',
  draft: true,
  createdAt: '2026-06-30 09:00:00',
};
const PARAMS = { bucketCount: 8, maxAgeDays: 30 };

describe('SimConfigPanel cost note', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const render = async (run: SimRunDto = DRAFT) => {
    await act(async () => {
      root.render(d(SimConfigPanel, { run, params: PARAMS, onApplied: () => {} }));
    });
  };

  beforeEach(() => {
    window.location.hash = '#/sim/3';
    installFetchStub([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('a draft panel has no cost note slot', async () => {
    await render();
    expect(document.querySelector('[data-testid="costDefaultFailed"]')).toBeNull();
  });
});
