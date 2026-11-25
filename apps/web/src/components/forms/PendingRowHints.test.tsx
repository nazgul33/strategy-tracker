import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see PendingTable.test.tsx.
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
  heldBuckets: [],
  mergeableBuckets: [],
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

describe('edit hints', () => {
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

  async function render(row: PendingFillDto) {
    installFetchStub([{ url: '/api/pending', json: [row] }]);
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
  }

  const field = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const type = (label: string, value: string) => act(async () => setInputValue(field(label), value));

  it('an untouched row has no edit hint', async () => {
    await render(ROW);
    expect(container.querySelector('[data-edit]')).toBeNull();
  });

  it('a changed field gets the solid hint and its title', async () => {
    await render(ROW);
    await type('Qty', '11');
    expect(field('Qty').getAttribute('data-edit')).toBe('changed');
    expect(field('Qty').title).toBe('Changed from what vision read');
    for (const cls of ['ring-1', 'ring-inset', 'ring-primary']) expect(field('Qty').className).toContain(cls);
    expect(container.querySelectorAll('[data-edit]').length).toBe(1);
  });

  it('a cleared fee gets the dashed hint and says the auto fee is booked', async () => {
    await render(ROW);
    await type('Fee', '');
    expect(field('Fee').getAttribute('data-edit')).toBe('erased');
    expect(field('Fee').title).toBe('Cleared — the auto fee will be booked');
    expect(field('Fee').classList.contains('border-dashed')).toBe(true);
    expect(field('Fee').classList.contains('border-warning')).toBe(true);
  });

  it('a cleared price gets the dashed hint and says a value is needed', async () => {
    await render(ROW);
    await type('Price', '');
    expect(field('Price').getAttribute('data-edit')).toBe('erased');
    expect(field('Price').title).toBe('Cleared — enter a value before confirming');
  });

  it('a field vision missed keeps only the standing border until it is filled in', async () => {
    await render({ ...ROW, filledOn: '', detected: { ...ROW.detected!, filledOn: null } });
    const date = container.querySelector('input[type=date]') as HTMLInputElement;
    expect(date.hasAttribute('data-edit')).toBe(false);
    expect(date.classList.contains('border-warning')).toBe(true);
    expect(date.classList.contains('border-dashed')).toBe(false);

    await act(async () => setInputValue(date, '2026-11-11'));
    expect(date.getAttribute('data-edit')).toBe('filled');
    expect(date.title).toBe('Filled in — vision read nothing here');
    expect(date.classList.contains('border-warning')).toBe(false);
  });

  it('a second missed field gets its warning border too', async () => {
    await render({ ...ROW, side: '', price: '', detected: { ...ROW.detected!, side: null, price: null } });
    const side = container.querySelector('select[aria-label="Side"]') as HTMLSelectElement;
    expect(side.classList.contains('border-warning')).toBe(true);
    expect(field('Price').classList.contains('border-warning')).toBe(true);
  });
});
