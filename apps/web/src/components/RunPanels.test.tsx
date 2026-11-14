import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillsPanel } = await import('./RunPanels');
const { LangProvider } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// FillsDto wire shape (price = myriadths string, fee = cents); the server lists
// fills id-ascending, so the deletable set is the newest row of each bucket —
// here {1, 3}: id 3 is bucket 0's last fill, id 1 is bucket 1's last fill.
const FILLS = [
  {
    id: 1,
    runId: 7,
    ticker: 'QQQ',
    side: 'buy' as const,
    bucketIdx: 1,
    shares: 4,
    price: '3000000',
    fee: 90,
    source: 'manual' as const,
    filledOn: '2026-11-10',
    createdAt: '2026-11-10T15:30:00Z',
  },
  {
    id: 2,
    runId: 7,
    ticker: 'QQQ',
    side: 'buy' as const,
    bucketIdx: 0,
    shares: 10,
    price: '3402300',
    fee: 102,
    source: 'capture' as const,
    filledOn: '2026-11-11',
    createdAt: '2026-11-11T15:30:00Z',
  },
  {
    id: 3,
    runId: 7,
    ticker: 'QQQ',
    side: 'sell' as const,
    bucketIdx: 0,
    shares: 20,
    price: '3500000',
    fee: 105,
    source: 'manual' as const,
    filledOn: '2026-11-12',
    createdAt: '2026-11-12T15:30:00Z',
  },
];

