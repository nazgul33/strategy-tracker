import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() (see PendingTable.test.tsx).
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 10 sh @ 12,345.00, fee 100 cents, with a screenshot and a detected snapshot.
const ROW: PendingFillDto = {
  id: 9,
  runId: 7,
  captureId: 3,
  bucketIdx: null,
  side: 'buy',
  ticker: 'AAPL',
  shares: 10,
  price: '123450000',
  fee: 100,
  filledOn: '2026-11-10',
  status: 'pending',
  createdAt: '2026-11-10T14:30:00Z',
  hasImage: true,
  costPpm: 40,
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('PendingTable comma-grouped price', () => {
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
    restoreFetch();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  async function typePriceAndConfirm(price: string) {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true } },
      { url: '/api/pending', json: [ROW] },
    ]);
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
    const input = container.querySelector('input[aria-label="Price"]') as HTMLInputElement;
    await act(async () => setInputValue(input, price));
    const confirm = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!;
    await act(async () => confirm.click());
    await flush();
    return calls;
  }

  it('a grouped price equal to the detected one confirms with no overrides and no prompt', async () => {
    const calls = await typePriceAndConfirm('12,345.00');
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(calls[0]!.body).toEqual({});
  });

  it('a grouped price that differs is refused and nothing is posted', async () => {
    const calls = await typePriceAndConfirm('12,345.50');
    expect(container.textContent).toContain('Check the values: qty and price must be positive');
    expect(calls.length).toBe(0);
  });
});
