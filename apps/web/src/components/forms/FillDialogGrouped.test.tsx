import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() (see FillDialog.test.tsx).
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillDialog } = await import('./FillDialog');
const { lookup } = await import('../../i18n/catalog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FILL = {
  id: 3,
  runId: 7,
  bucketIdx: 1,
  side: 'sell' as const,
  ticker: 'AAPL',
  shares: 10,
  price: '3402300',
  fee: 102,
  filledOn: '2026-11-06',
  source: 'manual' as const,
  createdAt: '2026-11-06 10:00:00',
};

let stub: FetchCalls;

function element(id: string): Element | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function type(id: string, value: string) {
  const el = element(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`[${id}] is not an input`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function press(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!button) throw new Error(`button "${label}" not found`);
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('FillDialog grouped prices', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function render(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(d(FillDialog, { runId: 7, onClose: () => {}, onSaved: () => {}, ...props }));
    });
  }

  beforeEach(() => {
    stub = installFetchStub([
      { method: 'POST', url: '/api/runs/7/fills', json: { ok: true } },
      { method: 'PUT', url: '/api/runs/7/fills/3', json: { ok: true, deltaCents: 0 } },
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

  it('add mode posts a grouped price without its commas', async () => {
    await render();
    await type('manualSharesInput', '10');
    await type('manualPriceInput', '1,234.50');
    await press('Add fill');
    expect(element('error')).toBeNull();
    expect(stub.length).toBe(1);
    expect(stub[0]!.method).toBe('POST');
    expect(stub[0]!.url).toContain('/api/runs/7/fills');
    expect((stub[0]!.body as { price: string }).price).toBe('1234.50');
  });

  it('modify mode reads a grouped price as cents', async () => {
    await render({ fill: FILL });
    await type('manualPriceInput', '1,234.50');
    await press('Save');
    expect(element('error')).toBeNull();
    expect(stub.length).toBe(1);
    expect(stub[0]!.method).toBe('PUT');
    expect((stub[0]!.body as { priceCents: number }).priceCents).toBe(123450);
  });

  it('a malformed grouping is still refused', async () => {
    await render();
    await type('manualSharesInput', '10');
    await type('manualPriceInput', '1,23.40');
    await press('Add fill');
    expect(element('error')?.textContent).toBe(lookup('en', 'manualInvalidPrice'));
    expect(stub.length).toBe(0);
  });

  it('a malformed grouping is also refused in modify mode', async () => {
    await render({ fill: FILL });
    await type('manualPriceInput', '1,23.40');
    await press('Save');
    expect(element('error')?.textContent).toBe(lookup('en', 'manualInvalidPrice'));
    expect(stub.length).toBe(0);
  });

  it('the price field explains the grouping', async () => {
    await render();
    expect(document.body.textContent).toContain('Commas group thousands: 1,234.50 is read as 1234.50.');
  });

  it('the grouping hint is catalogued in Korean', () => {
    expect(lookup('ko', 'manualPriceHint')).toBe('쉼표는 천 단위 구분 기호입니다: 1,234.50은 1234.50으로 읽습니다.');
  });
});
