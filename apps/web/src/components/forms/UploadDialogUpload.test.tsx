import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import { button } from '../../testing/fillDialog';
import { holdNext } from '../../testing/holdFetch';
import { imageFile, pickFiles, stubUploads } from '../../testing/upload';
import type { UploadAnswer } from '../../testing/upload';
import type { UploadCloseOutcome as Outcome } from './UploadDialog';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { UploadDialog } = await import('./UploadDialog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SELL_ROW = {
  id: 2,
  runId: 7,
  captureId: 3,
  side: 'sell',
  ticker: 'NVDA',
  shares: 10,
  price: '134.05',
  fee: null,
  filledOn: '2026-11-23',
  detectedFilledOn: '2026-11-23',
  status: 'pending',
  needsBucket: true,
  dateAfterToday: false,
};
const OUTCOME: UploadAnswer = { json: { events: [{ type: 'outcome', runId: 7, ticker: 'NVDA', outcome: { pending: [SELL_ROW] } }] } };
const DUPLICATE: UploadAnswer = { json: { events: [{ type: 'outcome', runId: 1, ticker: 'NVDA', outcome: 'duplicate' }] } };

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const has = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) !== null;
const panel = () => document.querySelector('[data-modal-panel]')!;

describe('UploadDialog uploading', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let closes: Outcome[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    closes = [];
    installFetchStub([]);
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

  async function open(runId?: number) {
    await act(async () => {
      root.render(d(UploadDialog, { ...(runId === undefined ? {} : { runId }), onClose: (o: Outcome) => closes.push(o) }));
    });
  }

  async function submit() {
    const btn = elementByTestId('uploadSubmit') as HTMLButtonElement;
    await act(async () => btn.focus()); // a real click focuses the button; happy-dom click() does not
    await act(async () => btn.click());
  }

  async function uploadOne(answer: UploadAnswer, runId?: number) {
    const stub = stubUploads([answer]);
    await open(runId);
    await pickFiles(act, [imageFile('fills-1.png')]);
    await submit();
    await flush();
    return stub;
  }

  it('pinned upload sends the run id and shows the result lines', async () => {
    const { sent } = await uploadOne(OUTCOME, 7);
    expect(sent).toEqual([{ name: 'fills-1.png', runId: '7' }]);
    const text = container.textContent ?? '';
    expect(text).toContain('NVDA → run #7: 1 waiting in Pending');
    expect(text).toContain('Sell 10 @ $134.05 on 2026-11-23');
    expect(text).toContain('Choose the bucket in Pending.');
    expect(container.querySelector('a[href="#/runs/7"]')).not.toBeNull();
    expect(has('uploadGoToPending')).toBe(true);
    expect(has('uploadClose')).toBe(false);
  });

  // Only the classes can be checked: the test DOM does no layout.
  it('a result line text, plain or a link, may shrink and wrap long unbroken text', async () => {
    await uploadOne(OUTCOME, 7);
    const texts = Array.from(container.querySelectorAll('[data-upload-result] li')).map((li) => li.children[1]!);
    expect(texts.some((el) => el.tagName === 'A')).toBe(true);
    expect(texts.some((el) => el.tagName === 'SPAN')).toBe(true);
    for (const el of texts) expect(el.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));
  });

  it('global upload sends no run id', async () => {
    const { sent } = await uploadOne(OUTCOME);
    expect(sent[0]!.runId).toBeNull();
  });

  it('files go one at a time in pick order, and a failure does not stop the rest', async () => {
    const held = holdNext('POST', '/api/captures');
    const { sent } = stubUploads([OUTCOME, 'network-error', DUPLICATE]);
    await open();
    await pickFiles(act, [imageFile('a.png'), imageFile('b.png'), imageFile('c.png')]);
    await submit();
    await flush();
    expect(sent.length).toBe(1);
    expect(container.textContent).toContain('reading…');
    expect(container.textContent).toContain('waiting');
    held.release();
    await flush();
    expect(sent.map((s) => s.name)).toEqual(['a.png', 'b.png', 'c.png']);
    const sections = Array.from(container.querySelectorAll('[data-upload-result]')).map((el) => el.textContent ?? '');
    expect(sections.length).toBe(3);
    expect(sections[1]).toContain('b.png');
    expect(sections[1]).toContain('The connection dropped before the server answered.');
    expect(sections[2]).toContain('c.png');
    expect(sections[2]).toContain('Already uploaded, nothing new');
  });

  it('while an upload is in flight Escape, the backdrop, ✕ and Cancel do nothing', async () => {
    const held = holdNext('POST', '/api/captures');
    stubUploads([DUPLICATE]);
    await open();
    await pickFiles(act, [imageFile('fills-1.png')]);
    await submit();
    await flush();
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => (container.querySelector('[role=dialog]') as HTMLElement).click());
    await act(async () => button('✕').click());
    await act(async () => button('Cancel').click());
    expect(closes.length).toBe(0);
    held.release();
    await flush();
    expect(has('uploadClose')).toBe(true);
  });

  it('focus stays inside the dialog when the upload starts and when it finishes', async () => {
    const held = holdNext('POST', '/api/captures');
    stubUploads([DUPLICATE]);
    await open();
    await pickFiles(act, [imageFile('fills-1.png')]);
    await submit();
    await flush();
    // happy-dom keeps focus on a control that turns disabled; a browser's Tab trap would lose it.
    expect(panel().contains(document.activeElement)).toBe(true);
    expect(document.activeElement!.matches(':disabled')).toBe(false);
    held.release();
    await flush();
    expect(document.activeElement === elementByTestId('uploadClose')).toBe(true);
  });

  it('focus lands on Go to pending when the upload reached Pending', async () => {
    await uploadOne(OUTCOME, 7);
    expect(document.activeElement === elementByTestId('uploadGoToPending')).toBe(true);
  });

  it('a file dropped outside the drop zone is not opened by the browser', async () => {
    await open();
    for (const type of ['dragover', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [imageFile('stray.png')] } });
      await act(async () => {
        document.body.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(elementByTestId('uploadSubmit').textContent).toBe('Upload (0)');
  });

  it('a drop on the dialog while an upload is in flight is not opened by the browser', async () => {
    const held = holdNext('POST', '/api/captures');
    stubUploads([DUPLICATE]);
    await open();
    await pickFiles(act, [imageFile('fills-1.png')]);
    await submit();
    await flush();
    const event = new Event('drop', { bubbles: true, cancelable: true });
    await act(async () => {
      container.querySelector('[role=dialog]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    held.release();
    await flush();
  });

  it('once the dialog is gone a drop is left to the browser', async () => {
    await open();
    await act(async () => root.render(null));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Go to pending stays primary after Upload more when an earlier batch reached Pending', async () => {
    stubUploads([OUTCOME, DUPLICATE]);
    await open(7);
    await pickFiles(act, [imageFile('fills-1.png')]);
    await submit();
    await flush();
    await act(async () => (elementByTestId('uploadMore') as HTMLButtonElement).click());
    await pickFiles(act, [imageFile('fills-2.png')]);
    await submit();
    await flush();
    expect(has('uploadClose')).toBe(false);
    await act(async () => (elementByTestId('uploadGoToPending') as HTMLButtonElement).click());
    expect(closes).toEqual([{ uploaded: true, goToPending: true }]);
  });

  it('Close is primary when nothing reached Pending, and reports the upload', async () => {
    await uploadOne(DUPLICATE);
    expect(has('uploadGoToPending')).toBe(false);
    const close = elementByTestId('uploadClose') as HTMLButtonElement;
    expect(close.className).toContain('bg-primary');
    await act(async () => close.click());
    expect(closes).toEqual([{ uploaded: true, goToPending: false }]);
  });

  it('Go to pending reports goToPending', async () => {
    await uploadOne(OUTCOME, 7);
    const go = elementByTestId('uploadGoToPending') as HTMLButtonElement;
    expect(go.className).toContain('bg-primary');
    await act(async () => go.click());
    expect(closes).toEqual([{ uploaded: true, goToPending: true }]);
  });

  it('vision not configured points to Settings', async () => {
    await uploadOne({ status: 503, json: { error: 'vision-not-configured' } });
    expect(container.textContent).toContain('Vision is not set up: set the vision base URL and model in Settings, then restart the server.');
    expect(container.querySelector('a[href="#/settings"]')).not.toBeNull();
  });

  it('Upload more returns to an empty picker and keeps the uploaded flag', async () => {
    await uploadOne(DUPLICATE);
    await act(async () => (elementByTestId('uploadMore') as HTMLButtonElement).click());
    expect(elementByTestId('uploadSubmit').textContent).toBe('Upload (0)');
    expect(container.textContent).not.toContain('fills-1.png');
    await act(async () => button('Cancel').click());
    expect(closes).toEqual([{ uploaded: true, goToPending: false }]);
  });
});
