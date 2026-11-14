import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in ManualCaptureForm.test.tsx: a hoisted import binds to the real DOM and
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

interface FetchCall {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let putFailure: { status: number; error: string } | null = null;

function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function elementByTestId(id: string): Element {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`[${id}] not found`);
  return el;
}

function inputByTestId(id: string): HTMLInputElement {
  const el = elementByTestId(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`[${id}] is not an input`);
  return el;
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
}

function button(text: string): HTMLButtonElement {
  const btn = findButton(text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

// Click + flush the async handler (the fetch stub resolves immediately).
async function clickButton(text: string) {
  await act(async () => {
    button(text).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

// FillDto fixture (api.types.ts wire shape: price = myriadths string, fee = cents).
function fillDto() {
  return {
    id: 3,
    runId: 7,
    bucketIdx: 1,
    side: 'sell' as const,
    ticker: 'AAPL',
    shares: 10,
    price: '3402300',
    fee: 102,
    filledOn: '2026-11-06',
    source: 'manual',
    createdAt: '2026-11-06 10:00:00',
  };
}

function errorText(): string | null {
  const el = document.querySelector('[data-testid="error"]');
  return el ? (el.textContent ?? '') : null;
}

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

  beforeEach(() => {
    calls = [];
    putFailure = null;
    saved = 0;
    closed = 0;
    globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
      const method = String(init?.method ?? 'GET');
      const u = String(url);
      calls.push({ method, url: u, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      if (method === 'PUT' && putFailure) {
        return new Response(JSON.stringify({ error: putFailure.error }), {
          status: putFailure.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = method === 'DELETE' ? { ok: true, deletedFillId: 3 } : { ok: true, fill: { id: 3 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
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

  it('modify mode: side and date locked, fields prefilled, PUTs recomputed auto-fee', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    expect((elementByTestId('manualSideSelect') as HTMLSelectElement).disabled).toBe(true);
    expect(inputByTestId('manualDateInput').disabled).toBe(true);
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
    expect(Object.keys(put!.body).sort()).toEqual(['feeCents', 'priceCents', 'qty']);
    expect(put!.body.qty).toBe(20);
    expect(put!.body.priceCents).toBe(68046);
    expect(put!.body.feeCents).toBe(41);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

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

  it('delete: confirm inside the dialog then DELETE, cancel returns to the form', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    expect(button('Delete')).toBeTruthy();

    await clickButton('Delete');
    expect(document.body.textContent).toContain(
      'Delete the last fill (10 shares)? Cash and positions are recomputed.',
    );

    // Cancel returns to the form without deleting.
    await clickButton('Cancel');
    expect(button('Delete')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0);

    await clickButton('Delete');
    await clickButton('Delete for real');

    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url.endsWith('/api/runs/7/fills/3')).toBe(true);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('no Delete button when the fill is not deletable or absent', async () => {
    await render({ fill: fillDto(), deletable: false });
    expect(findButton('Delete')).toBeUndefined();
    expect(findButton('Delete for real')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);

    await render();
    expect(findButton('Delete')).toBeUndefined();
  });

  it('maps a server error code through fillErr.* and keeps the dialog open', async () => {
    putFailure = { status: 422, error: 'not-last' };
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await clickButton('Save');
    expect(errorText()).toBe('Only the last fill of a bucket can be deleted.');
    expect(closed).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('falls back to the raw message for an unknown error code', async () => {
    putFailure = { status: 422, error: 'weird-code' };
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await clickButton('Save');
    const msg = errorText();
    expect(msg).not.toBeNull();
    expect(msg!.length).toBeGreaterThan(0);
    expect(msg).toContain('weird-code');
  });
});
