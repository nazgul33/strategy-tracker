// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DashboardDto, DashboardGroupDto, DashboardRowDto } from '../api.dashboard';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { holdNext } from '../testing/holdFetch';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { DashboardPage } = await import('./Dashboard');
const { getToken, setToken } = await import('../api');

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
const MR = 'mean-reversion';
const VR = 'value-rebalancing';

const SOXL: DashboardRowDto = {
  id: 1, name: 'SOXL main', ticker: 'SOXL', status: 'active', shares: 118, close: '361800', closeDate: '2026-11-25',
  closeMark: null, stockCents: 426924, cashCents: 2010510, valueCents: 2437434, waiting: 0,
};
const TQQQ: DashboardRowDto = {
  id: 2, name: 'TQQQ swing', ticker: 'TQQQ', status: 'paused', shares: 95, close: '714000', closeDate: '2026-11-25',
  closeMark: null, stockCents: 678300, cashCents: 1705299, valueCents: 2383599, waiting: 2,
};
const TQQQ_VR: DashboardRowDto = {
  id: 7, name: 'TQQQ VR', ticker: 'TQQQ', status: 'active', shares: 277, close: '714000', closeDate: '2026-11-25',
  closeMark: null, stockCents: 1977780, cashCents: 1212495, valueCents: 3190275, waiting: 2,
};
const IDLE: DashboardRowDto = {
  id: 3, name: 'Idle', ticker: 'SOXL', status: 'active', shares: 0, close: null, closeDate: null,
  closeMark: null, stockCents: 0, cashCents: 100000, valueCents: 100000, waiting: 0,
};

const mrGroup: DashboardGroupDto = { strategy: MR, totalCents: 4821033, incomplete: false, olderClose: false, runs: [SOXL, TQQQ] };
const vrGroup: DashboardGroupDto = { strategy: VR, totalCents: 3190275, incomplete: false, olderClose: false, runs: [TQQQ_VR] };
const DASH: DashboardDto = { today: '2026-11-26', closeDate: '2026-11-25', groups: [mrGroup, vrGroup] };

let gets = 0;
const dash = {
  url: '/api/dashboard',
  status: 200,
  get json(): unknown {
    gets += 1;
    return this.body;
  },
  body: DASH as unknown,
};

