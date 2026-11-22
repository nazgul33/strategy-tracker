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

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HELD = [
  { index: 0, shares: 10 },
  { index: 2, shares: 7 },
];

let stub: FetchCalls;
let postFailure: { status: number; error: string } | null = null;

function element(id: string): Element | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function bucketSelect(): HTMLSelectElement {
  const el = element('manualBucketSelect');
  if (!(el instanceof HTMLSelectElement)) throw new Error('bucket select not found');
  return el;
}

function optionTexts(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((o) => o.textContent ?? '');
}

async function choose(el: Element | null, value: string) {
  if (!(el instanceof HTMLSelectElement)) throw new Error('not a select');
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
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

async function fillAndAdd() {
  await type('manualSharesInput', '5');
  await type('manualPriceInput', '12.5');
  const add = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Add fill');
  if (!add) throw new Error('Add button not found');
  await act(async () => {
    add.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function postedBody(): Record<string, unknown> {
  expect(stub.length).toBe(1);
  return stub[0]!.body as Record<string, unknown>;
}

describe('FillDialog bucket selector', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function render(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(d(FillDialog, { runId: 7, heldBuckets: HELD, onClose: () => {}, onSaved: () => {}, ...props }));
    });
  }

  beforeEach(() => {
    postFailure = null;
    stub = installFetchStub([
      {
        method: 'POST',
        url: '',
        get status() {
          return postFailure ? postFailure.status : 200;
        },
        get json() {
          return postFailure ? { error: postFailure.error } : { ok: true };
        },
      },
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

  it('shows no bucket selector while the side is buy', async () => {
    await render();
    expect(element('manualBucketSelect')).toBeNull();
  });

  it("a sell offers Automatic and the run's held buckets", async () => {
    await render();
    await choose(element('manualSideSelect'), 'sell');
    expect(optionTexts(bucketSelect())).toEqual(['Automatic', 'Bucket 0 · 10 sh', 'Bucket 2 · 7 sh']);
    expect(bucketSelect().value).toBe('');
  });

  it('Automatic posts no bucketIdx', async () => {
    await render();
    await choose(element('manualSideSelect'), 'sell');
    await fillAndAdd();
    const body = postedBody();
    expect(body.side).toBe('sell');
    expect('bucketIdx' in body).toBe(false);
  });

  it('a chosen bucket is posted as bucketIdx', async () => {
    await render();
    await choose(element('manualSideSelect'), 'sell');
    await choose(bucketSelect(), '2');
    await fillAndAdd();
    expect(postedBody().bucketIdx).toBe(2);
  });

  it('a bucket chosen and then the side switched to buy posts no bucketIdx', async () => {
    await render();
    await choose(element('manualSideSelect'), 'sell');
    await choose(bucketSelect(), '2');
    await choose(element('manualSideSelect'), 'buy');
    await fillAndAdd();
    const body = postedBody();
    expect(body.side).toBe('buy');
    expect('bucketIdx' in body).toBe(false);
  });

  it('edit mode has no bucket selector', async () => {
    await render({
      fill: {
        id: 3,
        runId: 7,
        bucketIdx: 1,
        side: 'sell',
        ticker: 'AAPL',
        shares: 10,
        price: '3402300',
        fee: 102,
        filledOn: '2026-11-06',
        source: 'manual',
        createdAt: '2026-11-06 10:00:00',
      },
    });
    expect(element('manualBucketSelect')).toBeNull();
  });

  it('reads a bucket-not-held answer localized', async () => {
    postFailure = { status: 422, error: 'bucket-not-held' };
    await render();
    await choose(element('manualSideSelect'), 'sell');
    await choose(bucketSelect(), '0');
    await fillAndAdd();
    expect(element('error')?.textContent).toBe('This bucket is not currently held.');
  });
});
