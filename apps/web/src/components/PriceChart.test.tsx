// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PriceChart } = await import('./PriceChart');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let historyUrls: string[] = [];

const BARS = [
  { tradeDate: '2026-11-04', close: '470500' }, // $47.05
  { tradeDate: '2026-11-05', close: '482500' }, // $48.25
  { tradeDate: '2026-11-06', close: '465000' }, // $46.50
];

function stubFetch(bars: { tradeDate: string; close: string }[]) {
  historyUrls = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('/fills')) {
      return new Response(
        JSON.stringify([{ id: 1, runId: 1, side: 'buy', filledOn: '2026-11-05' }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/price-history')) {
      historyUrls.push(u);
      return new Response(JSON.stringify({ start: bars[0]?.tradeDate ?? null, bars }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function flush() {
  // two chained fetches (fills → price-history) need a few microtask turns
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function byTestId(id: string): Element | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('PriceChart', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  });

  it('draws one polyline vertex per bar and shows the latest close below', async () => {
    stubFetch(BARS);
    await act(async () => root.render(d(PriceChart, { runId: 1 })));
    await flush();

    const line = byTestId('priceChartLine');
    expect(line).not.toBeNull();
    expect(line!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(BARS.length);

    // chart window anchors on the first buy → start param is sent
    expect(historyUrls[0]).toContain('start=');

    const current = byTestId('priceChartCurrent');
    expect(current!.textContent).toContain('$46.50');
    expect(current!.textContent).toContain('2026-11-06');
  });

  it('hovering shows a tooltip with the nearest bar, leaving hides it', async () => {
    stubFetch(BARS);
    await act(async () => root.render(d(PriceChart, { runId: 1 })));
    await flush();

    const svg = byTestId('priceChartSvg')!;
    // happy-dom reports a zero-width rect, so any x clamps to the last bar
    await act(async () => {
      svg.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 320 }));
    });
    const tip = byTestId('priceChartTooltip');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain('2026-11-06');
    expect(tip!.textContent).toContain('$46.50');

    // React derives onMouseLeave from native mouseout; a raw "mouseleave"
    // event never reaches the delegated handler.
    await act(async () => {
      svg.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }));
    });
    expect(byTestId('priceChartTooltip')).toBeNull();
  });

  it('shows the empty hint when no bars were collected', async () => {
    stubFetch([]);
    await act(async () => root.render(d(PriceChart, { runId: 1 })));
    await flush();

    expect(byTestId('priceChartLine')).toBeNull();
    expect(byTestId('priceChartEmpty')!.textContent).toContain('No price history yet');
  });
});

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
