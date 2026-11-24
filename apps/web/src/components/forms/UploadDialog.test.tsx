import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { elementByTestId, inputByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import { button } from '../../testing/fillDialog';
import { dropFiles, imageFile, pasteFiles, pickFiles } from '../../testing/upload';
import { MAX_UPLOAD_BYTES } from '../../uploadpick';
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

describe('UploadDialog picking', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let closes: Outcome[];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    closes = [];
    installFetchStub([]);
    await act(async () => {
      root.render(d(UploadDialog, { onClose: (o: Outcome) => closes.push(o) }));
    });
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

  const submit = () => elementByTestId('uploadSubmit') as HTMLButtonElement;

  it('picked files show name and size and can be removed', async () => {
    await pickFiles(act, [imageFile('fills-1.png', { size: 412 * 1024 }), imageFile('fills-2.png')]);
    expect(container.textContent).toContain('fills-1.png');
    expect(container.textContent).toContain('412 KB');
    expect(container.textContent).toContain('fills-2.png');
    expect(submit().textContent).toBe('Upload (2)');
    expect(container.querySelectorAll('img').length).toBe(2);
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove fills-1.png"]')!;
    await act(async () => remove.click());
    expect(submit().textContent).toBe('Upload (1)');
    expect(container.textContent).not.toContain('fills-1.png');
  });

  it('wrong type and oversized files are refused with the server wording', async () => {
    await pickFiles(act, [
      imageFile('notes.pdf', { type: 'application/pdf' }),
      imageFile('heic.heic', { type: 'image/heic' }),
      imageFile('blank', { type: '' }),
      imageFile('big.png', { size: MAX_UPLOAD_BYTES + 1 }),
    ]);
    const text = container.textContent ?? '';
    for (const name of ['notes.pdf', 'heic.heic', 'blank']) {
      expect(text).toContain(`${name}: Only JPEG, PNG, WebP and GIF images can be read.`);
    }
    expect(text).toContain('big.png: This image is larger than 8 MB.');
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe('Upload (0)');
  });

  it('drop and paste add files', async () => {
    await dropFiles(act, [imageFile('dropped.png')]);
    await pasteFiles(act, [imageFile('pasted.png')]);
    expect(submit().textContent).toBe('Upload (2)');
  });

  it('Cancel before uploading reports nothing uploaded', async () => {
    await act(async () => button('Cancel').click());
    expect(closes).toEqual([{ uploaded: false, goToPending: false }]);
  });

  it('the input accepts the four image types, several at once', () => {
    const input = inputByTestId('uploadInput');
    expect(input.accept).toBe('image/jpeg,image/png,image/webp,image/gif');
    expect(input.multiple).toBe(true);
  });
});
