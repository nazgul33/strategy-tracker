// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VrCashDto } from '../../api.vr.types';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
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
const ADJ: VrCashDto = { ...WD, id: 24, kind: 'adjust', amountCents: -1_234, note: null };

const post = { method: 'POST' as const, url: '/cash', status: 201, json: { id: 30 } as unknown };
const put = { method: 'PUT' as const, url: '/cash/', status: 204, json: undefined as unknown };
const del = { method: 'DELETE' as const, url: '/cash/', status: 204, json: undefined as unknown };

describe('VrCashDialog', () => {
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
  const kindSelect = () => elementByTestId('vrCashKindSelect') as HTMLSelectElement;

  beforeEach(() => {
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

  it('adds a withdrawal as a negative amount, with no note key', async () => {
    await mount();
    expect(h.value('vrCashDateInput')).toBe('2026-12-09');
    await h.choose('vrCashKindSelect', 'withdraw');
    await h.type('vrCashAmountInput', '100.00');
    await h.click('Save');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/cash');
    expect(calls[0]!.body).toEqual({ kind: 'withdraw', amountCents: -10_000, movedOn: '2026-12-09' });
    expect('note' in (calls[0]!.body as object)).toBe(false);
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('adds a deposit with a trimmed note', async () => {
    await mount();
    await h.type('vrCashAmountInput', '250');
    await h.type('vrCashNoteInput', '  bonus ');
    await h.click('Save');
    expect(calls[0]!.body).toEqual({ kind: 'deposit', amountCents: 25_000, movedOn: '2026-12-09', note: 'bonus' });
  });

  it('adds an adjustment with either sign and changes the amount hint', async () => {
    await mount();
    expect(document.body.textContent).toContain('Enter a positive amount; the kind sets the sign.');
    await h.choose('vrCashKindSelect', 'adjust');
    expect(document.body.textContent).toContain(
      'Dividends and interest are positive; put a minus sign in front for money taken out.',
    );
    expect(document.body.textContent).not.toContain('Enter a positive amount; the kind sets the sign.');
    await h.type('vrCashAmountInput', '-12.34');
    await h.click('Save');
    expect((calls[0]!.body as { amountCents: number }).amountCents).toBe(-1_234);

    await h.type('vrCashAmountInput', '5');
    await h.click('Save');
    expect((calls[1]!.body as { amountCents: number }).amountCents).toBe(500);
  });

  it('offers the three kinds an entry can be added as', async () => {
    await mount();
    expect([...kindSelect().options].map((o) => o.value)).toEqual(['deposit', 'withdraw', 'adjust']);
    expect([...kindSelect().options].map((o) => o.textContent)).toEqual(['Deposit', 'Withdrawal', 'Adjustment']);
  });

  it('edits the opening cash: kind locked, no Delete, PUT with the note kept blank', async () => {
    await mount({ move: OPEN });
    expect(kindSelect().disabled).toBe(true);
    expect(kindSelect().selectedOptions[0]!.textContent).toBe('Opening cash');
    expect(h.value('vrCashAmountInput')).toBe('10000.00');
    expect(h.value('vrCashDateInput')).toBe('2026-11-05');
    expect(document.querySelector('[data-testid="vrCashDeleteBtn"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit cash movement');

    await h.type('vrCashAmountInput', '12000');
    await h.click('Save');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/cash/21');
    expect(calls[0]!.body).toEqual({ amountCents: 1_200_000, movedOn: '2026-11-05', note: '' });
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('edits a withdrawal: the amount shows positive and the kept note is sent again', async () => {
    await mount({ move: WD });
    expect(h.value('vrCashAmountInput')).toBe('50.00');
    expect(h.value('vrCashNoteInput')).toBe('fees');
    await h.click('Save');
    expect(calls[0]!.body).toEqual({ amountCents: -5_000, movedOn: '2026-12-01', note: 'fees' });
  });

  it('clears a note by sending it empty', async () => {
    await mount({ move: WD });
    await h.type('vrCashNoteInput', '');
    await h.click('Save');
    expect((calls[0]!.body as { note: string }).note).toBe('');
  });

  it('shows an adjustment with its sign', async () => {
    await mount({ move: ADJ });
    expect(h.value('vrCashAmountInput')).toBe('-12.34');
    await h.click('Save');
    expect((calls[0]!.body as { amountCents: number }).amountCents).toBe(-1_234);
  });

  it('confirms before deleting a movement', async () => {
    await mount({ move: WD });
    await h.clickId('vrCashDeleteBtn');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Delete this cash movement (-$50.00)?');
    expect(calls).toHaveLength(0);
    await h.click('Delete for real');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/cash/23');
    expect(saved).toBe(1);
    expect(closed).toBe(1);
  });

  it('goes back from the confirm step to the form', async () => {
    await mount({ move: WD });
    await h.clickId('vrCashDeleteBtn');
    await h.click('Cancel');
    expect(h.value('vrCashAmountInput')).toBe('50.00');
    expect(closed).toBe(0);
  });

  it('opens on the confirm step with startOnDelete, and Cancel closes the dialog', async () => {
    await mount({ move: WD, startOnDelete: true });
    expect(h.findButton('Delete for real')).toBeDefined();
    await h.click('Cancel');
    expect(closed).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
