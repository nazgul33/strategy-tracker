// VrRunPage: the Pending tab (label with the count, the deep link, and the reload that follows a decision).
// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { vrDialogHelpers } from '../testing/vrDialog';
import { VR_DETAIL, VR_PENDING, vrDetail } from '../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrRunPage } = await import('./VrRun');

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

let detail: unknown = VR_DETAIL;
let detailGets = 0;
let pendingGets = 0;

const routes = () => [
  { method: 'POST' as const, url: '/confirm', status: 201, json: { fillId: 50 } as unknown },
  {
    url: '/pending',
    get json() {
      pendingGets += 1;
      return VR_PENDING;
    },
  },
  { url: '/cycles', json: [] },
  { url: '/notifications', json: [] },
  { url: '/fills', json: [] },
  { url: '/cash', json: [] },
  {
    url: '/api/vr/runs/5',
    get json() {
      detailGets += 1;
      return detail;
    },
  },
];

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const tabLabels = () => [...document.querySelectorAll('[data-testid^="vrTab-"]')].map((b) => b.textContent);

describe('VrRunPage Pending tab', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const render = async (props: { initialTab?: 'pending' } = {}) => {
    await act(async () => root.render(d(VrRunPage, { id: 5, ...props })));
    await h.flush();
  };

  beforeEach(() => {
    detail = VR_DETAIL;
    detailGets = 0;
    pendingGets = 0;
    installFetchStub(routes());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('lists the tabs in order, the Pending one without a count when nothing waits', async () => {
    await render();
    expect(tabLabels()).toEqual(['Fills', 'Pending', 'Cash', 'Cycles', 'Alerts']);
  });

  it('shows the count on the Pending tab when rows wait', async () => {
    detail = vrDetail({ pendingCount: 3 });
    await render();
    expect(tabLabels()).toEqual(['Fills', 'Pending 3', 'Cash', 'Cycles', 'Alerts']);
  });

  it('opens on the Pending tab when asked to', async () => {
    await render({ initialTab: 'pending' });
    expect(byId('vrPendingPanel')).not.toBeNull();
    expect(byId('vrFillsPanel')).toBeNull();
    expect(byId('vrTab-pending')!.className).toContain('bg-primary');
    expect(byId('vrTab-fills')!.className).not.toContain('bg-primary');
  });

  it('opens on Fills by default', async () => {
    await render();
    expect(byId('vrFillsPanel')).not.toBeNull();
    expect(byId('vrPendingPanel')).toBeNull();
  });

  it('clicking the Pending tab fetches the list once and re-reads the detail', async () => {
    await render();
    expect(pendingGets).toBe(0);
    const before = detailGets;
    await h.clickId('vrTab-pending');
    expect(byId('vrPendingPanel')).not.toBeNull();
    expect(pendingGets).toBe(1);
    expect(detailGets).toBe(before + 1);
  });

  it('a confirm in the panel re-reads the detail, and the label follows the new count', async () => {
    detail = vrDetail({ pendingCount: 3 });
    await render({ initialTab: 'pending' });
    expect(tabLabels()[1]).toBe('Pending 3');
    const before = detailGets;
    detail = vrDetail({ pendingCount: 2 });
    await h.clickId('vrPendingConfirm-31');
    expect(detailGets).toBeGreaterThan(before);
    expect(tabLabels()[1]).toBe('Pending 2');
  });
});
