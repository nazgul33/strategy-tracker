// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';
import { RUN, buttonByText, inputByTestId, runDetailHelpers, runDetailRoutes } from '../testing/runDetail';
import type { Post } from '../testing/runDetail';

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

let calls: FetchCalls;
let posts: Post[] = [];
let runBody: Record<string, unknown> = RUN;

function stubFetch() {
  runBody = RUN;
  calls = installFetchStub(runDetailRoutes(() => runBody));
}

const { flush, type, openEditModal } = runDetailHelpers({
  act,
  calls: () => calls,
  onPosts: (mirrored) => (posts = mirrored),
});

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
    restoreFetch();
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
    expect(inputByTestId('cutLossInput').value).toBe('3.5');
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
    expect(gaps!.body).toEqual({ buyGapPpm: 30_000, sellGapPpm: 10_000, cutLossPpm: 35_000 });
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
    expect(gaps!.body).toEqual({ buyGapPpm: 25_000, sellGapPpm: 5_000, cutLossPpm: 35_000 });
  });

  it('disables Save on malformed cut-loss text', async () => {
    await openEditModal();
    await type('cutLossInput', '60');
    expect(buttonByText('Save').disabled).toBe(true);
  });

  it('disables Save on malformed gap text', async () => {
    await openEditModal();
    await type('gapBuyInput', 'abc');
    expect(buttonByText('Save').disabled).toBe(true);
  });
});

describe('RunDetailPage cut-loss', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const mount = async (run: Record<string, unknown>) => {
    stubFetch();
    runBody = run;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
  };

  const statValue = (label: string): string | null => {
    const el = Array.from(document.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent === label);
    return el?.parentElement?.textContent?.replace(label, '') ?? null;
  };

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('shows the cut-loss percent beside the gaps', async () => {
    await mount(RUN);
    expect(statValue('Cut loss')).toBe('3.5%');
  });

  it('shows the default marker when cut-loss is 0', async () => {
    await mount({ ...RUN, cutLossPpm: 0 });
    expect(statValue('Cut loss')).toBe('default');
  });

  it('feeds the chart close and held buckets into the modal underwater warning', async () => {
    // Latest chart close is 48.25. Held at 50.00, 3.0% => trigger 48.50 >= 48.25.
    await mount({
      ...RUN,
      cutLossPpm: 0,
      state: {
        ...RUN.state,
        buckets: [
          { index: 0, state: 'held', shares: 10, buyPrice: '500000', buyFeeCents: 0, filledOn: '2026-11-02' },
          { index: 1, state: 'held', shares: 10, buyPrice: '400000', buyFeeCents: 0, filledOn: '2026-11-03' },
        ],
      },
    });
    await openEditModal();
    await type('cutLossInput', '3');
    const w = document.querySelector('[data-testid="cutLossWarning"]');
    expect(w).not.toBeNull();
    expect(w!.textContent).toContain('1 held bucket');
    expect(w!.textContent).toContain('$48.25');
  });
});
