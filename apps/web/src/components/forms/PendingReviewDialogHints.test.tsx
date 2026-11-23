import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import type { RowValues } from '../../pendingvalues';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingReviewDialog } = await import('./PendingReviewDialog');
const { lookup } = await import('../../i18n/catalog');
const { autoFeeUsd } = await import('../../autofee');

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
  costPpm: 40,
  heldBuckets: [],
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

const VALUES: RowValues = { filledOn: '2026-11-10', side: 'buy', shares: '10', price: '12345.00', fee: '1.00', feeTouched: false };

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('PendingReviewDialog hints, as on the row', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const input = (label: string) => {
    const wrap = Array.from(container.querySelectorAll('label')).find(
      (l) => l.querySelector('span')?.textContent === label,
    );
    if (!wrap) throw new Error(`field ${label} not found`);
    return wrap.querySelector('input, select') as HTMLInputElement;
  };
  const selectNamed = (label: string) => {
    const el: Element = input(label);
    if (!(el instanceof window.HTMLSelectElement)) throw new Error(`field ${label} is not a select`);
    return el;
  };

  async function show(row: PendingFillDto = ROW, values: RowValues = VALUES) {
    await act(async () => {
      root.render(d(PendingReviewDialog, { row, values, onCancel: () => {}, onDone: () => {} }));
    });
  }

  beforeEach(() => {
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

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  const dialogText = () => container.querySelector('[role=dialog]')!.textContent ?? '';

  it('a changed field shows the same hint as the row', async () => {
    await show();
    expect(container.querySelector('[data-edit]')).toBeNull();
    await act(async () => {
      setInputValue(input('Qty'), '11');
    });
    expect(input('Qty').getAttribute('data-edit')).toBe('changed');
    expect(input('Qty').className).toContain('ring-primary');
    expect(dialogText()).toContain('Changed from what vision read');
  });

  it('a cleared fee shows the auto-fee placeholder and the erased hint', async () => {
    await show();
    await act(async () => {
      setInputValue(input('Fee'), '');
    });
    expect(input('Fee').getAttribute('data-edit')).toBe('erased');
    expect(input('Fee').className).toContain('border-dashed');
    expect(input('Fee').placeholder).toBe(
      lookup('en', 'pendingFeeAutoPlaceholder', { fee: autoFeeUsd('10', '12345.00', 40) }),
    );
    expect(input('Fee').placeholder).toBe('auto $4.94');
    expect(dialogText()).toContain('Cleared — the auto fee will be booked');
  });

  it('a fee that holds a value has no placeholder', async () => {
    await show();
    expect(input('Fee').hasAttribute('placeholder')).toBe(false);
  });

  it('a filled-in missed field is called filled', async () => {
    await show({ ...ROW, side: '', detected: { ...ROW.detected!, side: null } }, { ...VALUES, side: '' });
    expect(input('Side').hasAttribute('data-edit')).toBe(false);
    await act(async () => {
      const select = selectNamed('Side');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'buy');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input('Side').getAttribute('data-edit')).toBe('filled');
    expect(dialogText()).toContain('Filled in — vision read nothing here');
  });

  const description = (label: string) =>
    (input(label).getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent);
  const nameOf = (label: string) => input(label).closest('label')!.textContent;

  it('a hint is the field description and never part of its name', async () => {
    await show();
    expect(input('Qty').hasAttribute('aria-describedby')).toBe(false);
    await act(async () => {
      setInputValue(input('Qty'), '11');
    });
    expect(nameOf('Qty')).toBe('Qty');
    expect(description('Qty')).toEqual(['Changed from what vision read']);
    await act(async () => {
      setInputValue(input('Qty'), '');
    });
    expect(nameOf('Qty')).toBe('Qty');
    expect(description('Qty')).toEqual([lookup('en', 'pendingFieldErased')]);
  });

  it('a hint that appears while typing leaves the field focused', async () => {
    await show();
    const qty = input('Qty');
    qty.focus();
    await act(async () => {
      setInputValue(qty, '11');
    });
    expect(input('Qty')).toBe(qty);
    expect(document.activeElement).toBe(qty);
  });

  it('the derived fee carries its hint but no edit marker', async () => {
    await show({ ...ROW, fee: null, detected: { ...ROW.detected!, fee: null } }, { ...VALUES, fee: '4.94' });
    expect(input('Fee').hasAttribute('data-edit')).toBe(false);
    expect(dialogText()).toContain(lookup('en', 'pendingFeeAutoHint'));
  });

  describe('a field vision missed', () => {
    const missedPrice: PendingFillDto = { ...ROW, price: '', detected: { ...ROW.detected!, price: null } };
    const missedDate: PendingFillDto = { ...ROW, filledOn: '2026-11-09', detected: { ...ROW.detected!, filledOn: null } };
    const warned = () =>
      Array.from(container.querySelectorAll('[role=dialog] input, [role=dialog] select'))
        .filter((el) => el.className.split(' ').includes('border-warning'))
        .map((el) => el.closest('label')!.querySelector('span')!.textContent);

    it('carries the warning border until it is filled in, like the row', async () => {
      await show(missedPrice, { ...VALUES, price: '' });
      expect(warned()).toEqual(['Price']);
      expect(input('Price').className).toContain('w-full');
      expect(input('Price').hasAttribute('data-edit')).toBe(false);
      await act(async () => {
        setInputValue(input('Price'), '12.50');
      });
      expect(warned()).toEqual([]);
      expect(input('Price').getAttribute('data-edit')).toBe('filled');
    });

    it('gets the solid warning back, not the dashed erased look, when emptied again', async () => {
      await show(missedPrice, { ...VALUES, price: '' });
      await act(async () => {
        setInputValue(input('Price'), '12.50');
      });
      await act(async () => {
        setInputValue(input('Price'), '');
      });
      expect(warned()).toEqual(['Price']);
      expect(input('Price').className).not.toContain('border-dashed');
      expect(input('Price').hasAttribute('data-edit')).toBe(false);
    });

    it('marks every missed field at once: date and side', async () => {
      await show({ ...missedDate, side: '', detected: { ...missedDate.detected!, side: null } }, { ...VALUES, filledOn: '', side: '' });
      expect(warned()).toEqual(['Trade date', 'Side']);
    });

    it('a complete row and a row missing only its ticker mark nothing', async () => {
      await show();
      expect(warned()).toEqual([]);
      await show({ ...ROW, ticker: '' });
      expect(warned()).toEqual([]);
      expect(container.querySelector('[role=dialog]')!.getAttribute('aria-label')).toContain('?');
    });
  });
});
