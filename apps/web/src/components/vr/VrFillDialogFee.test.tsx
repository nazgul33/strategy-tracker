// The fee field of VrFillDialog follows shares x price x cost until the operator types one.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { vrDialogHelpers } from '../../testing/vrDialog';

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

describe('VrFillDialog auto fee', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;

  const mount = async (costPpm: number) => {
    await act(async () =>
      root.render(d(VrFillDialog, { runId: 5, costPpm, today: '2026-12-09', onClose: () => {}, onSaved: () => {} })),
    );
    await h.flush();
  };

  beforeEach(() => {
    calls = installFetchStub([
      { method: 'POST', url: '/fills', status: 201, json: { id: 13 } },
      { url: '/fills', json: [] },
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

  it('tracks shares x price x cost', async () => {
    await mount(700);
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    expect(h.value('vrFillFeeInput')).toBe('0.09');
    await h.type('vrFillSharesInput', '30');
    expect(h.value('vrFillFeeInput')).toBe('0.95');
    await h.type('vrFillPriceInput', '46');
    expect(h.value('vrFillFeeInput')).toBe('0.97');
  });

  it('stops following once a fee is typed, and follows again when it is cleared', async () => {
    await mount(700);
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    await h.type('vrFillFeeInput', '2.00');
    await h.type('vrFillSharesInput', '30');
    expect(h.value('vrFillFeeInput')).toBe('2.00');
    await h.type('vrFillFeeInput', '');
    expect(h.value('vrFillFeeInput')).toBe('0.95');
  });

  it('shows a zero fee for a zero cost and still sends no fee key', async () => {
    await mount(0);
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    expect(h.value('vrFillFeeInput')).toBe('0.00');
    await h.submit();
    expect(calls).toHaveLength(1);
    expect('fee' in (calls[0]!.body as object)).toBe(false);
  });

  it('leaves the fee blank while shares or price cannot be read', async () => {
    await mount(700);
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', 'abc');
    expect(h.value('vrFillFeeInput')).toBe('');
  });
});
