import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { todayIso } from '../../format';
import { restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { errorText, fillDialogHelpers, fillDto, installFillDialogStub } from '../../testing/fillDialog';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in FillDialogErrors.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillDialog } = await import('./FillDialog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let stub: FetchCalls;
let postFailure: { status: number; error: string } | null = null;

describe('FillDialog date and refusals', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let closed = 0;
  let saved = 0;

  async function render(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(d(FillDialog, { runId: 7, onClose: () => (closed += 1), onSaved: () => (saved += 1), ...props }));
    });
  }

  const dateValue = () => (document.querySelector('[data-testid="manualDateInput"]') as HTMLInputElement).value;

  const { type, clickButton } = fillDialogHelpers({ act, stub: () => stub });

  async function addFill() {
    await type('manualSharesInput', '3');
    await type('manualPriceInput', '5.00');
    await clickButton('Add fill');
  }

  beforeEach(() => {
    postFailure = null;
    closed = 0;
    saved = 0;
    stub = installFillDialogStub({ postFailure: () => postFailure });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it("a new fill defaults to the server's date", async () => {
    await render({ today: '2026-11-22' });
    expect(dateValue()).toBe('2026-11-22');
  });

  it("without a server date it falls back to the browser's", async () => {
    await render();
    expect(dateValue()).toBe(todayIso());
  });

  it('an edited fill keeps its own date', async () => {
    await render({ fill: fillDto(), today: '2026-11-22' });
    expect(dateValue()).toBe('2026-11-06');
  });

  it('a refused future date is worded', async () => {
    postFailure = { status: 422, error: 'fill-date-in-future' };
    await render({ today: '2026-11-22' });
    await addFill();
    expect(errorText()).toBe('The trade date is after today (New York time).');
    expect(closed).toBe(0);
    expect(saved).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('a sell that needs a bucket is worded', async () => {
    postFailure = { status: 422, error: 'choose-bucket' };
    await render({ today: '2026-11-22' });
    await addFill();
    expect(errorText()).toBe('The tracker cannot tell which bucket sold this — choose the bucket.');
    expect(closed).toBe(0);
    expect(saved).toBe(0);
  });
});
