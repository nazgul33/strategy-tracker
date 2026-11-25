// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import { VR_CYCLE } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrCyclesPanel } = await import('./VrCyclesPanel');

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

const C2 = { ...VR_CYCLE, id: 2, seq: 2, startDate: '2026-11-23', scheduledStart: '2026-11-23', endDate: '2026-12-06', nextStart: '2026-12-07', vCents: 900_000, vKept: true, depositCents: -25_000 };
const C1 = { ...VR_CYCLE, id: 1, seq: 1, startDate: '2026-11-09', scheduledStart: '2026-11-09', endDate: '2026-11-22', nextStart: '2026-11-23', prevClose: null, evalCents: null, poolBeforeCents: null };

const route = { url: '/api/vr/runs/5/cycles', status: 200, json: [VR_CYCLE, C2, C1] as unknown };

describe('VrCyclesPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const render = async () => {
    await act(async () => root.render(d(VrCyclesPanel, { runId: 5 })));
    await flush();
  };
  const bodyRows = () => [...container.querySelectorAll('tbody tr')];
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => td.textContent);

  beforeEach(() => {
    route.status = 200;
    route.json = [VR_CYCLE, C2, C1];
    installFetchStub([route]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('shows a row per cycle in server order with formatted values', async () => {
    await render();
    expect(
      [...container.querySelectorAll('th')].map((th) => th.textContent),
    ).toEqual(['Cycle', 'Dates', 'V', 'Band', 'Opening shares', 'Opening Pool', 'Buy budget', 'Close', 'E', 'Deposit']);
    expect(bodyRows()).toHaveLength(3);
    expect(cells(bodyRows()[0]!)).toEqual([
      '3',
      '2026-12-07 – 2026-12-20',
      '$9,350.00',
      '$7,947.50 – $10,752.50',
      '176',
      '$1,000.00',
      '$500.00',
      '$60.12',
      '$10,581.12',
      '$0.00',
    ]);
    expect(cells(bodyRows()[1]!)[0]).toBe('2');
    expect(cells(bodyRows()[2]!)[0]).toBe('1');
  });

  it('marks a cycle that kept its previous V, with the reason as a hint', async () => {
    await render();
    const rows = bodyRows();
    const cellsOf = (i: number) => cells(rows[i]!);
    expect(cellsOf(1)[2]).toBe('$9,000.00 V kept');
    expect(cellsOf(1)[9]).toBe('-$250.00');
    expect(rows[1]!.querySelector('span[title]')!.getAttribute('title')).toBe('The formula gave a V of zero or less, so the previous V was kept.');
    expect(cellsOf(0)[2]).not.toContain('V kept');
    expect(cellsOf(2)[2]).not.toContain('V kept');
    expect(container.querySelectorAll('span[title]')).toHaveLength(1);
  });

  it('shows a dash for the close and E of the first cycle', async () => {
    await render();
    const first = cells(bodyRows()[2]!);
    expect(first[7]).toBe('—');
    expect(first[8]).toBe('—');
  });

  it('shows the empty note', async () => {
    route.json = [];
    await render();
    expect(container.textContent).toBe('No cycle yet.');
    expect(container.querySelector('table')).toBeNull();
  });

  it('shows a server error and recovers on Retry', async () => {
    route.status = 500;
    route.json = {};
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The server had a problem (http-500). Try again; if it keeps failing, check the server log.',
    );
    route.status = 200;
    route.json = [VR_CYCLE];
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(bodyRows()).toHaveLength(1);
  });
});
