// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls, Route } from '../../testing/fetchStub';
import type { SimRunDto } from '../../api';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SimConfigPanel } = await import('./SimConfigPanel');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const DRAFT: SimRunDto = {
  id: 3,
  ticker: 'QQQ',
  fromDate: '2026-01-02',
  toDate: '2026-06-30',
  poolCents: 10_000_000,
  costPpm: 700,
  buyGapPpm: 5000,
  sellGapPpm: 20_000,
  cutLossPpm: 35_000,
  paramsJson: '{"bucketCount":8,"maxAgeDays":30}',
  draft: true,
  createdAt: '2026-06-30 09:00:00',
};
const PARAMS = { bucketCount: 8, maxAgeDays: 30 };

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function input(id: string): HTMLInputElement {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el || !(el instanceof HTMLInputElement)) throw new Error(`input [${id}] not found`);
  return el;
}

function button(id: string): HTMLButtonElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function type(id: string, value: string) {
  await act(async () => {
    setInputValue(input(id), value);
  });
}

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(id: string) {
  const btn = button(id);
  if (!btn) throw new Error(`button [${id}] not found`);
  await act(async () => {
    btn.click();
  });
  await flush();
}

const FIELD_IDS = [
  'simFromInput',
  'simToInput',
  'simPoolInput',
  'costInput',
  'buyGapInput',
  'sellGapInput',
  'cutLossInput',
  'bucketCountInput',
  'maxAgeInput',
];

