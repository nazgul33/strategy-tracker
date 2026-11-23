/**
 * happy-dom may not implement Element.scrollIntoView. `installScrollShim()` gives the
 * prototype a no-op (only when missing) so a test can spy on it or render a component
 * that scrolls; `restoreScrollShim()` removes it again. Call both while a DOM is registered.
 */
const proto = () => window.Element.prototype as { scrollIntoView?: unknown };
let defined = false;

export function installScrollShim(): void {
  if (typeof proto().scrollIntoView !== 'function') {
    proto().scrollIntoView = () => {};
    defined = true;
  }
}

export function restoreScrollShim(): void {
  if (defined) {
    delete proto().scrollIntoView;
    defined = false;
  }
}
