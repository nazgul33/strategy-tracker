import { parseUsd } from '@st/core/money';

/** Parses a USD amount string; returns null when malformed or not > 0. */
export function usdOrNull(value: string): string | null {
  const s = value.trim();
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return null;
  try {
    return parseUsd(s) > 0n ? s : null;
  } catch {
    return null;
  }
}

/** Parses a USD fee ("0" allowed); returns null when malformed or negative. */
export function usdFeeOrNull(value: string): string | null {
  const s = value.trim();
  if (s === '') return null;
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return null;
  try {
    return parseUsd(s) >= 0n ? s : null;
  } catch {
    return null;
  }
}

/** Trimmed text; strictly well-formed grouping ("12,345.90") is stripped (parseUsd rejects commas). */
export function ungroupUsd(value: string): string {
  const s = value.trim();
  return /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s;
}

/** "12.345" USD → integer cents, half-up; null on bad input. */
export function usdToCents(value: string): number | null {
  try {
    const v = parseUsd(ungroupUsd(value));
    return v < 0n ? null : Number((v + 50n) / 100n);
  } catch {
    return null;
  }
}
