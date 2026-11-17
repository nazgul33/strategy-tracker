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
  hasImage: false,
  autoFeeCents: 100,
  detected: null,
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

  it('trade date column shows the detected date above the override input', async () => {
    stubFetch('conflict');
    await renderTable(root);
    const cell = container.querySelectorAll('tbody tr td')[0]!;
    expect(cell.textContent).toContain('2026-11-10');
    const input = cell.querySelector('input[type=date]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.value).toBe('');
    // DOM order: detected date block first, override picker right below it.
    expect(cell.firstElementChild?.tagName).toBe('DIV');
    expect(cell.firstElementChild?.textContent).toBe('2026-11-10');
    expect(cell.firstElementChild?.nextElementSibling).toBe(input);
  });

  it('quantity and price cells stack the detected value in a div above the override input, like the date cell', async () => {
    stubFetch('conflict');
    await renderTable(root);
    const cells = container.querySelectorAll('tbody tr td');
    for (const [idx, text] of [[3, '10'], [4, '$12,345.00']] as const) {
      const cell = cells[idx]!;
      const input = cell.querySelector('input');
      expect(input).toBeTruthy();
      expect(cell.firstElementChild?.tagName).toBe('DIV');
      expect(cell.firstElementChild?.textContent).toBe(text);
      expect(cell.firstElementChild?.nextElementSibling).toBe(input);
    }
  });

  it('typing an override date keeps the detected date above it and confirm posts overrides.filledOn', async () => {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true } },
      { url: '/api/pending', json: [ROW] },
    ]);
    await renderTable(root);

    const cell = () => container.querySelectorAll('tbody tr td')[0]!;
    const input = cell().querySelector('input[type=date]') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, '2026-11-12');
    });

    const input2 = cell().querySelector('input[type=date]') as HTMLInputElement;
    expect(input2.value).toBe('2026-11-12');
    expect(cell().firstElementChild?.tagName).toBe('DIV');
    expect(cell().firstElementChild?.textContent).toBe('2026-11-10');
    expect(cell().firstElementChild?.nextElementSibling).toBe(input2);

    await clickConfirm();

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/pending/9/confirm',
      body: { overrides: { filledOn: '2026-11-12' } },
    });
  });

  it('confirm without any override posts an empty body', async () => {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true } },
      { url: '/api/pending', json: [ROW] },
    ]);
    await renderTable(root);
    await clickConfirm();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({});
  });

  it('empty detected trade date renders an em dash and keeps the flagged override input', async () => {
    stubFetch('conflict', { ...ROW, filledOn: '' });
    await renderTable(root);
    const cell = container.querySelectorAll('tbody tr td')[0]!;
    expect(cell.textContent).toContain('—');
    const input = cell.querySelector('input[type=date]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.className).toContain('border-warning');
  });
});
