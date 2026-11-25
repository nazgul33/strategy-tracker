// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { inputByTestId, setInputValue } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { goOffline } from '../../testing/offline';
import { SETTINGS_ROUTE } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrCreateForm } = await import('./VrCreateForm');
const { resetDefaultCostMemo } = await import('../../defaultcost');
const { lookup } = await import('../../i18n');

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

const VALID = { name: 'TQQQ lump sum', vrTickerInput: 'tqqq', vrCashInput: '10000' };
const DEFAULT_BODY = {
  name: 'TQQQ lump sum',
  ticker: 'TQQQ',
  cashCents: 1_000_000,
  initialStockCents: 500_000,
  g: 10,
  formula: 'skill',
  bandPpm: 150_000,
  spendLimitPpm: 500_000,
  cycleDepositCents: 0,
  costPpm: 700,
};

describe('VrCreateForm', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let stub: FetchCalls;
  let created: number[];
  const post = { method: 'POST' as const, url: '/api/vr/runs', status: 201, json: { id: 7 } as unknown };

  const type = (testid: string, value: string) => act(async () => setInputValue(inputByTestId(testid), value));
  const fillValid = async (over: Record<string, string> = {}) => {
    const values: Record<string, string> = { vrNameInput: VALID.name, vrTickerInput: VALID.vrTickerInput, vrCashInput: VALID.vrCashInput, ...over };
    for (const [id, value] of Object.entries(values)) await type(id, value);
  };
  const submit = async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create');
    if (!btn) throw new Error('Create button not found');
    await act(async () => btn.click());
    await flush();
  };
  const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;
  const body = () => stub[0]!.body as Record<string, unknown>;

  beforeEach(async () => {
    resetDefaultCostMemo();
    post.status = 201;
    post.json = { id: 7 };
    created = [];
    stub = installFetchStub([SETTINGS_ROUTE, post]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(VrCreateForm, { onCreated: (id: number) => created.push(id), onCancel: () => {} })));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('starts with the focus on the first field', () => {
    expect(document.activeElement).toBe(inputByTestId('vrNameInput'));
  });

  it('posts the defaults for the given cash', async () => {
    await fillValid();
    await submit();
    expect(stub).toHaveLength(1);
    expect(stub[0]!.url).toBe('/api/vr/runs');
    expect(body()).toEqual(DEFAULT_BODY);
  });

  it('uses the ticker as the name when the name is blank', async () => {
    await fillValid({ vrNameInput: '  ' });
    await submit();
    expect(body().name).toBe('TQQQ');
  });

  it('prefills the defaults and the server default cost', () => {
    const values = ['vrGInput', 'vrBandInput', 'vrSpendLimitInput', 'vrDepositInput', 'vrCostInput'].map((id) => inputByTestId(id).value);
    expect(values).toEqual(['10', '15', '50', '0', '0.070']);
    expect((document.querySelector('[data-testid="vrFormulaSelect"]') as HTMLSelectElement).value).toBe('skill');
  });

  it('keeps the initial stock at half the cash until it is edited', async () => {
    await type('vrCashInput', '8000');
    expect(inputByTestId('vrStockInput').value).toBe('4000.00');
    await type('vrStockInput', '3000');
    await type('vrCashInput', '9000');
    expect(inputByTestId('vrStockInput').value).toBe('3000');
    await fillValid({ vrCashInput: '9000' });
    await submit();
    expect(body().initialStockCents).toBe(300_000);
    expect(body().cashCents).toBe(900_000);
  });

  it.each([
    ['-250', -25_000],
    ['-1,000.50', -100_050],
    ['75', 7500],
  ])('sends the deposit %s as %d cents', async (text, cents) => {
    await fillValid({ vrDepositInput: text });
    await submit();
    expect(body().cycleDepositCents).toBe(cents);
  });

  it('sends the chosen formula, G, band and spend limit', async () => {
    await fillValid({ vrGInput: '25', vrBandInput: '12.5', vrSpendLimitInput: '0' });
    await act(async () => {
      const select = document.querySelector('[data-testid="vrFormulaSelect"]') as HTMLSelectElement;
      select.value = 'basic';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await submit();
    expect(body()).toMatchObject({ g: 25, formula: 'basic', bandPpm: 125_000, spendLimitPpm: 0 });
  });

  const CHECKS: [label: string, field: string, value: string, key: string][] = [
    ['ticker with a digit', 'vrTickerInput', 'TQ1', 'runInvalidTicker'],
    ['blank ticker', 'vrTickerInput', '', 'runInvalidTicker'],
    ['name over 128 characters', 'vrNameInput', 'x'.repeat(129), 'vr.invalidName'],
    ['zero cash', 'vrCashInput', '0', 'vr.invalidCash'],
    ['text cash', 'vrCashInput', 'abc', 'vr.invalidCash'],
    ['zero stock', 'vrStockInput', '0', 'vr.invalidInitialStock'],
    ['stock above cash', 'vrStockInput', '10000.01', 'vr.invalidInitialStock'],
    ['G 0', 'vrGInput', '0', 'vr.invalidG'],
    ['G 1001', 'vrGInput', '1001', 'vr.invalidG'],
    ['G 2.5', 'vrGInput', '2.5', 'vr.invalidG'],
    ['band 0', 'vrBandInput', '0', 'vr.invalidBand'],
    ['band 100', 'vrBandInput', '100', 'vr.invalidBand'],
    ['band text', 'vrBandInput', 'abc', 'vr.invalidBand'],
    ['spend limit 101', 'vrSpendLimitInput', '101', 'vr.invalidSpendLimit'],
    ['blank spend limit', 'vrSpendLimitInput', '', 'vr.invalidSpendLimit'],
    ['blank deposit', 'vrDepositInput', '', 'vr.invalidDeposit'],
    ['text deposit', 'vrDepositInput', 'abc', 'vr.invalidDeposit'],
    ['bad cost', 'vrCostInput', 'x', 'runInvalidCostPpm'],
  ];

  it.each(CHECKS)('blocks the request: %s', async (_label, field, value, key) => {
    await fillValid({ [field]: value });
    await submit();
    expect(stub).toHaveLength(0);
    expect(alertText()).toBe(lookup('en', key));
  });

  it('accepts a stock equal to the cash and a spend limit of 0', async () => {
    await fillValid({ vrStockInput: '10000', vrSpendLimitInput: '0' });
    await submit();
    expect(stub).toHaveLength(1);
    expect(body()).toMatchObject({ initialStockCents: 1_000_000, spendLimitPpm: 0 });
  });

  it('words vr-name-taken and keeps the form open', async () => {
    post.status = 409;
    post.json = { error: 'vr-name-taken' };
    await fillValid();
    await submit();
    expect(alertText()).toBe('Another run already uses this name. Choose a different name.');
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Create')).toBe(true);
    expect(created).toEqual([]);
    expect(inputByTestId('vrNameInput').value).toBe(VALID.name);
  });

  it('words a generic bad request without a catalog entry', async () => {
    post.status = 400;
    post.json = { error: 'invalid g' };
    await fillValid();
    await submit();
    expect(alertText()).toBe(lookup('en', 'errRequest', { code: 'invalid g' }));
  });

  it('words a network failure', async () => {
    goOffline('POST', '/api/vr/runs');
    await fillValid();
    await submit();
    expect(alertText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(created).toEqual([]);
  });

  it('shows a status note with a link to the new run', async () => {
    await fillValid();
    await submit();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('VR run #7 created');
    const link = document.querySelector('a[href="#/vr/7"]') as HTMLAnchorElement;
    expect(created).toEqual([]);
    await act(async () => link.click());
    expect(created).toEqual([7]);
  });
});
