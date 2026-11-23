// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SimPage } = await import('./Sim');
const { resetDefaultCostMemo } = await import('../defaultcost');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

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

function runButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Run simulation');
  if (!btn) throw new Error('run simulation button not found');
  return btn as HTMLButtonElement;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function fillBaseFields() {
  await act(async () => {
    setInputValue(inputByLabel('Ticker'), 'QQQ');
    setInputValue(inputByLabel('Pool'), '100000');
    setInputValue(inputByLabel('Start'), '2026-01-02');
    setInputValue(inputByLabel('End'), '2026-01-09');
  });
}

async function submitForm() {
  await act(async () => {
    runButton().click();
  });
  // Flush the async submit handler (fetch stub resolves immediately).
  await act(async () => {
    await Promise.resolve();
  });
  // Mirror the helper's recorded non-GET calls into the local shape.
  calls = stub.map((c) => ({ url: c.url, body: c.body as Record<string, unknown> }));
}

describe('SimPage gap fields', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let settingsRoute: { url: string; status: number; json: unknown };

  beforeEach(() => {
    resetDefaultCostMemo();
    calls = [];
    settingsRoute = {
      url: '/api/settings',
      status: 200,
      json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 },
    };
    stub = installFetchStub([
      settingsRoute,
      { method: 'POST', url: '/api/sim', status: 201, json: { id: 3, dayCount: 5 } },
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

  it('converts percent gap inputs to integer ppm on submit', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await fillBaseFields();
    await type('buyGapInput', '0.5');
    await type('sellGapInput', '2');
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('/api/sim');
    expect(calls[0]!.body.ticker).toBe('QQQ');
    expect(calls[0]!.body.buyGapPpm).toBe(5000);
    expect(calls[0]!.body.sellGapPpm).toBe(20000);
  });

  it('asks for no name and posts none', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    const labels = Array.from(document.querySelectorAll('label span')).map((s) => s.textContent ?? '');
    expect(labels.some((l) => l.trim() === 'Name')).toBe(false);
    await fillBaseFields();
    await submitForm();
    expect(calls.length).toBe(1);
    expect('name' in calls[0]!.body).toBe(false);
  });

  it('submits blank gaps as explicit 0', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await fillBaseFields();
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body.buyGapPpm).toBe(0);
    expect(calls[0]!.body.sellGapPpm).toBe(0);
  });

  it('marks invalid gap text and disables submit until fixed', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    const buy = inputByTestId('buyGapInput');
    expect(runButton().disabled).toBe(false);
    expect(buy.getAttribute('aria-invalid')).toBeNull();

    for (const bad of ['abc', '-1', '101', '0.00001']) {
      await type('buyGapInput', bad);
      expect(buy.getAttribute('aria-invalid')).toBe('true');
      expect(runButton().disabled).toBe(true);
    }

    await type('buyGapInput', '0.5');
    expect(inputByTestId('buyGapInput').getAttribute('aria-invalid')).toBeNull();
    expect(runButton().disabled).toBe(false);

    await type('buyGapInput', '');
    expect(inputByTestId('buyGapInput').getAttribute('aria-invalid')).toBeNull();
    expect(runButton().disabled).toBe(false);
  });

  it('prefills cost from the settings default and posts ppm', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(inputByTestId('costInput').value).toBe('0.070');
    await fillBaseFields();
    await submitForm();

    expect(calls.length).toBe(1);
    expect(calls[0]!.body.costPpm).toBe(700);
  });

  it('a settings load that succeeded leaves the cost status empty', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const note = document.querySelector('[data-testid="costDefaultFailed"]');
    expect(note).not.toBeNull();
    expect(note!.getAttribute('role')).toBe('status');
    expect(note!.textContent).toBe('');
  });

  it('a failed settings load says so by the cost field', async () => {
    settingsRoute.status = 500;
    await act(async () => {
      root.render(d(SimPage));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const note = document.querySelector('[data-testid="costDefaultFailed"]');
    expect(note?.textContent).toBe("Couldn't load the default cost. Enter one.");
    expect(note!.closest('label')).toBeNull();
    expect(inputByTestId('costInput').value).toBe('');
  });

  it('a failed list load reads in the sim wording, with its code', async () => {
    restoreFetch();
    stub = installFetchStub([settingsRoute, { url: '/api/sim', status: 500, json: {} }]);
    await act(async () => {
      root.render(d(SimPage));
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('The server hit an error (http-500). Try again.');
  });

  it('sends cut-loss as ppm', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await fillBaseFields();
    await type('cutLossInput', '3.5');
    await submitForm();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.cutLossPpm).toBe(35_000);
  });

  it('blank cut-loss is an explicit 0', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await fillBaseFields();
    await submitForm();
    expect(calls[0]!.body.cutLossPpm).toBe(0);
  });

  it('a market-data failure on run reads in words, not as the code', async () => {
    restoreFetch();
    stub = installFetchStub([
      settingsRoute,
      { method: 'POST', url: '/api/sim', status: 502, json: { error: 'market-data:http' } },
    ]);
    await act(async () => {
      root.render(d(SimPage));
    });
    await fillBaseFields();
    await submitForm();
    expect(document.body.textContent).toContain('The market data provider returned an error or could not be reached');
    expect(document.body.textContent).not.toContain('market-data:http');
    expect(document.body.textContent).not.toContain('The request failed');
  });

  it('marks 3.55 invalid with the shared rule and disables submit', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await fillBaseFields();
    await type('cutLossInput', '3.55');
    expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBe('true');
    expect(runButton().disabled).toBe(true);
    await type('cutLossInput', '3.5');
    expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBeNull();
    expect(runButton().disabled).toBe(false);
  });

  it('rejects a four-decimal cost without calling the API', async () => {
    await act(async () => {
      root.render(d(SimPage));
    });
    await act(async () => {
      await Promise.resolve();
    });
    await fillBaseFields();
    await type('costInput', '0.0701');
    expect(inputByTestId('costInput').getAttribute('aria-invalid')).toBe('true');
    expect(runButton().disabled).toBe(true);

    // Enter in a field still fires a native submit: it must explain, not call the API.
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    calls = stub.map((c) => ({ url: c.url, body: c.body as Record<string, unknown> }));
    expect(calls.length).toBe(0);
    expect(document.body.textContent).toContain('at most 3 decimals');
  });
});
