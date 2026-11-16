// Percent text helpers shared by the forms: percent at the UI boundary,
// integer ppm (1% = 10_000, 0 = "not set") on the wire. Conversion is pure
// integer math so no float ever enters a ppm value. `maxDecimals` is
// supported for 1–4 only (0 breaks the regex, 5+ mis-scales the padding).

/** Percent text like `0.5` / `2` is well-formed, within 0–100 and has at most `maxDecimals` decimals. */
export function isPercentText(s: string, maxDecimals: number): boolean {
  return new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`).test(s) && Number(s) <= 100;
}

/** Percent text (at most `maxDecimals` decimals, 4 is the ppm limit) → integer ppm. Blank → 0. */
export function percentTextToPpm(s: string, maxDecimals: number): number {
  if (s === '') return 0;
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0000').slice(0, maxDecimals);
  return Number(whole) * 10_000 + Number(fracPadded.padEnd(4, '0'));
}

/**
 * Integer ppm → percent text for an input; 0 ("not set") → blank. The
 * division is display-only (prefill), so float is fine; `toFixed` cannot cross
 * a rounding boundary for ppm that fit `maxDecimals`, and Number() trims
 * trailing zeros (`5000 → 0.5`, `700 @3 → 0.07`).
 */
export function ppmToPercentText(ppm: number, maxDecimals = 4): string {
  if (ppm === 0) return '';
  return String(Number((ppm / 10_000).toFixed(maxDecimals)));
}

/** Gap percent text (4 decimals) is well-formed and within 0–100. */
export function isGapText(s: string): boolean {
  return isPercentText(s, 4);
}

/** Gap percent text → integer ppm (1% = 10_000). Blank means "not set" → 0. */
export function gapToPpm(s: string): number {
  return percentTextToPpm(s, 4);
}

/** Cut-loss percent text: one decimal, 0–50 % (the server caps `cutLossPpm` at 500_000). */
export function isCutLossText(s: string): boolean {
  return isPercentText(s, 1) && Number(s) <= 50;
}

/** Cut-loss percent text → integer ppm (3.5 % = 35_000). Blank means off → 0. */
export function cutLossToPpm(s: string): number {
  return percentTextToPpm(s, 1);
}