describe('SimConfigPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;
  let applied = 0;
  let routes: Route[];

  const render = async (run: SimRunDto = DRAFT) => {
    await act(async () => {
      root.render(d(SimConfigPanel, { run, params: PARAMS, onApplied: () => (applied += 1) }));
    });
  };

  beforeEach(() => {
    applied = 0;
    window.location.hash = '#/sim/3';
    routes = [
      { method: 'PUT', url: '/api/sim/3', json: { id: 3, dayCount: 5 } },
      { method: 'POST', url: '/api/sim/3/save', status: 204, json: undefined },
      { method: 'DELETE', url: '/api/sim/3', status: 204, json: undefined },
    ];
    calls = installFetchStub(routes);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('prefills every field from the run DTO and paramsJson', async () => {
    await render();
    expect(input('simFromInput').value).toBe('2026-01-02');
    expect(input('simToInput').value).toBe('2026-06-30');
    expect(input('simPoolInput').value).toBe('100000');
    expect(input('costInput').value).toBe('0.070');
    expect(input('buyGapInput').value).toBe('0.5');
    expect(input('sellGapInput').value).toBe('2');
    expect(input('cutLossInput').value).toBe('3.5');
    expect(input('bucketCountInput').value).toBe('8');
    expect(input('maxAgeInput').value).toBe('30');
    expect(document.querySelector('[data-testid="simStatusBadge"]')!.textContent).toBe('Draft');
    expect(button('simApplyBtn')).not.toBeNull();
    expect(button('simSaveBtn')).not.toBeNull();
    expect(button('simDiscardBtn')).not.toBeNull();
  });

  it('shows blank for unset gaps and cut-loss', async () => {
    await render({ ...DRAFT, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0 });
    expect(input('buyGapInput').value).toBe('');
    expect(input('sellGapInput').value).toBe('');
    expect(input('cutLossInput').value).toBe('');
  });

  it('the ticker is displayed but has no input', async () => {
    await render();
    expect(document.querySelector('[data-testid="simConfigTicker"]')!.textContent).toBe('QQQ');
    const values = Array.from(document.querySelectorAll('input')).map((i) => i.value);
    expect(values).not.toContain('QQQ');
    expect(document.querySelectorAll('input').length).toBe(FIELD_IDS.length);
  });

  it('Apply calls updateSimRun with the edited config and refetches', async () => {
    await render();
    await type('cutLossInput', '5');
    await type('buyGapInput', '');
    await type('bucketCountInput', '6');
    await click('simApplyBtn');

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/sim/3');
    expect(calls[0]!.body).toMatchObject({
      from: '2026-01-02',
      to: '2026-06-30',
      poolCents: 10_000_000,
      costPpm: 700,
      buyGapPpm: 0,
      sellGapPpm: 20_000,
      cutLossPpm: 50_000,
      params: { bucketCount: 6, maxAgeDays: 30 },
    });
    expect('ticker' in (calls[0]!.body as object)).toBe(false);
    expect(applied).toBe(1);
    // Still an editable draft afterwards: Apply can run again.
    expect(button('simApplyBtn')!.disabled).toBe(false);
  });

  it('Apply surfaces a validation error without calling the API', async () => {
    await render();
    await type('simFromInput', '2026-07-01');
    await click('simApplyBtn');

    expect(calls.length).toBe(0);
    expect(applied).toBe(0);
    expect(document.body.textContent).toContain('Start must be before end.');

    await type('simFromInput', '2026-01-02');
    await type('simPoolInput', '0');
    await click('simApplyBtn');
    expect(calls.length).toBe(0);
    expect(document.body.textContent).toContain('Enter a pool amount greater than zero.');
  });

  it('marks a malformed percent and disables Apply until it is fixed', async () => {
    await render();
    for (const bad of ['3.55', '60', 'abc']) {
      await type('cutLossInput', bad);
      expect(input('cutLossInput').getAttribute('aria-invalid')).toBe('true');
      expect(button('simApplyBtn')!.disabled).toBe(true);
    }
    await type('cutLossInput', '3.5');
    expect(input('cutLossInput').getAttribute('aria-invalid')).toBeNull();
    expect(button('simApplyBtn')!.disabled).toBe(false);
    await type('costInput', '0.0701');
    expect(input('costInput').getAttribute('aria-invalid')).toBe('true');
    expect(button('simApplyBtn')!.disabled).toBe(true);
  });

  it('shows a sim-finalized refusal from Apply and refetches so the page catches up', async () => {
    routes[0]!.status = 409;
    routes[0]!.json = { error: 'sim-finalized' };
    await render();
    await click('simApplyBtn');
    expect(document.body.textContent).toContain('already saved');
    expect(applied).toBe(1);
  });

  it('shows other Apply failures with their code and does not refetch', async () => {
    routes[0]!.status = 502;
    routes[0]!.json = { error: 'market-data:upstream' };
    await render();
    await click('simApplyBtn');
    expect(document.body.textContent).toContain('market-data:upstream');
    expect(applied).toBe(0);
  });

  it('offers Save only for the config that was applied', async () => {
    await render();
    expect(button('simSaveBtn')!.disabled).toBe(false);
    await type('cutLossInput', '5');
    expect(button('simSaveBtn')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Unapplied changes');
    await click('simApplyBtn');
    expect(button('simSaveBtn')!.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Unapplied changes');
    // Editing back to something else makes it dirty again.
    await type('cutLossInput', '6');
    expect(button('simSaveBtn')!.disabled).toBe(true);
  });

  it('Save calls saveSimRun, then the panel is read-only with no Apply/Save/Discard', async () => {
    await render();
    await click('simSaveBtn');

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/sim/3/save');
    expect(applied).toBe(1);
    expect(button('simApplyBtn')).toBeNull();
    expect(button('simSaveBtn')).toBeNull();
    expect(button('simDiscardBtn')).toBeNull();
    for (const id of FIELD_IDS) expect(input(id).disabled).toBe(true);
    expect(document.querySelector('[data-testid="simStatusBadge"]')!.textContent).toBe('Saved');
  });

  it('a failed Save keeps the draft editable and shows the error', async () => {
    routes[1]!.status = 409;
    routes[1]!.json = { error: 'sim-finalized' };
    await render();
    await click('simSaveBtn');
    expect(document.body.textContent).toContain('already saved');
    expect(applied).toBe(1);
  });

  it('Discard confirms, calls deleteSimRun, and navigates to #/sim', async () => {
    await render();
    await click('simDiscardBtn');
    expect(calls.length).toBe(0);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await click('simDiscardConfirmBtn');
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('/api/sim/3');
    expect(window.location.hash).toBe('#/sim');
  });

  it('cancelling the Discard dialog deletes nothing', async () => {
    await render();
    await click('simDiscardBtn');
    await click('simDiscardCancelBtn');
    expect(calls.length).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.hash).toBe('#/sim/3');
  });

  it('a finalized run renders read-only from the start', async () => {
    await render({ ...DRAFT, draft: false });
    expect(button('simApplyBtn')).toBeNull();
    expect(button('simSaveBtn')).toBeNull();
    expect(button('simDiscardBtn')).toBeNull();
    for (const id of FIELD_IDS) expect(input(id).disabled).toBe(true);
    expect(input('cutLossInput').value).toBe('3.5');
    expect(document.querySelector('[data-testid="simStatusBadge"]')!.textContent).toBe('Saved');
    expect(calls.length).toBe(0);
  });
});
