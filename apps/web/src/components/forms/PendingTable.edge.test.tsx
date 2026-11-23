import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch, type Route } from '../../testing/fetchStub';
import { setInputValue } from '../../testing/dom';
import { PENDING_ROW } from '../../testing/pendingRow';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and onChange
// silently breaks.
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

function confirmButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
  if (!btn) throw new Error('confirm button not found');
  return btn as HTMLButtonElement;
}

async function clickConfirm() {
  await act(async () => {
    confirmButton().click();
  });
  await flush();
}

describe('PendingTable edge cases', () => {
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

  const cells = () => Array.from(container.querySelectorAll('tbody tr td'));
  const control = <T extends HTMLElement>(idx: number, selector: string) => cells()[idx]!.querySelector(selector) as T;
  const promptOpen = () => container.querySelector('[role=dialog]') !== null;

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
    await renderTable(root);
    return calls;
  }

  const type = (idx: number, selector: string, value: string) =>
    act(async () => setInputValue(control<HTMLInputElement>(idx, selector), value));

  it('an unparsable price blocks the confirm with the validation message', async () => {
    const calls = await renderWithConfirmCalls(PENDING_ROW);
    await type(4, 'input', 'abc');
    await clickConfirm();

    expect(calls.length).toBe(0);
    expect(container.textContent).toContain('Check the values');
    expect(promptOpen()).toBe(false);
  });

  it('a cleared trade date that vision read blocks the confirm', async () => {
    const calls = await renderWithConfirmCalls(PENDING_ROW);
    await type(0, 'input[type=date]', '');
    await clickConfirm();

    expect(calls.length).toBe(0);
    expect(container.textContent).toContain('Check the values');
    expect(container.textContent).not.toContain(lookup('en', 'pendingNeedsOverride'));
  });

  it('fee text that is not an amount blocks the confirm', async () => {
    const calls = await renderWithConfirmCalls(PENDING_ROW);
    await type(5, 'input', 'abc');
    await clickConfirm();

    expect(calls.length).toBe(0);
    expect(container.textContent).toContain('Check the values');
  });

  it('dismissing the keep prompt and confirming again re-asks, then posts once', async () => {
    const calls = await renderWithConfirmCalls(PENDING_ROW);
    await type(3, 'input', '11');
    await clickConfirm();
    await pressButton('✕');
    expect(promptOpen()).toBe(false);
    await clickConfirm();

    expect(promptOpen()).toBe(true);
    expect(calls.length).toBe(0);

    await pressButton('Keep for review');
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ overrides: { shares: 11 }, keepImage: true });
  });

  it('a row handled elsewhere while the prompt is open answers Already handled and drops out', async () => {
    const routes: Route[] = [
      { method: 'POST', url: '/api/pending', status: 409, json: { error: 'not-pending' } },
      { url: '/api/pending', json: [PENDING_ROW] },
    ];
    const calls = installFetchStub(routes);
    await renderTable(root);
    await type(3, 'input', '11');
    await clickConfirm();
    expect(promptOpen()).toBe(true);

    routes[1]!.json = [];
    await pressButton('Keep for review');

    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/confirm' });
    expect(container.textContent).toContain('Already handled');
    expect(promptOpen()).toBe(false);
    expect(container.textContent).toContain('Nothing waiting for confirmation.');
  });

  it('a field vision missed blocks the confirm even when another missed field was filled in', async () => {
    const missedBoth: PendingFillDto = {
      ...PENDING_ROW,
      side: '',
      price: '',
      detected: { ...PENDING_ROW.detected!, side: null, price: null },
    };
    const calls = await renderWithConfirmCalls(missedBoth);
    await act(async () => {
      const side = control<HTMLSelectElement>(2, 'select');
      side.value = 'buy';
      side.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickConfirm();

    expect(calls.length).toBe(0);
    expect(promptOpen()).toBe(false);
    expect(container.querySelector('p.text-destructive')!.textContent).toBe(lookup('en', 'pendingNeedsOverride'));
  });
});