describe('DashboardPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const render = async () => {
    await act(async () => root.render(d(DashboardPage)));
    await flush();
  };
  const buttonByText = (text: string) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`button [${text}] not found`);
    return btn;
  };
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const text = (id: string) => q(id)?.textContent;
  const cells = (row: Element | null) => [...row!.querySelectorAll('td')].map((td) => td.textContent ?? '');
  const row = (strategy: string, id: number) => q(`dashRow-${strategy}-${id}`);
  const body = (groups: [DashboardGroupDto, DashboardGroupDto], closeDate: string | null = '2026-11-25'): DashboardDto => ({
    today: '2026-11-26', closeDate, groups,
  });

  beforeEach(() => {
    gets = 0;
    dash.status = 200;
    dash.body = DASH;
    installFetchStub([dash]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('shows the closes date, a card per strategy with its total, and the rows with formatted money', async () => {
    await render();
    expect(text('dashClosesOf')).toBe('closes of 2026-11-25');
    expect(text('dashTotal-mean-reversion')).toBe('$48,210.33');
    expect(text('dashTotal-value-rebalancing')).toBe('$31,902.75');
    expect(q('dashGroup-mean-reversion')!.textContent).toContain('Mean reversion');
    expect(q('dashGroup-value-rebalancing')!.textContent).toContain('Value Rebalancing');
    expect(cells(row(MR, 1))).toEqual(['SOXL main', 'SOXL', 'Active', '118', '$36.18', '$4,269.24', '$20,105.10', '$24,374.34', '']);
    expect(cells(row(MR, 2))).toEqual(['TQQQ swing', 'TQQQ', 'Paused', '95', '$71.40', '$6,783.00', '$17,052.99', '$23,835.99', '2']);
    expect(cells(row(VR, 7))).toEqual(['TQQQ VR', 'TQQQ', 'Active', '277', '$71.40', '$19,777.80', '$12,124.95', '$31,902.75', '2']);
  });

  it('the groups come in the order received', async () => {
    await render();
    const sections = [...container.querySelectorAll('section')].map((s) => s.getAttribute('data-testid'));
    expect(sections).toEqual(['dashGroup-mean-reversion', 'dashGroup-value-rebalancing']);
  });

  it('reads Cash in the mean-reversion table and Pool in the VR table', async () => {
    await render();
    const heads = (g: string) => [...q(g)!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads('dashGroup-mean-reversion')).toEqual(['Run', 'Ticker', 'Status', 'Shares', 'Close', 'Stock value', 'Cash', 'Value', 'Waiting']);
    expect(heads('dashGroup-value-rebalancing')[6]).toBe('Pool');
  });

  it('links each run to its page and a waiting count to its pending list; zero renders nothing', async () => {
    await render();
    expect(container.querySelector('a[href="#/runs/1"]')?.textContent).toBe('SOXL main');
    expect(container.querySelector('a[href="#/vr/7"]')?.textContent).toBe('TQQQ VR');
    const mrWaiting = q('dashWaiting-mean-reversion-2');
    expect(mrWaiting?.getAttribute('href')).toBe('#/pending');
    expect(mrWaiting?.textContent).toBe('2');
    expect(q('dashWaiting-value-rebalancing-7')?.getAttribute('href')).toBe('#/vr/7?tab=pending');
    expect(row(MR, 1)!.querySelector('[data-testid^="dashWaiting"]')).toBeNull();
    expect(cells(row(MR, 1)).at(-1)).toBe('');
  });

  it('a missing close shows the mark and a blank stock value, and its card says the total is incomplete', async () => {
    const missing: DashboardRowDto = { ...SOXL, close: null, closeDate: null, closeMark: 'missing', stockCents: null, valueCents: 2010510 };
    dash.body = body([{ ...mrGroup, totalCents: 4394109, incomplete: true, runs: [missing, TQQQ] }, vrGroup]);
    await render();
    expect(cells(row(MR, 1))).toEqual(['SOXL main', 'SOXL', 'Active', '118', 'close missing', '', '$20,105.10', '$20,105.10', '']);
    expect(row(MR, 1)!.textContent).not.toContain('—');
    expect(text('dashIncomplete-mean-reversion')).toBe('Incomplete: shares without a stored close are not counted.');
    expect(text('dashTotal-mean-reversion')).toBe('$43,941.09');
    expect(q('dashIncomplete-value-rebalancing')).toBeNull();
  });

  it('an older close shows its own date and the mark, and its card says some shares use an older close', async () => {
    const older: DashboardRowDto = { ...TQQQ_VR, closeDate: '2026-11-24', closeMark: 'older' };
    dash.body = body([mrGroup, { ...vrGroup, olderClose: true, runs: [older] }]);
    await render();
    expect(cells(row(VR, 7))[4]).toBe('$71.40older close (2026-11-24)');
    expect(row(VR, 7)!.querySelector('[data-testid="dashCloseOlder"]')).not.toBeNull();
    expect(text('dashOlderClose-value-rebalancing')).toBe('Some shares are valued at an older close.');
    expect(q('dashOlderClose-mean-reversion')).toBeNull();
    expect(q('dashIncomplete-value-rebalancing')).toBeNull();
    expect(text('dashClosesOf')).toBe('closes of 2026-11-25');
  });

  it('a row with no shares shows a blank close and $0.00 stock value, with no mark', async () => {
    dash.body = body([{ ...mrGroup, runs: [SOXL, TQQQ, IDLE] }, vrGroup]);
    await render();
    expect(cells(row(MR, 3))).toEqual(['Idle', 'SOXL', 'Active', '0', '', '$0.00', '$1,000.00', '$1,000.00', '']);
    expect(row(MR, 3)!.querySelector('[data-testid="dashCloseMissing"]')).toBeNull();
    expect(row(MR, 3)!.querySelector('[data-testid="dashCloseOlder"]')).toBeNull();
  });

  it('a strategy with no runs shows the empty line, a $0.00 total and no table', async () => {
    dash.body = body([mrGroup, { strategy: VR, totalCents: 0, incomplete: false, olderClose: false, runs: [] }]);
    await render();
    const vr = q('dashGroup-value-rebalancing')!;
    expect(vr.textContent).toContain('No active or paused runs.');
    expect(text('dashTotal-value-rebalancing')).toBe('$0.00');
    expect(vr.querySelector('table')).toBeNull();
    expect(q('dashGroup-mean-reversion')!.querySelector('table')).not.toBeNull();
  });

  it('shows no closes date when there is none', async () => {
    dash.body = body(
      [{ ...mrGroup, totalCents: 0, runs: [] }, { ...vrGroup, totalCents: 0, runs: [] }],
      null,
    );
    await render();
    expect(q('dashClosesOf')).toBeNull();
    expect(container.textContent).toContain('Dashboard');
  });

  it('shows a server error and recovers on Retry', async () => {
    dash.status = 500;
    dash.body = {};
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SERVER_ERROR);
    dash.status = 200;
    dash.body = DASH;
    await act(async () => buttonByText('Retry').click());
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('SOXL main');
  });

  it('shows the error when the 500 has a plain-text body', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } }))) as unknown as typeof fetch;
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SERVER_ERROR);
    expect(buttonByText('Retry')).toBeTruthy();
  });

  it('an expired sign-in clears the token and goes to the sign-in page', async () => {
    setToken('stale');
    window.location.hash = '#/dashboard';
    try {
      dash.status = 401;
      dash.body = { error: 'unauthorized' };
      await render();
      expect(getToken()).toBeNull();
      expect(window.location.hash).toBe('#/login');
    } finally {
      setToken(null);
      window.location.hash = '';
    }
  });

  it('shows a spinner while loading', async () => {
    const hold = holdNext('GET', '/api/dashboard');
    await act(async () => root.render(d(DashboardPage)));
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
    hold.release();
    await flush();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(container.textContent).toContain('SOXL main');
  });

  it('Reload reads the dashboard again and keeps the page on screen', async () => {
    await render();
    const before = gets;
    await act(async () => (q('dashReload') as HTMLButtonElement).click());
    await flush();
    expect(gets).toBe(before + 1);
    expect(container.textContent).toContain('SOXL main');
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});
