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
const { resetDefaultCostMemo } = await import('../../defaultcost');
const { lookup } = await import('../../i18n/catalog');

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
let settingsRoute: { url: string; status: number; json: unknown };

function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

describe('CreateRunForm cost field', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    resetDefaultCostMemo();
    calls = [];
    settingsRoute = {
      url: '/api/settings',
      status: 200,
      json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 },
    };
    stub = installFetchStub([settingsRoute, { method: 'POST', url: '/api/runs', status: 201, json: { id: 7 } }]);
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

  async function renderForm() {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  const failedNote = () => document.querySelector('[data-testid="costDefaultFailed"]');

  it('prefills cost from the settings default and posts ppm', async () => {
    await renderForm();
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
    await renderForm();
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

  it('a cost typed before the default fails to load shows no note', async () => {
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
    await act(async () => {
      setInputValue(inputByLabel('Cost (%)'), '0.2');
    });
    settingsRoute.status = 500;
    await act(async () => {
      release();
      await gate;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(failedNote()!.textContent).toBe('');
    expect(inputByLabel('Cost (%)').value).toBe('0.2');
  });

  it('rejects a four-decimal cost', async () => {
    await renderForm();
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

  it('a failed settings load says so by the cost field, until the operator types', async () => {
    settingsRoute.status = 500;
    await renderForm();
    const note = failedNote()!;
    expect(note.textContent).toBe("Couldn't load the default cost. Enter one.");
    expect(inputByLabel('Cost (%)').value).toBe('');
    await act(async () => setInputValue(inputByLabel('Cost (%)'), '0.1'));
    expect(failedNote()!.textContent).toBe('');
  });

  it('no note text when the default loads', async () => {
    await renderForm();
    expect(failedNote()!.textContent).toBe('');
  });

  it('the note sits outside the cost label and is mounted before the load fails', async () => {
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
    expect(failedNote()).not.toBeNull();
    expect(failedNote()!.textContent).toBe('');
    expect(failedNote()!.closest('label')).toBeNull();

    settingsRoute.status = 500;
    await act(async () => {
      release();
      await gate;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(failedNote()!.textContent).toBe("Couldn't load the default cost. Enter one.");
    expect(failedNote()!.closest('label')).toBeNull();
  });

  it('ko copy for the note', () => {
    expect(lookup('ko', 'costDefaultFailed')).toBe('기본 비용을 불러오지 못했습니다. 직접 입력하세요.');
  });
});
