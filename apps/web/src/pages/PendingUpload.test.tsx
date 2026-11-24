import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../testing/dom';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { buttonByText } from '../testing/runDetail';
import { countGets, imageFile, pickFiles, stubUploads } from '../testing/upload';
import type { UploadAnswer } from '../testing/upload';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingPage } = await import('./Pending');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DUPLICATE: UploadAnswer = { json: { events: [{ type: 'outcome', runId: 1, ticker: 'QQQ', outcome: 'duplicate' }] } };

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const headings = (tag: string) => Array.from(document.querySelectorAll(tag)).map((h) => h.textContent);

const click = async (testId: string) => {
  await act(async () => (elementByTestId(testId) as HTMLButtonElement).click());
};

describe('PendingPage upload button', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
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

  async function render(answers: UploadAnswer[]) {
    installFetchStub([
      { url: '/api/corrections', json: [] },
      { url: '/api/pending', json: [] },
    ]);
    const stub = stubUploads(answers);
    await act(async () => {
      root.render(d(PendingPage));
    });
    await flush();
    return stub;
  }

  async function upload() {
    await click('uploadScreenshot');
    await pickFiles(act, [imageFile('fills-1.png')]);
    await click('uploadSubmit');
    await flush();
  }

  it('the page header has the upload button and the popup is global', async () => {
    const { sent } = await render([DUPLICATE]);
    expect(elementByTestId('uploadScreenshot').textContent).toBe('Upload screenshot');
    await upload();
    expect(sent[0]!.runId).toBeNull();
    expect(headings('h1')).toEqual(['Pending']);
  });

  it('closing after an upload re-reads the pending table and the corrections', async () => {
    await render([DUPLICATE]);
    await upload();
    const pending = countGets('/api/pending');
    const corrections = countGets('/api/corrections');
    await click('uploadClose');
    await flush();
    expect(pending()).toBe(1);
    expect(corrections()).toBe(1);
  });

  it('closing without an upload re-reads nothing', async () => {
    await render([]);
    const pending = countGets('/api/pending');
    const corrections = countGets('/api/corrections');
    await click('uploadScreenshot');
    await act(async () => buttonByText('Cancel').click());
    await flush();
    expect(pending()).toBe(0);
    expect(corrections()).toBe(0);
    expect(document.querySelector('[data-testid="uploadSubmit"]')).toBeNull();
  });
});
