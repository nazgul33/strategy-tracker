// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { holdNext } from '../testing/holdFetch';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { VR_CYCLE, VR_DETAIL, vrDetail } from '../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrRunPage } = await import('./VrRun');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const SERVER_ERROR = 'The server had a problem (http-500). Try again; if it keeps failing, check the server log.';
const EMPTY = { buy: [], sell: [], buyTotal: 0, sellTotal: 0 };

let detail: unknown = VR_DETAIL;
let detailStatus = 200;
let detailGets = 0;
let cycleGets = 0;
let noticeGets = 0;

const routes = () => [
  { method: 'PATCH' as const, url: '/api/vr/runs/5', status: 200, json: { ok: true } as unknown },
  {
    url: '/cycles',
    get json() {
      cycleGets += 1;
      return [VR_CYCLE];
    },
  },
  {
    url: '/notifications',
    get json() {
      noticeGets += 1;
      return [{ id: 1, runId: 5, chatId: '42', text: 'Cycle 3 opened', sentAt: '2026-12-07 07:30:00' }];
    },
  },
  { url: '/fills', json: [] },
  { url: '/cash', json: [] },
  {
    url: '/api/vr/runs/5',
    get status() {
      return detailStatus;
    },
    get json() {
      detailGets += 1;
      return detail;
    },
  },
];

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const summary = () => byId('vrSummary')!;
const statValueEl = (label: string) =>
  [...summary().querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === label)!
    .nextElementSibling as HTMLElement;
const stat = (label: string) => statValueEl(label).textContent;
const rows = (id: string) =>
  [...document.querySelectorAll(`[data-testid="${id}"] tbody tr`)].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

