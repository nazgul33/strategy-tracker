import { parseUsd } from '@st/core/money';

/**
 * Formatting helpers for values coming off the API.
 *
 * Wire units (see apps/server/src/http/app.ts `jsonBig`):
 *  - `poolCents`, `cashCents`, `amountCents`, `fee` → integer **cents** (number)
 *  - `price`, `buyPrice`, `sellPrice`, `limitPrice` → bigint myriadths (1e-4 USD)
 *    serialized as **strings**, because they exceed JSON's safe integer range.
 * Nothing here ever goes through a float: cents are integers, prices stay strings
 * until a `bigint` is needed, and the one division (win rate) is display-only.
 */

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Integer cents → `$1,234.50` (locale-independent: US dollars, US grouping). */
export function centsUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return usdFormatter.format(cents / 100);
}

/** Integer cents → `+$123.45` / `-$12.30`, for realized P&L. */
export function signedCentsUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const text = usdFormatter.format(Math.abs(cents) / 100);
  if (cents > 0) return `+${text}`;
  if (cents < 0) return `-${text}`;
  return text;
}

/** Myriadths (as the API's decimal string) → `$226.8100` trimmed of trailing zeros. */
export function priceUsd(myriadths: string | number | null | undefined): string {
  if (myriadths === null || myriadths === undefined || myriadths === '') return '—';
  const whole = String(myriadths).trim();
  if (!/^-?\d+$/.test(whole)) return '—';
  const value = BigInt(whole);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / 10_000n;
  const frac = abs % 10_000n;
  if (frac === 0n) return `${negative ? '-' : ''}$${groups(units)}`;
  const fracText = frac.toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}$${groups(units)}.${fracText}`;
}

/** Myriadths → 4-decimal string, for editing in a text input. */
export function priceInputValue(myriadths: string | number | null | undefined): string {
  if (myriadths === null || myriadths === undefined || myriadths === '') return '';
  const value = BigInt(String(myriadths));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = (abs / 10_000n).toString() + '.' + (abs % 10_000n).toString().padStart(4, '0');
  return negative ? `-${text}` : text;
}

/**
 * A price input → myriadths string, using the same parser as the API
 * (`parseUsd`), so the client rejects exactly what the server would reject.
 * `null` means "invalid input".
 */
export function priceToMyriadths(input: string): string | null {
  try {
    return parseUsd(input).toString();
  } catch {
    return null;
  }
}

/** USD text (e.g. `1,000.50`) → integer cents, or `null` when unparsable. */
export function usdTextToCents(input: string): number | null {
  try {
    const myriadths = parseUsd(input);
    const sign = myriadths < 0n ? -1n : 1n;
    const abs = myriadths < 0n ? -myriadths : myriadths;
    const cents = (abs + 50n) / 100n; // myriadths → cents, half-up
    return Number(sign * cents);
  } catch {
    return null;
  }
}

/** Integer cents → USD text for a number input, e.g. 123450 → `1234.50`. */
export function centsToUsdText(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

/** Basis points (integer ppm / 100) → `2.50%`. */
export function bpPercent(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined || !Number.isFinite(basisPoints)) return '—';
  return `${(basisPoints / 100).toFixed(2)}%`;
}

/** Fraction (0..1) → `72.4%`; `null` when there is nothing to divide by. */
export function percent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date value from the API → `YYYY-MM-DD`, shown exactly as the server wrote it.
 * No locale wording, and no `new Date()` round-trip: an untyped `new Date`
 * parses a bare `YYYY-MM-DD` as UTC midnight, which lands on the day before in
 * western browser timezones. Accepts the DATE wire format (`2026-01-05`) and
 * legacy locale-free datetimes (`2026-01-05 09:05:00`, `2026-01-05T09:05`);
 * `null`/garbage → `—`.
 */
export function isoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = iso.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '—';
}

/**
 * Datetime value from the API → `YYYY-MM-DD HH:MM`, a naive wall-clock string
 * with no timezone jargon:
 *  - bare date (`2026-01-05`) → as-is; a fake ` 00:00` would be a lie.
 *  - locale-free server stamps (`2026-01-05 09:05[:SS]`, `2026-01-05T09:05`)
 *    → as-is: these are already New York wall-clock times from the server.
 *  - explicit offset or `Z` (`…T09:05:00Z`, `…T09:05:00+09:00`) → rendered in
 *    the browser's own zone.
 * `null`/garbage → `—`.
 */
export function isoDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const bare = iso.match(/^\d{4}-\d{2}-\d{2}$/);
  if (bare) return bare[0];
  const naive = iso.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/);
  if (naive && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) return naive[0].replace('T', ' ');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** `YYYY-MM-DD` for a Date, in the browser's local calendar. */
export function todayIso(local: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

/** Thousands grouping for a bigint dollar amount. */
function groups(value: bigint): string {
  const text = value.toString();
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
