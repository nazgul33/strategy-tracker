// Input helpers shared by the web test fixtures. They need a registered DOM (window/document) at call time, not at import time.

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
