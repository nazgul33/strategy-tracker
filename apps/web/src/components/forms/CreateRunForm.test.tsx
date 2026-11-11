import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { CreateRunForm } = await import('./CreateRunForm');

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

function inputByLabel(label: string): HTMLInputElement {
  const labelEl = Array.from(document.querySelectorAll('label')).find(
    (l) => (l.querySelector('span')?.textContent ?? '').includes(label),
  );
  if (!labelEl) throw new Error(`label containing [${label}] not found`);
  const el = labelEl.querySelector('input');
  if (!el || !(el instanceof HTMLInputElement)) throw new Error(`input for label [${label}] not found`);
  return el;
}

function createButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Create');
  if (!btn) throw new Error('create button not found');
  return btn as HTMLButtonElement;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function submitForm() {
  await act(async () => {
    createButton().click();
  });
  // Flush the async submit handler (fetch stub resolves immediately).
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CreateRunForm gap fields', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return new Response(JSON.stringify({ id: 7 }), {
        status: 201,
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

  it('converts percent gap inputs to integer ppm on submit', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    await type('buyGapInput', '0.5');
    await type('sellGapInput', '2');
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('/api/runs');
    expect(calls[0]!.body.ticker).toBe('QQQ');
    expect(calls[0]!.body.buyGapPpm).toBe(5000);
    expect(calls[0]!.body.sellGapPpm).toBe(20000);
  });

  it('submits blank gaps as explicit 0', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    await submitForm();

    expect(calls.length).toBe(1);
    expect('buyGapPpm' in calls[0]!.body).toBe(true);
    expect('sellGapPpm' in calls[0]!.body).toBe(true);
    expect(calls[0]!.body.buyGapPpm).toBe(0);
    expect(calls[0]!.body.sellGapPpm).toBe(0);
  });

  it('marks invalid gap text and disables create until fixed', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    const buy = inputByTestId('buyGapInput');
    const btn = createButton();
    expect(btn.disabled).toBe(false);
    expect(buy.getAttribute('aria-invalid')).toBeNull();

    for (const bad of ['abc', '-1', '101', '0.00001']) {
      await type('buyGapInput', bad);
      expect(buy.getAttribute('aria-invalid')).toBe('true');
      expect(createButton().disabled).toBe(true);
    }

    await type('buyGapInput', '0.5');
    expect(inputByTestId('buyGapInput').getAttribute('aria-invalid')).toBeNull();
    expect(createButton().disabled).toBe(false);

    await type('buyGapInput', '');
    expect(inputByTestId('buyGapInput').getAttribute('aria-invalid')).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('does not leak the invalid prop to the DOM', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await type('buyGapInput', 'abc');
    const el = inputByTestId('buyGapInput');
    expect(el.getAttribute('invalid')).toBeNull();
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });
});
