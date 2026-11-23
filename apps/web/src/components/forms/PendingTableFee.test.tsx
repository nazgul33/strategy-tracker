import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { restoreFetch } from '../../testing/fetchStub';
import { setInputValue } from '../../testing/dom';
import { PENDING_ROW as ROW } from '../../testing/pendingRow';
import { pendingTableHelpers, stubPendingFetch as stubFetch } from '../../testing/pendingTable';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const { createRoot } = await import('react-dom/client');
const { act, createElement } = await import('react');
const { PendingTable } = await import('./PendingTable');
const { lookup } = await import('../../i18n/catalog');

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

  const { renderTable, clickConfirm, pressButton, promptOpen, confirmKeeping, control, renderWithConfirmCalls } = pendingTableHelpers({
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

  describe('a fee vision did not read', () => {
    // 10 sh @ 12,345.00 at 40 ppm: 4.94; 12 sh: 5.93.
    const feeless: PendingFillDto = { ...ROW, fee: null, detected: { ...ROW.detected!, fee: null } };
    const feeInput = () => control<HTMLInputElement>(5, 'input');
    const autoMarker = () => container.querySelector('[data-auto-fee]');
    const type = (idx: number, value: string) => act(async () => setInputValue(control<HTMLInputElement>(idx, 'input'), value));

    it('prefills the derived fee, marks it auto, and an untouched confirm still posts {}', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      expect(feeInput().value).toBe('4.94');
      expect(autoMarker()!.textContent).toBe('auto');
      await clickConfirm();
      expect(calls[0]!.body).toEqual({});
    });

    it('clearing the field posts nothing, since the server derives that fee anyway', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      await type(5, '');
      await clickConfirm();
      await pressButton('Use auto fee');
      expect(calls[0]!.body).toEqual({});
    });

    it('a qty edit re-derives the fee on screen, and the confirm sends the qty and no fee', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      await type(3, '12');
      expect(feeInput().value).toBe('5.93');
      expect(autoMarker()).toBeTruthy();
      await confirmKeeping();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ shares: 12 });
    });

    it('a price edit re-derives it too', async () => {
      await renderWithConfirmCalls(feeless);
      await type(4, '24690.00');
      expect(feeInput().value).toBe('9.88');
    });

    it('a typed fee drops the auto marker, is sent, and stops following qty', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      await type(5, '2.00');
      expect(autoMarker()).toBeNull();
      await type(3, '12');
      expect(feeInput().value).toBe('2.00');
      await confirmKeeping();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ shares: 12, feeCents: 200 });
    });

    // The reviewer's second case: typing the number the derivation gave earlier must not
    // be mistaken for "the derived fee" once the quantity has moved on.
    it('a typed fee equal to the earlier derived value is still sent after a qty edit', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      await type(3, '12');
      await type(5, '4.94');
      expect(autoMarker()).toBeNull();
      await confirmKeeping();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ shares: 12, feeCents: 494 });
    });

    it('the fee on screen is the one a confirm books: no fee is sent while the field follows the derivation', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      await type(3, '12');
      await type(4, '24690.00');
      expect(feeInput().value).toBe('11.85');
      await confirmKeeping();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ shares: 12, price: '24690.00' });
    });
  });

  describe('a fee vision read', () => {
    it('stays as read when the qty changes, and is not marked auto', async () => {
      await renderWithConfirmCalls(ROW);
      await act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), '12'));
      expect(control<HTMLInputElement>(5, 'input').value).toBe('1.00');
      expect(container.querySelector('[data-auto-fee]')).toBeNull();
    });
  });

  describe('a legacy row (no detected snapshot)', () => {
    const legacy: PendingFillDto = { ...ROW, detected: null, fee: null };

    it('prefills from the row itself and an untouched confirm posts {}', async () => {
      const calls = await renderWithConfirmCalls(legacy);
      expect(control<HTMLInputElement>(3, 'input').value).toBe('10');
      expect(control<HTMLInputElement>(5, 'input').value).toBe('4.94');
      await clickConfirm();
      expect(calls[0]!.body).toEqual({});
    });

    it('an edited qty posts overrides.shares', async () => {
      const calls = await renderWithConfirmCalls(legacy);
      await act(async () => {
        setInputValue(control<HTMLInputElement>(3, 'input'), '11');
      });
      await clickConfirm();
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ shares: 11 });
    });
  });

  // Ingest stores the capture date in `filledOn` when vision read none (the row is never
  // blank), and `detected.filledOn` is null: the only trace that the operator has not seen the date.
  describe('a trade date vision missed', () => {
    const missedDate: PendingFillDto = { ...ROW, filledOn: '2026-11-09', detected: { ...ROW.detected!, filledOn: null } };
    const dateInput = () => control<HTMLInputElement>(0, 'input[type=date]');

    it('renders an empty date input with the warning border and the needs-input hint', async () => {
      stubFetch('conflict', missedDate);
      await renderTable(root);
      expect(dateInput().value).toBe('');
      expect(dateInput().className).toContain('border-warning');
      expect(container.textContent).toContain(lookup('en', 'pendingNeedsOverride'));
    });

    it('blocks the confirm: nothing is posted and the operator is told to fill it in', async () => {
      const calls = await renderWithConfirmCalls(missedDate);
      await clickConfirm();
      expect(calls.length).toBe(0);
      expect(promptOpen()).toBe(false);
      expect(container.querySelector('p.text-destructive')!.textContent).toBe(lookup('en', 'pendingNeedsOverride'));
    });

    it('once filled in the warning clears and the date is posted as an override', async () => {
      const calls = await renderWithConfirmCalls(missedDate);
      await act(async () => setInputValue(dateInput(), '2026-11-09'));
      expect(dateInput().className).not.toContain('border-warning');
      await confirmKeeping();
      expect(calls.length).toBe(1);
      expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ filledOn: '2026-11-09' });
    });

    it('a date vision read has no warning', async () => {
      stubFetch('conflict');
      await renderTable(root);
      expect(dateInput().value).toBe('2026-11-10');
      expect(dateInput().className).not.toContain('border-warning');
    });
  });
});
