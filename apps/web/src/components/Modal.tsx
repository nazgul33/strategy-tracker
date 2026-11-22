import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

// Elements a keyboard user can land on inside a dialog. Deliberately narrow
// (no tabindex, no audio/video): every dialog in the app is buttons, inputs,
// selects and links.
export const MODAL_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

// The control that had focus while each panel was mounted, so closing hands
// focus back to whatever opened it — an outer dialog's control when panels
// nest, the page button otherwise. `opener` is captured in render (see
// below), before children's autoFocus can move focus anywhere.
const modalOpeners = new WeakMap<Element, HTMLElement | null>();

/** Where focus starts in the panel, and where a Tab from behind the overlay
 * returns it: an explicit autoFocus child, else the body's first control. */
function modalInitialFocus(panel: HTMLElement): HTMLElement | null {
  const preferred = panel.querySelector<HTMLElement>('[autoFocus]');
  if (preferred) return preferred;
  const body = panel.querySelector<HTMLElement>('[data-modal-body]');
  if (body) {
    const inBody = body.querySelector<HTMLElement>(MODAL_FOCUSABLE);
    if (inBody) return inBody;
  }
  return panel.querySelector<HTMLElement>(MODAL_FOCUSABLE);
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
  children?: React.ReactNode;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  // Captured during this panel's first render, so the value is already right
  // when an autoFocus child steals focus during the same commit.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  // Initial focus, the opener bookkeeping, and the restore on unmount — all
  // in one effect, so the cleanup still has the panel element after React
  // detaches the ref. The opener may be an outer dialog's control, so
  // restoring happens only when this panel goes away. A detached opener (the
  // row that opened it re-rendered away) gets nothing — focusing a dead node
  // would drop focus to <body> for no reason.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    modalOpeners.set(panel, opener); // `opener` is state: fixed for the panel's lifetime.
    if (!panel.contains(document.activeElement)) modalInitialFocus(panel)?.focus();
    return () => {
      const back = modalOpeners.get(panel);
      modalOpeners.delete(panel);
      if (back && back.isConnected) back.focus();
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
