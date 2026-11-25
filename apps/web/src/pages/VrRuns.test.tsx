// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';
import { SETTINGS_ROUTE, VR_SUMMARY, VR_SUMMARY_FRESH } from '../testing/vr';
import { inputByTestId, setInputValue } from '../testing/dom';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrRunsPage } = await import('./VrRuns');
const { resetDefaultCostMemo } = await import('../defaultcost');

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

let listGets = 0;
const list = {
  url: '/api/vr/runs',
  status: 200,
  get json(): unknown {
    listGets += 1;
    return this.body;
  },
  body: [VR_SUMMARY, VR_SUMMARY_FRESH] as unknown,
};

describe('VrRunsPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let stub: FetchCalls;

  const render = async () => {
    await act(async () => root.render(d(VrRunsPage)));
    await flush();
  };
  const buttonByText = (text: string) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`button [${text}] not found`);
    return btn;
  };
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => td.textContent ?? '');

  beforeEach(() => {
    resetDefaultCostMemo();
    listGets = 0;
    list.status = 200;
    list.body = [VR_SUMMARY, VR_SUMMARY_FRESH];
    stub = installFetchStub([{ method: 'POST', url: '/api/vr/runs', status: 201, json: { id: 7 } }, SETTINGS_ROUTE, list]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('lists the runs with formatted money', async () => {
    await render();
    const text = container.textContent ?? '';
    for (const want of ['VR runs', 'TQQQ lump sum', 'TQQQ', 'Active', '179', '$864.46', '$9,350.00', '$9,098.46']) {
      expect(text).toContain(want);
    }
    expect(container.querySelector('a[href="#/vr/5"]')?.textContent).toBe('TQQQ lump sum');
    expect(container.querySelector('a[href="#/vr/6"]')).toBeTruthy();
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(cells(rows[0]!)).toEqual(['TQQQ lump sumTQQQ', 'Active', '179', '$864.46', '$9,350.00', '$9,098.46']);
  });

  it('shows a dash for a V and a value that are not known yet', async () => {
    await render();
    const fresh = [...container.querySelectorAll('tbody tr')][1]!;
    expect(cells(fresh)).toEqual(['SOXL freshSOXL', 'Paused', '0', '$5,000.00', '—', '—']);
  });

  it('shows the empty note', async () => {
    list.body = [];
    await render();
    expect(container.textContent).toContain('No VR runs yet.');
    expect(container.querySelector('table')).toBeNull();
  });

  it('shows a server error and recovers on Retry', async () => {
    list.status = 500;
    list.body = {};
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SERVER_ERROR);
    list.status = 200;
    list.body = [VR_SUMMARY];
    await act(async () => buttonByText('Retry').click());
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('TQQQ lump sum');
  });

  it('opens the create form focused on the name, and Escape does not close it', async () => {
    await render();
    await act(async () => buttonByText('New VR run').click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('New VR run');
    expect(document.activeElement).toBe(inputByTestId('vrNameInput'));

    await act(async () => setInputValue(inputByTestId('vrNameInput'), 'Typed'));
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(inputByTestId('vrNameInput').value).toBe('Typed');
  });

  it('Cancel closes the form', async () => {
    await render();
    await act(async () => buttonByText('New VR run').click());
    await flush();
    await act(async () => buttonByText('Cancel').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('creating a run closes the form from the status link and reloads the list', async () => {
    await render();
    await act(async () => buttonByText('New VR run').click());
    await flush();
    await act(async () => setInputValue(inputByTestId('vrTickerInput'), 'soxl'));
    await act(async () => setInputValue(inputByTestId('vrCashInput'), '5000'));
    const before = listGets;
    await act(async () => buttonByText('Create').click());
    await flush();
    expect(stub).toHaveLength(1);
    expect(stub[0]!.url).toBe('/api/vr/runs');
    const link = document.querySelector('[role="status"] a[href="#/vr/7"]') as HTMLAnchorElement;
    expect(link.textContent).toBe('#7');
    await act(async () => link.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(listGets).toBeGreaterThan(before);
  });
});
