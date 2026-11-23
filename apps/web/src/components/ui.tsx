// Small presentational building blocks shared by the pages. All colours come
// from the semantic Tailwind tokens (see tailwind.config.ts + style.css), so
// the dark class on <html> repaints everything at once.
import { cloneElement, isValidElement, useId } from 'react';
import type { ReactNode } from 'react';

import { useT } from '../i18n';
import type { BadgeTone } from '../viewmodels';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-card p-4 ${className}`}>{children}</div>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>;
}

const BADGE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  primary: 'border border-primary/40 text-primary',
  success: 'bg-positive/15 text-positive',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${BADGE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: BadgeTone;
}) {
  const valueClass =
    tone === 'success'
      ? 'text-positive'
      : tone === 'danger'
        ? 'text-destructive'
        : tone === 'warning'
          ? 'text-warning'
          : tone === 'info'
            ? 'text-info'
            : 'text-foreground';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${valueClass}`}>{value}</div>
      {sub !== undefined && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="animate-pulse py-6 text-center text-sm text-muted-foreground">…</div>;
}

const ERROR_NOTE_CLASS = 'rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive';

export function ErrorNote({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const t = useT();
  if (!onDismiss) {
    return (
      <div className={ERROR_NOTE_CLASS} role="alert">
        {message}
      </div>
    );
  }
  return (
    <div className={`${ERROR_NOTE_CLASS} flex items-start gap-2`}>
      <div role="alert" className="flex-1">
        {message}
      </div>
      <button type="button" aria-label={t('dismiss')} onClick={onDismiss} className="shrink-0 leading-none">
        ✕
      </button>
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
};

export function Button({ variant = 'secondary', busy = false, disabled, children, className = '', ...rest }: ButtonProps) {
  const style =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:opacity-90'
      : variant === 'danger'
        ? 'bg-destructive text-destructive-foreground hover:opacity-90'
        : 'border border-border bg-transparent text-foreground hover:bg-muted';
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${style} ${className}`}
      {...rest}
    >
      {busy ? '…' : children}
    </button>
  );
}

const INPUT_CLASS =
  'rounded border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none';

export function Input({ invalid, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={`${INPUT_CLASS} ${invalid ? 'border-destructive' : 'border-input'} focus:border-primary ${props.className ?? ''}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${INPUT_CLASS} border-input focus:border-primary ${props.className ?? ''}`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const hintId = useId();
  let control = children;
  if (hint !== undefined && isValidElement<{ 'aria-describedby'?: string }>(children)) {
    const own = children.props['aria-describedby'];
    control = cloneElement(children, { 'aria-describedby': own ? `${own} ${hintId}` : hintId });
  }
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
        {control}
      </label>
      {hint !== undefined && (
        <span id={hintId} data-field-hint className="mt-1 block text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="py-4 text-center text-sm text-muted-foreground">{children}</div>;
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className = '',
  scope = 'col',
}: {
  children?: ReactNode;
  className?: string;
  scope?: 'col' | 'row';
}) {
  return (
    <th scope={scope} className={`whitespace-nowrap border-b border-border py-1.5 pr-3 font-medium text-muted-foreground ${className}`}>
      {children}
    </th>
  );
}

export function Td({
  children,
  className = '',
  colSpan,
  rowSpan,
}: {
  children?: ReactNode;
  className?: string;
  colSpan?: number;
  rowSpan?: number;
}) {
  return (
    <td colSpan={colSpan} rowSpan={rowSpan} className={`border-b border-border/60 py-1.5 pr-3 align-top ${className}`}>
      {children}
    </td>
  );
}

// The shared dialog lives in its own module now (focus trap, Escape, focus
// restore); re-exported here so pages keep importing it from the ui barrel.
export { Modal } from './Modal';
