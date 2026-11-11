// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SimDayDto, SimRunDto } from '../api';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SimReplay } = await import('./SimReplay');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const run: SimRunDto = {
  id: 3,
  ticker: 'QQQ',
  fromDate: '2026-01-02',
  toDate: '2026-01-03',
  poolCents: 10_000_00,
  costPpm: 200,
  buyGapPpm: 5000,
  sellGapPpm: 0,
  paramsJson: '{"bucketCount":2,"maxAgeDays":5}',
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

describe('SimReplay stored-run gaps', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders stored gaps in the run meta: 5000 ppm as 0.5%, 0 as the default marker', async () => {
    await act(async () => {
      root.render(d(SimReplay, { run, days: [day] }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Buy gap');
    expect(text).toContain('0.5%');
    expect(text).toContain('Sell gap');
    expect(text).toContain('default');
  });
});
