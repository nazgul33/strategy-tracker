import type { act as ReactAct } from 'react';
import { inputByTestId, setInputValue } from './dom';
import type { FetchCalls, Route } from './fetchStub';

export interface Post {
  url: string;
  body: Record<string, unknown>;
}

export const RUN = {
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

export const BARS = {
  start: '2026-11-04',
  bars: [
    { tradeDate: '2026-11-04', close: '470500' },
    { tradeDate: '2026-11-05', close: '482500' },
  ],
};

// Sub-resource GETs must come before the bare /api/runs/1 route: the helper
// matches by substring, so the run route would otherwise swallow them.
export const SUB_ROUTES: Route[] = [
  { url: '/price-history', json: BARS },
  { url: '/orders', json: [] },
  { url: '/fills', json: [] },
  { url: '/notifications', json: [] },
  { url: '/closed', json: [] },
];

export const CLOSED_ROW = {
  index: 0,
  shares: 120,
  buyPrice: '4000000', // myriadths
  soldPrice: '4200000',
  buyFeeCents: 500,
  sellFeeCents: 500,
  openedOn: '2026-11-02',
  closedOn: '2026-11-05',
};

export const RUN_WITH_HISTORY = {
  ...RUN,
  state: { ...RUN.state, closed: [CLOSED_ROW] },
};

// The run route re-reads the body on every request, so a test that assigns
// its `runBody` variable changes what later GETs return.
export function runDetailRoutes(runBody: () => Record<string, unknown>): Route[] {
  return [
    { method: 'POST', url: '', json: { ok: true } },
    ...SUB_ROUTES,
    {
      url: '/api/runs/1',
      get json() {
        return runBody();
      },
    },
  ];
}

export function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

export interface RunDetailHelperDeps {
  act: typeof ReactAct;
  calls: () => FetchCalls;
  onPosts?: (posts: Post[]) => void;
}

export function runDetailHelpers({ act, calls, onPosts }: RunDetailHelperDeps) {
  async function flush() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    // Mirror recorded calls into `posts`; the helper only records non-GET calls.
    onPosts?.(calls().map((c) => ({ url: c.url, body: c.body as Record<string, unknown> })));
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

  return { flush, type, openEditModal };
}
