import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { fillDialogHelpers, fillDto, findButton, button, installFillDialogStub } from '../../testing/fillDialog';
import type { FillDialogCall } from '../../testing/fillDialog';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
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
let calls: FillDialogCall[] = [];
let deltaCents = 0; // booked cash adjustment returned by the PUT/DELETE stubs

describe('FillDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let saved = 0;
  let closed = 0;

  async function render(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(d(FillDialog, { runId: 7, onClose: () => (closed += 1), onSaved: () => (saved += 1), ...props }));
    });
  }

  const { clickButton } = fillDialogHelpers({
    act,
    stub: () => stub,
    onCalls: (recorded) => (calls = recorded),
  });

  beforeEach(() => {
    calls = [];
    saved = 0;
    closed = 0;
    deltaCents = 0;
    stub = installFillDialogStub({ deltaCents: () => deltaCents });
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

  it('delete: confirm inside the dialog then DELETE, cancel returns to the form', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    expect(button('Delete')).toBeTruthy();

    await clickButton('Delete');
    expect(document.body.textContent).toContain(
      "Delete this bucket's last fill (10 shares)? Cash and positions are recomputed.",
    );

    // Cancel returns to the form without deleting.
    await clickButton('Cancel');
    expect(button('Delete')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0);

    await clickButton('Delete');
    await clickButton('Delete for real');

    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url.endsWith('/api/runs/7/fills/3')).toBe(true);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('no Delete button when the fill is not deletable or absent', async () => {
    await render({ fill: fillDto(), deletable: false });
    expect(findButton('Delete')).toBeUndefined();
    expect(findButton('Delete for real')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);

    await render();
    expect(findButton('Delete')).toBeUndefined();
  });


  it('edit save with a nonzero delta: success step shows the summary, OK saves and closes', async () => {
    deltaCents = -120;
    await render({ fill: fillDto() });
    await clickButton('Save');
    // Form replaced by the booked-adjustment summary; nothing propagates yet.
    expect(document.getElementById('manualSharesInput')).toBeNull();
    expect(document.body.textContent ?? '').toContain('-$1.20');
    expect(document.body.textContent ?? '').not.toContain('Rebuilt run state');
    // The shared result popup is what renders here, not an ad-hoc copy.
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();
    expect(saved).toBe(0);
    expect(closed).toBe(0);

    await clickButton('OK');
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('delete with a nonzero delta: same success step, OK saves and closes', async () => {
    deltaCents = 80;
    await render({ fill: fillDto(), deletable: true });
    await clickButton('Delete');
    await clickButton('Delete for real');
    expect(document.body.textContent ?? '').toContain('$0.80');
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();
    expect(saved).toBe(0);
    expect(closed).toBe(0);

    await clickButton('OK');
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('edit save with a nonzero delta: the X button dismisses and still saves and closes', async () => {
    deltaCents = -120;
    await render({ fill: fillDto() });
    await clickButton('Save');
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();

    await act(async () => {
      document
        .querySelector('[role="dialog"] button[aria-label="Cancel"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('delete with a nonzero delta: backdrop dismiss saves and closes too', async () => {
    deltaCents = 80;
    await render({ fill: fillDto(), deletable: true });
    await clickButton('Delete');
    await clickButton('Delete for real');
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();

    await act(async () => {
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

});
