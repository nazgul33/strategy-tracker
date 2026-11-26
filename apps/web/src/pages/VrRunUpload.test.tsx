// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RunStatus } from '../api';
import { elementByTestId } from '../testing/dom';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { countGets, imageFile, pickFiles, stubUploads } from '../testing/upload';
import type { UploadAnswer } from '../testing/upload';
import { VR_DETAIL, VR_PENDING, VR_RUN, vrDetail } from '../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrRunPage } = await import('./VrRun');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const VR_WAITING: UploadAnswer = {
  json: { events: [{ type: 'vr-outcome', runId: 5, ticker: 'TQQQ', outcome: { waiting: 2, dropped: 0, possibleDuplicates: 0 } }] },
};
const VR_DUP: UploadAnswer = { json: { events: [{ type: 'vr-outcome', runId: 5, ticker: 'TQQQ', outcome: 'duplicate' }] } };

let detailBody: unknown = VR_DETAIL;
let pendingGets = 0;

const click = async (testId: string) => {
  await act(async () => (elementByTestId(testId) as HTMLButtonElement).click());
  await flush();
};
const tabButton = (id: string) => elementByTestId(`vrTab-${id}`);

describe('VrRunPage upload button', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let sent: { name: string; runId: string | null }[];

  async function mount(answers: UploadAnswer[], detail: unknown = VR_DETAIL) {
    detailBody = detail;
    pendingGets = 0;
    installFetchStub([
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
          return detailBody;
        },
      },
    ]);
    sent = stubUploads(answers).sent;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(VrRunPage, { id: 5 })));
    await flush();
  }

  async function upload() {
    await click('uploadScreenshot');
    await pickFiles(act, [imageFile('vr-1.png')]);
    await click('uploadSubmit');
    await flush();
  }

  beforeEach(() => {
    sent = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  for (const status of ['active', 'paused', 'closed'] as RunStatus[]) {
    it(`shows Upload screenshot for a ${status} run`, async () => {
      await mount([], { ...VR_DETAIL, run: { ...VR_RUN, status } });
      expect(elementByTestId('uploadScreenshot').textContent).toBe('Upload screenshot');
    });
  }

  it('the popup pins the upload to this run', async () => {
    await mount([VR_DUP]);
    await upload();
    expect(sent[0]!.runId).toBe('5');
  });

  it('closing after an upload reloads the run', async () => {
    await mount([VR_DUP]);
    await upload();
    detailBody = vrDetail({ name: 'After upload' });
    await click('uploadClose');
    expect(document.querySelector('h1')!.textContent).toContain('After upload');
    expect(document.querySelector('[data-testid="uploadSubmit"]')).toBeNull();
  });

  it('closing without an upload does not reload', async () => {
    await mount([]);
    const gets = countGets('/api/vr/runs/5');
    await click('uploadScreenshot');
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
    await act(async () => cancel.click());
    await flush();
    expect(gets()).toBe(0);
    expect(document.querySelector('[data-testid="uploadSubmit"]')).toBeNull();
  });

  it('Go to pending selects the Pending tab and reloads the run', async () => {
    await mount([VR_WAITING]);
    await upload();
    detailBody = vrDetail({ pendingCount: 2 });
    await click('uploadGoToPending');
    expect(tabButton('pending').className).toContain('bg-primary');
    expect(tabButton('pending').textContent).toBe('Pending 2');
    expect(elementByTestId('vrPendingPanel')).not.toBeNull();
  });

  it('Go to pending while on the Pending tab re-reads the list once', async () => {
    await mount([VR_WAITING]);
    await click('vrTab-pending');
    const gets = countGets('/pending');
    await upload();
    await click('uploadGoToPending');
    expect(gets()).toBe(1);
    expect(tabButton('pending').className).toContain('bg-primary');
  });

  it('the result line links to the Pending tab', async () => {
    await mount([VR_WAITING]);
    await upload();
    const link = document.querySelector('[data-upload-result] a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/vr/5?tab=pending');
    expect(link.textContent).toBe('TQQQ → VR run #5: 2 waiting on its Pending tab');
  });

  it('a waiting outcome pinned to this run makes Go to pending the main button', async () => {
    await mount([VR_WAITING]);
    await upload();
    expect(document.querySelector('[data-testid="uploadClose"]')).toBeNull();
    expect(elementByTestId('uploadGoToPending')).not.toBeNull();
  });

  it("a 'duplicate' answer shows Close, and closing keeps the Fills tab", async () => {
    await mount([VR_DUP]);
    await upload();
    expect(document.querySelector('[data-testid="uploadGoToPending"]')).toBeNull();
    await click('uploadClose');
    expect(tabButton('fills').className).toContain('bg-primary');
    expect(elementByTestId('vrFillsPanel')).not.toBeNull();
    expect(pendingGets).toBe(0);
  });
});
