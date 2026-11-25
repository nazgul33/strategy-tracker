// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lookup } from '../../i18n/catalog';
import { elementByTestId, inputByTestId, setInputValue } from '../../testing/dom';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { goOffline } from '../../testing/offline';
import { VR_RUN } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrSettingsModal } = await import('./VrSettingsModal');

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

const post = { method: 'POST' as const, url: '/api/vr/runs/5/settings', status: 204, json: undefined as unknown };

describe('VrSettingsModal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let closed = 0;
  let saved = 0;

  const buttonByText = (text: string) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`button [${text}] not found`);
    return btn;
  };
  const type = (id: string, value: string) => act(async () => setInputValue(inputByTestId(id), value));
  const chooseFormula = (value: string) =>
    act(async () => {
      const select = elementByTestId('vrFormulaSelect') as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const save = async () => {
    await act(async () => buttonByText('Save').click());
    await flush();
  };
  const alertText = () => document.querySelector('[role="alert"]')?.textContent;

  beforeEach(async () => {
    post.status = 204;
    post.json = undefined;
    closed = 0;
    saved = 0;
    calls = installFetchStub([post]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(d(VrSettingsModal, { run: VR_RUN, onClose: () => (closed += 1), onSaved: () => (saved += 1) })),
    );
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('prefills the five settings, shows the next-cycle note and focuses G', () => {
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Run settings');
    expect(inputByTestId('vrGInput').value).toBe('10');
    expect((elementByTestId('vrFormulaSelect') as HTMLSelectElement).value).toBe('skill');
    expect(inputByTestId('vrBandInput').value).toBe('15');
    expect(inputByTestId('vrSpendLimitInput').value).toBe('50');
    expect(inputByTestId('vrDepositInput').value).toBe('0.00');
    expect(elementByTestId('vrSettingsNote').textContent).toBe('Changes apply from the next cycle.');
    expect(document.activeElement).toBe(inputByTestId('vrGInput'));
  });

  it('sends the settings in ppm and cents', async () => {
    await type('vrBandInput', '12.5');
    await type('vrSpendLimitInput', '0');
    await type('vrDepositInput', '-250');
    await type('vrGInput', '20');
    await chooseFormula('basic');
    await save();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/vr/runs/5/settings',
      body: { g: 20, formula: 'basic', bandPpm: 125_000, spendLimitPpm: 0, cycleDepositCents: -25_000 },
    });
  });

  const CHECKS: [string, string, string, string][] = [
    ['G 0', 'vrGInput', '0', 'vr.invalidG'],
    ['G 1001', 'vrGInput', '1001', 'vr.invalidG'],
    ['G 2.5', 'vrGInput', '2.5', 'vr.invalidG'],
    ['band 0', 'vrBandInput', '0', 'vr.invalidBand'],
    ['band 100', 'vrBandInput', '100', 'vr.invalidBand'],
    ['band abc', 'vrBandInput', 'abc', 'vr.invalidBand'],
    ['spend limit 101', 'vrSpendLimitInput', '101', 'vr.invalidSpendLimit'],
    ['spend limit blank', 'vrSpendLimitInput', '', 'vr.invalidSpendLimit'],
    ['deposit blank', 'vrDepositInput', '', 'vr.invalidDeposit'],
    ['deposit abc', 'vrDepositInput', 'abc', 'vr.invalidDeposit'],
  ];
  for (const [name, id, value, key] of CHECKS) {
    it(`blocks the request for ${name}`, async () => {
      await type(id, value);
      await save();
      expect(calls).toHaveLength(0);
      expect(alertText()).toBe(lookup('en', key));
      expect(saved).toBe(0);
    });
  }

  it('words a server error and keeps the form open', async () => {
    post.status = 400;
    post.json = { error: 'invalid bandPpm' };
    await save();
    expect(alertText()).toBe('The request failed (invalid bandPpm).');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(saved).toBe(0);

    post.status = 500;
    post.json = {};
    await save();
    expect(alertText()).toBe(lookup('en', 'errServer', { code: 'http-500' }));
    expect(saved).toBe(0);
  });

  it('words a network failure and keeps the form open', async () => {
    goOffline('POST', '/settings');
    await save();
    expect(alertText()).toBe(lookup('en', 'errNetwork'));
    expect(inputByTestId('vrGInput')).toBeTruthy();
    expect(saved).toBe(0);
  });

  it('shows the saved view with Close after a successful save', async () => {
    await save();
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Settings saved. They apply from the next cycle.');
    expect(saved).toBe(1);
    expect(document.querySelector('[data-testid="vrGInput"]')).toBeNull();
    await act(async () => buttonByText('Close').click());
    expect(closed).toBe(1);
  });

  it('Escape does not close it', async () => {
    await type('vrGInput', '12');
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(inputByTestId('vrGInput').value).toBe('12');
    expect(closed).toBe(0);
  });

  it('Cancel closes it without a request', async () => {
    await act(async () => buttonByText('Cancel').click());
    expect(closed).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
