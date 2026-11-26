// VrPendingPanel: Confirm all and its summary (booked, refused with reasons, rows left to decide one by one).
// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_PENDING } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrPendingPanel } = await import('./VrPendingPanel');

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

const RESULT = { confirmed: 1, refused: [{ id: 34, error: 'fill-date-in-future' }], skippedDuplicates: 1, skippedUndated: 1 };
const FUTURE = 'The trade date is after today (New York time).';

const confirmAll = { method: 'POST' as const, url: '/pending/confirm-all', status: 200, json: RESULT as unknown };
const confirm = { method: 'POST' as const, url: '/confirm', status: 201, json: { fillId: 50 } as unknown };
const list = { url: '/pending', status: 200, json: VR_PENDING as unknown };

describe('VrPendingPanel confirm all', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let changed = 0;
  let gets = 0;

  const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const text = (id: string) => byId(id)?.textContent ?? null;
  const refusedItems = () => [...document.querySelectorAll('[data-testid="vrConfirmAllRefused"] li')].map((li) => li.textContent);

  beforeEach(async () => {
    confirmAll.status = 200;
    confirmAll.json = RESULT;
    confirm.status = 201;
    list.json = VR_PENDING;
    changed = 0;
    gets = 0;
    calls = installFetchStub([
      confirmAll,
      confirm,
      {
        url: '/pending',
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
      root.render(d(VrPendingPanel, { runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => (changed += 1) })),
    );
    await h.flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('posts confirm-all, shows the three numbers and the refused row from the old list, then re-reads', async () => {
    list.json = VR_PENDING.filter((r) => r.id === 32 || r.id === 33 || r.id === 34);
    const before = gets;
    await h.clickId('vrPendingConfirmAll');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/vr/runs/5/pending/confirm-all', body: {} });
    expect(text('vrConfirmAllBooked')).toBe('Booked: 1.');
    expect(text('vrConfirmAllLeftDuplicates')).toBe('Possible duplicates left to decide one by one: 1.');
    expect(text('vrConfirmAllLeftUndated')).toBe('Rows without a date from the screenshot, left to decide one by one: 1.');
    expect(refusedItems()).toEqual([`Buy 3 @ $43.66 on 2026-12-10 — ${FUTURE}`]);
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('describes a refused id that is not in the list as #id, and words an unknown code generically', async () => {
    confirmAll.json = {
      confirmed: 0,
      refused: [
        { id: 99, error: 'fill-date-in-future' },
        { id: 31, error: 'weird-code' },
      ],
      skippedDuplicates: 0,
      skippedUndated: 0,
    };
    await h.clickId('vrPendingConfirmAll');
    expect(refusedItems()).toEqual([`#99 — ${FUTURE}`, 'Buy 3 @ $44.39 on 2026-12-08 — The request failed (weird-code).']);
  });

  it('words vr-negative-shares and vr-not-pending', async () => {
    confirmAll.json = {
      confirmed: 0,
      refused: [
        { id: 33, error: 'vr-negative-shares' },
        { id: 31, error: 'vr-not-pending' },
      ],
      skippedDuplicates: 0,
      skippedUndated: 0,
    };
    await h.clickId('vrPendingConfirmAll');
    expect(refusedItems()).toEqual([
      'Sell 2 @ $61.10 on 2026-12-09 — This change would leave the run with fewer than 0 shares. Check the sells that come after it.',
      'Buy 3 @ $44.39 on 2026-12-08 — This fill is no longer waiting: it was already confirmed or rejected.',
    ]);
  });

  it('shows every count, zero included, and no refused list when nothing was refused', async () => {
    confirmAll.json = { confirmed: 4, refused: [], skippedDuplicates: 0, skippedUndated: 0 };
    await h.clickId('vrPendingConfirmAll');
    expect(text('vrConfirmAllBooked')).toBe('Booked: 4.');
    expect(text('vrConfirmAllLeftDuplicates')).toBe('Possible duplicates left to decide one by one: 0.');
    expect(text('vrConfirmAllLeftUndated')).toBe('Rows without a date from the screenshot, left to decide one by one: 0.');
    expect(byId('vrConfirmAllRefused')).toBeNull();
  });

  it('keeps the summary above the empty note when everything was booked', async () => {
    confirmAll.json = { confirmed: 4, refused: [], skippedDuplicates: 0, skippedUndated: 0 };
    list.json = [];
    await h.clickId('vrPendingConfirmAll');
    expect(container.textContent).toContain('No screenshot fills are waiting.');
    expect(text('vrConfirmAllBooked')).toBe('Booked: 4.');
    const summary = byId('vrConfirmAllSummary')!;
    const empty = [...container.querySelectorAll('div')].find((e) => e.textContent === 'No screenshot fills are waiting.')!;
    expect(summary.compareDocumentPosition(empty) & 4).toBe(4);
  });

  it('shows the server text when the request fails, with no summary and no reload', async () => {
    confirmAll.status = 500;
    confirmAll.json = { error: 'boom' };
    const before = gets;
    await h.clickId('vrPendingConfirmAll');
    expect(byId('vrConfirmAllSummary')).toBeNull();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      'The server had a problem (boom). Try again; if it keeps failing, check the server log.',
    );
    expect(gets).toBe(before);
    expect(changed).toBe(0);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
  });

  it('a row action after the summary clears it', async () => {
    await h.clickId('vrPendingConfirmAll');
    expect(byId('vrConfirmAllSummary')).not.toBeNull();
    await h.clickId('vrPendingConfirm-31');
    expect(byId('vrConfirmAllSummary')).toBeNull();
  });

  it('a new Confirm all replaces the failure note of the last one', async () => {
    confirmAll.status = 500;
    confirmAll.json = { error: 'boom' };
    await h.clickId('vrPendingConfirmAll');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    confirmAll.status = 200;
    confirmAll.json = RESULT;
    await h.clickId('vrPendingConfirmAll');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(byId('vrConfirmAllSummary')).not.toBeNull();
  });
});
