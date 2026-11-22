import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

// Elements a keyboard user can land on inside a dialog: links, enabled form
// controls (not hidden inputs) and anything with a tabindex other than -1.
// No audio/video: no dialog in the app has any.
export const MODAL_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The control that had focus while each panel was mounted, so closing hands
// focus back to whatever opened it — an outer dialog's control when panels
// nest, the page button otherwise. `opener` is captured in render (see
// below), before children's autoFocus can move focus anywhere. Entries are
// never deleted: a later dialog's opener-chain walk may still pass through a
// closed panel (a step swap), and the WeakMap frees them with their nodes.
const modalOpeners = new WeakMap<Element, HTMLElement | null>();

/** Where focus starts in the panel, and where a Tab from behind the overlay
 * returns it: a `data-autofocus` child, else the body's first control. React
 * does not write `autoFocus` to the DOM, so a child that sets `autoFocus` also
 * sets `data-autofocus` to be findable here. */
function modalInitialFocus(panel: HTMLElement): HTMLElement | null {
  const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
  if (preferred) return preferred;
  const body = panel.querySelector<HTMLElement>('[data-modal-body]');
  if (body) {
    const inBody = body.querySelector<HTMLElement>(MODAL_FOCUSABLE);
    if (inBody) return inBody;
  }
  return panel.querySelector<HTMLElement>(MODAL_FOCUSABLE);
}

// The control that had focus, plus the control to return to: when focus sat
// inside another panel (a popup opened from a popup's button), the host panel
// usually closes together with this one, taking its buttons down — so the
// host panel's own recorded opener replaces it. Resolution runs during
// render, while the host panel is still mounted and its opener recorded.
// `raw` is kept to honor "restore what I took" while it is still on screen.
function captureOpener(active: HTMLElement | null): { raw: HTMLElement | null; back: HTMLElement | null } {
  if (!active) return { raw: null, back: null };
  let back = active;
  const seen = new Set<Element>(); // panels already walked: no chasing a cycle
  for (
    let host = active.closest('[data-modal-panel]');
    host !== null && !seen.has(host);
    host = back?.closest('[data-modal-panel]') ?? null
  ) {
    seen.add(host);
    const chained = modalOpeners.get(host);
    if (!chained) break;
    back = chained;
  }
  return { raw: active, back };
}

/** Simple fixed-overlay modal used by the dialogs (pool edit, new run); `wide` makes room for side-by-side content.
 * Traps focus inside the panel, closes on Escape unless `closeOnEscape` is off, and returns focus to its opener. */
export function Modal({
  title,
  onClose,
  wide = false,
  closeOnEscape = true,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  /** Opt out of the Escape key for panels whose buttons carry the meaning. */
  closeOnEscape?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  // Captured during this panel's first render, so the value is already right
  // when an autoFocus child steals focus during the same commit — and so a
  // host panel that opens together with this one is still in the DOM while
  // its recorded opener is looked up.
  const [opener] = useState(() =>
    captureOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );

  // Initial focus, the opener bookkeeping, and the restore on unmount — all
  // in one effect, so the cleanup still has the panel element after React
  // detaches the ref. The opener may be an outer dialog's control, so
  // restoring happens only when this panel goes away. A detached opener (the
  // row that opened it re-rendered away) gets nothing — focusing a dead node
  // would drop focus to <body> for no reason.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    modalOpeners.set(panel, opener.raw); // `opener` is state: fixed for the panel's lifetime.
    if (!panel.contains(document.activeElement)) modalInitialFocus(panel)?.focus();
    return () => {
      // Two cases where restoring would steal focus from a dialog that is
      // taking over: StrictMode's simulated unmount (the panel is still
      // attached), and a successor dialog that already holds focus (a step
      // swap mounts the new panel before this cleanup runs).
      if (panel.isConnected) return;
      const owner = document.activeElement?.closest('[data-modal-panel]');
      if (owner && owner !== panel && owner.isConnected) return;
      const raw = modalOpeners.get(panel);
      // What we took if it is still on screen; otherwise the chained opener —
      // the host panel this one was opened from usually went down with it.
      // A dead chain end gets nothing: focusing a detached node would drop
      // focus to <body> for no reason.
      const target = raw && raw.isConnected ? raw : opener.back;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  // Escape and the Tab cycle, both from a window listener so they work
  // wherever focus sits. Only while open, so panels that nest get first
  // claim: a handler ignores the keystroke when its own panel is no longer
  // the top-most dialog, which is the one a real user is looking at.
  const onKeyDown = useCallback(
    (ev: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const dialogs = document.querySelectorAll('[role=dialog]');
      if (dialogs[dialogs.length - 1] !== panel.closest('[role=dialog]')) return; // a nested panel owns the keystroke
      if (ev.key === 'Escape') {
        if (!closeOnEscape) return; // opt-out: the buttons carry the meaning
        ev.preventDefault();
        onClose();
        return;
      }
      if (ev.key !== 'Tab') return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        // Focus escaped behind the overlay — pull it back to where it started.
        ev.preventDefault();
        (modalInitialFocus(panel) ?? first).focus();
        return;
      }
      if (active === panel) return; // tabbing off the container itself: natural order
      const index = focusables.indexOf(active);
      if (index === -1) return; // a control the selector does not cover
      ev.preventDefault();
      if (ev.shiftKey) (index === 0 ? last : focusables[index - 1]!).focus();
      else (index === focusables.length - 1 ? first : focusables[index + 1]!).focus();
    },
    [closeOnEscape, onClose],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 p-4 pt-16 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={panelRef}
        data-modal-panel
        tabIndex={-1}
        className={`w-full ${wide ? 'max-w-4xl' : 'max-w-md'} rounded-lg border border-border bg-card p-4 shadow-lg`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button type="button" aria-label={t('cancel')} className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            ✕
          </button>
        </div>
        <div data-modal-body>{children}</div>
      </div>
    </div>
  );
}
