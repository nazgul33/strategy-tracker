import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import { PENDING_ROW as ROW, setInputValue } from '../../testing/pendingRow';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');
const { lookup } = await import('../../i18n/catalog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// GET /api/pending always returns [row] (default ROW); every POST (the
// confirm) replies with the given status (default 409) and server error code.
let gets = 0;

function stubFetch(confirmCode: string, row: PendingFillDto = ROW, status = 409) {
  gets = 0;
  installFetchStub([
    { method: 'POST', url: '/api/pending', status, json: { error: confirmCode } },
    {
      url: '/api/pending',
      // The getter fires on every matched GET, so it doubles as the
      // reload counter the integrity-guard assertions read via pendingGets().
      get json() {
        gets += 1;
        return [row];
      },
    },
  ]);
}

const pendingGets = () => gets;

function confirmButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
  if (!btn) throw new Error('confirm button not found');
  return btn as HTMLButtonElement;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderTable(root: ReturnType<typeof createRoot>) {
  await act(async () => {
    root.render(d(PendingTable, { runId: 7 }));
  });
  await flush();
}

async function clickConfirm() {
  await act(async () => {
    confirmButton().click();
  });
  await flush();
}

describe('PendingTable', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  async function pressButton(text: string) {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button ${text} not found`);
    await act(async () => (btn as HTMLButtonElement).click());
    await flush();
  }

  const promptOpen = () => container.querySelector('[role=dialog]') !== null;

  // Edited rows with a screenshot stop at the keep/discard prompt; this walks
  // through it so a test can read the posted body.
  async function confirmKeeping() {
    await clickConfirm();
    await pressButton('Keep for review');
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows the ticker-mismatch message without reloading after a 409 confirm', async () => {
    stubFetch('ticker-mismatch');
    await renderTable(root);
    expect(container.textContent).toContain('AAPL');

    await clickConfirm();

    expect(container.textContent).toContain('Ticker does not match the run — reject this row and re-capture.');
    expect(container.textContent).not.toContain('Already handled');
    // Integrity guard: the row is untouched, so no reload — it must stay
    // visible (one GET = the initial load only) for the user to reject it.
    expect(pendingGets()).toBe(1);
    expect(container.textContent).toContain('AAPL');
  });

  it('still shows "Already handled" and reloads on a generic 409', async () => {
    stubFetch('not-pending');
    await renderTable(root);
    expect(container.textContent).toContain('AAPL');

    await clickConfirm();

    expect(container.textContent).toContain('Already handled');
    expect(pendingGets()).toBe(2);
  });

  const confirmErrors: Array<[string, string]> = [
    ['no-bucket-for-sell', 'No held bucket can cover this sell — check the share count.'],
    ['no-empty-bucket', 'No empty bucket left in this run — free one up first.'],
    ['too-many-shares', 'More shares than the position holds.'],
    ['invalid-shares', 'Invalid share count.'],
  ];

  for (const [code, text] of confirmErrors) {
    it(`a 422 ${code} on confirm shows the localized text and keeps the row`, async () => {
      stubFetch(code, ROW, 422);
      await renderTable(root);
      await clickConfirm();

      expect(container.textContent).toContain(text);
      expect(container.textContent).not.toContain(code);
      // Nothing was booked: no reload, the row stays for another attempt or a reject.
      expect(pendingGets()).toBe(1);
      expect(container.textContent).toContain('AAPL');
    });
  }

  it('falls back to the raw code for an unknown 422 confirm error', async () => {
    stubFetch('weird-code', ROW, 422);
    await renderTable(root);
    await clickConfirm();
    expect(container.textContent).toContain('weird-code');
  });

  const cells = () => Array.from(container.querySelectorAll('tbody tr td'));
  const control = <T extends HTMLElement>(idx: number, selector: string) => cells()[idx]!.querySelector(selector) as T;

  async function renderWithConfirmCalls(row: PendingFillDto, postJson: unknown = { ok: true }) {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: postJson },
      { url: '/api/pending', json: [row] },
    ]);
    await renderTable(root);
    return calls;
  }

  it('renders exactly one control per editable field, pre-filled from the detected values', async () => {
    stubFetch('conflict');
    await renderTable(root);

    expect(control<HTMLInputElement>(0, 'input[type=date]').value).toBe('2026-11-10');
    expect(control<HTMLSelectElement>(2, 'select').value).toBe('buy');
    expect(control<HTMLInputElement>(3, 'input').value).toBe('10');
    expect(control<HTMLInputElement>(4, 'input').value).toBe('12345.00');
    expect(control<HTMLInputElement>(5, 'input').value).toBe('1.00');

    // One control per field and no static copy of the value next to it.
    for (const idx of [0, 3, 4, 5]) {
      expect(cells()[idx]!.querySelectorAll('input, select').length).toBe(1);
      expect(cells()[idx]!.textContent).toBe('');
    }
    expect(cells()[2]!.querySelectorAll('input, select').length).toBe(1);
    expect(cells()[2]!.textContent).toBe('BuySell');
    expect(cells()[1]!.textContent).toBe('AAPL');
    expect(cells()[1]!.querySelector('input, select')).toBeNull();
  });

  it('the side control is a select offering buy and sell', async () => {
    stubFetch('conflict');
    await renderTable(root);
    const options = Array.from(control<HTMLSelectElement>(2, 'select').options).map((o) => o.value);
    expect(options).toEqual(['buy', 'sell']);
  });

  it('a side vision missed shows an empty select and keeps the flagged border', async () => {
    const missed = { ...ROW, side: '', detected: { ...ROW.detected!, side: null } };
    stubFetch('conflict', missed);
    await renderTable(root);
    const select = control<HTMLSelectElement>(2, 'select');
    expect(select.value).toBe('');
    expect(select.className).toContain('border-warning');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'buy', 'sell']);
  });

  it('renders the screenshot thumbnail pointing at the capture image endpoint', async () => {
    stubFetch('conflict');
    await renderTable(root);
    const img = container.querySelector('tbody img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toContain('/api/captures/3/image');
  });

  it('renders no thumbnail when hasImage is false', async () => {
    stubFetch('conflict', { ...ROW, hasImage: false });
    await renderTable(root);
    expect(container.querySelector('tbody img')).toBeNull();
  });

  it('the side-by-side button is only offered while a screenshot exists', async () => {
    stubFetch('conflict');
    await renderTable(root);
    expect(Array.from(container.querySelectorAll('tbody button')).some((b) => b.textContent === 'Compare')).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    stubFetch('conflict', { ...ROW, hasImage: false });
    await renderTable(root);
    expect(Array.from(container.querySelectorAll('tbody button')).some((b) => b.textContent === 'Compare')).toBe(false);
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

  it('a missing ticker points at reject and re-capture, a missing field at the highlighted control', async () => {
    stubFetch('conflict', { ...ROW, ticker: '' });
    await renderTable(root);
    expect(container.textContent).toContain('reject this row and re-capture');
    await act(async () => root.unmount());
    root = createRoot(container);
    stubFetch('conflict', { ...ROW, price: '', detected: { ...ROW.detected!, price: null } });
    await renderTable(root);
    expect(container.textContent).toContain(lookup('en', 'pendingNeedsOverride'));
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

  describe('keep or discard the screenshot', () => {
    const editQty = () => act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), '11'));

    it('confirming an edited row prompts before posting, then posts keepImage true', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await editQty();
      await clickConfirm();

      expect(promptOpen()).toBe(true);
      expect(container.textContent).toContain('Values were edited');
      expect(calls.length).toBe(0);

      await pressButton('Keep for review');
      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 }, keepImage: true });
    });

    it('Discard posts the edit with no keepImage', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await editQty();
      await clickConfirm();
      await pressButton('Discard');

      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 } });
    });

    const RECORD_FAILED = 'its review record could not be saved';

    it('a keep whose review record failed says so', async () => {
      await renderWithConfirmCalls(ROW, { ok: true, archived: false });
      await editQty();
      await clickConfirm();
      await pressButton('Keep for review');

      expect(container.textContent).toContain(RECORD_FAILED);
    });

    it('a keep that stuck shows no note', async () => {
      const calls = await renderWithConfirmCalls(ROW, { ok: true, archived: true });
      await editQty();
      await clickConfirm();
      await pressButton('Keep for review');

      expect(calls.length).toBe(1);
      expect(container.textContent).not.toContain(RECORD_FAILED);
    });

    it('Discard never shows the note', async () => {
      const calls = await renderWithConfirmCalls(ROW, { ok: true, archived: false });
      await editQty();
      await clickConfirm();
      await pressButton('Discard');

      expect(calls.length).toBe(1);
      expect(container.textContent).not.toContain(RECORD_FAILED);
    });

    it('a reject kept for review whose review record failed says so', async () => {
      const calls = await renderWithConfirmCalls(ROW, { ok: true, archived: false });
      await pressButton('Reject');
      await pressButton('Keep for review');

      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/reject' });
      expect(container.textContent).toContain(RECORD_FAILED);
    });

    it('dismissing the prompt posts nothing and leaves the edit in place', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await editQty();
      await clickConfirm();
      await pressButton('✕');

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(0);
      expect(control<HTMLInputElement>(3, 'input').value).toBe('11');
    });

    it('confirming an untouched row posts immediately with no prompt', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await clickConfirm();

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({});
    });

    it('rejecting prompts, and Keep for review posts keepImage true', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await pressButton('Reject');

      expect(promptOpen()).toBe(true);
      expect(container.textContent).toContain('Rejecting this fill');
      expect(calls.length).toBe(0);

      await pressButton('Keep for review');
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/reject', body: { keepImage: true } });
    });

    it('rejecting prompts, and Discard posts a reject with no keepImage', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await pressButton('Reject');
      await pressButton('Discard');

      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/reject' });
      expect(calls[0]!.body).toEqual({});
    });

    it('dismissing the reject prompt posts nothing', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await pressButton('Reject');
      await pressButton('✕');

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(0);
    });

    it('no prompt when the row has no image, even when edited', async () => {
      const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
      await editQty();
      await clickConfirm();

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 } });
    });

    it('no prompt when rejecting a row that has no image', async () => {
      const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
      await pressButton('Reject');

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({});
    });

    it('no prompt for a legacy row with detected null, on confirm or reject', async () => {
      const legacy: PendingFillDto = { ...ROW, detected: null };
      const calls = await renderWithConfirmCalls(legacy);
      await editQty();
      await clickConfirm();
      expect(promptOpen()).toBe(false);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 } });

      await pressButton('Reject');
      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(2);
      expect(calls[1]!.body).toEqual({});
    });

    it('a failed validation opens no prompt', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), '0'));
      await clickConfirm();

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(0);
      expect(container.textContent).toContain('Check the values');
    });

    for (const bad of ['1e1', '0x10', '1.5', '-3']) {
      it(`rejects the share count "${bad}" instead of reading it as a number`, async () => {
        const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
        await act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), bad));
        await clickConfirm();

        expect(calls.length).toBe(0);
        expect(container.textContent).toContain('Check the values');
      });
    }
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
      await pressButton('Use default fee');
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

  it('clearing a fee vision read posts feeCents null (recompute)', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(5, 'input'), '');
    });
    await clickConfirm();
    await pressButton('Use default fee');
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
