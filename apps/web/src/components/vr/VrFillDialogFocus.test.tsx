// VrFillDialog: first focus, Escape, and the note after an entry dated before the current cycle.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
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

const NOTE =
  'Saved. This entry is dated before the current cycle started, so the V values of earlier cycles are not recalculated.';

describe('VrFillDialog focus, Escape and the earlier-cycle note', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let closed = 0;
  let saved = 0;
  let listed: unknown = VR_FILLS;
  let listStatus = 200;
  let fillGets = 0;
  const post = { method: 'POST' as const, url: '/fills', status: 201, json: { id: 13 } as unknown };
  const put = { method: 'PUT' as const, url: '/fills/', status: 204, json: undefined as unknown };
  const del = { method: 'DELETE' as const, url: '/fills/', status: 204, json: undefined as unknown };

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
  const earlierRow = (beforeCycle: boolean) => [{ ...VR_FILLS[1]!, id: 13, filledOn: '2026-11-20', beforeCycle }, ...VR_FILLS];
  const addDatedFill = async () => {
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    await h.type('vrFillDateInput', '2026-11-20');
    await h.submit();
  };

  beforeEach(() => {
    closed = 0;
    saved = 0;
    listed = VR_FILLS;
    listStatus = 200;
    fillGets = 0;
    installFetchStub([
      post,
      put,
      del,
      {
        url: '/fills',
        get status() {
          return listStatus;
        },
        get json() {
          fillGets += 1;
          return listStatus === 200 ? listed : { error: 'boom' };
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

  it('focuses the side select first, in add and in edit mode', async () => {
    await mount();
    expect(document.activeElement).toBe(elementByTestId('vrFillSideSelect'));
    await act(async () => root.render(null));
    await mount({ fill: VR_FILLS[0] });
    expect(document.activeElement).toBe(elementByTestId('vrFillSideSelect'));
  });

  it('ignores Escape on the form and keeps the typed values', async () => {
    await mount();
    await h.type('vrFillSharesInput', '7');
    await h.pressEscape();
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrFillSharesInput')).toBe('7');
    expect(closed).toBe(0);
  });

  it('ignores Escape on the delete step', async () => {
    await mount({ fill: VR_FILLS[0], startOnDelete: true });
    expect(document.activeElement).toBe(h.button('Cancel'));
    await h.pressEscape();
    expect(h.dialogOpen()).toBe(true);
    expect(h.findButton('Delete for real')).toBeDefined();
    expect(closed).toBe(0);
  });

  it('shows the earlier-cycle note when the saved fill is dated before the cycle, and reports the save on Close', async () => {
    listed = earlierRow(true);
    await mount();
    await addDatedFill();
    expect(elementByTestId('vrEarlierCycleNote').textContent).toBe(NOTE);
    expect(saved).toBe(0);
    expect(closed).toBe(0);
    expect(document.activeElement).toBe(h.button('Close'));

    await h.pressEscape();
    expect(document.querySelector('[data-testid="vrEarlierCycleNote"]')).not.toBeNull();
    expect(saved).toBe(0);

    await h.click('Close');
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('shows the note after an edit that leaves the fill before the cycle', async () => {
    await mount({ fill: VR_FILLS[1] });
    await h.click('Save');
    expect(document.querySelector('[data-testid="vrEarlierCycleNote"]')).not.toBeNull();
  });

  it('shows no note when the saved fill is not before the cycle', async () => {
    listed = earlierRow(false);
    await mount();
    await addDatedFill();
    expect(document.querySelector('[data-testid="vrEarlierCycleNote"]')).toBeNull();
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('closes normally when the re-read fails (the save itself succeeded)', async () => {
    listStatus = 500;
    await mount();
    await addDatedFill();
    expect(document.querySelector('[data-testid="vrEarlierCycleNote"]')).toBeNull();
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('closes normally when the re-read cannot reach the server', async () => {
    await mount();
    await h.type('vrFillSharesInput', '3');
    await h.type('vrFillPriceInput', '45.15');
    goOffline('GET', '/fills');
    await h.submit();
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('shows the note after deleting a fill dated before the cycle, without a re-read', async () => {
    await mount({ fill: VR_FILLS[1], startOnDelete: true });
    await h.click('Delete for real');
    expect(elementByTestId('vrEarlierCycleNote').textContent).toBe(NOTE);
    expect(fillGets).toBe(0);
    expect(saved).toBe(0);
    await h.click('Close');
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('deletes a current-cycle fill without a note', async () => {
    await mount({ fill: VR_FILLS[0], startOnDelete: true });
    await h.click('Delete for real');
    expect(document.querySelector('[data-testid="vrEarlierCycleNote"]')).toBeNull();
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });
});
