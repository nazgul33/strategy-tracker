// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';
import { RUN, runDetailHelpers, runDetailRoutes } from '../testing/runDetail';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunDetailPage } = await import('./RunDetail');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

let calls: FetchCalls;
let runBody: Record<string, unknown> = RUN;

function stubFetch() {
  runBody = RUN;
  calls = installFetchStub(runDetailRoutes(() => runBody));
}

const { flush } = runDetailHelpers({ act, calls: () => calls });

describe('RunDetailPage add-fill button', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    stubFetch();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('keeps the tab bar data-only and puts Add fill in the header actions row', () => {
    // Header actions row is `gap-2 items-center`; the tab row is `gap-1`.
    const tabRow = document.querySelector('div.flex.flex-wrap.gap-1');
    expect(tabRow).not.toBeNull();
    expect([...tabRow!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Orders',
      'Pending',
      'Fills',
      'History',
      'Alerts',
    ]);
    const btns = Array.from(document.querySelectorAll('[data-testid="tabManual"]'));
    expect(btns.length).toBe(1);
    expect(btns[0]!.textContent).toBe('Add fill');
    // No inline manual form any more: the Shares input only exists inside the dialog.
    expect(document.querySelector('[data-testid="manualSideSelect"]')).toBeNull();
  });

  it('opens the shared fill dialog with side selectable, defaulting to buy', async () => {
    await act(async () => {
      (document.querySelector('[data-testid="tabManual"]') as HTMLElement).click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const side = document.querySelector('[data-testid="manualSideSelect"]') as HTMLSelectElement | null;
    expect(side).not.toBeNull();
    expect(side!.disabled).toBe(false);
    expect(side!.value).toBe('buy');
  });

  it("the fill dialog's date defaults to the server's date from the run response", async () => {
    runBody = { ...RUN, today: '2026-11-22' };
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      (document.querySelector('[data-testid="tabManual"]') as HTMLElement).click();
    });
    expect((document.querySelector('[data-testid="manualDateInput"]') as HTMLInputElement).value).toBe('2026-11-22');
  });

  it("the fill dialog offers the run's held buckets when the side is sell", async () => {
    runBody = {
      ...RUN,
      state: {
        ...RUN.state,
        buckets: [{ index: 1, state: 'held', shares: 20, buyPrice: '4700000', buyFeeCents: 0, filledOn: '2026-11-02' }],
      },
    };
    // The page already loaded the empty RUN in beforeEach: remount to fetch this body.
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      (document.querySelector('[data-testid="tabManual"]') as HTMLElement).click();
    });
    const side = document.querySelector('[data-testid="manualSideSelect"]') as HTMLSelectElement;
    await act(async () => {
      side.value = 'sell';
      side.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const bucket = document.querySelector('[data-testid="manualBucketSelect"]') as HTMLSelectElement;
    expect(Array.from(bucket.options).map((o) => o.textContent)).toEqual(['Automatic', 'Bucket 1 · 20 sh']);
  });
});
