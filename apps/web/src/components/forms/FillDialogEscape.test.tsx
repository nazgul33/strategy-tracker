// FillDialog's Escape rules: the form and the delete-confirm step both ignore it,
// since their buttons carry the meaning (a stray Escape must not discard typed
// values or abandon a confirm).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see FillDialog.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillDialog } = await import('./FillDialog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function elementByTestId(id: string): Element {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`[${id}] not found`);
  return el;
}

function inputByTestId(id: string): HTMLInputElement {
  const el = elementByTestId(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`[${id}] is not an input`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

async function type(testid: string, value: string) {
  await act(async () => {
    setInputValue(inputByTestId(testid), value);
  });
}

async function clickButton(text: string) {
  await act(async () => {
    button(text).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

// Escape as the focused control would send it (bubbling up to the window).
async function pressEscape() {
  await act(async () => {
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
}

function fillDto() {
  return {
    id: 3,
    runId: 7,
    bucketIdx: 1,
    side: 'sell' as const,
    ticker: 'AAPL',
    shares: 10,
    price: '3402300',
    fee: 102,
    filledOn: '2026-11-06',
    source: 'manual',
    createdAt: '2026-11-06 10:00:00',
  };
}

describe('FillDialog Escape', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let closed = 0;

  async function render(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(d(FillDialog, { runId: 7, onClose: () => (closed += 1), onSaved: () => {}, ...props }));
    });
  }

  beforeEach(() => {
    closed = 0;
    installFetchStub([]);
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

  it('Escape in the fill form does not close it', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await type('manualSharesInput', '5');
    await pressEscape();
    expect(closed).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(inputByTestId('manualSharesInput').value).toBe('5');
  });

  it('Escape on the delete-confirm step does not close the dialog', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await clickButton('Delete');
    await pressEscape();
    expect(closed).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(button('Delete for real')).toBeTruthy();
  });
});
