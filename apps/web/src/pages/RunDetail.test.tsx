// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls, Route } from '../testing/fetchStub';

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
  cutLossPpm: 35_000, // 3.5%
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
  progressView: { heldCount: 0, cashCents: 100_000, exposureCents: 0, realizedCents: 0, winRate: null },
  state: { buckets: [], cashCents: 100_000, closed: [], ages: {} },
};

const BARS = {
  start: '2026-11-04',
  bars: [
    { tradeDate: '2026-11-04', close: '470500' },
    { tradeDate: '2026-11-05', close: '482500' },
  ],
};

let calls: FetchCalls;
let posts: Post[] = [];
let runGetCount = 0;
let runBody: Record<string, unknown> = RUN;

// Sub-resource GETs must come before the bare /api/runs/1 route: the helper
// matches by substring, so the run route would otherwise swallow them.
const SUB_ROUTES: Route[] = [
  { url: '/price-history', json: BARS },
  { url: '/orders', json: [] },
  { url: '/fills', json: [] },
  { url: '/notifications', json: [] },
  { url: '/closed', json: [] },
];

function stubFetch() {
  const routes: Route[] = [
    { method: 'POST', url: '', json: { ok: true } },
    ...SUB_ROUTES,
    {
      url: '/api/runs/1',
      get json() {
        return runBody;
      },
    },
  ];
  runBody = RUN;
  calls = installFetchStub(routes);
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  // Mirror recorded calls into `posts`; the helper only records non-GET calls.
  posts = calls.map((c) => ({ url: c.url, body: c.body as Record<string, unknown> }));
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

describe('RunDetailPage add-fill button', () => {
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

  it('keeps the tab bar data-only and puts Add fill in the header actions row', () => {
    // Header actions row is `gap-2 items-center`; the tab row is `gap-1`.
    const tabRow = document.querySelector('div.flex.flex-wrap.gap-1');
    expect(tabRow).not.toBeNull();
    expect([...tabRow!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Orders',
      'Pending',
      'Fills',
      'History',
      'Alerts',
    ]);
    const btns = Array.from(document.querySelectorAll('[data-testid="tabManual"]'));
    expect(btns.length).toBe(1);
    expect(btns[0]!.textContent).toBe('Add fill');
    // No inline manual form any more: the Shares input only exists inside the dialog.
    expect(document.querySelector('[data-testid="manualSideSelect"]')).toBeNull();
  });

  it('opens the shared fill dialog with side selectable, defaulting to buy', async () => {
    await act(async () => {
      (document.querySelector('[data-testid="tabManual"]') as HTMLElement).click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const side = document.querySelector('[data-testid="manualSideSelect"]') as HTMLSelectElement | null;
    expect(side).not.toBeNull();
    expect(side!.disabled).toBe(false);
    expect(side!.value).toBe('buy');
  });
});

const CLOSED_ROW = {
  index: 0,
  shares: 120,
  buyPrice: '4000000', // myriadths
  soldPrice: '4200000',
  buyFeeCents: 500,
  sellFeeCents: 500,
  openedOn: '2026-11-02',
  closedOn: '2026-11-05',
};

const RUN_WITH_HISTORY = {
  ...RUN,
  state: { ...RUN.state, closed: [CLOSED_ROW] },
};

// Route set with a switchable POST /api/runs/1/recalc endpoint. The helper
// re-reads status/json on every matched request, so mutating `flag` mid-test
// switches the endpoint between the 422 and 200 shapes.
function stubFetchWithRecalc(): { recalcFails: boolean; recalcCode: string; deltaCents: number; fillCount: number } {
  const flag = { recalcFails: true, recalcCode: 'no-run', deltaCents: 0, fillCount: 3 };
  runGetCount = 0;
  const routes: Route[] = [
    {
      method: 'POST',
      url: '/recalc',
      get status() {
        return flag.recalcFails ? 422 : 200;
      },
      get json() {
        return flag.recalcFails
          ? { error: flag.recalcCode }
          : { ok: true, deltaCents: flag.deltaCents, fillCount: flag.fillCount };
      },
    },
    { method: 'POST', url: '', json: { ok: true } },
    ...SUB_ROUTES,
    {
      url: '/api/runs/1',
      // Counted here because the helper records non-GET calls only:
      // one fire per GET of the run itself.
      get json() {
        runGetCount += 1;
        return RUN_WITH_HISTORY;
      },
    },
  ];
  calls = installFetchStub(routes);
  return flag;
}

const recalcPosts = () => posts.filter((p) => p.url.endsWith('/recalc'));

describe('RunDetailPage history recalc error handling', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let recalcFlag: { recalcFails: boolean; recalcCode: string };

  beforeEach(async () => {
    recalcFlag = stubFetchWithRecalc();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      buttonByText('History').click();
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('shows the localized recalc error and clears it on the next successful recalc', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).toContain('Run not found.');
    expect(recalcPosts().length).toBe(1);

    recalcFlag.recalcFails = false;
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).not.toContain('Run not found.');
    expect(recalcPosts().length).toBe(2);
  });

  it('localizes known domain error codes instead of showing the raw code', async () => {
    recalcFlag.recalcCode = 'bucket-not-held';
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).toContain('This bucket is not currently held.');
    expect(document.body.textContent).not.toContain('bucket-not-held');
  });

  it('falls back to the raw code for unknown recalc errors', async () => {
    recalcFlag.recalcCode = 'zzz';
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).toContain('zzz');
  });
});

describe('RunDetailPage recalc result popup', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let recalcFlag: { recalcFails: boolean; recalcCode: string; deltaCents: number; fillCount: number };

  beforeEach(async () => {
    recalcFlag = stubFetchWithRecalc();
    recalcFlag.recalcFails = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      buttonByText('History').click();
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  const popup = () => document.querySelector('[data-testid="recalcResult"]');
  // GETs of the run itself — one per useAsync reload().
  const runGets = () => runGetCount;

  it('shows the result popup after a successful recalc', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(popup()).not.toBeNull();
    expect(popup()!.textContent).toContain('Recalculation complete');
    expect(popup()!.textContent).toContain('No cash adjustment was needed.');
    expect(popup()!.textContent).toContain('Rebuilt run state from 3 fills.');
  });

  it('reports a booked cash adjustment in the popup', async () => {
    recalcFlag.deltaCents = -120;
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(popup()).not.toBeNull();
    expect(popup()!.textContent).toContain('Cash was off by');
    expect(popup()!.textContent).toContain('-$1.20');
  });

  it('dismisses the popup on OK and refetches the run', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(popup()).not.toBeNull();
    const before = runGets();
    await act(async () => {
      buttonByText('OK').click();
    });
    await flush();
    expect(popup()).toBeNull();
    expect(runGets()).toBe(before + 1);
  });

  it('refetches the run when the popup is dismissed with the X button', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    const before = runGets();
    await act(async () => {
      document
        .querySelector('[data-testid="recalcResult"] [role="dialog"] button[aria-label="Cancel"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(popup()).toBeNull();
    expect(runGets()).toBe(before + 1);
  });

  it('refetches the run when the popup is dismissed by clicking the backdrop', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    const before = runGets();
    await act(async () => {
      document
        .querySelector('[data-testid="recalcResult"] [role="dialog"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(popup()).toBeNull();
    expect(runGets()).toBe(before + 1);
  });
});
