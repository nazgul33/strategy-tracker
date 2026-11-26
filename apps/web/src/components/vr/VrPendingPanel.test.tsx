// VrPendingPanel: the waiting rows, their marks, and the per-row actions. Confirm all lives in VrPendingConfirmAll.test.tsx.
// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { holdNext } from '../../testing/holdFetch';
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

const NOT_PENDING = 'This fill is no longer waiting: it was already confirmed or rejected.';

const confirmAll = { method: 'POST' as const, url: '/pending/confirm-all', status: 200, json: {} as unknown };
const confirm = { method: 'POST' as const, url: '/confirm', status: 201, json: { fillId: 50 } as unknown };
const reject = { method: 'POST' as const, url: '/reject', status: 204, json: undefined as unknown };
const put = { method: 'PUT' as const, url: '/pending/', status: 204, json: undefined as unknown };
const list = { url: '/pending', status: 200, json: VR_PENDING as unknown };

describe('VrPendingPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let changed = 0;
  let gets = 0;

  const rows = () =>
    [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));
  const rowEl = (i: number) => container.querySelectorAll('tbody tr')[i]!;
  const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const btn = (id: string) => elementByTestId(id) as HTMLButtonElement;

  const mount = async () => {
    await act(async () => root.render(d(VrPendingPanel, { runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => (changed += 1) })));
    await h.flush();
  };

  beforeEach(async () => {
    confirm.status = 201;
    confirm.json = { fillId: 50 };
    reject.status = 204;
    reject.json = undefined;
    list.status = 200;
    list.json = VR_PENDING;
    changed = 0;
    gets = 0;
    calls = installFetchStub([
      confirmAll,
      confirm,
      reject,
      put,
      {
        url: '/pending',
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
    await mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('lists the rows in the server order with their formatting and marks', () => {
    expect(byId('vrPendingPanel')!.getAttribute('data-run-id')).toBe('5');
    const r = rows();
    expect(r).toHaveLength(4);
    const cut = (row: string[]) => [...row.slice(0, 5), row[6]];
    expect(cut(r[0]!)).toEqual(['2026-12-08', 'Buy', '3', '$44.39', 'auto', '']);
    expect(cut(r[1]!)).toEqual(['2026-12-08', 'Buy', '3', '$44.40', '$0.09', 'possible duplicate of $44.39']);
    expect(cut(r[2]!)).toEqual(['2026-12-09', 'Sell', '2', '$61.10', 'auto', 'date not in the screenshot']);
    expect(cut(r[3]!)).toEqual(['2026-12-10', 'Buy', '3', '$43.66', 'auto', 'dated after today']);
  });

  it('shows the screenshot of a row that still has one, and a dash otherwise', () => {
    expect(rowEl(0).querySelector('img')!.getAttribute('src')).toBe('/api/captures/9/image');
    expect(rowEl(2).querySelector('img')).toBeNull();
    expect(rows()[2]![5]).toBe('—');
  });

  it('puts each mark in its own test id', () => {
    expect(byId('vrPendingNoDate-33')!.textContent).toBe('date not in the screenshot');
    expect(byId('vrPendingFuture-34')!.textContent).toBe('dated after today');
    expect(byId('vrPendingDup-32')!.textContent).toBe('possible duplicate of $44.39');
    expect(byId('vrPendingNoDate-31')).toBeNull();
    expect(byId('vrPendingFuture-31')).toBeNull();
    expect(byId('vrPendingDup-31')).toBeNull();
    expect(byId('vrPendingDup-34')).toBeNull();
  });

  it('disables Confirm on a row dated after today and says why', () => {
    expect(btn('vrPendingConfirm-34').disabled).toBe(true);
    expect(byId('vrPendingFutureHint-34')!.textContent).toBe('Edit the date to confirm: it is after today (New York time).');
    for (const id of [31, 32, 33]) {
      expect(btn(`vrPendingConfirm-${id}`).disabled).toBe(false);
      expect(byId(`vrPendingFutureHint-${id}`)).toBeNull();
    }
    expect(btn('vrPendingEdit-34').disabled).toBe(false);
    expect(btn('vrPendingReject-34').disabled).toBe(false);
  });

  it('shows the empty note and keeps Confirm all disabled for an empty list', async () => {
    list.json = [];
    await act(async () => root.render(null));
    await mount();
    expect(container.textContent).toContain('No screenshot fills are waiting.');
    expect(container.querySelector('table')).toBeNull();
    expect(btn('vrPendingConfirmAll').disabled).toBe(true);
  });

  it('shows the error with Retry, and the rows come back after a retry', async () => {
    list.status = 500;
    list.json = { error: 'boom' };
    await act(async () => root.render(null));
    await mount();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
    list.status = 200;
    list.json = VR_PENDING;
    await h.click('Retry');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  it('confirms a row, then re-reads the list and reports the change', async () => {
    list.json = VR_PENDING.filter((r) => r.id !== 31);
    const before = gets;
    await h.clickId('vrPendingConfirm-31');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/vr/runs/5/pending/31/confirm', body: {} });
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
    expect(rows()).toHaveLength(3);
  });

  it('rejects a row, then re-reads the list and reports the change', async () => {
    list.json = VR_PENDING.filter((r) => r.id !== 31);
    const before = gets;
    await h.clickId('vrPendingReject-31');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/vr/runs/5/pending/31/reject', body: {} });
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
    expect(rows()).toHaveLength(3);
  });

  it('words a refused confirm beside the row, keeps the row and does not reload', async () => {
    confirm.status = 422;
    confirm.json = { error: 'fill-date-in-future' };
    const before = gets;
    await h.clickId('vrPendingConfirm-31');
    expect(byId('vrPendingError-31')!.textContent).toBe('The trade date is after today (New York time).');
    expect(rows()).toHaveLength(4);
    expect(gets).toBe(before);
    expect(changed).toBe(0);
    expect(byId('vrPendingError-32')).toBeNull();
    expect(btn('vrPendingConfirm-31').disabled).toBe(false);
  });

  it('words vr-negative-shares on a sell', async () => {
    confirm.status = 422;
    confirm.json = { error: 'vr-negative-shares' };
    await h.clickId('vrPendingConfirm-33');
    expect(byId('vrPendingError-33')!.textContent).toBe(
      'This change would leave the run with fewer than 0 shares. Check the sells that come after it.',
    );
    expect(rows()).toHaveLength(4);
    expect(changed).toBe(0);
  });

  it('words vr-not-pending on a reject', async () => {
    reject.status = 409;
    reject.json = { error: 'vr-not-pending' };
    await h.clickId('vrPendingReject-32');
    expect(byId('vrPendingError-32')!.textContent).toBe(NOT_PENDING);
    expect(rows()).toHaveLength(4);
    expect(changed).toBe(0);
  });

  it('words vr-not-pending on a confirm', async () => {
    confirm.status = 409;
    confirm.json = { error: 'vr-not-pending' };
    await h.clickId('vrPendingConfirm-32');
    expect(byId('vrPendingError-32')!.textContent).toBe(NOT_PENDING);
  });

  it('a later successful action clears the earlier row error', async () => {
    confirm.status = 422;
    confirm.json = { error: 'vr-too-large' };
    await h.clickId('vrPendingConfirm-31');
    expect(byId('vrPendingError-31')).not.toBeNull();
    confirm.status = 201;
    confirm.json = { fillId: 50 };
    await h.clickId('vrPendingConfirm-31');
    expect(byId('vrPendingError-31')).toBeNull();
    expect(changed).toBe(1);
  });

  it('edits a row: the dialog opens prefilled, Save sends the PUT, the list is re-read and the change reported', async () => {
    await h.clickId('vrPendingEdit-32');
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrPendingPriceInput')).toBe('44.4000');
    expect(h.value('vrPendingFeeInput')).toBe('0.09');
    const before = gets;
    await h.submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/pending/32');
    expect(gets).toBeGreaterThan(before);
    expect(changed).toBe(1);
    expect(h.dialogOpen()).toBe(false);
  });

  it('cancelling the edit changes nothing', async () => {
    await h.clickId('vrPendingEdit-32');
    await h.click('Cancel');
    expect(h.dialogOpen()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(changed).toBe(0);
  });

  it('a successful edit clears that row\'s earlier error', async () => {
    confirm.status = 422;
    confirm.json = { error: 'vr-too-large' };
    await h.clickId('vrPendingConfirm-31');
    expect(byId('vrPendingError-31')).not.toBeNull();
    await h.clickId('vrPendingEdit-31');
    await h.submit();
    expect(byId('vrPendingError-31')).toBeNull();
  });

  it('while a confirm is in flight every other button and Confirm all are disabled', async () => {
    const held = holdNext('POST', '/confirm');
    await act(async () => btn('vrPendingConfirm-31').click());
    await h.flush();
    for (const id of [31, 32, 33, 34]) {
      for (const kind of ['Confirm', 'Reject', 'Edit']) expect(btn(`vrPending${kind}-${id}`).disabled).toBe(true);
    }
    expect(btn('vrPendingConfirmAll').disabled).toBe(true);
    await act(async () => held.release());
    await h.flush();
    expect(btn('vrPendingConfirm-32').disabled).toBe(false);
    expect(btn('vrPendingConfirmAll').disabled).toBe(false);
  });
});
