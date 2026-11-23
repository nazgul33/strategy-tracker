import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { goOffline } from '../../testing/offline';
import { restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { errorText, fillDialogHelpers, fillDto, installFillDialogStub } from '../../testing/fillDialog';

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
let putFailure: { status: number; error: string } | null = null;
let postFailure: { status: number; error: string } | null = null;
let deleteFailure: { status: number; error: string } | null = null;

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

  const { type, clickButton } = fillDialogHelpers({ act, stub: () => stub });

  beforeEach(() => {
    putFailure = null;
    postFailure = null;
    deleteFailure = null;
    saved = 0;
    closed = 0;
    stub = installFillDialogStub({
      putFailure: () => putFailure,
      postFailure: () => postFailure,
      deleteFailure: () => deleteFailure,
    });
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

  it('maps a server error code through fillErr.* and keeps the dialog open', async () => {
    putFailure = { status: 422, error: 'not-last' };
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await clickButton('Save');
    expect(errorText()).toBe('Only the last fill of a bucket can be deleted.');
    expect(closed).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  const replayErrors: Array<[string, string]> = [
    ['too-many-shares', 'More shares than the position holds.'],
    ['bucket-not-held', 'This bucket is not currently held.'],
    ['bucket-not-empty', 'This bucket still has open shares.'],
  ];

  for (const [code, text] of replayErrors) {
    it(`save failing with ${code} shows the localized text, not the raw code`, async () => {
      putFailure = { status: 422, error: code };
      await render({ costPpm: 30, fill: fillDto(), deletable: true });
      await clickButton('Save');
      expect(errorText()).toBe(text);
      expect(closed).toBe(0);
    });

    it(`delete failing with ${code} shows the localized text, not the raw code`, async () => {
      deleteFailure = { status: 422, error: code };
      await render({ costPpm: 30, fill: fillDto(), deletable: true });
      await clickButton('Delete');
      await clickButton('Delete for real');
      expect(errorText()).toBe(text);
      expect(closed).toBe(0);
    });
  }

  const addErrors: Array<[string, string]> = [
    ['no-bucket-for-sell', 'No held bucket can cover this sell — check the share count.'],
    ['no-empty-bucket', 'No empty bucket left in this run — free one up first.'],
    ['invalid-shares', 'Invalid share count.'],
  ];

  for (const [code, text] of addErrors) {
    it(`add fill failing with ${code} shows the localized text and keeps the dialog open`, async () => {
      postFailure = { status: 422, error: code };
      await render();
      await type('manualSharesInput', '3');
      await type('manualPriceInput', '5.00');
      await type('manualDateInput', '2026-11-06');
      await clickButton('Add fill');
      expect(errorText()).toBe(text);
      expect(closed).toBe(0);
      expect(saved).toBe(0);
    });
  }

  it('an unknown error code keeps its code in worded copy', async () => {
    putFailure = { status: 422, error: 'weird-code' };
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await clickButton('Save');
    expect(errorText()).toBe('The request failed (weird-code).');
  });

  it('a save with the server unreachable is worded and keeps the dialog open', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    goOffline('PUT');
    await clickButton('Save');
    expect(errorText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('edit mode with bucketClosed shows the closed-bucket warning', async () => {
    await render({ fill: fillDto(), bucketClosed: true });
    expect(document.querySelector('[role="dialog"]')!.textContent ?? '').toContain(
      'This fill belongs to a closed position. Saving re-derives all later history and may book a cash adjustment.',
    );
  });

  it('delete confirm with bucketClosed shows the closed-bucket warning', async () => {
    await render({ fill: fillDto(), bucketClosed: true, deletable: true });
    await clickButton('Delete');
    expect(document.querySelector('[role="dialog"]')!.textContent ?? '').toContain(
      'This fill belongs to a closed position. Saving re-derives all later history and may book a cash adjustment.',
    );
  });


  it('edit mode without bucketClosed shows no warning', async () => {
    await render({ fill: fillDto() });
    expect(document.querySelector('[role="dialog"]')!.textContent ?? '').not.toContain('closed position');
  });
});
