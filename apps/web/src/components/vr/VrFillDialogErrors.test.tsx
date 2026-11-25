// VrFillDialog: client checks and worded server errors. The dialog stays open on every failure.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lookup } from '../../i18n/catalog';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { goOffline } from '../../testing/offline';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_FILLS } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrFillDialog } = await import('./VrFillDialog');

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

describe('VrFillDialog errors', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let saved = 0;

  const mount = async (props: Record<string, unknown> = {}) => {
    await act(async () =>
      root.render(
        d(VrFillDialog, { runId: 5, costPpm: 700, today: '2026-12-09', onClose: () => {}, onSaved: () => (saved += 1), ...props }),
      ),
    );
    await h.flush();
  };
  const fillForm = async (shares = '3', price = '45.15') => {
    await h.type('vrFillSharesInput', shares);
    await h.type('vrFillPriceInput', price);
  };

  beforeEach(() => {
    for (const r of [post, put, del]) {
      r.status = r === post ? 201 : 204;
      r.json = r === post ? { id: 13 } : undefined;
    }
    saved = 0;
    calls = installFetchStub([post, put, del, { url: '/fills', json: VR_FILLS }]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  const CHECKS: [string, string, string, string, string, string][] = [
    ['an unreadable price', '3', 'abc', '', '2026-12-09', 'manualInvalidPrice'],
    ['a zero price', '3', '0', '', '2026-12-09', 'manualInvalidPrice'],
    ['zero shares', '0', '45.15', '', '2026-12-09', 'manualInvalidQty'],
    ['fractional shares', '1.5', '45.15', '', '2026-12-09', 'manualInvalidQty'],
    ['shares beyond the server limit', '2147483648', '45.15', '', '2026-12-09', 'vr.invalidSharesLarge'],
    ['a negative fee', '3', '45.15', '-1', '2026-12-09', 'manualInvalidFee'],
    ['a blank date', '3', '45.15', '', '', 'manualInvalidDate'],
  ];
  for (const [name, shares, price, fee, date, key] of CHECKS) {
    it(`blocks the request for ${name}`, async () => {
      await mount();
      await fillForm(shares, price);
      if (fee !== '') await h.type('vrFillFeeInput', fee);
      await h.type('vrFillDateInput', date);
      await h.submitForm();
      expect(calls).toHaveLength(0);
      expect(h.errorText()).toBe(lookup('en', key));
      expect(saved).toBe(0);
    });
  }

  it('accepts the largest share count the server takes', async () => {
    await mount();
    await fillForm('2147483647', '1');
    await h.submit();
    expect(calls).toHaveLength(1);
  });

  it('words fill-date-in-future and keeps the typed values', async () => {
    post.status = 422;
    post.json = { error: 'fill-date-in-future' };
    await mount();
    await fillForm();
    await h.submit();
    expect(h.errorText()).toBe('The trade date is after today (New York time).');
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrFillSharesInput')).toBe('3');
    expect(saved).toBe(0);
  });

  it('words vr-negative-shares on an edit', async () => {
    put.status = 422;
    put.json = { error: 'vr-negative-shares' };
    await mount({ fill: VR_FILLS[0] });
    await h.click('Save');
    expect(h.errorText()).toBe(
      'This change would leave the run with fewer than 0 shares. Check the sells that come after it.',
    );
    expect(h.dialogOpen()).toBe(true);
    expect(saved).toBe(0);
  });

  it('words vr-negative-shares on a delete and stays on the confirm step', async () => {
    del.status = 422;
    del.json = { error: 'vr-negative-shares' };
    await mount({ fill: VR_FILLS[0], startOnDelete: true });
    await h.click('Delete for real');
    expect(h.errorText()).toBe(
      'This change would leave the run with fewer than 0 shares. Check the sells that come after it.',
    );
    expect(h.findButton('Delete for real')).toBeDefined();
    expect(saved).toBe(0);
  });

  it('words vr-too-large on a delete', async () => {
    del.status = 422;
    del.json = { error: 'vr-too-large' };
    await mount({ fill: VR_FILLS[0], startOnDelete: true });
    await h.click('Delete for real');
    expect(h.errorText()).toBe('This entry is too large for the books. Check the amounts.');
    expect(h.findButton('Delete for real')).toBeDefined();
  });

  it('words a server-side price error', async () => {
    post.status = 422;
    post.json = { error: 'invalid-price' };
    await mount();
    await fillForm();
    await h.submit();
    expect(h.errorText()).toBe('Enter a price above $0 with at most 4 decimals.');
  });

  it('words an unreachable server', async () => {
    await mount();
    await fillForm();
    goOffline('POST', '/fills');
    await h.submit();
    expect(h.errorText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(h.dialogOpen()).toBe(true);
  });

  it('words an unknown error code generically', async () => {
    post.status = 404;
    post.json = { error: 'not found' };
    await mount();
    await fillForm();
    await h.submit();
    expect(h.errorText()).toBe('The request failed (not found).');
  });

  it('can retry after an error', async () => {
    post.status = 422;
    post.json = { error: 'fill-date-in-future' };
    await mount();
    await fillForm();
    await h.submit();
    post.status = 201;
    post.json = { id: 13 };
    await h.submit();
    expect(saved).toBe(1);
    expect(h.errorText()).toBeNull();
  });
});
