import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { OrderDto } from '../api';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { OrderTable } = await import('./OrderTable');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const ORDERS = [
  {
    id: 1,
    runId: 7,
    tradeDate: '2026-11-12',
    kind: 'sell_loc',
    bucketIdx: 0,
    limitPrice: '1030000',
    shares: 10,
    status: 'open',
    skipReason: null,
    cancelReason: null,
  },
  {
    id: 2,
    runId: 7,
    tradeDate: '2026-11-12',
    kind: 'stop_sell',
    bucketIdx: 0,
    limitPrice: '970000',
    shares: 10,
    status: 'open',
    skipReason: null,
    cancelReason: null,
  },
] as OrderDto[];

describe('OrderTable stop_sell', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(OrderTable, { orders: ORDERS })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('labels the stop order and shows its trigger price', () => {
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('Sell · limit');
    expect(rows[1]!.textContent).toContain('Sell · stop');
    expect(rows[1]!.textContent).toContain('$97.00');
  });
});
