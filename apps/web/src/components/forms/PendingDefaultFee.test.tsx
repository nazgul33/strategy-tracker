import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see PendingTable.test.tsx.
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

// 10 sh @ 12,345.00, fee 100 cents, with a screenshot and a detected snapshot;
// at 40 ppm the derived fee is $4.94.
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
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};
const FEELESS: PendingFillDto = { ...ROW, fee: null, hasImage: false, detected: { ...ROW.detected!, fee: null } };

const TITLE = 'Use the default fee?';

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

describe('default fee popup', () => {
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

  const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const dialog = (title: string) => container.querySelector(`[role=dialog][aria-label="${title}"]`);

  async function pressButton(text: string) {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button ${text} not found`);
    await act(async () => (btn as HTMLButtonElement).click());
    await flush();
  }

  async function renderWithConfirmCalls(row: PendingFillDto, postJson: unknown = { ok: true }) {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: postJson },
      { url: '/api/pending', json: [row] },
    ]);
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
    return calls;
  }

  const type = (label: string, value: string) => act(async () => setInputValue(input(label), value));

  it('clearing a read fee asks before booking the default fee, then confirms with feeCents null', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await type('Fee', '');
    await pressButton('Confirm');

    expect(dialog(TITLE)).toBeTruthy();
    expect(dialog(TITLE)!.textContent).toContain('0.004% × $12345.00 × 10 sh = $4.94');
    expect(calls.length).toBe(0);

    await pressButton('Use default fee');
    expect(dialog(TITLE)).toBeNull();
    expect(container.querySelector('[role=dialog]')!.textContent).toContain('Values were edited');
    expect(calls.length).toBe(0);

    await pressButton('Discard');
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ overrides: { feeCents: null } });
  });

  it('Go back posts nothing and leaves the field blank', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await type('Fee', '');
    await pressButton('Confirm');
    await pressButton('Go back');

    expect(calls.length).toBe(0);
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(input('Fee').value).toBe('');
  });

  it('closing the popup posts nothing either', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await type('Fee', '');
    await pressButton('Confirm');
    await pressButton('✕');

    expect(calls.length).toBe(0);
    expect(container.querySelector('[role=dialog]')).toBeNull();
  });

  it('a blank fee on a feeless row asks too, then confirms with no overrides', async () => {
    const calls = await renderWithConfirmCalls(FEELESS);
    await type('Fee', '');
    await pressButton('Confirm');
    expect(dialog(TITLE)).toBeTruthy();
    expect(calls.length).toBe(0);

    await pressButton('Use default fee');
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({});
  });

  it('the popup keeps showing the values Confirm was pressed with', async () => {
    const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
    await type('Fee', '');
    await pressButton('Confirm');
    expect(dialog(TITLE)!.textContent).toContain('× 10 sh = $4.94');

    await type('Qty', '20');
    expect(dialog(TITLE)!.textContent).toContain('× 10 sh = $4.94');
    expect(dialog(TITLE)!.textContent).not.toContain('20 sh');

    await pressButton('Use default fee');
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/confirm' });
    expect(calls[0]!.body).toEqual({ overrides: { feeCents: null } });
  });

  it('validation runs before the popup', async () => {
    const calls = await renderWithConfirmCalls(FEELESS);
    await type('Price', 'abc');
    await type('Fee', '');
    await pressButton('Confirm');
    expect(container.textContent).toContain(lookup('en', 'pendingInvalidOverride'));
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('a missed date is asked for before the popup', async () => {
    const missed = { ...FEELESS, filledOn: '', detected: { ...FEELESS.detected!, filledOn: null } };
    const calls = await renderWithConfirmCalls(missed);
    await type('Fee', '');
    await pressButton('Confirm');
    expect(container.querySelector('p.text-destructive')!.textContent).toBe(lookup('en', 'pendingNeedsOverride'));
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('the keep choice survives the popup and follows the snapshot', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await type('Fee', '');
    await pressButton('Confirm');
    await type('Qty', '20');
    await pressButton('Use default fee');
    expect(calls.length).toBe(0);

    await pressButton('Keep for review');
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ overrides: { feeCents: null }, keepImage: true });
  });

  it('a kept image the server could not archive is reported after the popup path too', async () => {
    await renderWithConfirmCalls(ROW, { ok: true, archived: false });
    await type('Fee', '');
    await pressButton('Confirm');
    await pressButton('Use default fee');
    await pressButton('Keep for review');
    expect(container.textContent).toContain(lookup('en', 'keepImageNotKept'));
  });

  it('Compare, clear the fee, Done, then Confirm still meets the popup', async () => {
    const calls = await renderWithConfirmCalls(ROW);
    await pressButton('Compare');
    const fee = container.querySelectorAll('[role=dialog] input[inputmode=decimal]')[1] as HTMLInputElement;
    await act(async () => setInputValue(fee, ''));
    await pressButton('Done');
    await pressButton('Confirm');
    expect(dialog(TITLE)).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it('the popup shows the quantity trimmed', async () => {
    await renderWithConfirmCalls(FEELESS);
    await type('Qty', ' 10 ');
    await type('Fee', '');
    await pressButton('Confirm');
    expect(dialog(TITLE)!.textContent).toContain('× 10 sh');
    expect(dialog(TITLE)!.textContent).not.toContain('×  10');
  });

  it('a comma-grouped price still gets the popup', async () => {
    const calls = await renderWithConfirmCalls(FEELESS);
    await type('Price', '12,345.00');
    await type('Fee', '');
    await pressButton('Confirm');

    expect(dialog(TITLE)).toBeTruthy();
    expect(dialog(TITLE)!.textContent).toContain('$12,345.00');
    expect(calls.length).toBe(0);
  });

  it('a typed fee never shows the popup', async () => {
    await renderWithConfirmCalls(ROW);
    await type('Fee', '1.00');
    await pressButton('Confirm');
    expect(dialog(TITLE)).toBeNull();
  });

  it('Reject never shows the popup', async () => {
    await renderWithConfirmCalls(ROW);
    await type('Fee', '');
    await pressButton('Reject');
    expect(dialog(TITLE)).toBeNull();
    expect(container.querySelector('[role=dialog]')!.textContent).toContain('Rejecting this fill');
  });
});
