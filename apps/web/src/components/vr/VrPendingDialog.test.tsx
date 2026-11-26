// VrPendingDialog: prefill, client checks, the PUT body, focus and worded server errors.
// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lookup } from '../../i18n/catalog';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_PENDING } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrPendingDialog } = await import('./VrPendingDialog');

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

const put = { method: 'PUT' as const, url: '/pending/', status: 204, json: undefined as unknown };

describe('VrPendingDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let saved: string[];

  const mount = async (row = VR_PENDING[1]!) => {
    await act(async () =>
      root.render(
        d(VrPendingDialog, {
          runId: 5,
          costPpm: 700,
          row,
          onClose: () => saved.push('close'),
          onSaved: () => saved.push('saved'),
          onStale: () => saved.push('stale'),
        }),
      ),
    );
    await h.flush();
  };
  const placeholder = (id: string) => (elementByTestId(id) as HTMLInputElement).placeholder;

  beforeEach(() => {
    put.status = 204;
    put.json = undefined;
    saved = [];
    calls = installFetchStub([put]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('prefills the fields from the row', async () => {
    await mount();
    expect((elementByTestId('vrPendingSideSelect') as HTMLSelectElement).value).toBe('buy');
    expect(h.value('vrPendingSharesInput')).toBe('3');
    expect(h.value('vrPendingPriceInput')).toBe('44.4000');
    expect(h.value('vrPendingFeeInput')).toBe('0.09');
    expect(h.value('vrPendingDateInput')).toBe('2026-12-08');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit waiting fill');
  });

  it('leaves the fee empty for an automatic fee and shows what it would be as the placeholder', async () => {
    await mount(VR_PENDING[0]);
    expect(h.value('vrPendingFeeInput')).toBe('');
    expect(placeholder('vrPendingFeeInput')).toBe('auto $0.09');
  });

  it('prefills the side of a sell', async () => {
    await mount(VR_PENDING[2]);
    expect((elementByTestId('vrPendingSideSelect') as HTMLSelectElement).value).toBe('sell');
    expect(h.value('vrPendingPriceInput')).toBe('61.1000');
  });

  it('focuses the side select first', async () => {
    await mount();
    expect(document.activeElement).toBe(elementByTestId('vrPendingSideSelect'));
  });

  it('ignores Escape and keeps the typed values', async () => {
    await mount();
    await h.type('vrPendingSharesInput', '7');
    await h.pressEscape();
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrPendingSharesInput')).toBe('7');
    expect(saved).toEqual([]);
  });

  const CHECKS: [string, string, string, string, string, string][] = [
    ['an unreadable price', '3', 'abc', '0.09', '2026-12-08', 'manualInvalidPrice'],
    ['zero shares', '0', '44.40', '0.09', '2026-12-08', 'manualInvalidQty'],
    ['shares beyond the server limit', '2147483648', '44.40', '0.09', '2026-12-08', 'vr.invalidSharesLarge'],
    ['a negative fee', '3', '44.40', '-1', '2026-12-08', 'manualInvalidFee'],
    ['a malformed date', '3', '44.40', '0.09', '2026-13', 'manualInvalidDate'],
  ];
  for (const [name, shares, price, fee, date, key] of CHECKS) {
    it(`blocks the request for ${name}`, async () => {
      await mount();
      await h.type('vrPendingSharesInput', shares);
      await h.type('vrPendingPriceInput', price);
      await h.type('vrPendingFeeInput', fee);
      await h.type('vrPendingDateInput', date);
      await h.submitForm();
      expect(calls).toHaveLength(0);
      expect(h.errorText()).toBe(lookup('en', key));
      expect(saved).toEqual([]);
    });
  }

  it('sends no fee key when the fee is cleared', async () => {
    await mount();
    await h.type('vrPendingFeeInput', '');
    await h.submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/pending/32');
    expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '44.4000', filledOn: '2026-12-08' });
    expect('fee' in (calls[0]!.body as object)).toBe(false);
  });

  it('sends every edited field, with the price ungrouped', async () => {
    await mount();
    await h.choose('vrPendingSideSelect', 'sell');
    await h.type('vrPendingSharesInput', '5');
    await h.type('vrPendingPriceInput', '1,234.50');
    await h.type('vrPendingFeeInput', '0.25');
    await h.type('vrPendingDateInput', '2026-12-07');
    await h.submit();
    expect(calls[0]!.body).toEqual({ side: 'sell', shares: 5, price: '1234.50', fee: '0.25', filledOn: '2026-12-07' });
  });

  it('calls onSaved and then onClose, once each, on success', async () => {
    await mount();
    await h.submit();
    expect(saved).toEqual(['saved', 'close']);
  });

  it('words a server 422 invalid-price, stays open and keeps the typed values', async () => {
    put.status = 422;
    put.json = { error: 'invalid-price' };
    await mount();
    await h.type('vrPendingSharesInput', '8');
    await h.submit();
    expect(h.errorText()).toBe('Enter a price above $0 with at most 4 decimals.');
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrPendingSharesInput')).toBe('8');
    expect(saved).toEqual([]);
  });

  it('words a 409 vr-not-pending', async () => {
    put.status = 409;
    put.json = { error: 'vr-not-pending' };
    await mount();
    await h.submit();
    expect(h.errorText()).toBe('This fill is no longer waiting: it was already confirmed or rejected.');
    expect(h.dialogOpen()).toBe(true);
    expect(saved).toEqual([]);
    await h.click('Cancel');
    expect(saved).toEqual(['stale', 'close']);
  });

  it('closing after another kind of error does not report a stale row', async () => {
    put.status = 422;
    put.json = { error: 'invalid-price' };
    await mount();
    await h.submit();
    await h.click('Cancel');
    expect(saved).toEqual(['close']);
  });

  it('shows a price finer than a cent in full and saves it unchanged', async () => {
    await mount({ ...VR_PENDING[1]!, price: '443912', fee: 0 });
    expect(h.value('vrPendingPriceInput')).toBe('44.3912');
    expect(h.value('vrPendingFeeInput')).toBe('0.00');
    await h.submit();
    expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '44.3912', fee: '0.00', filledOn: '2026-12-08' });
  });

  it('saves a row with no fee unchanged without a fee key', async () => {
    await mount(VR_PENDING[0]);
    await h.submit();
    expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '44.3900', filledOn: '2026-12-08' });
    expect('fee' in (calls[0]!.body as object)).toBe(false);
  });

  it('can retry after an error', async () => {
    put.status = 422;
    put.json = { error: 'invalid-price' };
    await mount();
    await h.submit();
    put.status = 204;
    put.json = undefined;
    await h.submit();
    expect(saved).toEqual(['saved', 'close']);
    expect(h.errorText()).toBeNull();
  });

  it('Cancel closes without a request', async () => {
    await mount();
    await h.click('Cancel');
    expect(calls).toHaveLength(0);
    expect(saved).toEqual(['close']);
  });
});
