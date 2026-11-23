import type { act as ReactAct } from 'react';
import { installFetchStub } from './fetchStub';
import type { FetchCalls } from './fetchStub';

export interface FillDialogCall {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

type Failure = { status: number; error: string } | null;

export function setInputValue(el: HTMLInputElement, value: string) {
  // Bypass React's value tracker so onChange fires (same as user typing).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function elementByTestId(id: string): Element {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`[${id}] not found`);
  return el;
}

export function inputByTestId(id: string): HTMLInputElement {
  const el = elementByTestId(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`[${id}] is not an input`);
  return el;
}

export function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
}

export function button(text: string): HTMLButtonElement {
  const btn = findButton(text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

// FillDto fixture (api.types.ts wire shape: price = myriadths string, fee = cents).
export function fillDto() {
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

export function errorText(): string | null {
  const el = document.querySelector('[data-testid="error"]');
  return el ? (el.textContent ?? '') : null;
}

// The state a test file keeps as plain `let` variables is read through getters,
// so the routes see the current value on every request.
export interface FillDialogFlags {
  putFailure?: () => Failure;
  postFailure?: () => Failure;
  deleteFailure?: () => Failure;
  deltaCents?: () => number;
}

export function installFillDialogStub({
  putFailure = () => null,
  postFailure = () => null,
  deleteFailure = () => null,
  deltaCents = () => 0,
}: FillDialogFlags = {}): FetchCalls {
  // Route getters re-read the flags on every request — same semantics as
  // the old closure-based stub.
  return installFetchStub([
    {
      method: 'DELETE',
      url: '/api/runs/',
      get status() {
        return deleteFailure() ? deleteFailure()!.status : 200;
      },
      get json() {
        return deleteFailure() ? { error: deleteFailure()!.error } : { ok: true, deletedFillId: 3, deltaCents: deltaCents() };
      },
    },
    {
      method: 'PUT',
      url: '/api/runs/',
      get status() {
        return putFailure() ? putFailure()!.status : 200;
      },
      get json() {
        return putFailure() ? { error: putFailure()!.error } : { ok: true, fill: { id: 3 }, deltaCents: deltaCents() };
      },
    },
    {
      method: 'POST',
      url: '',
      get status() {
        return postFailure() ? postFailure()!.status : 200;
      },
      get json() {
        return postFailure() ? { error: postFailure()!.error } : { ok: true, fill: { id: 3 }, deltaCents: deltaCents() };
      },
    },
  ]);
}

export interface FillDialogHelperDeps {
  act: typeof ReactAct;
  stub: () => FetchCalls;
  onCalls?: (calls: FillDialogCall[]) => void;
}

export function fillDialogHelpers({ act, stub, onCalls }: FillDialogHelperDeps) {
  // Mirror the helper's recorded non-GET calls into the local shape.
  const recordCalls = () =>
    onCalls?.(stub().map((c) => ({ method: c.method, url: c.url, body: c.body as Record<string, unknown> })));

  async function type(testid: string, value: string) {
    await act(async () => {
      setInputValue(inputByTestId(testid), value);
    });
  }

  // Click + flush the async handler (the fetch stub resolves immediately).
  async function clickButton(text: string) {
    await act(async () => {
      button(text).click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    recordCalls();
  }

  // Fire the form's submit event directly (no constraint validation), like a
  // browser without a native date control would. Needed to exercise the dialog's
  // own guards with values the DOM would otherwise reject on click.
  async function submitForm() {
    const form = button('Save').closest('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    recordCalls();
  }

  return { type, clickButton, submitForm };
}
