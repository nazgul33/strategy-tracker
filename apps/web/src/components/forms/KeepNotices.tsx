import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { Button } from '../ui';

/**
 * A fill the operator asked to keep a screenshot for, whose review record
 * could not be saved. The action itself went through, so this is a warning
 * that must outlive the next action's error, not an error — and it names the
 * fill, because by the time it shows the row itself is gone from the table.
 */
export interface KeepNotice {
  id: number;
  // Names the outcome (`book`), not the button that led to it (Confirm).
  action: 'book' | 'reject';
  ticker: string;
  side: string;
  shares: string;
  price: string;
  date: string;
}

export interface KeepNotices {
  list: KeepNotice[];
  add(notice: Omit<KeepNotice, 'id'>): void;
  dismiss(id: number): void;
}

/** The oldest notice stays on top; each dismissal removes only its own row. */
export function useKeepNotices(): KeepNotices {
  const [list, setList] = useState<KeepNotice[]>([]);
  const nextId = useRef(1);
  const add = useCallback((notice: Omit<KeepNotice, 'id'>) => {
    setList((cur) => [...cur, { ...notice, id: nextId.current++ }]);
  }, []);
  const dismiss = useCallback((id: number) => setList((cur) => cur.filter((n) => n.id !== id)), []);
  return { list, add, dismiss };
}

/**
 * Warning notices over the pending table, each with a Dismiss button. They
 * live in ONE live region that is always mounted — a status element that
 * arrives together with its text is not reliably announced — and that is
 * empty, with no box of its own, until a notice arrives. The side label is
 * translated at render time, so switching language re-renders an
 * already-standing notice in the new language.
 */
export function KeepNoticeList({ notices }: { notices: KeepNotices }) {
  const t = useT();
  const regionRef = useRef<HTMLDivElement>(null);
  // Where the dismissed notice sat: once it is gone, focus goes to whichever
  // notice took its place, else to the region, instead of dropping to <body>.
  const refocusAt = useRef<number | null>(null);
  useEffect(() => {
    const index = refocusAt.current;
    if (index === null) return;
    refocusAt.current = null;
    const buttons = regionRef.current?.querySelectorAll<HTMLElement>('[data-keep-notice] button');
    const target = buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : regionRef.current;
    target?.focus();
  }, [notices.list]);
  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      data-keep-notices
      tabIndex={-1}
      className="space-y-2 outline-none empty:-mb-3"
    >
      {notices.list.map((n, i) => (
        <div
          key={n.id}
          data-keep-notice
          className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          <span className="flex-1">
            {t(n.action === 'book' ? 'keepRecordFailedBooked' : 'keepRecordFailedRejected', {
              ticker: n.ticker || '?',
              side: n.side === 'buy' ? t('orderSideBuy') : n.side === 'sell' ? t('orderSideSell') : n.side || '?',
              shares: n.shares || '?',
              price: n.price || '?',
              date: n.date || '?',
            })}
          </span>
          <Button
            onClick={() => {
              refocusAt.current = i;
              notices.dismiss(n.id);
            }}
          >
            {t('dismiss')}
          </Button>
        </div>
      ))}
    </div>
  );
}
