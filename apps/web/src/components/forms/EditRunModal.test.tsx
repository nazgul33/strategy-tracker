// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls } from '../../testing/fetchStub';
import { goOffline } from '../../testing/offline';
import type { BucketDto } from '../../api';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { EditRunModal } = await import('./EditRunModal');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function held(index: number, buyPrice: string): BucketDto {
  return { index, state: 'held', shares: 10, buyPrice, buyFeeCents: 0, filledOn: '2026-11-02' };
}

// Held at 100.00 and 90.00 (myriadths), plus an empty bucket that must be ignored.
const BUCKETS: BucketDto[] = [
  held(0, '1000000'),
  held(1, '900000'),
  { index: 2, state: 'empty', shares: 0, buyPrice: null, buyFeeCents: 0, filledOn: null },
];

let calls: FetchCalls;
let saved = 0;

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function inputByTestId(id: string): HTMLInputElement {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el || !(el instanceof HTMLInputElement)) throw new Error(`input [${id}] not found`);
  return el;
}

function saveButton(): HTMLButtonElement {
  const btn = document.querySelector('[data-testid="runSaveBtn"]');
  if (!btn || !(btn instanceof HTMLButtonElement)) throw new Error('save button not found');
  return btn;
}

function warning(): HTMLElement | null {
  return document.querySelector('[data-testid="cutLossWarning"]');
}

