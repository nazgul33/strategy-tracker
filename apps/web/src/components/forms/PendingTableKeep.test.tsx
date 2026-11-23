import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { restoreFetch } from '../../testing/fetchStub';
import { setInputValue } from '../../testing/dom';
import { PENDING_ROW as ROW } from '../../testing/pendingRow';
import { pendingTableHelpers } from '../../testing/pendingTable';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const { createRoot } = await import('react-dom/client');
const { act, createElement } = await import('react');
const { PendingTable } = await import('./PendingTable');

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('PendingTable', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const { clickConfirm, pressButton, promptOpen, control, renderWithConfirmCalls } = pendingTableHelpers({
    act,
    createElement,
    PendingTable,
    container: () => container,
    root: () => root,
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

  describe('keep or discard the screenshot', () => {
    const editQty = () => act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), '11'));

    it('confirming an edited row prompts before posting, then posts keepImage true', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await editQty();
      await clickConfirm();

      expect(promptOpen()).toBe(true);
      expect(container.textContent).toContain('Values were edited');
      expect(calls.length).toBe(0);

      await pressButton('Keep for review');
      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 }, keepImage: true });
    });

    it('Discard posts the edit with no keepImage', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await editQty();
      await clickConfirm();
      await pressButton('Discard');

      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 } });
    });

    const RECORD_FAILED = 'its review record could not be saved';

    it('a keep whose review record failed says so', async () => {
      await renderWithConfirmCalls(ROW, { ok: true, archived: false });
      await editQty();
      await clickConfirm();
      await pressButton('Keep for review');

      expect(container.textContent).toContain(RECORD_FAILED);
    });

    it('a keep that stuck shows no note', async () => {
      const calls = await renderWithConfirmCalls(ROW, { ok: true, archived: true });
      await editQty();
      await clickConfirm();
      await pressButton('Keep for review');

      expect(calls.length).toBe(1);
      expect(container.textContent).not.toContain(RECORD_FAILED);
    });

    it('Discard never shows the note', async () => {
      const calls = await renderWithConfirmCalls(ROW, { ok: true, archived: false });
      await editQty();
      await clickConfirm();
      await pressButton('Discard');

      expect(calls.length).toBe(1);
      expect(container.textContent).not.toContain(RECORD_FAILED);
    });

    it('a reject kept for review whose review record failed says so', async () => {
      const calls = await renderWithConfirmCalls(ROW, { ok: true, archived: false });
      await pressButton('Reject');
      await pressButton('Keep for review');

      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/reject' });
      expect(container.textContent).toContain(RECORD_FAILED);
    });

    it('dismissing the prompt posts nothing and leaves the edit in place', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await editQty();
      await clickConfirm();
      await pressButton('✕');

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(0);
      expect(control<HTMLInputElement>(3, 'input').value).toBe('11');
    });

    it('confirming an untouched row posts immediately with no prompt', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await clickConfirm();

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({});
    });

    it('rejecting prompts, and Keep for review posts keepImage true', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await pressButton('Reject');

      expect(promptOpen()).toBe(true);
      expect(container.textContent).toContain('Rejecting this fill');
      expect(calls.length).toBe(0);

      await pressButton('Keep for review');
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/reject', body: { keepImage: true } });
    });

    it('rejecting prompts, and Discard posts a reject with no keepImage', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await pressButton('Reject');
      await pressButton('Discard');

      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/pending/9/reject' });
      expect(calls[0]!.body).toEqual({});
    });

    it('dismissing the reject prompt posts nothing', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await pressButton('Reject');
      await pressButton('✕');

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(0);
    });

    it('no prompt when the row has no image, even when edited', async () => {
      const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
      await editQty();
      await clickConfirm();

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 } });
    });

    it('no prompt when rejecting a row that has no image', async () => {
      const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
      await pressButton('Reject');

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toEqual({});
    });

    it('no prompt for a legacy row with detected null, on confirm or reject', async () => {
      const legacy: PendingFillDto = { ...ROW, detected: null };
      const calls = await renderWithConfirmCalls(legacy);
      await editQty();
      await clickConfirm();
      expect(promptOpen()).toBe(false);
      expect(calls[0]!.body).toEqual({ overrides: { shares: 11 } });

      await pressButton('Reject');
      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(2);
      expect(calls[1]!.body).toEqual({});
    });

    it('a failed validation opens no prompt', async () => {
      const calls = await renderWithConfirmCalls(ROW);
      await act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), '0'));
      await clickConfirm();

      expect(promptOpen()).toBe(false);
      expect(calls.length).toBe(0);
      expect(container.textContent).toContain('Check the values');
    });

    for (const bad of ['1e1', '0x10', '1.5', '-3']) {
      it(`rejects the share count "${bad}" instead of reading it as a number`, async () => {
        const calls = await renderWithConfirmCalls({ ...ROW, hasImage: false });
        await act(async () => setInputValue(control<HTMLInputElement>(3, 'input'), bad));
        await clickConfirm();

        expect(calls.length).toBe(0);
        expect(container.textContent).toContain('Check the values');
      });
    }
  });
});
