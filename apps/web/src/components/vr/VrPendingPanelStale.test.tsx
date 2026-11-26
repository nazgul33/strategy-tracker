// VrPendingPanel: requests that fail for a reason other than a refusal, a row that was decided elsewhere, a fine price,
// and the panel staying busy until the list is re-read. A refusal (422) is covered in VrPendingPanel.test.tsx.
// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { holdNext } from '../../testing/holdFetch';
import { goOffline } from '../../testing/offline';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_PENDING, VR_PENDING_FINE } from '../../testing/vr';

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
const SERVER_ERROR = 'The server had a problem (boom). Try again; if it keeps failing, check the server log.';
const OFFLINE = 'Could not reach the server. Check the connection and try again.';

const confirmAll = { method: 'POST' as const, url: '/pending/confirm-all', status: 200, json: {} as unknown };
const confirm = { method: 'POST' as const, url: '/confirm', status: 201, json: { fillId: 50 } as unknown };
const reject = { method: 'POST' as const, url: '/reject', status: 204, json: undefined as unknown };
const put = { method: 'PUT' as const, url: '/pending/', status: 204, json: undefined as unknown };
const list = { url: '/pending', json: VR_PENDING as unknown };

describe('VrPendingPanel after a request that was not simply refused', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let changed = 0;
  let gets = 0;

  const rows = () =>
    [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));
  const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const btn = (id: string) => elementByTestId(id) as HTMLButtonElement;
  const panelError = () => byId('vrPendingPanelError')?.textContent ?? null;

  const mount = async () => {
    await act(async () => root.render(d(VrPendingPanel, { runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => (changed += 1) })));
    await h.flush();
  };

  beforeEach(async () => {
    for (const r of [confirmAll, confirm, reject, put]) r.status = r === confirmAll ? 200 : r === confirm ? 201 : 204;
    confirmAll.json = {};
    confirm.json = { fillId: 50 };
    reject.json = undefined;
    put.json = undefined;
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

  it('a Reject answered vr-not-pending words it for the panel, re-reads, drops the row and reports the change', async () => {
    reject.status = 409;
    reject.json = { error: 'vr-not-pending' };
    list.json = VR_PENDING.filter((r) => r.id !== 32);
    const before = gets;
    await h.clickId('vrPendingReject-32');
    expect(panelError()).toBe(NOT_PENDING);
    expect(byId('vrPendingPanelError')!.querySelector('[role="alert"]')).not.toBeNull();
    expect(byId('vrPendingError-32')).toBeNull();
    expect(gets).toBe(before + 1);
    expect(rows()).toHaveLength(3);
    expect(byId('vrPendingConfirm-32')).toBeNull();
    expect(changed).toBe(1);
  });

  it('a Confirm answered vr-not-pending words it for the panel, re-reads, drops the row and reports the change', async () => {
    confirm.status = 409;
    confirm.json = { error: 'vr-not-pending' };
    list.json = VR_PENDING.filter((r) => r.id !== 32);
    const before = gets;
    await h.clickId('vrPendingConfirm-32');
    expect(panelError()).toBe(NOT_PENDING);
    expect(byId('vrPendingError-32')).toBeNull();
    expect(gets).toBe(before + 1);
    expect(rows()).toHaveLength(3);
    expect(changed).toBe(1);
  });

  it('a Confirm answered 500 shows the panel message, re-reads and reports the change', async () => {
    confirm.status = 500;
    confirm.json = { error: 'boom' };
    list.json = VR_PENDING.filter((r) => r.id !== 31);
    const before = gets;
    await h.clickId('vrPendingConfirm-31');
    expect(panelError()).toBe(SERVER_ERROR);
    expect(byId('vrPendingError-31')).toBeNull();
    expect(gets).toBe(before + 1);
    expect(rows()).toHaveLength(3);
    expect(changed).toBe(1);
  });

  it('a Confirm that never got an answer shows the panel message, re-reads and reports the change', async () => {
    goOffline('POST', '/confirm');
    const before = gets;
    await h.clickId('vrPendingConfirm-31');
    expect(panelError()).toBe(OFFLINE);
    expect(byId('vrPendingError-31')).toBeNull();
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
  });

  it('a Reject answered 500 shows the panel message, re-reads and reports the change', async () => {
    reject.status = 500;
    reject.json = { error: 'boom' };
    const before = gets;
    await h.clickId('vrPendingReject-31');
    expect(panelError()).toBe(SERVER_ERROR);
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
  });

  it('a refusal (422) stays beside its row with no panel message and no re-read', async () => {
    confirm.status = 422;
    confirm.json = { error: 'vr-too-large' };
    const before = gets;
    await h.clickId('vrPendingConfirm-31');
    expect(panelError()).toBeNull();
    expect(byId('vrPendingError-31')!.getAttribute('role')).toBe('alert');
    expect(gets).toBe(before);
    expect(changed).toBe(0);
  });

  it('the next action clears the panel message', async () => {
    confirm.status = 500;
    confirm.json = { error: 'boom' };
    await h.clickId('vrPendingConfirm-31');
    expect(panelError()).not.toBeNull();
    confirm.status = 201;
    confirm.json = { fillId: 50 };
    await h.clickId('vrPendingConfirm-32');
    expect(panelError()).toBeNull();
  });

  it('a failed Confirm all says rows may have been booked, re-reads and reports the change', async () => {
    confirmAll.status = 500;
    confirmAll.json = { error: 'boom' };
    list.json = VR_PENDING.filter((r) => r.id === 33 || r.id === 34);
    const before = gets;
    await h.clickId('vrPendingConfirmAll');
    expect(panelError()).toBe(`${SERVER_ERROR} Some rows may have been booked before this failed. Check the list below.`);
    expect(byId('vrConfirmAllSummary')).toBeNull();
    expect(gets).toBe(before + 1);
    expect(rows()).toHaveLength(2);
    expect(changed).toBe(1);
  });

  it('a Confirm all that never got an answer says the same', async () => {
    goOffline('POST', '/confirm-all');
    const before = gets;
    await h.clickId('vrPendingConfirmAll');
    expect(panelError()).toBe(`${OFFLINE} Some rows may have been booked before this failed. Check the list below.`);
    expect(gets).toBe(before + 1);
    expect(changed).toBe(1);
  });

  it('keeps the panel message above the empty note when the re-read list is empty', async () => {
    confirmAll.status = 500;
    confirmAll.json = { error: 'boom' };
    list.json = [];
    await h.clickId('vrPendingConfirmAll');
    expect(panelError()).not.toBeNull();
    expect(container.textContent).toContain('No screenshot fills are waiting.');
  });

  describe('a fine price and a fee of zero', () => {
    const mountFine = async (row = VR_PENDING_FINE) => {
      list.json = [row];
      await act(async () => root.render(null));
      await mount();
    };

    it('shows the price in full and a fee of $0.00 instead of auto', async () => {
      await mountFine();
      const cells = rows()[0]!;
      expect(cells[3]).toBe('$44.3912');
      expect(cells[4]).toBe('$0.00');
    });

    it('shows a possible duplicate\'s price in full', async () => {
      await mountFine({ ...VR_PENDING_FINE, dupPrice: '443912' });
      expect(byId('vrPendingDup-35')!.textContent).toBe('possible duplicate of $44.3912');
    });

    it('pre-fills the dialog in full, and saving it unchanged sends the same price and fee', async () => {
      await mountFine();
      await h.clickId('vrPendingEdit-35');
      expect(h.value('vrPendingPriceInput')).toBe('44.3912');
      expect(h.value('vrPendingFeeInput')).toBe('0.00');
      await h.submit();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('/api/vr/runs/5/pending/35');
      expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '44.3912', fee: '0.00', filledOn: '2026-12-08' });
    });

    it('a row with no fee saved unchanged sends no fee key', async () => {
      await h.clickId('vrPendingEdit-31');
      await h.submit();
      expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '44.3900', filledOn: '2026-12-08' });
      expect('fee' in (calls[0]!.body as object)).toBe(false);
    });
  });

  describe('after an edit is saved', () => {
    it('keeps every button disabled until the list has been re-read', async () => {
      await h.clickId('vrPendingEdit-31');
      const held = holdNext('GET', '/pending');
      await h.submit();
      expect(h.dialogOpen()).toBe(false);
      for (const id of [31, 32, 33, 34]) {
        for (const kind of ['Confirm', 'Reject', 'Edit']) expect(btn(`vrPending${kind}-${id}`).disabled).toBe(true);
      }
      expect(btn('vrPendingConfirmAll').disabled).toBe(true);
      expect(changed).toBe(0);
      await act(async () => held.release());
      await h.flush();
      expect(btn('vrPendingConfirm-31').disabled).toBe(false);
      expect(btn('vrPendingConfirmAll').disabled).toBe(false);
      expect(changed).toBe(1);
    });

    it('clears an earlier Confirm all summary', async () => {
      confirmAll.json = { confirmed: 1, refused: [], skippedDuplicates: 0, skippedUndated: 0 };
      await h.clickId('vrPendingConfirmAll');
      expect(byId('vrConfirmAllSummary')).not.toBeNull();
      await h.clickId('vrPendingEdit-31');
      await h.submit();
      expect(byId('vrConfirmAllSummary')).toBeNull();
    });
  });

  describe('a dialog whose row was decided elsewhere', () => {
    it('words vr-not-pending in the dialog, and closing it re-reads the list and reports the change', async () => {
      put.status = 409;
      put.json = { error: 'vr-not-pending' };
      list.json = VR_PENDING.filter((r) => r.id !== 31);
      await h.clickId('vrPendingEdit-31');
      await h.submit();
      expect(h.errorText()).toBe(NOT_PENDING);
      expect(h.dialogOpen()).toBe(true);
      expect(changed).toBe(0);
      const before = gets;
      await h.click('Cancel');
      expect(h.dialogOpen()).toBe(false);
      expect(gets).toBe(before + 1);
      expect(changed).toBe(1);
      expect(byId('vrPendingConfirm-31')).toBeNull();
      expect(rows()).toHaveLength(3);
    });

    it('does not re-read when the dialog is closed after another kind of error', async () => {
      put.status = 422;
      put.json = { error: 'invalid-price' };
      await h.clickId('vrPendingEdit-31');
      await h.submit();
      const before = gets;
      await h.click('Cancel');
      expect(gets).toBe(before);
      expect(changed).toBe(0);
    });
  });
});
