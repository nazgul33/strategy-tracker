import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in CreateRunForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { GapEditForm } = await import('./GapEditForm');

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

function saveButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save gaps');
  if (!btn) throw new Error('save button not found');
  return btn as HTMLButtonElement;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function clickSave() {
  await act(async () => {
    saveButton().click();
  });
  // Flush the async submit handler (fetch stub resolves immediately).
  await act(async () => {
    await Promise.resolve();
  });
}

describe('GapEditForm', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return new Response(null, { status: 204 });
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

  it('prefills percents from ppm and posts ppm on save', async () => {
    let saved = 0;
    await act(async () => {
      root.render(d(GapEditForm, { runId: 1, initialBuyPpm: 5000, initialSellPpm: 0, onSaved: () => (saved += 1) }));
    });
    expect(inputByTestId('gapBuyInput').value).toBe('0.5');
    expect(inputByTestId('gapSellInput').value).toBe('');

    await type('gapBuyInput', '1');
    await clickSave();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('/api/runs/1/gaps');
    expect(calls[0]!.body.buyGapPpm).toBe(10000);
    expect(calls[0]!.body.sellGapPpm).toBe(0);
    expect(saved).toBe(1);
  });

  it('rejects >100 with inline error and no post', async () => {
    let saved = 0;
    await act(async () => {
      root.render(d(GapEditForm, { runId: 1, initialBuyPpm: 0, initialSellPpm: 0, onSaved: () => (saved += 1) }));
    });
    await type('gapBuyInput', '101');
    expect(inputByTestId('gapBuyInput').getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);

    await clickSave(); // clicking a disabled button must do nothing
    expect(calls.length).toBe(0);
    expect(saved).toBe(0);
  });

  it('shows the api error code when the save fails', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'gapTooLarge' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await act(async () => {
      root.render(d(GapEditForm, { runId: 1, initialBuyPpm: 0, initialSellPpm: 0, onSaved: () => undefined }));
    });
    await type('gapBuyInput', '5');
    await clickSave();

    expect(container.textContent).toContain('gap update failed (gapTooLarge)');
  });
});
