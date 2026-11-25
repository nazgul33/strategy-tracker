// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_FILLS } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrFillsPanel } = await import('./VrFillsPanel');

const d = React.createElement;
const h = vrDialogHelpers(act);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const post = { method: 'POST' as const, url: '/fills', status: 201, json: { id: 13 } as unknown };
const put = { method: 'PUT' as const, url: '/fills/', status: 204, json: undefined as unknown };
const del = { method: 'DELETE' as const, url: '/fills/', status: 204, json: undefined as unknown };
const list = { url: '/fills', status: 200, json: VR_FILLS as unknown };

describe('VrFillsPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let changed = 0;
  let gets = 0;

  const rows = () => [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));

  beforeEach(async () => {
    list.status = 200;
    list.json = VR_FILLS;
    changed = 0;
    gets = 0;
    calls = installFetchStub([
      post,
      put,
      del,
      {
        url: '/fills',
        get status() {
          return list.status;
        },
        get json() {
          gets += 1;
          return list.json;
        },
      },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(d(VrFillsPanel, { runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => (changed += 1) })),
    );
    await h.flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('lists the fills in the server order with the earlier-cycle mark', () => {
    expect(elementByTestId('vrFillsPanel')).not.toBeNull();
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r[0]!.slice(0, 5)).toEqual(['2026-12-08', 'Buy', '3', '$45.15', '$0.09']);
    expect(r[1]!.slice(0, 5)).toEqual(['2026-11-06 earlier cycle', 'Buy', '176', '$51.13', '$1.12']);
    const mark = container.querySelectorAll('tbody tr')[1]!.querySelector('span[title]')!;
    expect(mark.getAttribute('title')).toBe(
      'Dated before the current cycle started; the current V was not recalculated.',
    );
    expect(container.querySelectorAll('tbody tr')[0]!.querySelector('span[title]')).toBeNull();
  });

  it('puts Edit and Delete on every row', () => {
    for (const f of VR_FILLS) {
      expect(document.querySelector(`[data-testid="vrFillEdit-${f.id}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-testid="vrFillDelete-${f.id}"]`)).not.toBeNull();
    }
  });

  it('adds a fill, then reloads the list and reports the change', async () => {
    await h.clickId('vrAddFill');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Add fill');
    list.json = [{ ...VR_FILLS[0]!, id: 13 }, ...VR_FILLS];
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    const before = gets;
    await h.submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(gets).toBe(before + 2);
    expect(changed).toBe(1);
    expect(h.dialogOpen()).toBe(false);
    expect(rows()).toHaveLength(3);
  });

  it('edits a fill', async () => {
    await h.clickId('vrFillEdit-12');
    expect(h.value('vrFillSharesInput')).toBe('3');
    const before = gets;
    await h.click('Save');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/vr/runs/5/fills/12');
    expect(gets).toBeGreaterThan(before);
    expect(changed).toBe(1);
    expect(h.dialogOpen()).toBe(false);
  });

  it('deletes from the row straight on the confirm step', async () => {
    await h.clickId('vrFillDelete-12');
    expect(h.findButton('Delete for real')).toBeDefined();
    expect(calls).toHaveLength(0);
    list.json = [VR_FILLS[1]];
    const before = gets;
    await h.click('Delete for real');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/fills/12');
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('does not report a change when the dialog is cancelled', async () => {
    await h.clickId('vrAddFill');
    await h.click('Cancel');
    expect(h.dialogOpen()).toBe(false);
    expect(changed).toBe(0);
  });

  it('shows an empty note and keeps the Add button', async () => {
    list.json = [];
    await act(async () => root.render(null));
    await act(async () =>
      root.render(d(VrFillsPanel, { runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => {} })),
    );
    await h.flush();
    expect(container.textContent).toContain('No fills.');
    expect(document.querySelector('[data-testid="vrAddFill"]')).not.toBeNull();
    expect(document.querySelector('table')).toBeNull();
  });

  it('shows the error with Retry, and the rows come back after a retry', async () => {
    list.status = 500;
    list.json = { error: 'boom' };
    await act(async () => root.render(null));
    await act(async () =>
      root.render(d(VrFillsPanel, { runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => {} })),
    );
    await h.flush();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    list.status = 200;
    list.json = VR_FILLS;
    await h.click('Retry');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(rows()).toHaveLength(2);
  });
});
