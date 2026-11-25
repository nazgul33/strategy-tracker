// react-dom/client must stay a dynamic import: it has to load *after* GlobalRegistrator.register().
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VrCashDto } from '../../api.vr.types';
import { elementByTestId } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { vrDialogHelpers } from '../../testing/vrDialog';
import { VR_CASH, VR_CYCLE } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrCashPanel } = await import('./VrCashPanel');

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
// The cycle's row id (8) differs from its number (2), so a panel that prints the id fails.
const DEPOSIT: VrCashDto = { id: 25, kind: 'deposit', amountCents: 25_000, movedOn: '2026-11-23', note: null, cycleId: 8, createdAt: '2026-11-23 10:00:00', beforeCycle: false };
const CASH = [DEPOSIT, WD, OPEN];

const post = { method: 'POST' as const, url: '/cash', status: 201, json: { id: 30 } as unknown };
const put = { method: 'PUT' as const, url: '/cash/', status: 204, json: undefined as unknown };
const del = { method: 'DELETE' as const, url: '/cash/', status: 204, json: undefined as unknown };

describe('VrCashPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let changed = 0;
  let cashGets = 0;
  const cash = { status: 200, json: CASH as unknown };
  const cycles = { status: 200, json: [{ ...VR_CYCLE, id: 8, seq: 2 }] as unknown };

  const props = () => ({ runId: 5, costPpm: 700, today: '2026-12-09', onChanged: () => (changed += 1) });
  const mount = async () => {
    await act(async () => root.render(d(VrCashPanel, props())));
    await h.flush();
  };
  const cells = (n: number) => [...container.querySelectorAll(`tbody tr td:nth-child(${n})`)].map((td) => td.textContent ?? '');

  beforeEach(async () => {
    cash.status = 200;
    cash.json = CASH;
    cycles.status = 200;
    changed = 0;
    cashGets = 0;
    calls = installFetchStub([
      post,
      put,
      del,
      {
        url: '/cycles',
        get status() {
          return cycles.status;
        },
        get json() {
          return cycles.json;
        },
      },
      {
        url: '/cash',
        get status() {
          return cash.status;
        },
        get json() {
          cashGets += 1;
          return cash.json;
        },
      },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('lists the movements with kind, signed amount, note and cycle number', () => {
    expect(elementByTestId('vrCashPanel')).not.toBeNull();
    expect(cells(2)).toEqual(['Deposit', 'Withdrawal', 'Opening cash']);
    expect(cells(3)).toEqual(['+$250.00', '-$50.00', '+$10,000.00']);
    expect(cells(4)).toEqual(['', 'fees', '']);
    expect(cells(5)).toEqual(['Cycle 2', '', '']);
  });

  it('marks movements dated before the current cycle', () => {
    const first = cells(1);
    expect(first[0]).toBe('2026-11-23');
    expect(first[1]).toBe('2026-12-01 earlier cycle');
    expect(first[2]).toBe('2026-11-05 earlier cycle');
  });

  it('gives the opening row an Edit but no Delete, and the others both', () => {
    const has = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null;
    expect(has('vrCashEdit-21')).toBe(true);
    expect(has('vrCashDelete-21')).toBe(false);
    for (const id of [25, 23]) {
      expect(has(`vrCashEdit-${id}`)).toBe(true);
      expect(has(`vrCashDelete-${id}`)).toBe(true);
    }
  });

  it('adds a movement, then reloads the list and reports the change', async () => {
    await h.clickId('vrAddCash');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Add cash movement');
    await h.type('vrCashAmountInput', '250');
    const before = cashGets;
    await h.click('Save', document.querySelector('[role="dialog"]')!);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(cashGets).toBe(before + 1);
    expect(changed).toBe(1);
    expect(h.dialogOpen()).toBe(false);
  });

  it('edits a movement', async () => {
    await h.clickId('vrCashEdit-23');
    expect(h.value('vrCashAmountInput')).toBe('50.00');
    const before = cashGets;
    await h.click('Save', document.querySelector('[role="dialog"]')!);
    expect(calls[0]!.url).toBe('/api/vr/runs/5/cash/23');
    expect(cashGets).toBe(before + 1);
    expect(changed).toBe(1);
  });

  it('deletes from the row straight on the confirm step', async () => {
    await h.clickId('vrCashDelete-23');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Delete this cash movement (-$50.00)?');
    cash.json = [DEPOSIT, OPEN];
    const before = cashGets;
    await h.click('Delete for real');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('/api/vr/runs/5/cash/23');
    expect(cashGets).toBe(before + 1);
    expect(changed).toBe(1);
    expect(cells(2)).toEqual(['Deposit', 'Opening cash']);
  });

  it('shows an empty note and keeps the Add button', async () => {
    cash.json = [];
    await act(async () => root.render(null));
    await mount();
    expect(container.textContent).toContain('No cash movements.');
    expect(document.querySelector('[data-testid="vrAddCash"]')).not.toBeNull();
    expect(document.querySelector('table')).toBeNull();
  });

  it('shows the error with Retry when the cash list fails, and recovers', async () => {
    cash.status = 500;
    cash.json = { error: 'boom' };
    await act(async () => root.render(null));
    await mount();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    cash.status = 200;
    cash.json = CASH;
    await h.click('Retry');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(cells(2)).toHaveLength(3);
  });

  it('shows the error when the cycles cannot be read', async () => {
    cycles.status = 500;
    cycles.json = { error: 'boom' };
    await act(async () => root.render(null));
    await mount();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});
