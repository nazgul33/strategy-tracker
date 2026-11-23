// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunDetailPage } = await import('./RunDetail');
const { installFetchStub, restoreFetch } = await import('../testing/fetchStub');
const { setInputValue } = await import('../testing/dom');
const { PENDING_ROW } = await import('../testing/pendingRow');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const RUN = {
  id: 1,
  strategyKey: 'mean-reversion',
  ticker: 'AAPL',
  name: 'Test run',
  poolCents: 100_000,
  costPpm: 3_000,
  buyGapPpm: 25_000,
  sellGapPpm: 10_000,
  cutLossPpm: 0,
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
  progressView: { heldCount: 0, cashCents: 100_000, exposureCents: 0, realizedCents: 0, winRate: null },
  state: { buckets: [], cashCents: 100_000, closed: [], ages: {} },
};

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

async function press(text: string) {
  await act(async () => {
    buttonByText(text).click();
  });
  await flush();
}

describe('RunDetailPage keep notices', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true, archived: false } },
      { url: '/api/corrections', json: [] },
      { url: '/price-history', json: { start: '2026-11-04', bars: [] } },
      { url: '/orders', json: [] },
      { url: '/api/pending', json: [{ ...PENDING_ROW, runId: 1 }] },
      { url: '/api/runs/1', json: RUN },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await press('Pending');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('a record-failed notice survives a tab switch until it is dismissed', async () => {
    const qty = container.querySelector('input[aria-label="Qty"]') as HTMLInputElement;
    await act(async () => setInputValue(qty, '11'));
    await press('Confirm');
    await press('Keep for review');
    expect(container.querySelectorAll('[data-keep-notice]').length).toBe(1);

    await press('Orders');
    expect(container.querySelector('[data-keep-notice]')).toBeNull();
    await press('Pending');

    expect(container.querySelectorAll('[data-keep-notice]').length).toBe(1);
    expect(container.querySelector('[data-keep-notice]')!.textContent).toContain('AAPL');
  });
});
