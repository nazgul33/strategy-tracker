// VrCashDialog: client checks, worded server errors, focus and Escape.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VrCashDto } from '../../api.vr.types';
import { lookup } from '../../i18n/catalog';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { goOffline } from '../../testing/offline';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_CASH } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrCashDialog } = await import('./VrCashDialog');

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

const OPEN = VR_CASH[0]!;
const WD: VrCashDto = { id: 23, kind: 'withdraw', amountCents: -5_000, movedOn: '2026-12-01', note: 'fees', cycleId: null, createdAt: '2026-12-01 10:00:00', beforeCycle: true };

const post = { method: 'POST' as const, url: '/cash', status: 201, json: { id: 30 } as unknown };
const put = { method: 'PUT' as const, url: '/cash/', status: 204, json: undefined as unknown };
const del = { method: 'DELETE' as const, url: '/cash/', status: 204, json: undefined as unknown };

describe('VrCashDialog checks and errors', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let closed = 0;
  let saved = 0;

  const mount = async (props: Record<string, unknown> = {}) => {
    await act(async () =>
      root.render(
        d(VrCashDialog, { runId: 5, today: '2026-12-09', onClose: () => (closed += 1), onSaved: () => (saved += 1), ...props }),
      ),
    );
    await h.flush();
  };

  beforeEach(() => {
    post.status = 201;
    post.json = { id: 30 };
    put.status = 204;
    put.json = undefined;
    del.status = 204;
    del.json = undefined;
    closed = 0;
    saved = 0;
    calls = installFetchStub([post, put, del]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  const CHECKS: [string, string, string, string][] = [
    ['deposit', '0', 'vr.invalidCashAmount', 'a zero deposit'],
    ['deposit', '-5', 'vr.invalidCashAmount', 'a negative deposit'],
    ['deposit', '', 'vr.invalidCashAmount', 'a blank deposit'],
    ['withdraw', 'abc', 'vr.invalidCashAmount', 'an unreadable withdrawal'],
    ['withdraw', '-5', 'vr.invalidCashAmount', 'a withdrawal typed with a minus sign'],
    ['adjust', '0', 'vr.invalidAdjustAmount', 'a zero adjustment'],
    ['adjust', '-0', 'vr.invalidAdjustAmount', 'a negative zero adjustment'],
    ['adjust', '', 'vr.invalidAdjustAmount', 'a blank adjustment'],
    ['adjust', '--5', 'vr.invalidAdjustAmount', 'a double minus'],
    ['deposit', '21474836.48', 'vr.cashAmountTooLarge', 'a deposit beyond the server limit'],
    ['adjust', '-21474836.48', 'vr.cashAmountTooLarge', 'an adjustment beyond the server limit'],
  ];
  for (const [kind, amount, key, name] of CHECKS) {
    it(`blocks the request for ${name}`, async () => {
      await mount();
      await h.choose('vrCashKindSelect', kind);
      await h.type('vrCashAmountInput', amount);
      await h.submitForm();
      expect(calls).toHaveLength(0);
      expect(h.errorText()).toBe(lookup('en', key));
      expect(saved).toBe(0);
    });
  }

  it('accepts the largest amount the server takes', async () => {
    await mount();
    await h.type('vrCashAmountInput', '21474836.47');
    await h.click('Save');
    expect((calls[0]!.body as { amountCents: number }).amountCents).toBe(2_147_483_647);
  });

  it('blocks a blank date', async () => {
    await mount();
    await h.type('vrCashAmountInput', '5');
    await h.type('vrCashDateInput', '');
    await h.submitForm();
    expect(calls).toHaveLength(0);
    expect(h.errorText()).toBe('Enter a date as YYYY-MM-DD.');
  });

  it('blocks a note over 255 characters', async () => {
    await mount();
    await h.type('vrCashAmountInput', '5');
    await h.type('vrCashNoteInput', 'x'.repeat(256));
    await h.submitForm();
    expect(calls).toHaveLength(0);
    expect(h.errorText()).toBe('The note can be at most 255 characters.');
  });

  it('words cash-date-in-future and keeps the dialog open', async () => {
    post.status = 422;
    post.json = { error: 'cash-date-in-future' };
    await mount();
    await h.type('vrCashAmountInput', '5');
    await h.click('Save');
    expect(h.errorText()).toBe('The date is after today (New York time).');
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrCashAmountInput')).toBe('5');
    expect(saved).toBe(0);
  });

  it('words invalid-amount', async () => {
    post.status = 422;
    post.json = { error: 'invalid-amount' };
    await mount();
    await h.type('vrCashAmountInput', '5');
    await h.click('Save');
    expect(h.errorText()).toBe(lookup('en', 'vrErr.invalid-amount'));
  });

  it('words invalid-note', async () => {
    post.status = 422;
    post.json = { error: 'invalid-note' };
    await mount();
    await h.type('vrCashAmountInput', '5');
    await h.click('Save');
    expect(h.errorText()).toBe('The note can be at most 255 characters.');
  });

  it('words vr-too-large on an edit', async () => {
    put.status = 422;
    put.json = { error: 'vr-too-large' };
    await mount({ move: OPEN });
    await h.click('Save');
    expect(h.errorText()).toBe('This entry is too large for the books. Check the amounts.');
  });

  it('words an unreachable server', async () => {
    await mount();
    await h.type('vrCashAmountInput', '5');
    goOffline('POST', '/cash');
    await h.click('Save');
    expect(h.errorText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(h.dialogOpen()).toBe(true);
  });

  it('words vr-negative-shares on a delete and stays on the confirm step', async () => {
    del.status = 422;
    del.json = { error: 'vr-negative-shares' };
    await mount({ move: WD, startOnDelete: true });
    await h.click('Delete for real');
    expect(h.errorText()).toBe(lookup('en', 'vrErr.vr-negative-shares'));
    expect(h.findButton('Delete for real')).toBeDefined();
    expect(saved).toBe(0);
  });

  it('words vr-too-large on a delete and stays on the confirm step', async () => {
    del.status = 422;
    del.json = { error: 'vr-too-large' };
    await mount({ move: WD, startOnDelete: true });
    await h.click('Delete for real');
    expect(h.errorText()).toBe('This entry is too large for the books. Check the amounts.');
    expect(h.findButton('Delete for real')).toBeDefined();
  });

  it('focuses the kind select when adding and the amount when editing', async () => {
    await mount();
    expect(document.activeElement).toBe(elementByTestId('vrCashKindSelect'));
    await act(async () => root.render(null));
    await mount({ move: OPEN });
    expect(document.activeElement).toBe(elementByTestId('vrCashAmountInput'));
  });

  it('ignores Escape on the form and on the confirm step', async () => {
    await mount({ move: WD });
    await h.type('vrCashAmountInput', '7');
    await h.pressEscape();
    expect(h.dialogOpen()).toBe(true);
    expect(h.value('vrCashAmountInput')).toBe('7');
    await h.clickId('vrCashDeleteBtn');
    await h.pressEscape();
    expect(h.findButton('Delete for real')).toBeDefined();
    expect(closed).toBe(0);
  });
});
