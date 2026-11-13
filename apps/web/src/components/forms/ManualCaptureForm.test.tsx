import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { ManualCaptureForm, autoFeeUsd } = await import('./ManualCaptureForm');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function inputByTestId(id: string): HTMLInputElement {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el || !(el instanceof HTMLInputElement)) throw new Error(`input [${id}] not found`);
  return el;
}

function submitButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Add fill');
  if (!btn) throw new Error('submit button not found');
  return btn as HTMLButtonElement;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function clickSubmit() {
  await act(async () => {
    submitButton().click();
  });
  // Flush the async submit handler (fetch stub resolves immediately).
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ManualCaptureForm', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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

  it('submits without a ticker and never renders a ticker input', async () => {
    let added = 0;
    await act(async () => {
      root.render(d(ManualCaptureForm, { runId: 7, onAdded: () => (added += 1) }));
    });

    // form no longer renders the ticker input
    expect(document.querySelector('input[placeholder="AAPL"]')).toBeNull();

    await type('manualSharesInput', '3');
    await type('manualPriceInput', '5.00');
    await type('manualDateInput', '2026-11-06');
    await clickSubmit();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url.endsWith('/api/runs/7/fills')).toBe(true);
    const body = calls[0]!.body;
    expect('ticker' in body).toBe(false);
    expect(body.side).toBe('buy');
    expect(body.shares).toBe(3);
    expect(body.price).toBe('5.00');
    expect(body.filledOn).toBe('2026-11-06');
    expect(body.fee).toBeUndefined();
    expect(added).toBe(1);
  });

  async function renderWith(props: Record<string, unknown>) {
    await act(async () => {
      root.render(d(ManualCaptureForm, { runId: 7, ...props }));
    });
  }

  it('prefills the fee from price and shares', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02'); // feeCents(3402300n, 100, 30) = 102
    await type('manualDateInput', '2026-11-06');
    await clickSubmit();
    expect(calls[0]!.body.fee).toBe('1.02');
  });

  it('recomputes the auto fee when price changes', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    await type('manualPriceInput', '680.46');
    expect(inputByTestId('manualFeeInput').value).toBe('2.04');
  });

  it('recomputes the auto fee when shares change', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    await type('manualSharesInput', '200');
    expect(inputByTestId('manualFeeInput').value).toBe('2.04');
  });

  it('typed fee survives later price and shares edits', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    await type('manualFeeInput', '5.00');
    await type('manualPriceInput', '680.46');
    await type('manualSharesInput', '200');
    expect(inputByTestId('manualFeeInput').value).toBe('5.00');
    await type('manualDateInput', '2026-11-06');
    await clickSubmit();
    expect(calls[0]!.body.fee).toBe('5.00');
  });

  it('clearing the fee input returns it to auto mode', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualFeeInput', '5.00');
    await type('manualFeeInput', '');
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02');
  });

  it('invalid price clears an auto fee', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02');
    await type('manualPriceInput', 'abc');
    expect(inputByTestId('manualFeeInput').value).toBe('');
  });

  it('invalid shares clears an auto fee', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('1.02');
    await type('manualSharesInput', '1.5');
    expect(inputByTestId('manualFeeInput').value).toBe('');
  });

  it('invalid price does not clear a typed fee', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualFeeInput', '5.00');
    await type('manualPriceInput', 'abc');
    expect(inputByTestId('manualFeeInput').value).toBe('5.00');
  });

  it('prefills 0.00 when cost is 0 ppm', async () => {
    await renderWith({ costPpm: 0 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('0.00');
    await type('manualDateInput', '2026-11-06');
    await clickSubmit();
    expect(calls[0]!.body.fee).toBe('0.00');
  });

  it('a fee cleared without re-autofilling is omitted from the body', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    await type('manualFeeInput', '');
    await type('manualDateInput', '2026-11-06');
    await clickSubmit();
    expect(calls[0]!.body.fee).toBeUndefined(); // server computes from costPpm
  });

  it('no costPpm means no auto-fee', async () => {
    await renderWith({});
    await type('manualSharesInput', '100');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('');
  });

  it('a price that overflows the fee limit leaves the fee empty instead of an invalid value', async () => {
    await renderWith({ costPpm: 30 });
    await type('manualSharesInput', '1e21');
    await type('manualPriceInput', '340.23');
    expect(inputByTestId('manualFeeInput').value).toBe('');
    await type('manualDateInput', '2026-11-06');
    await clickSubmit();
    expect(calls[0]!.body.fee).toBeUndefined();
  });
});

describe('autoFeeUsd', () => {
  it('computes the fee in whole cents from price, shares and ppm', () => {
    expect(autoFeeUsd('100', '340.23', 30)).toBe('1.02');
  });

  it('rounds an exact half cent up', () => {
    // 5 × $1.00 × 1000 ppm = 0.5¢ → 1¢
    expect(autoFeeUsd('5', '1.00', 1000)).toBe('0.01');
  });

  it('rounds half-up from a 4-decimal price rather than flooring', () => {
    // 1000 × $340.2345 × 30 ppm = 1020.7035¢ → 1021¢ (floor would give 10.20)
    expect(autoFeeUsd('1000', '340.2345', 30)).toBe('10.21');
  });

  it('returns 0.00 when cost is 0 ppm', () => {
    expect(autoFeeUsd('100', '340.23', 0)).toBe('0.00');
  });

  it('returns empty when costPpm is undefined', () => {
    expect(autoFeeUsd('100', '340.23', undefined)).toBe('');
  });

  it.each([['abc'], [''], ['0'], ['-5'], ['1.5']])('returns empty for invalid shares %p', (shares) => {
    expect(autoFeeUsd(shares, '340.23', 30)).toBe('');
  });

  it.each([['abc'], [''], ['0'], ['-1'], ['1.23456']])('returns empty for invalid price %p', (price) => {
    expect(autoFeeUsd('100', price, 30)).toBe('');
  });

  it.each([[1.5], [Number.NaN], [-30], [Number.POSITIVE_INFINITY]])(
    'returns empty instead of throwing for unusable costPpm %p',
    (costPpm) => {
      expect(autoFeeUsd('100', '340.23', costPpm)).toBe('');
    },
  );

  it('returns empty when the fee would exceed what the fee field accepts', () => {
    // 1e21 shares → toFixed would switch to exponent notation
    expect(autoFeeUsd('1e21', '340.23', 30)).toBe('');
    // largest accepted fee is 999999999.99; this one is just above it
    expect(autoFeeUsd('1000000', '999999999', 1_000_000)).toBe('');
  });

  it('keeps a large fee that the fee field still accepts', () => {
    // 1 × $999999999 × 1_000_000 ppm = $999999999.00
    expect(autoFeeUsd('1', '999999999', 1_000_000)).toBe('999999999.00');
  });
});
