// The shared dialog's focus contract: opener capture, initial focus, a Tab
// cycle inside the panel (header close included), Escape with an opt-out, and
// restore to the opener when the panel goes away — including nested panels.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and onChange
// silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { Modal, MODAL_FOCUSABLE } = await import('./Modal');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface HostProps {
  closeOnEscape?: boolean;
  /** Drop the opener from the tree once the dialog is open, so closing the
   * dialog has to cope with a detached opener. */
  dropOpenerWhenOpen?: boolean;
}

// One button outside the dialog opens it; the outer body has a control that
// opens a second dialog nested inside the first.
function Host({ closeOnEscape, dropOpenerWhenOpen }: HostProps) {
  const [open, setOpen] = React.useState(false);
  const [innerOpen, setInnerOpen] = React.useState(false);
  return d(
    'div',
    null,
    !(dropOpenerWhenOpen && open) &&
      d('button', { key: 'opener', id: 'opener', onClick: () => setOpen(true) }, 'Open'),
    open &&
      d(
        Modal,
        { key: 'outer', title: 'Test dialog', onClose: () => setOpen(false), closeOnEscape },
        d('input', { 'data-testid': 'first' }),
        d('button', { key: 'openInner', onClick: () => setInnerOpen(true) }, 'Open inner'),
        d('button', { key: 'last', 'data-testid': 'last' }, 'Last'),
        innerOpen &&
          d(
            Modal,
            { key: 'inner', title: 'Inner dialog', onClose: () => setInnerOpen(false) },
            d('input', { 'data-testid': 'inner' }),
            d('button', { key: 'innerDone', 'data-testid': 'innerDone' }, 'Inner done'),
          ),
      ),
  );
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  if (!el) throw new Error(`[data-testid=${id}] not found`);
  return el;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function topPanel(): Element {
  const panels = Array.from(document.querySelectorAll('[data-modal-panel]'));
  const last = panels[panels.length - 1];
  if (!last) throw new Error('no dialog on screen');
  return last;
}

function focusablesOf(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE));
}

function headerClose(panel: Element): HTMLButtonElement {
  const btn = Array.from(panel.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Cancel');
  if (!btn) throw new Error('header close button not found');
  return btn as HTMLButtonElement;
}

// A bubbling keydown, like a real keystroke from the focused control.
function press(el: Element, key: string, shift = false): KeyboardEvent {
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey: shift });
  act(() => el.dispatchEvent(ev));
  return ev;
}

const focus = async (el: Element) => {
  await act(async () => (el as HTMLElement).focus());
};

const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
};

const dialogCount = () => document.querySelectorAll('[role=dialog]').length;

describe('Modal focus behaviour', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const show = async (props: HostProps = {}) => {
    await act(async () => root.render(d(Host, props)));
    // A real activation — mouse or keyboard — focuses the button, and happy-dom's
    // programmatic click() does not, so move focus first.
    await focus(byId('opener'));
    await click(byId('opener'));
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('focuses the first control when opened', async () => {
    await show();
    expect(document.activeElement).toBe(byTestId('first'));
  });

  it('restores focus to the opener when closed', async () => {
    await show();
    await focus(byTestId('last'));
    await click(headerClose(topPanel()));
    expect(dialogCount()).toBe(0);
    expect(document.activeElement).toBe(byId('opener'));
  });

  it('leaves focus alone when the opener is gone', async () => {
    await show({ dropOpenerWhenOpen: true });
    expect(document.getElementById('opener')).toBeNull();
    expect(document.activeElement).toBe(byTestId('first'));
    press(document.body, 'Escape');
    expect(dialogCount()).toBe(0);
    // No throw, and focus is not yanked onto a detached node.
    expect(document.activeElement).toBe(document.body);
  });

  it('sends Tab from the last control to the first', async () => {
    await show();
    const cycle = focusablesOf(topPanel());
    const first = cycle[0]!;
    const last = cycle[cycle.length - 1]!;
    expect(first).toBe(headerClose(topPanel()));
    expect(last).toBe(byTestId('last'));
    await focus(last);
    const ev = press(last, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('sends Shift-Tab from the first control to the last', async () => {
    await show();
    const cycle = focusablesOf(topPanel());
    const first = cycle[0]!;
    const last = cycle[cycle.length - 1]!;
    await focus(first);
    const ev = press(first, 'Tab', true);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('keeps focus inside when Tab is pressed outside the dialog', async () => {
    await show();
    const opener = byId('opener');
    await focus(opener);
    const ev = press(opener, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    // Pulled back to where an open dialog starts: the body's first control.
    expect(document.activeElement).toBe(byTestId('first'));
    expect(topPanel().contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape', async () => {
    await show();
    press(byTestId('first'), 'Escape');
    expect(dialogCount()).toBe(0);
  });

  it('does nothing on Escape when closeOnEscape is false', async () => {
    await show({ closeOnEscape: false });
    const before = document.activeElement;
    const ev = press(document.body, 'Escape');
    expect(ev.defaultPrevented).toBe(false);
    expect(dialogCount()).toBe(1);
    expect(document.activeElement).toBe(before);
  });

  it('returns focus to the outer dialog when the inner panel closes', async () => {
    await show();
    const openInner = Array.from(topPanel().querySelectorAll('button')).find((b) => b.textContent === 'Open inner')!;
    // A keyboard user would have tabbed to the control before opening the
    // inner dialog; focus() is what the trigger looks like at that point.
    await focus(openInner);
    await click(openInner);
    expect(dialogCount()).toBe(2);
    expect(document.activeElement).toBe(byTestId('inner'));

    press(document.body, 'Escape');
    expect(dialogCount()).toBe(1);
    expect(document.activeElement).toBe(openInner);
  });

  it('keeps the header close button in the tab order', async () => {
    await show();
    const close = headerClose(topPanel());
    // Shift-Tab backwards from the body's first control lands on the ✕.
    await focus(byTestId('first'));
    press(byTestId('first'), 'Tab', true);
    expect(document.activeElement).toBe(close);
  });
});