describe('VrRunPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const buttonByText = (text: string) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`button [${text}] not found`);
    return btn;
  };
  const render = async () => {
    await act(async () => root.render(d(VrRunPage, { id: 5 })));
    await flush();
  };
  const click = async (text: string) => {
    await act(async () => buttonByText(text).click());
    await flush();
  };

  beforeEach(() => {
    detail = VR_DETAIL;
    detailStatus = 200;
    detailGets = 0;
    cycleGets = 0;
    noticeGets = 0;
    installFetchStub(routes());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('renders the header, the cycle line, every stat and both ladders', async () => {
    await render();
    const root5 = byId('vr-run-page')!;
    expect(root5.getAttribute('data-run-id')).toBe('5');
    const h1 = document.querySelector('h1')!.textContent!;
    for (const want of ['TQQQ lump sum', 'TQQQ', 'Active']) expect(h1).toContain(want);
    expect(byId('vrCycleLine')!.textContent).toBe('Cycle 3 · 2026-12-07 – 2026-12-20 · next cycle 2026-12-21');

    expect(stat('V')).toBe('$9,350.00');
    expect(stat('Band')).toBe('$7,947.50 – $10,752.50');
    expect(stat('G · formula')).toBe('10 · Skill formula');
    expect(stat('Shares')).toBe('179');
    expect(stat('Pool')).toBe('$864.46');
    expect(stat('Budget left')).toBe('$364.55');
    expect(statValueEl('Budget left').nextElementSibling!.textContent).toBe('of $500.00');
    expect(stat('Value')).toBe('$9,098.46');
    expect(stat('Net invested')).toBe('$10,000.00');
    expect(stat('Profit')).toBe('-$901.54');
    expect(statValueEl('Profit').classList.contains('text-destructive')).toBe(true);
    expect(stat('Average cost')).toBe('$51.03');
    expect(byId('vrPoolNegative')).toBeNull();

    expect(rows('vrBuyLadder')).toEqual([
      ['3', '$44.39'],
      ['3', '$43.66'],
    ]);
    expect(byId('vrBuyLadder')!.querySelector('h3')!.textContent).toContain('2 of 3 rungs left');
    expect(rows('vrSellLadder')).toHaveLength(22);
    expect(rows('vrSellLadder').slice(0, 2)).toEqual([
      ['2', '$61.10'],
      ['2', '$61.80'],
    ]);
    expect(byId('vrSellLadder')!.querySelector('h3')!.textContent).toContain('22 of 22 rungs left');
  });

  it('shows the empty note for an empty buy side', async () => {
    detail = vrDetail({ ladder: { ...VR_DETAIL.ladder, buy: [] } });
    await render();
    const buy = byId('vrBuyLadder')!;
    expect(buy.textContent).toContain('0 of 3 rungs left');
    expect(buy.textContent).toContain('No open rungs.');
    expect(buy.querySelector('tbody')).toBeNull();
    expect(rows('vrSellLadder')).toHaveLength(22);
  });

  it('shows dashes for value and profit without a last close, and renders the page', async () => {
    detail = {
      ...VR_DETAIL,
      lastClose: null,
      books: { ...VR_DETAIL.books, evalCents: null, valueCents: null, profitCents: null },
    };
    await render();
    expect(stat('Value')).toBe('—');
    expect(stat('Profit')).toBe('—');
    expect(statValueEl('Profit').classList.contains('text-destructive')).toBe(false);
    expect(stat('Average cost')).toBe('$51.03');
    expect(rows('vrBuyLadder')).toHaveLength(2);
  });

  it('shows a dash for an average cost that is null', async () => {
    detail = { ...VR_DETAIL, books: { ...VR_DETAIL.books, avgCost: null } };
    await render();
    expect(stat('Average cost')).toBe('—');
  });

  it('shows the buy instruction instead of the ladders', async () => {
    detail = vrDetail({
      books: { ...VR_DETAIL.books, shares: 0 },
      buyInstruction: { shares: 203, targetCents: 935_000 },
      ladder: EMPTY,
    });
    await render();
    expect(byId('vrBuyInstruction')!.textContent).toBe('Buy 203 shares, about $9,350.00 at the last close of $46.00 on 2026-12-08.');
    expect(byId('vrBuyLadder')).toBeNull();
    expect(byId('vrSellLadder')).toBeNull();
  });

  it('before cycle 1 the cycle line says so and V and the budget are dashes', async () => {
    detail = vrDetail({
      cycle: null,
      budgetLeftCents: null,
      books: { shares: 0, poolCents: 1_000_000, netInvestedCents: 1_000_000, avgCost: null, evalCents: 0, valueCents: 1_000_000, profitCents: 0 },
      buyInstruction: { shares: 195, targetCents: 900_000 },
      ladder: EMPTY,
    });
    await render();
    expect(byId('vrCycleLine')!.textContent).toBe('No cycle yet.');
    expect(stat('V')).toBe('—');
    expect(stat('Band')).toBe('—');
    expect(stat('Budget left')).toBe('—');
    expect(statValueEl('Budget left').nextElementSibling).toBeNull();
    expect(stat('G · formula')).toBe('10 · Skill formula');
    expect(byId('vrBuyInstruction')!.textContent).toBe('Buy 195 shares, about $9,000.00 at the last close of $46.00 on 2026-12-08.');
  });

  it('says the instruction arrives with the morning message when there is no close', async () => {
    detail = vrDetail({
      cycle: null,
      budgetLeftCents: null,
      lastClose: null,
      books: { shares: 0, poolCents: 1_000_000, netInvestedCents: 1_000_000, avgCost: null, evalCents: null, valueCents: null, profitCents: null },
      buyInstruction: null,
      ladder: EMPTY,
    });
    await render();
    expect(byId('vrBuyPending')).not.toBeNull();
    expect(byId('vrBuyInstruction')).toBeNull();
  });

  it('says the ladder arrives with the next cycle when shares are held and there is no ladder', async () => {
    detail = vrDetail({ cycle: null, budgetLeftCents: null, ladder: EMPTY });
    await render();
    expect(byId('vrLadderNextCycle')).not.toBeNull();
    expect(byId('vrBuyLadder')).toBeNull();
  });

  it('warns about a negative Pool', async () => {
    detail = vrDetail({ books: { ...VR_DETAIL.books, poolCents: -1_230 } });
    await render();
    expect(stat('Pool')).toBe('-$12.30');
    expect(byId('vrPoolNegative')!.textContent).toBe('The Pool is below zero. Check the cash movements against the broker.');
  });

  it('keeps the root attributes while loading and then shows the run', async () => {
    const hold = holdNext('GET', '/api/vr/runs/5');
    await act(async () => root.render(d(VrRunPage, { id: 5 })));
    expect(container.textContent).toBe('…');
    expect(document.querySelector('[data-testid="vr-run-page"][data-run-id="5"]')).not.toBeNull();
    hold.release();
    await flush();
    expect(container.textContent).toContain('TQQQ lump sum');
  });

  it('shows a server error with Retry, keeps the root attributes, and recovers', async () => {
    detailStatus = 500;
    detail = {};
    await render();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(SERVER_ERROR);
    expect(document.querySelector('[data-testid="vr-run-page"][data-run-id="5"]')).not.toBeNull();
    detailStatus = 200;
    detail = VR_DETAIL;
    await click('Retry');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(byId('vrSummary')).not.toBeNull();
  });

  it('loads the Cycles and Alerts tabs when they are selected', async () => {
    await render();
    expect(byId('vrFillsPanel')).not.toBeNull();
    expect(cycleGets).toBe(0);
    const before = detailGets;

    await click('Cycles');
    expect(cycleGets).toBe(1);
    expect(detailGets).toBe(before + 1);
    expect(byId('vrFillsPanel')).toBeNull();
    const cycleRows = [...container.querySelectorAll('tbody tr')].filter((tr) => tr.textContent!.includes('2026-12-07 – 2026-12-20'));
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0]!.textContent).toContain('$9,350.00');

    expect(noticeGets).toBe(0);
    await click('Alerts');
    expect(noticeGets).toBe(1);
    expect(container.textContent).toContain('Cycle 3 opened');

    await click('Cash');
    expect(byId('vrCashPanel')).not.toBeNull();
    expect(byId('vrFillsPanel')).toBeNull();
  });
});
