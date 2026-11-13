// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunDetailPage } = await import('./RunDetail');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const realFetch = globalThis.fetch;

interface Post {
  url: string;
  body: Record<string, unknown>;
}

const RUN = {
  id: 1,
  strategyKey: 'mean-reversion',
  ticker: 'QQQ',
  name: 'Test run',
  poolCents: 100_000,
  costPpm: 3_000,
  buyGapPpm: 25_000, // 2.5%
  sellGapPpm: 10_000, // 1%
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
  progressView: { heldCount: 0, cashCents: 100_000, exposureCents: 0, realizedCents: 0, winRate: null },
  state: { buckets: [], cashCents: 100_000, closed: [], ages: {} },
};

let posts: Post[] = [];

function stubFetch() {
  posts = [];
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/price-history')) {
      return new Response(
        JSON.stringify({
          start: '2026-11-04',
          bars: [
            { tradeDate: '2026-11-04', close: '470500' },
            { tradeDate: '2026-11-05', close: '482500' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.match(/\/api\/runs\/1$/)) {
      return new Response(JSON.stringify(RUN), {
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

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function openEditModal() {
  await act(async () => {
    buttonByText('Edit run').click();
  });
}

describe('RunDetailPage edit-run modal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    stubFetch();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  });

  it('renders the price chart and no standalone gap pane', () => {
    expect(document.querySelector('[data-testid="priceChartLine"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Save gaps');
  });

  it('opens the Edit run modal prefilled with the current gaps', async () => {
    await openEditModal();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(inputByTestId('gapBuyInput').value).toBe('2.5');
    expect(inputByTestId('gapSellInput').value).toBe('1');
  });

  it('sends pool top-up (absolute) and gap ppm together on Save', async () => {
    await openEditModal();
    await type('poolTopupInput', '500');
    await type('gapBuyInput', '3');
    await act(async () => {
      buttonByText('Save').click();
    });
    await flush();

    const pool = posts.find((p) => p.url.includes('/pool'));
    const gaps = posts.find((p) => p.url.includes('/gaps'));
    expect(pool!.body.amountCents).toBe(150_000); // 1000 + 500 USD
    expect(gaps!.body).toEqual({ buyGapPpm: 30_000, sellGapPpm: 10_000 });
  });

  it('saves gaps alone when the top-up field is blank', async () => {
    await openEditModal();
    await type('gapSellInput', '0.5');
    await act(async () => {
      buttonByText('Save').click();
    });
    await flush();

    expect(posts.some((p) => p.url.includes('/pool'))).toBe(false);
    const gaps = posts.find((p) => p.url.includes('/gaps'));
    expect(gaps!.body).toEqual({ buyGapPpm: 25_000, sellGapPpm: 5_000 });
  });

  it('disables Save on malformed gap text', async () => {
    await openEditModal();
    await type('gapBuyInput', 'abc');
    expect(buttonByText('Save').disabled).toBe(true);
  });
});