interface FetchCall {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let failDelete = false;
let delDelta = 0; // deltaCents returned by the DELETE stub

function stubFetch() {
  calls = [];
  failDelete = false;
  delDelta = 0;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      calls.push({ method, url: u, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      if (method === 'DELETE' && failDelete) {
        return new Response(JSON.stringify({ error: 'not-last' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        });
      }
      const payload =
      method === 'DELETE' ? { ok: true, deletedFillId: 3, deltaCents: delDelta } : { ok: true };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/runs/7/fills')) {
      return new Response(JSON.stringify(FILLS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function inputByTestId(id: string): HTMLInputElement {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`input [${id}] not found`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

describe('FillsPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mutated = 0;

  beforeEach(async () => {
    stubFetch();
    mutated = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(d(LangProvider, null, d(FillsPanel, { runId: 7, onMutated: () => (mutated += 1) })));
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.fetch = realFetch;
  });

  it('renders the fills table from the stubbed GET with an Edit button per row', () => {
    expect(document.getElementById('fillEdit-2')).not.toBeNull();
    expect(document.getElementById('fillEdit-3')).not.toBeNull();
    expect(document.body.textContent ?? '').not.toContain('No fills.');
    // One row-level Delete per bucket: that bucket's newest fill (ids 1 and 3).
    expect(document.getElementById('fillDelete-1')).not.toBeNull();
    expect(document.getElementById('fillDelete-3')).not.toBeNull();
    expect(document.getElementById('fillDelete-2')).toBeNull();
  });

  it('edits the buy row: prefilled, PUTs the payload, fires onMutated once, unmounts', async () => {
    await click(document.getElementById('fillEdit-2')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(inputByTestId('manualSharesInput').value).toBe('10');

    await act(async () => {
      setInputValue(inputByTestId('manualSharesInput'), '20');
    });
    await click(button('Save'));

    const put = calls.filter((c) => c.method === 'PUT');
    expect(put.length).toBe(1);
    expect(put[0]!.url).toContain('/api/runs/7/fills/2');
    expect(put[0]!.body.qty).toBe(20);
    expect(mutated).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows Delete in the dialog for each bucket's last fill", async () => {
    await click(document.getElementById('fillEdit-3')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="fillDeleteBtn"]')).not.toBeNull();
    await click(button('Cancel'));

    await click(document.getElementById('fillEdit-1')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="fillDeleteBtn"]')).not.toBeNull();
    await click(button('Cancel'));

    // id 2 shares bucket 0 with the newer id 3, so the server would reject it.
    await click(document.getElementById('fillEdit-2')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="fillDeleteBtn"]')).toBeNull();
  });

  it('deletes from the row: confirm modal, DELETE recorded, onMutated fired', async () => {
    await click(document.getElementById('fillDelete-1')!);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent ?? '').toContain('(4 shares)');

    await click(button('Delete for real'));

    const del = calls.filter((c) => c.method === 'DELETE');
    expect(del.length).toBe(1);
    expect(del[0]!.url).toContain('/api/runs/7/fills/1');
    expect(mutated).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('row delete cancel: no DELETE call, dialog closed', async () => {
    await click(document.getElementById('fillDelete-1')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click(button('Cancel'));

    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('row delete rejected by the server: dialog stays open with the error, onMutated not fired', async () => {
    failDelete = true;
    await click(document.getElementById('fillDelete-1')!);
    await click(button('Delete for real'));

    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent ?? '').toContain('Delete failed.');
    expect(mutated).toBe(0);
  });

  it('deletes the last fill through the confirm step: DELETE recorded, onMutated fired', async () => {
    await click(document.getElementById('fillEdit-3')!);
    await click(document.querySelector('[data-testid="fillDeleteBtn"]')!);
    expect(button('Delete for real')).toBeDefined();
    await click(button('Delete for real'));

    const del = calls.filter((c) => c.method === 'DELETE');
    expect(del.length).toBe(1);
    expect(del[0]!.url).toContain('/api/runs/7/fills/3');
    expect(mutated).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('row delete with a nonzero delta: result modal first, OK dismisses and fires onMutated', async () => {
    delDelta = 80;
    await click(document.getElementById('fillDelete-1')!);
    await click(button('Delete for real'));

    // Confirm modal is gone; the result modal is up with the booked adjustment.
    expect(document.body.textContent ?? '').toContain('Recalculation complete');
    expect(document.body.textContent ?? '').toContain('$0.80');
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();
    expect(mutated).toBe(0);

    await click(button('OK'));
    expect(document.body.textContent ?? '').not.toContain('Recalculation complete');
    expect(mutated).toBe(1);
  });

  it('dialog delete with a nonzero delta also gates onMutated behind the OK', async () => {
    delDelta = -120;
    await click(document.getElementById('fillEdit-3')!);
    await click(document.querySelector('[data-testid="fillDeleteBtn"]')!);
    await click(button('Delete for real'));
    // FillDialog's own success step holds onSaved, so onMutated waits for OK.
    expect(document.body.textContent ?? '').toContain('-$1.20');
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();
    expect(mutated).toBe(0);
    await click(button('OK'));
    expect(mutated).toBe(1);
  });

  // Re-render the shared root with closed bucket 0 (fills 2 and 3 live there).
  async function mountClosedBucketPanel() {
    await act(async () => {
      root.render(d(LangProvider, null, d(FillsPanel, { runId: 7, closedIndexes: [0], onMutated: () => {} })));
    });
    await flush();
  }

  it('row delete confirm warns when the bucket is closed', async () => {
    await mountClosedBucketPanel();
    await click(document.getElementById('fillDelete-3')!); // bucket 0, closed
    expect(document.querySelector('[role="dialog"]')!.textContent ?? '').toContain(
      'This fill belongs to a closed position. Saving re-derives all later history and may book a cash adjustment.',
    );
  });

  it('row delete confirm does not warn for an open bucket', async () => {
    await mountClosedBucketPanel();
    await click(document.getElementById('fillDelete-1')!); // bucket 1, open
    expect(document.querySelector('[role="dialog"]')!.textContent ?? '').not.toContain('closed position');
  });

  it('edit dialog warns when the fill is in a closed bucket', async () => {
    await mountClosedBucketPanel();
    await click(document.getElementById('fillEdit-2')!); // bucket 0, closed
    expect(document.querySelector('[role="dialog"]')!.textContent ?? '').toContain(
      'This fill belongs to a closed position. Saving re-derives all later history and may book a cash adjustment.',
    );
  });
});
