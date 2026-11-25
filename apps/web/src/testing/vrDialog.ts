// Interaction helpers for the VR fill and cash dialog and panel tests. `act` comes from the test's dynamic react import,
// because react-dom has to load after GlobalRegistrator.register().
import type { act as ReactAct } from 'react';
import { elementByTestId, inputByTestId, setInputValue } from './dom';

export function vrDialogHelpers(act: typeof ReactAct) {
  async function flush() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const type = (id: string, value: string) => act(async () => setInputValue(inputByTestId(id), value));

  const choose = (id: string, value: string) =>
    act(async () => {
      const select = elementByTestId(id) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

  const findButton = (text: string, scope: ParentNode = document): HTMLButtonElement | undefined =>
    [...scope.querySelectorAll('button')].find((b) => b.textContent === text);

  const button = (text: string, scope: ParentNode = document): HTMLButtonElement => {
    const btn = findButton(text, scope);
    if (!btn) throw new Error(`button [${text}] not found`);
    return btn;
  };

  /** Clicks a button by its text and lets the async handlers settle. */
  async function click(text: string, scope: ParentNode = document) {
    await act(async () => button(text, scope).click());
    await flush();
  }

  async function clickId(id: string) {
    await act(async () => (elementByTestId(id) as HTMLElement).click());
    await flush();
  }

  /** The dialog's own submit button (a panel behind it can carry a button with the same text). */
  async function submit() {
    await act(async () => (document.querySelector('[role="dialog"] button[type="submit"]') as HTMLButtonElement).click());
    await flush();
  }

  /** Fires the form's submit event directly, skipping the browser's constraint validation. */
  async function submitForm() {
    const form = document.querySelector('[role="dialog"] form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  /** Escape as the focused control would send it (bubbling up to the window). */
  async function pressEscape() {
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
  }

  const errorText = (): string | null => document.querySelector('[data-testid="error"]')?.textContent ?? null;
  const dialogOpen = (): boolean => document.querySelector('[role="dialog"]') !== null;
  const value = (id: string): string => inputByTestId(id).value;

  return { flush, type, choose, findButton, button, click, clickId, submit, submitForm, pressEscape, errorText, dialogOpen, value };
}
