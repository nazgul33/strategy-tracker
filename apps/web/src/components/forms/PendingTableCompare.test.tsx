import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { restoreFetch } from '../../testing/fetchStub';
import { setInputValue } from '../../testing/dom';
import { PENDING_ROW as ROW } from '../../testing/pendingRow';
import { pendingTableHelpers } from '../../testing/pendingTable';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const { createRoot } = await import('react-dom/client');
const { act, createElement } = await import('react');
const { PendingTable } = await import('./PendingTable');

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('PendingTable', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const { clickConfirm, pressButton, confirmKeeping, control, renderWithConfirmCalls } = pendingTableHelpers({
    act,
    createElement,
    PendingTable,
    container: () => container,
    root: () => root,
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

  describe('side-by-side dialog', () => {
    const click = async (text: string) => {
      const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
      if (!btn) throw new Error(`button ${text} not found`);
      await act(async () => (btn as HTMLButtonElement).click());
    };
    const dialogPrice = () =>
      container.querySelector('[role=dialog] input[inputmode=decimal]') as HTMLInputElement;

    it('Compare opens the dialog seeded from the row and Done writes the edit back without booking', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      expect(container.querySelector('[role=dialog]')).toBeNull();
      await click('Compare');
      expect(dialogPrice().value).toBe('12345.00');

      await act(async () => setInputValue(dialogPrice(), '12345.50'));
      await click('Done');

      expect(container.querySelector('[role=dialog]')).toBeNull();
      expect(control<HTMLInputElement>(4, 'input').value).toBe('12345.50');
      expect(calls.length).toBe(0);

      await confirmKeeping();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ price: '12345.50' });
    });

    it('a derived fee carries through Done and keeps following qty on the row', async () => {
      const feeless: PendingFillDto = { ...ROW, fee: null, detected: { ...ROW.detected!, fee: null } };
      const calls = await renderWithConfirmCalls(feeless);
      await click('Compare');
      const qty = container.querySelector('[role=dialog] input[inputmode=numeric]') as HTMLInputElement;
      await act(async () => setInputValue(qty, '12'));
      await click('Done');
      expect(control<HTMLInputElement>(5, 'input').value).toBe('5.93');
      expect(container.querySelector('[data-auto-fee]')).toBeTruthy();

      await act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), '20'));
      expect(control<HTMLInputElement>(5, 'input').value).toBe('9.88');
      await confirmKeeping();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ shares: 20 });
    });

    it('Cancel leaves the row untouched', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await click('Compare');
      await act(async () => setInputValue(dialogPrice(), '1.00'));
      await click('Cancel');

      expect(container.querySelector('[role=dialog]')).toBeNull();
      expect(control<HTMLInputElement>(4, 'input').value).toBe('12345.00');
      expect(calls.length).toBe(0);
    });

    it('reopening shows the values the row now holds', async () => {
      await renderWithConfirmCalls(ROW);
      await act(async () => setInputValue(control<HTMLInputElement>(4, 'input'), '5.00'));
      await click('Compare');
      expect(dialogPrice().value).toBe('5.00');
    });
  });

  it('confirm posts the edited values as overrides', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(3, 'input'), '11');
    });
    await confirmKeeping();
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/confirm', body: { overrides: { shares: 11 } } });
    expect(Object.keys((calls[0]!.body as { overrides: object }).overrides)).toEqual(['shares']);
  });

  it('editing the date, price and fee posts only those fields; side stays omitted', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(0, 'input'), '2026-11-12');
      setInputValue(control<HTMLInputElement>(4, 'input'), '12345.50');
      setInputValue(control<HTMLInputElement>(5, 'input'), '0.75');
    });
    await confirmKeeping();
    expect((calls[0]!.body as { overrides: object }).overrides).toEqual({
      filledOn: '2026-11-12',
      price: '12345.50',
      feeCents: 75,
    });
  });

  it('changing the side posts side', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    const select = control<HTMLSelectElement>(2, 'select');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'sell');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await confirmKeeping();
    expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ side: 'sell' });
  });

  it('confirm on an untouched row posts no overrides', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await clickConfirm();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({});
  });

  it('clearing a fee vision read posts feeCents null (recompute)', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(5, 'input'), '');
    });
    await clickConfirm();
    await pressButton('Use auto fee');
    await pressButton('Keep for review');
    expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ feeCents: null });
  });

  it('a price with sub-cent precision prefills without loss and an untouched confirm posts {}', async () => {
    const row = { ...ROW, price: '1784050', detected: { ...ROW.detected!, price: '1784050' } };
    const calls = await renderWithConfirmCalls(row);
    expect(control<HTMLInputElement>(4, 'input').value).toBe('178.405');
    await clickConfirm();
    expect(calls[0]!.body).toEqual({});
  });

  it('an invalid edited value blocks the confirm and shows the validation message', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(3, 'input'), '0');
    });
    await clickConfirm();
    expect(calls.length).toBe(0);
    expect(container.textContent).toContain('Check the values');
  });
});
