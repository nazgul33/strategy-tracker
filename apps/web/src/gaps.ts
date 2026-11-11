// Order price gap helpers shared by the forms: percent text at the UI
// boundary, integer ppm (1% = 10_000, 0 = "not set") on the wire.

/** Percent gap text like `0.5` / `2` is well-formed and within 0–100. */
export function isGapText(s: string): boolean {
  return /^\d+(\.\d{1,4})?$/.test(s) && Number(s) <= 100;
}

/** Percent gap text → integer ppm (1% = 10_000). Blank means "not set" → 0. */
export function gapToPpm(s: string): number {
  if (s === '') return 0;
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0000').slice(0, 4);
  return Number(whole) * 10_000 + Number(fracPadded);
}

/**
 * Integer ppm → percent text for a gap input; 0 ("not set") → blank. The
 * division is display-only (prefill), so float is fine; `toFixed(4)` cannot
 * cross a rounding boundary, and Number() trims trailing zeros (`5000 → 0.5`).
 */
export function ppmToPercentText(ppm: number): string {
  if (ppm === 0) return '';
  return String(Number((ppm / 10_000).toFixed(4)));
}
