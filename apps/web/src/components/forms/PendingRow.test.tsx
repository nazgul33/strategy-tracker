import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import type { RowValues } from '../../pendingvalues';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() (see PendingTable.test.tsx).
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');
const { PendingRow } = await import('./PendingRow');
const { LangProvider } = await import('../../i18n');
const { lookup } = await import('../../i18n/catalog');

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

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

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

  it('a grouped price that differs is posted without its commas', async () => {
    const calls = await typePriceAndConfirm('12,345.50');
    const discard = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discard')!;
    await act(async () => discard.click());
    await flush();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ overrides: { price: '12345.50' } });
  });

  it('a malformed grouping is refused and nothing is posted', async () => {
    const calls = await typePriceAndConfirm('12,34.00');
    expect(container.textContent).toContain('Check the values: qty and price must be positive');
    expect(calls.length).toBe(0);
  });
});

describe('PendingTable header', () => {
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

  it('names the thumbnail column for screen readers', async () => {
    installFetchStub([{ url: '/api/pending', json: [ROW] }]);
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
    const th = Array.from(container.querySelectorAll('thead th'))[7]!;
    const label = th.querySelector('.sr-only')!;
    expect(label.textContent).toBe('Screenshot');
    expect(lookup('ko', 'pendingColScreenshot')).toBe('스크린샷');
  });

  // A class-name pin: the test DOM has no layout, so the pinning cannot be measured.
  it('keeps the actions column pinned while the table scrolls', async () => {
    installFetchStub([{ url: '/api/pending', json: [ROW] }]);
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
    const th = Array.from(container.querySelectorAll('thead th')).at(-1)!;
    const td = Array.from(container.querySelectorAll('tbody tr:first-child td')).at(-1)!;
    for (const cell of [th, td]) {
      for (const cls of ['sticky', 'right-0', 'bg-card', 'pl-3']) expect(cell.className).toContain(cls);
    }
  });
});

describe('PendingRow blank fee', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const FEELESS: PendingFillDto = { ...ROW, fee: null, detected: { ...ROW.detected!, fee: null } };
  const VALUES: RowValues = {
    filledOn: '2026-11-10',
    side: 'buy',
    shares: '10',
    price: '12345.00',
    fee: '',
    feeTouched: false,
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function feeInput(row: PendingFillDto, values: Partial<RowValues>) {
    await act(async () => {
      root.render(
        d(
          LangProvider,
          null,
          d(
            'table',
            null,
            d(
              'tbody',
              null,
              d(PendingRow, {
                row,
                values: { ...VALUES, ...values },
                onChange: () => {},
                onOpenSideBySide: () => {},
                onConfirm: () => {},
                bucket: '',
                onBucketChange: () => {},
                bucketRefused: false,
                onReject: () => {},
                busy: false,
              }),
            ),
          ),
        ),
      );
    });
    return container.querySelector('input[aria-label="Fee"]') as HTMLInputElement;
  }

  // 10 sh @ 12,345.00 at 40 ppm derives $4.94
  it('a cleared fee on a feeless row shows the fee the server will book', async () => {
    expect((await feeInput(FEELESS, {})).placeholder).toBe('auto $4.94');
  });

  it('a cleared fee vision did read shows the recomputed fee too', async () => {
    expect((await feeInput(ROW, {})).placeholder).toBe('auto $4.94');
  });

  it('no auto marker while the placeholder shows', async () => {
    const input = await feeInput(FEELESS, {});
    expect(input.placeholder).toBe('auto $4.94');
    expect(container.querySelector('[data-auto-fee]')).toBeNull();
  });

  it('a derived fee marker is hidden from assistive tech; the fee hint carries the meaning', async () => {
    const input = await feeInput(FEELESS, { fee: '4.94' });
    const marker = container.querySelector('[data-auto-fee]')!;
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector(`#${input.getAttribute('aria-describedby')}`)).toBeTruthy();
  });

  it('a comma-grouped price still derives the placeholder', async () => {
    expect((await feeInput(FEELESS, { price: '12,345.00' })).placeholder).toBe('auto $4.94');
  });

  it('no placeholder while the field holds a fee', async () => {
    expect((await feeInput(FEELESS, { fee: '4.94' })).getAttribute('placeholder')).toBeNull();
  });

  it('no placeholder when qty or price do not parse', async () => {
    expect((await feeInput(FEELESS, { shares: 'x' })).getAttribute('placeholder')).toBeNull();
  });

  // A class-name pin: the test DOM has no layout, so clipping cannot be measured.
  it('the fee field is wide enough for the placeholder', async () => {
    const input = await feeInput(FEELESS, {});
    expect(input.classList.contains('w-28')).toBe(true);
    expect(input.classList.contains('w-20')).toBe(false);
  });

  it('ko copy', () => {
    expect(lookup('ko', 'pendingFeeAutoPlaceholder', { fee: '4.94' })).toBe('자동 $4.94');
  });
});
