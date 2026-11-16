// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';

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

let stub: FetchCalls;
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
  // Mirror the helper's recorded non-GET calls into the local shape.
  calls = stub.map((c) => ({ url: c.url, body: c.body as Record<string, unknown> }));
}

describe('CreateRunForm gap fields', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    calls = [];
    stub = installFetchStub([
      { url: '/api/settings', json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 } },
      { method: 'POST', url: '/api/runs', status: 201, json: { id: 7 } },
    ]);
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

  it('prefills cost from the settings default and posts ppm', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const cost = inputByLabel('Cost (%)');
    expect(cost.value).toBe('0.070');
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body.costPpm).toBe(700);
  });

  it('converts an edited percent cost to ppm', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
      setInputValue(inputByLabel('Cost (%)'), '0.125');
    });
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body.costPpm).toBe(1250);
  });

  it('does not overwrite a cost typed before settings arrive', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/settings')) await gate;
      return stubbed(input, init);
    }) as typeof fetch;

    await act(async () => {
      root.render(d(CreateRunForm));
    });
    expect(inputByLabel('Cost (%)').value).toBe('');
    await act(async () => {
      setInputValue(inputByLabel('Cost (%)'), '0.2');
    });
    await act(async () => {
      release();
      await gate;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(inputByLabel('Cost (%)').value).toBe('0.2');
  });

  it('rejects a four-decimal cost', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
      setInputValue(inputByLabel('Cost (%)'), '0.0701');
    });
    await submitForm();

    expect(calls.length).toBe(0);
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Cost must be a percent with at most 3 decimals (0 to 100)');
  });

  it('posts cutLossPpm from a one-decimal percent', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    await type('cutLossInput', '3.5');
    expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBeNull();
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body.cutLossPpm).toBe(35_000);
  });

  it('sends cutLossPpm 0 when the field is blank', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body.cutLossPpm).toBe(0);
  });

  it('marks 3.55 and 60 invalid, disables create and posts nothing', async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    for (const bad of ['3.55', '60', 'abc', '-1']) {
      await type('cutLossInput', bad);
      expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBe('true');
      expect(createButton().disabled).toBe(true);
    }
    await submitForm();
    expect(calls.length).toBe(0);

    await type('cutLossInput', '50');
    expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBeNull();
    expect(createButton().disabled).toBe(false);
  });
});
