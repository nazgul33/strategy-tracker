// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../testing/dom';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';
import { RUN, buttonByText, runDetailHelpers, runDetailRoutes } from '../testing/runDetail';
import { countGets, imageFile, pickFiles, stubUploads } from '../testing/upload';
import type { UploadAnswer } from '../testing/upload';

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

const PENDING_ROW = {
  id: 2,
  runId: 1,
  captureId: 3,
  side: 'buy',
  ticker: 'QQQ',
  shares: 10,
  price: '470.50',
  fee: null,
  filledOn: '2026-11-23',
  detectedFilledOn: '2026-11-23',
  status: 'pending',
  needsBucket: false,
  dateAfterToday: false,
};
const OUTCOME: UploadAnswer = { json: { events: [{ type: 'outcome', runId: 1, ticker: 'QQQ', outcome: { pending: [PENDING_ROW] } }] } };
const DUPLICATE: UploadAnswer = { json: { events: [{ type: 'outcome', runId: 1, ticker: 'QQQ', outcome: 'duplicate' }] } };

let calls: FetchCalls;
let runBody: Record<string, unknown> = RUN;

const { flush } = runDetailHelpers({ act, calls: () => calls });

const click = async (testId: string) => {
  await act(async () => (elementByTestId(testId) as HTMLButtonElement).click());
};

describe('RunDetailPage upload button', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let sent: { name: string; runId: string | null }[];

  async function mount(answers: UploadAnswer[]) {
    runBody = RUN;
    calls = installFetchStub(runDetailRoutes(() => runBody));
    sent = stubUploads(answers).sent;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
  }

  async function upload() {
    await click('uploadScreenshot');
    await pickFiles(act, [imageFile('fills-1.png')]);
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

  it('Upload screenshot sits right after Add fill in the header actions', async () => {
    await mount([]);
    const next = elementByTestId('tabManual').nextElementSibling;
    expect(next).toBe(elementByTestId('uploadScreenshot'));
    expect(next!.textContent).toBe('Upload screenshot');
    const tabRow = document.querySelector('div.flex.flex-wrap.gap-1');
    expect([...tabRow!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Orders',
      'Pending',
      'Fills',
      'History',
      'Alerts',
    ]);
  });

  it('the popup pins the upload to this run', async () => {
    await mount([DUPLICATE]);
    await upload();
    expect(sent[0]!.runId).toBe('1');
  });

  it('closing after an upload reloads the run', async () => {
    await mount([DUPLICATE]);
    await upload();
    runBody = { ...RUN, name: 'After upload' };
    await click('uploadClose');
    await flush();
    expect(document.querySelector('h1')!.textContent).toContain('After upload');
  });

  it('closing without an upload does not reload', async () => {
    await mount([]);
    const gets = countGets('/api/runs/1');
    await click('uploadScreenshot');
    await act(async () => buttonByText('Cancel').click());
    await flush();
    expect(gets()).toBe(0);
    expect(document.querySelector('[data-testid="uploadSubmit"]')).toBeNull();
  });

  it('Go to pending selects the Pending tab', async () => {
    await mount([OUTCOME]);
    await upload();
    await click('uploadGoToPending');
    await flush();
    expect(buttonByText('Pending').className).toContain('bg-primary');
  });
});
