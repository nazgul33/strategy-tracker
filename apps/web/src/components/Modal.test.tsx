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
        {
          key: 'outer',
          title: 'Test dialog',
          onClose: () => setOpen(false),
          closeOnEscape,
          children: d(
            React.Fragment,
            null,
            d('input', { 'data-testid': 'first' }),
            d('button', { key: 'openInner', onClick: () => setInnerOpen(true) }, 'Open inner'),
            d('button', { key: 'last', 'data-testid': 'last' }, 'Last'),
            innerOpen &&
              d(Modal, {
                key: 'inner',
                title: 'Inner dialog',
                onClose: () => setInnerOpen(false),
                children: d(
                  React.Fragment,
                  null,
                  d('input', { 'data-testid': 'inner' }),
                  d('button', { key: 'innerDone', 'data-testid': 'innerDone' }, 'Inner done'),
                ),
              }),
          ),
        },
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
    // The page behind is inert, so nothing there can take focus; what is left is focus
    // falling to <body> (the focused control went away, or a click on the page chrome).
    await act(async () => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    const ev = press(document.body, 'Tab');
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

  it('closes only the last dialog in document order on Escape when two are mounted', async () => {
    const closed: string[] = [];
    await act(async () =>
      root.render(
        d(
          'div',
          null,
          d(Modal, { title: 'First', onClose: () => closed.push('first'), children: d('button', null, 'a') }),
          d(Modal, { title: 'Second', onClose: () => closed.push('second'), children: d('button', null, 'b') }),
        ),
      ),
    );
    expect(dialogCount()).toBe(2);
    const [firstDialog, secondDialog] = Array.from(document.querySelectorAll('[role=dialog]'));
    expect(firstDialog!.closest('[inert]')).not.toBeNull();
    expect(secondDialog!.closest('[inert]')).toBeNull();

    press(document.body, 'Escape');

    expect(closed).toEqual(['second']);
  });

  // A result popup can arrive (after a request) while another dialog is open, and
  // sit earlier in the document: the one that opened last is the one in use.
  it('a dialog that opens later but earlier in the document owns Escape and stays reachable', async () => {
    const closed: string[] = [];
    const tree = (withFirst: boolean) =>
      d(
        'div',
        null,
        withFirst && d(Modal, { key: 'first', title: 'First', onClose: () => closed.push('first'), children: d('button', null, 'a') }),
        d(Modal, { key: 'second', title: 'Second', onClose: () => closed.push('second'), children: d('button', null, 'b') }),
      );
    await act(async () => root.render(tree(false)));
    await act(async () => root.render(tree(true)));
    const [firstDialog, secondDialog] = Array.from(document.querySelectorAll('[role=dialog]'));
    expect(firstDialog!.getAttribute('aria-label')).toBe('First');
    expect(firstDialog!.closest('[inert]')).toBeNull();
    expect(secondDialog!.closest('[inert]')).not.toBeNull();

    press(document.body, 'Escape');

    expect(closed).toEqual(['first']);
  });

  // StrictMode (main.tsx) simulates an unmount and re-mount on mount; the
  // simulated cleanup must not restore focus to the opener over the autoFocus child.
  it('keeps focus on the autoFocus child under StrictMode, and restores the opener on close', async () => {
    function StrictHost() {
      const [open, setOpen] = React.useState(false);
      return d(
        'div',
        null,
        d('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open'),
        open &&
          d(Modal, {
            title: 'Strict dialog',
            onClose: () => setOpen(false),
            children: d(
              React.Fragment,
              null,
              d('button', { 'data-testid': 'danger' }, 'Danger'),
              d('button', { 'data-testid': 'safe', autoFocus: true, 'data-autofocus': true }, 'Safe'),
            ),
          }),
      );
    }
    await act(async () => root.render(d(React.StrictMode, null, d(StrictHost))));
    await focus(byId('opener'));
    await click(byId('opener'));
    expect(document.activeElement).toBe(byTestId('safe'));
    expect(byId('opener').closest('[inert]')).not.toBeNull();

    await click(headerClose(topPanel()));
    expect(dialogCount()).toBe(0);
    expect(document.activeElement).toBe(byId('opener'));
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('prefers a data-autofocus child over the first control, on open and on a Tab from outside', async () => {
    await act(async () =>
      root.render(
        d(Modal, {
          title: 'Marked',
          onClose: () => {},
          children: d(
            React.Fragment,
            null,
            d('input', { 'data-testid': 'first' }),
            d('button', { 'data-testid': 'marked', 'data-autofocus': true }, 'Marked'),
          ),
        }),
      ),
    );
    expect(document.activeElement).toBe(byTestId('marked'));
    document.body.focus();
    const ev = press(document.body, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byTestId('marked'));
  });

  const inertOutside = (el: Element) => el.closest('[inert]') !== null;

  it('makes the page behind inert while open, and nothing stays inert after it closes', async () => {
    const outside = document.createElement('p');
    document.body.appendChild(outside);
    try {
      await show();
      expect(inertOutside(byId('opener'))).toBe(true);
      expect(inertOutside(outside)).toBe(true);
      expect(inertOutside(topPanel())).toBe(false);
      expect(document.body.hasAttribute('inert')).toBe(false);
      await click(headerClose(topPanel()));
      expect(document.querySelector('[inert]')).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it('an inner dialog makes the rest of the outer one inert, and gives it back on close', async () => {
    await show();
    const openInner = Array.from(topPanel().querySelectorAll('button')).find((b) => b.textContent === 'Open inner')!;
    await focus(openInner);
    await click(openInner);
    expect(inertOutside(byTestId('first'))).toBe(true);
    expect(inertOutside(openInner)).toBe(true);
    expect(inertOutside(byTestId('inner'))).toBe(false);
    expect(inertOutside(byId('opener'))).toBe(true);

    press(document.body, 'Escape');
    expect(dialogCount()).toBe(1);
    expect(inertOutside(byTestId('first'))).toBe(false);
    expect(inertOutside(byId('opener'))).toBe(true);

    press(document.body, 'Escape');
    expect(dialogCount()).toBe(0);
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('a non-dismissible dialog ignores Escape, the backdrop and ✕', async () => {
    let calls = 0;
    const onClose = () => {
      calls += 1;
    };
    const render = (dismissible: boolean) =>
      act(async () =>
        root.render(d(Modal, { title: 'Busy', onClose, dismissible, children: d('button', null, 'a') })),
      );
    await render(false);
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    await click(document.querySelector('[role=dialog]')!);
    const close = headerClose(topPanel());
    await click(close);
    expect(calls).toBe(0);
    expect(close.hasAttribute('disabled')).toBe(true);
    expect(close.classList.contains('disabled:opacity-50')).toBe(true);

    await render(true);
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(calls).toBe(1);
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