function unknownClose(): HTMLElement | null {
  return document.querySelector('[data-testid="cutLossCloseUnknown"]');
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function save() {
  await act(async () => {
    saveButton().click();
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('EditRunModal cut-loss', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const render = async (props: { initialCutLossPpm?: number; latestClose?: string | null } = {}) => {
    await act(async () => {
      root.render(
        d(EditRunModal, {
          runId: 1,
          poolCents: 100_000,
          initialBuyPpm: 25_000,
          initialSellPpm: 10_000,
          initialCutLossPpm: props.initialCutLossPpm ?? 0,
          buckets: BUCKETS,
          latestClose: props.latestClose === undefined ? '920000' : props.latestClose,
          onClose: () => undefined,
          onSaved: () => {
            saved += 1;
          },
        }),
      );
    });
  };

  beforeEach(() => {
    saved = 0;
    calls = installFetchStub([{ method: 'POST', url: '', json: { ok: true } }]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('prefills the stored cut-loss and saves all three values', async () => {
    await render({ initialCutLossPpm: 35_000 });
    expect(inputByTestId('gapBuyInput').value).toBe('2.5');
    expect(inputByTestId('gapSellInput').value).toBe('1');
    expect(inputByTestId('cutLossInput').value).toBe('3.5');

    await save();
    const gaps = calls.find((c) => c.url.includes('/gaps'));
    expect(gaps!.body).toEqual({ buyGapPpm: 25_000, sellGapPpm: 10_000, cutLossPpm: 35_000 });
    expect(saved).toBe(1);
  });

  it('prefills blank for off and still sends the field as an explicit 0', async () => {
    await render({ initialCutLossPpm: 0 });
    expect(inputByTestId('cutLossInput').value).toBe('');

    await save();
    const gaps = calls.find((c) => c.url.includes('/gaps'));
    expect(gaps!.body).toEqual({ buyGapPpm: 25_000, sellGapPpm: 10_000, cutLossPpm: 0 });
  });

  it('saves an edited cut-loss as ppm', async () => {
    await render({ initialCutLossPpm: 35_000 });
    await type('cutLossInput', '5');
    await save();
    const gaps = calls.find((c) => c.url.includes('/gaps'));
    expect((gaps!.body as Record<string, unknown>).cutLossPpm).toBe(50_000);
  });

  it('marks 3.55 and 60 invalid and disables Save', async () => {
    await render();
    for (const bad of ['3.55', '60', 'abc']) {
      await type('cutLossInput', bad);
      expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBe('true');
      expect(saveButton().disabled).toBe(true);
      expect(warning()).toBeNull();
    }
    await type('cutLossInput', '3.5');
    expect(inputByTestId('cutLossInput').getAttribute('aria-invalid')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('warns how many held buckets are already below the proposed trigger, and still saves', async () => {
    // 3.0% => triggers 97.00 / 87.30 against a 92.00 close: only bucket 0 is underwater.
    await render();
    expect(warning()).toBeNull();
    await type('cutLossInput', '3');

    const w = warning();
    expect(w).not.toBeNull();
    expect(w!.textContent).toContain('1 held bucket');
    expect(w!.textContent).toContain('$92.00');
    expect(saveButton().disabled).toBe(false);

    await save();
    const gaps = calls.find((c) => c.url.includes('/gaps'));
    expect((gaps!.body as Record<string, unknown>).cutLossPpm).toBe(30_000);
    expect(saved).toBe(1);
  });

  it('counts both buckets when both triggers are at or above the close', async () => {
    await render({ latestClose: '850000' });
    await type('cutLossInput', '0.5'); // 99.50 / 89.50, both above an 85.00 close
    expect(warning()!.textContent).toContain('2 held bucket');
  });

  it('drops the warning when the new trigger sits below the close', async () => {
    await render({ latestClose: '850000' });
    await type('cutLossInput', '0.5');
    expect(warning()).not.toBeNull();
    await type('cutLossInput', '20'); // 80.00 / 72.00, both below 85.00
    expect(warning()).toBeNull();
  });

  it('shows no warning when cut-loss is blank', async () => {
    await render();
    await type('cutLossInput', '3');
    expect(warning()).not.toBeNull();
    await type('cutLossInput', '');
    expect(warning()).toBeNull();
  });

  it('says the check could not run when the latest close is unknown, and still saves', async () => {
    await render({ latestClose: null });
    expect(unknownClose()).toBeNull();
    await type('cutLossInput', '3');
    expect(warning()).toBeNull();
    expect(unknownClose()!.textContent).toContain('Latest close unknown');
    expect(saveButton().disabled).toBe(false);

    await save();
    const gaps = calls.find((c) => c.url.includes('/gaps'));
    expect((gaps!.body as Record<string, unknown>).cutLossPpm).toBe(30_000);
    expect(saved).toBe(1);
  });

  it('does not claim an unchecked stop when cut-loss is off or invalid', async () => {
    await render({ latestClose: null, initialCutLossPpm: 0 });
    expect(unknownClose()).toBeNull();
    await type('cutLossInput', '3.55');
    expect(unknownClose()).toBeNull();
    await type('cutLossInput', '3');
    expect(unknownClose()).not.toBeNull();
    await type('cutLossInput', '');
    expect(unknownClose()).toBeNull();
  });

  it('does not show the unknown-close line when the close is known', async () => {
    await render();
    await type('cutLossInput', '3');
    expect(unknownClose()).toBeNull();
  });

  it('focus starts on the pool top-up input and returns to the opener', async () => {
    // The modal as RunPanels renders it: a button opens it, and closing —
    // here via the ✕, exactly what a keyboard user reaches for once Escape
    // is off — hands focus back to that button.
    function Host() {
      const [open, setOpen] = React.useState(false);
      return d(
        'div',
        null,
        d('button', { id: 'editBtn', onClick: () => setOpen(true) }, 'Edit run'),
        open &&
          d(EditRunModal, {
            runId: 1,
            poolCents: 100_000,
            initialBuyPpm: 25_000,
            initialSellPpm: 10_000,
            initialCutLossPpm: 0,
            buckets: BUCKETS,
            latestClose: '920000',
            onClose: () => setOpen(false),
            onSaved: () => {
              saved += 1;
            },
          }),
      );
    }
    await act(async () => root.render(d(Host)));
    const opener = document.getElementById('editBtn')!;
    await act(async () => opener.focus());
    await act(async () => opener.click());
    expect(document.activeElement).toBe(inputByTestId('poolTopupInput')); // its autoFocus wins
    await act(async () => {
      (document.querySelector('[aria-label="Cancel"]') as HTMLButtonElement).click(); // the header ✕
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(saved).toBe(0);
    expect(document.activeElement).toBe(opener);
  });

  const alertText = () => document.querySelector('[role="alert"]')?.textContent;

  it('a refused save names the gap update and keeps the code', async () => {
    restoreFetch();
    calls = installFetchStub([{ method: 'POST', url: '', status: 422, json: { error: 'invalid-body' } }]);
    await render();
    await save();
    expect(alertText()).toBe('gap update failed (invalid-body)');
    expect(saved).toBe(0);
  });

  it('a save with the server unreachable is worded', async () => {
    await render();
    goOffline('POST');
    await save();
    expect(alertText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(saved).toBe(0);
  });
});
