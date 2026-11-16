// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SimPage } = await import('./Sim');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

let stub: FetchCalls;

function simRow(id: number, ticker: string, draft: boolean): Record<string, unknown> {
  return {
    id,
    ticker,
    fromDate: '2026-01-02',
    toDate: '2026-06-30',
    poolCents: 10_000_000,
    costPpm: 700,
    buyGapPpm: 0,
    sellGapPpm: 0,
    cutLossPpm: 0,
    paramsJson: '{}',
    draft,
    createdAt: '2026-06-30 09:00:00',
  };
}

describe('SimPage drafts', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let listRoute: { url: string; json: unknown };

  beforeEach(() => {
    listRoute = {
      url: '/api/sim',
      json: [simRow(7, 'NVDA', true), simRow(6, 'QQQ', false), simRow(5, 'TSLA', true), simRow(4, 'AAPL', false)],
    };
    stub = installFetchStub([
      { url: '/api/settings', json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 } },
      { method: 'DELETE', url: '/api/sim/7', status: 204, json: undefined },
      listRoute,
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

  function rowsIn(testid: string): string[] {
    const card = document.querySelector(`[data-testid="${testid}"]`);
    if (!card) throw new Error(`[${testid}] not found`);
    return Array.from(card.querySelectorAll('tbody tr')).map((tr) => tr.textContent ?? '');
  }

  async function renderList() {
    await act(async () => {
      root.render(d(SimPage));
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it('the sim list separates drafts from saved runs', async () => {
    await renderList();
    const drafts = rowsIn('simDrafts');
    const saved = rowsIn('simSaved');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toContain('NVDA');
    expect(drafts[1]).toContain('TSLA');
    expect(saved).toHaveLength(2);
    expect(saved[0]).toContain('QQQ');
    expect(saved[1]).toContain('AAPL');
    // A draft never appears in the saved table and vice versa.
    expect(saved.join('')).not.toContain('NVDA');
    expect(saved.join('')).not.toContain('TSLA');
    expect(drafts.join('')).not.toContain('QQQ');
  });

  it('shows no drafts card when there are no drafts', async () => {
    listRoute.json = [simRow(6, 'QQQ', false)];
    await renderList();
    expect(document.querySelector('[data-testid="simDrafts"]')).toBeNull();
    expect(rowsIn('simSaved')).toHaveLength(1);
  });

  it('links each draft to its detail page and discards a draft from its row', async () => {
    await renderList();
    const link = document.querySelector('[data-testid="simDrafts"] a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/sim/7');

    const discard = document.querySelector('[data-testid="simDiscardRow-7"]') as HTMLButtonElement;
    expect(discard).not.toBeNull();
    expect(document.querySelector('[data-testid="simDiscardRow-6"]')).toBeNull();

    listRoute.json = [simRow(6, 'QQQ', false), simRow(5, 'TSLA', true), simRow(4, 'AAPL', false)];
    await act(async () => {
      discard.click();
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(stub.length).toBe(1);
    expect(stub[0]!.method).toBe('DELETE');
    expect(stub[0]!.url).toBe('/api/sim/7');
    expect(rowsIn('simDrafts')).toHaveLength(1);
    expect(rowsIn('simDrafts')[0]).toContain('TSLA');
  });
});
