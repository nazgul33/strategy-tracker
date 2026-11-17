import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { RowValues } from '../../viewmodels';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and onChange
// silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingReviewDialog } = await import('./PendingReviewDialog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
  autoFeeCents: 100,
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

const VALUES: RowValues = { filledOn: '2026-11-10', side: 'buy', shares: '10', price: '12345.00', fee: '1.00' };

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('PendingReviewDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let done: RowValues[];
  let cancels: number;
  let calls: ReturnType<typeof installFetchStub>;

  const input = (label: string) => {
    const wrap = Array.from(container.querySelectorAll('label')).find(
      (l) => l.querySelector('span')?.textContent === label,
    );
    if (!wrap) throw new Error(`field ${label} not found`);
    return wrap.querySelector('input, select') as HTMLInputElement;
  };
  const button = (text: string) => {
    const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent === text);
    if (!b) throw new Error(`button ${text} not found`);
    return b as HTMLButtonElement;
  };

  async function show(row: PendingFillDto = ROW, values: RowValues = VALUES) {
    await act(async () => {
      root.render(
        d(PendingReviewDialog, {
          row,
          values,
          onCancel: () => {
            cancels += 1;
          },
          onDone: (v: RowValues) => {
            done.push(v);
          },
        }),
      );
    });
  }

  beforeEach(() => {
    done = [];
    cancels = 0;
    calls = installFetchStub([]);
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

  it('shows the screenshot and fields pre-filled with the row values', async () => {
    await show(ROW, { filledOn: '2026-11-11', side: 'sell', shares: '4', price: '99.50', fee: '0.25' });

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('/api/captures/3/image');
    expect(container.querySelector('[role=dialog]')).toBeTruthy();

    expect(input('Trade date').value).toBe('2026-11-11');
    expect(input('Side').value).toBe('sell');
    expect(input('Qty').value).toBe('4');
    expect(input('Price').value).toBe('99.50');
    expect(input('Fee').value).toBe('0.25');
    expect(container.textContent).toContain('AAPL');
  });

  it('Done reports the edited values and Cancel reports nothing', async () => {
    await show();
    await act(async () => {
      setInputValue(input('Price'), '99.00');
    });
    await act(async () => {
      button('Done').click();
    });
    expect(done).toEqual([{ ...VALUES, price: '99.00' }]);
    expect(cancels).toBe(0);

    done = [];
    await act(async () => root.unmount());
    root = createRoot(container);
    await show();
    await act(async () => {
      setInputValue(input('Price'), '77.00');
    });
    await act(async () => {
      button('Cancel').click();
    });
    expect(done).toEqual([]);
    expect(cancels).toBe(1);
  });

  it('the side can be changed and is reported on Done', async () => {
    await show();
    const select = input('Side') as unknown as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'sell');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      button('Done').click();
    });
    expect(done[0]!.side).toBe('sell');
  });

  it('Done does not book anything', async () => {
    await show();
    await act(async () => {
      setInputValue(input('Qty'), '12');
    });
    await act(async () => {
      button('Done').click();
    });
    expect(done.length).toBe(1);
    expect(calls.length).toBe(0);
  });

  it('closing the dialog from the backdrop cancels', async () => {
    await show();
    await act(async () => {
      (container.querySelector('[role=dialog]') as HTMLElement).click();
    });
    expect(cancels).toBe(1);
    expect(done).toEqual([]);
  });
});
