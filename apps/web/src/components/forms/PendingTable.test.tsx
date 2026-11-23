import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { restoreFetch } from '../../testing/fetchStub';
import { goOffline } from '../../testing/offline';
import { PENDING_ROW as ROW } from '../../testing/pendingRow';
import { pendingTableHelpers, stubPendingFetch } from '../../testing/pendingTable';

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

let gets = 0;

function stubFetch(confirmCode: string, row: PendingFillDto = ROW, status = 409) {
  gets = 0;
  stubPendingFetch(confirmCode, row, status, () => {
    gets += 1;
  });
}

const pendingGets = () => gets;

describe('PendingTable', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const { renderTable, clickConfirm, cells, control } = pendingTableHelpers({
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

  const actionError = () => container.querySelector('[data-testid="pendingActionError"]')?.textContent;

  it('an unknown 422 confirm error keeps its code in worded copy', async () => {
    stubFetch('weird-code', ROW, 422);
    await renderTable(root);
    await clickConfirm();
    expect(actionError()).toBe('The request failed (weird-code).');
  });

  it('a confirm with the server unreachable is worded and keeps the row', async () => {
    stubFetch('conflict');
    await renderTable(root);
    goOffline('POST', '/api/pending');
    await clickConfirm();
    expect(actionError()).toBe('Could not reach the server. Check the connection and try again.');
    expect(container.textContent).toContain('AAPL');
  });

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
});
