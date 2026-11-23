import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { elementByTestId, inputByTestId } from '../../testing/dom';
import { errorText, fillDialogHelpers, fillDto, installFillDialogStub } from '../../testing/fillDialog';
import type { FillDialogCall } from '../../testing/fillDialog';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillDialog } = await import('./FillDialog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let stub: FetchCalls;
let calls: FillDialogCall[] = [];

describe('FillDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let saved = 0;
  let closed = 0;

  async function render(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(d(FillDialog, { runId: 7, onClose: () => (closed += 1), onSaved: () => (saved += 1), ...props }));
    });
  }

  const { type, clickButton, submitForm } = fillDialogHelpers({
    act,
    stub: () => stub,
    onCalls: (recorded) => (calls = recorded),
  });

  beforeEach(() => {
    calls = [];
    saved = 0;
    closed = 0;
    stub = installFillDialogStub();
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

  it('add mode: renders the fields and posts the manual-fill body without a fee key', async () => {
    await render();
    for (const id of ['manualSideSelect', 'manualSharesInput', 'manualPriceInput', 'manualFeeInput', 'manualDateInput']) {
      expect(elementByTestId(id)).toBeTruthy();
    }
    expect((elementByTestId('manualSideSelect') as HTMLSelectElement).disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();

    await type('manualSharesInput', '3');
    await type('manualPriceInput', '5.00');
    await type('manualDateInput', '2026-11-06');
    await clickButton('Add fill');

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.endsWith('/api/runs/7/fills')).toBe(true);
    const body = calls[0]!.body;
    expect(body.side).toBe('buy');
    expect(body.shares).toBe(3);
    expect(body.price).toBe('5.00');
    expect(body.filledOn).toBe('2026-11-06');
    expect('fee' in body).toBe(false);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('add mode: auto-fee syncs until the fee is touched, clearing returns to auto', async () => {
    await render({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02'); // feeCents(3402300n, 100, 30) = 102
    await type('manualFeeInput', '5.00');
    await type('manualPriceInput', '680.46');
    expect(inputByTestId('manualFeeInput').value).toBe('5.00');
    await type('manualFeeInput', '');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02');
  });

  it('modify mode: side locked, date editable, fields prefilled, PUTs recomputed auto-fee', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    expect((elementByTestId('manualSideSelect') as HTMLSelectElement).disabled).toBe(true);
    expect(inputByTestId('manualDateInput').disabled).toBe(false);
    expect(inputByTestId('manualSharesInput').value).toBe('10');
    expect(inputByTestId('manualPriceInput').value).toBe('340.2300');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02');
    expect(inputByTestId('manualDateInput').value).toBe('2026-11-06');

    await type('manualSharesInput', '20');
    await type('manualPriceInput', '680.46');
    // feeCents(6804600n, 20, 30) = 40.8276 → 41¢ shown as 0.41
    expect(inputByTestId('manualFeeInput').value).toBe('0.41');

    await clickButton('Save');

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url.endsWith('/api/runs/7/fills/3')).toBe(true);
    expect(Object.keys(put!.body).sort()).toEqual(['feeCents', 'filledOn', 'priceCents', 'qty']);
    expect(put!.body.qty).toBe(20);
    expect(put!.body.priceCents).toBe(68046);
    expect(put!.body.feeCents).toBe(41);
    // The prefilled trade date passes through untouched when not edited.
    expect(put!.body.filledOn).toBe('2026-11-06');
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('modify mode: the trade date input is editable and prefilled with the fill date', async () => {
    await render({ fill: fillDto() });
    const dateInput = inputByTestId('manualDateInput');
    expect(dateInput.disabled).toBe(false);
    expect(dateInput.value).toBe('2026-11-06');
  });

  it('modify mode: changing the trade date PUTs the new filledOn', async () => {
    await render({ fill: fillDto() });
    await type('manualDateInput', '2026-12-25');
    await clickButton('Save');

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(Object.keys(put!.body).sort()).toEqual(['feeCents', 'filledOn', 'priceCents', 'qty']);
    expect(put!.body.filledOn).toBe('2026-12-25');
    expect(put!.body.qty).toBe(10);
    expect(put!.body.priceCents).toBe(34023);
    expect(put!.body.feeCents).toBe(102);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it.each([[''], ['2026-11-6']])(
    'modify mode: an emptied or non-padded date value %p shows the date error and sends no PUT',
    async (value) => {
      await render({ fill: fillDto() });
      // setInputValue (via type) is the only way to get a type=date input empty.
      await type('manualDateInput', value);
      // The DOM blocks a submit-button click while the required date input is
      // invalid, so fire the submit event directly — what a browser without a
      // native date control does — and let the dialog's own guard run.
      await submitForm();
      expect(errorText()).toBe('Enter a date as YYYY-MM-DD.');
      expect(calls.filter((c) => c.method === 'PUT').length).toBe(0);
      expect(saved).toBe(0);
      expect(closed).toBe(0);
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    },
  );

  it('modify mode: a typed fee survives a shares edit and is sent as feeCents', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await type('manualFeeInput', '7.00');
    await type('manualSharesInput', '20');
    expect(inputByTestId('manualFeeInput').value).toBe('7.00');

    await clickButton('Save');

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.body.qty).toBe(20);
    expect(put!.body.priceCents).toBe(34023);
    expect(put!.body.feeCents).toBe(700);
  });

});
