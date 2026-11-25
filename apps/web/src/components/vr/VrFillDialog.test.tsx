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

describe('VrFillDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let closed = 0;
  let saved = 0;
  let listed: unknown = VR_FILLS;
  let fillGets = 0;

  const mount = async (props: Record<string, unknown> = {}) => {
    await act(async () =>
      root.render(
        d(VrFillDialog, {
          runId: 5,
          costPpm: 700,
          today: '2026-12-09',
          onClose: () => (closed += 1),
          onSaved: () => (saved += 1),
          ...props,
        }),
      ),
    );
    await h.flush();
  };

  beforeEach(() => {
    post.status = 201;
    post.json = { id: 13 };
    closed = 0;
    saved = 0;
    listed = VR_FILLS;
    fillGets = 0;
    calls = installFetchStub([
      post,
      put,
      del,
      {
        url: '/fills',
        get json() {
          fillGets += 1;
          return listed;
        },
      },
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

  it('adds a fill on the auto fee: no fee key is sent', async () => {
    await mount();
    expect(h.value('vrFillDateInput')).toBe('2026-12-09');
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    expect(h.value('vrFillFeeInput')).toBe('0.09');
    await h.submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/fills');
    expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '45.15', filledOn: '2026-12-09' });
    expect('fee' in (calls[0]!.body as object)).toBe(false);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('sends a typed fee', async () => {
    await mount();
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    await h.type('vrFillFeeInput', '0.10');
    await h.submit();
    expect(calls[0]!.body).toEqual({ side: 'buy', shares: 3, price: '45.15', fee: '0.10', filledOn: '2026-12-09' });
  });

  it('sends the sell side', async () => {
    await mount();
    await h.choose('vrFillSideSelect', 'sell');
    await h.type('vrFillSharesInput', '2');
    await h.type('vrFillPriceInput', '60');
    await h.submit();
    expect((calls[0]!.body as { side: string }).side).toBe('sell');
  });

  it('sends the typed date', async () => {
    await mount();
    await h.type('vrFillSharesInput', '1');
    await h.type('vrFillPriceInput', '60');
    await h.type('vrFillDateInput', '2026-12-01');
    await h.submit();
    expect((calls[0]!.body as { filledOn: string }).filledOn).toBe('2026-12-01');
  });

  it('pre-fills an edit and sends PUT with the shown fee', async () => {
    await mount({ fill: VR_FILLS[0] });
    expect((elementByTestId('vrFillSideSelect') as HTMLSelectElement).value).toBe('buy');
    expect(h.value('vrFillSharesInput')).toBe('3');
    expect(h.value('vrFillPriceInput')).toBe('45.1500');
    expect(h.value('vrFillFeeInput')).toBe('0.09');
    expect(h.value('vrFillDateInput')).toBe('2026-12-08');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit fill');

    await h.type('vrFillSharesInput', '4');
    expect(h.value('vrFillFeeInput')).toBe('0.13');
    await h.click('Save');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/fills/12');
    expect(calls[0]!.body).toEqual({ side: 'buy', shares: 4, price: '45.1500', fee: '0.13', filledOn: '2026-12-08' });
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('keeps a fee typed during an edit when the shares change', async () => {
    await mount({ fill: VR_FILLS[0] });
    await h.type('vrFillFeeInput', '1.00');
    await h.type('vrFillSharesInput', '5');
    expect(h.value('vrFillFeeInput')).toBe('1.00');
    await h.click('Save');
    expect((calls[0]!.body as { fee: string }).fee).toBe('1.00');
  });

  it('can change the side of an existing fill', async () => {
    await mount({ fill: VR_FILLS[0] });
    await h.choose('vrFillSideSelect', 'sell');
    await h.click('Save');
    expect((calls[0]!.body as { side: string }).side).toBe('sell');
  });

  it('confirms before deleting from the edit form', async () => {
    await mount({ fill: VR_FILLS[0] });
    await h.clickId('vrFillDeleteBtn');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Delete this fill (3 shares)?');
    expect(calls).toHaveLength(0);

    await h.click('Cancel');
    expect(h.value('vrFillSharesInput')).toBe('3');
    expect(closed).toBe(0);

    await h.clickId('vrFillDeleteBtn');
    await h.click('Delete for real');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/fills/12');
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('opens on the confirm step with startOnDelete, and Cancel closes the dialog', async () => {
    await mount({ fill: VR_FILLS[0], startOnDelete: true });
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Delete this fill (3 shares)?');
    expect(h.findButton('Delete for real')).toBeDefined();
    await h.click('Cancel');
    expect(closed).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('reads the fills once after a save, to see whether the fill is dated before the cycle', async () => {
    await mount();
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    await h.submit();
    expect(fillGets).toBe(1);
  });
});
