import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { setInputValue } from '../../testing/dom';
import { PENDING_ROW as ROW } from '../../testing/pendingRow';

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

const SELL_NINE: PendingFillDto = {
  ...ROW,
  id: 9,
  runId: 7,
  side: 'sell',
  detected: { ...ROW.detected!, side: 'sell' },
  heldBuckets: [
    { index: 0, shares: 10 },
    { index: 3, shares: 4 },
  ],
};
const SELL_TEN: PendingFillDto = {
  ...ROW,
  id: 10,
  runId: 8,
  side: 'sell',
  detected: { ...ROW.detected!, side: 'sell' },
  heldBuckets: [{ index: 1, shares: 5 }],
};

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function choose(el: Element | null, value: string) {
  if (!(el instanceof HTMLSelectElement)) throw new Error('not a select');
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PendingTable bucket selector', () => {
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

  async function renderRows(rows: PendingFillDto[]): Promise<FetchCalls> {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true } },
      { url: '/api/pending', json: rows },
    ]);
    await act(async () => {
      root.render(d(PendingTable, {}));
    });
    await flush();
    return calls;
  }

  const rowOf = (id: number) => {
    const tr = Array.from(container.querySelectorAll('tbody tr'))[id === 9 ? 0 : 1];
    if (!tr) throw new Error(`row ${id} not found`);
    return tr;
  };
  const bucketSelect = (id: number) => rowOf(id).querySelector('select[aria-label="Bucket"]');
  const optionTexts = (el: Element | null) => Array.from((el as HTMLSelectElement).options).map((o) => o.textContent);
  const sideSelect = (id: number) => rowOf(id).querySelector('select[aria-label="Side"]');
  const promptOpen = () => container.querySelector('[role=dialog]') !== null;

  async function pressButton(text: string) {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button ${text} not found`);
    await act(async () => (btn as HTMLButtonElement).click());
    await flush();
  }

  async function confirmRow(id: number) {
    const btn = Array.from(rowOf(id).querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
    if (!btn) throw new Error('confirm button not found');
    await act(async () => (btn as HTMLButtonElement).click());
    await flush();
  }

  it("each sell row offers its own run's held buckets", async () => {
    await renderRows([SELL_NINE, SELL_TEN]);
    expect(optionTexts(bucketSelect(9))).toEqual(['Automatic', 'Bucket 0 · 10 sh', 'Bucket 3 · 4 sh']);
    expect(optionTexts(bucketSelect(10))).toEqual(['Automatic', 'Bucket 1 · 5 sh']);
  });

  it('the header has a Bucket column and as many headers as cells', async () => {
    await renderRows([SELL_NINE]);
    const headers = Array.from(container.querySelectorAll('thead th'));
    expect(headers.length).toBe(10);
    expect(headers[6]!.textContent).toBe('Bucket');
    expect(container.querySelectorAll('tbody tr td').length).toBe(10);
  });

  it('an untouched confirm posts no overrides', async () => {
    const calls = await renderRows([SELL_NINE, SELL_TEN]);
    await confirmRow(9);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({});
  });

  it('a chosen bucket is posted as an override without opening the screenshot prompt', async () => {
    const calls = await renderRows([SELL_NINE, SELL_TEN]);
    await choose(bucketSelect(9), '3');
    await confirmRow(9);
    expect(promptOpen()).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ overrides: { bucketIdx: 3 } });
  });

  it("one row's bucket choice does not leak into another row", async () => {
    const calls = await renderRows([SELL_NINE, SELL_TEN]);
    await choose(bucketSelect(9), '3');
    await confirmRow(10);
    expect(calls[0]!.body).toEqual({});
  });

  it('a bucket chosen and then the side switched to buy posts no bucketIdx', async () => {
    const calls = await renderRows([SELL_NINE]);
    await choose(bucketSelect(9), '3');
    await choose(sideSelect(9), 'buy');
    expect(bucketSelect(9)).toBeNull();
    await confirmRow(9);
    await pressButton('Keep for review');
    expect(calls.length).toBe(1);
    expect((calls[0]!.body as { overrides: unknown }).overrides).toEqual({ side: 'buy' });
  });

  it('a chosen bucket survives the default-fee popup and the keep prompt', async () => {
    const calls = await renderRows([SELL_NINE]);
    await choose(bucketSelect(9), '3');
    await act(async () => setInputValue(rowOf(9).querySelector('input[aria-label="Fee"]') as HTMLInputElement, ''));
    await confirmRow(9);
    await pressButton('Use auto fee');
    await pressButton('Keep for review');
    expect(calls.length).toBe(1);
    expect((calls[0]!.body as { overrides: { bucketIdx?: number } }).overrides.bucketIdx).toBe(3);
  });

  it('a buy row shows no bucket selector', async () => {
    await renderRows([ROW]);
    expect(bucketSelect(9)).toBeNull();
  });

  it('a row whose side vision missed shows no bucket selector', async () => {
    await renderRows([{ ...SELL_NINE, detected: { ...SELL_NINE.detected!, side: null } }]);
    expect(bucketSelect(9)).toBeNull();
  });
});
