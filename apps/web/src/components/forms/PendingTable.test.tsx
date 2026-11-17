import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// One valid, complete pending row (no override highlight) for the table.
const ROW: PendingFillDto = {
  id: 9,
  runId: 7,
  captureId: 3,
  bucketIdx: null,
  side: 'buy',
  ticker: 'AAPL',
  shares: 10,
  price: '123450000', // myriadths → $12,345
  fee: 100,
  filledOn: '2026-11-10',
  status: 'pending',
  createdAt: '2026-11-10T14:30:00Z',
  hasImage: true,
  autoFeeCents: 100,
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

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

function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
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

  async function renderWithConfirmCalls(row: PendingFillDto) {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true } },
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

  it('confirm posts the edited values as overrides', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(3, 'input'), '11');
    });
    await clickConfirm();
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
    await clickConfirm();
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
    await clickConfirm();
    expect((calls[0]!.body as { overrides: object }).overrides).toEqual({ side: 'sell' });
  });

  it('confirm on an untouched row posts no overrides', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await clickConfirm();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({});
  });

  describe('a fee vision did not read', () => {
    const feeless: PendingFillDto = { ...ROW, fee: null, autoFeeCents: 7, detected: { ...ROW.detected!, fee: null } };

    it('prefills the derived fee, and an untouched confirm still posts {}', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      expect(control<HTMLInputElement>(5, 'input').value).toBe('0.07');
      await clickConfirm();
      expect(calls[0]!.body).toEqual({});
    });

    it('clearing the field posts nothing, since the server derives that fee anyway', async () => {
      const calls = await renderWithConfirmCalls(feeless);
      await act(async () => {
        setInputValue(control<HTMLInputElement>(5, 'input'), '');
      });
      await clickConfirm();
      expect(calls[0]!.body).toEqual({});
    });
  });

  it('clearing a fee vision read posts feeCents null (recompute)', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await act(async () => {
      setInputValue(control<HTMLInputElement>(5, 'input'), '');
    });
    await clickConfirm();
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

  it('empty detected trade date renders an empty date input that keeps the warning border', async () => {
    stubFetch('conflict', { ...ROW, filledOn: '', detected: { ...ROW.detected!, filledOn: null } });
    await renderTable(root);
    const cell = container.querySelectorAll('tbody tr td')[0]!;
    const input = cell.querySelector('input[type=date]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.className).toContain('border-warning');
  });
});
