// Pure VR text helpers shared by the create form, the settings dialog and the run page.
import type { VrFormula, VrSettingsDto } from '../../api.vr.types';
import { isPercentText, percentTextToPpm, ppmToPercentText } from '../../gaps';
import { usdToCents } from '../../usd';

export const VR_TICKER_RE = /^[A-Za-z.]{1,10}$/;
export const VR_MAX_NAME = 128;

export function formulaLabelKey(f: VrFormula): string {
  return f === 'basic' ? 'vr.formulaBasic' : 'vr.formulaSkill';
}

/** Display text for a ppm percent: 150_000 → `15%`, 125_000 → `12.5%`, 0 → `0%`. Integer math only. */
export function ppmPercent(ppm: number): string {
  const sign = ppm < 0 ? '-' : '';
  const abs = Math.abs(ppm);
  const frac = String(abs % 10_000).padStart(4, '0').replace(/0+$/, '');
  return `${sign}${Math.floor(abs / 10_000)}${frac === '' ? '' : `.${frac}`}%`;
}

/** Input prefill for a ppm percent. Unlike `ppmToPercentText`, 0 stays `0` (a spend limit of 0 is a real value). */
export function ppmInputText(ppm: number): string {
  return ppm === 0 ? '0' : ppmToPercentText(ppm);
}

/** USD text with an optional leading minus → integer cents; `null` when malformed. `-0` never comes out. */
export function signedUsdTextToCents(text: string): number | null {
  let rest = text.trim();
  const negative = rest.startsWith('-');
  if (negative) rest = rest.slice(1);
  if (rest.startsWith('-') || rest.startsWith('+')) return null;
  const cents = usdToCents(rest);
  if (cents === null) return null;
  return negative && cents !== 0 ? -cents : cents;
}

/** The server's default for the initial stock amount: half the cash, rounded down. */
export function halfCents(cashCents: number): number {
  return Math.floor(cashCents / 2);
}

export interface VrSettingsText {
  g: string;
  formula: VrFormula;
  band: string;
  spendLimit: string;
  deposit: string;
}

export const VR_DEFAULT_SETTINGS_TEXT: VrSettingsText = { g: '10', formula: 'skill', band: '15', spendLimit: '50', deposit: '0' };

/** The client checks of the five settings fields, in form order; stops at the first failure. */
export function parseVrSettingsText(s: VrSettingsText): { settings: VrSettingsDto } | { errorKey: string } {
  const gText = s.g.trim();
  const g = Number(gText);
  if (!/^\d+$/.test(gText) || g < 1 || g > 1000) return { errorKey: 'vr.invalidG' };
  const band = s.band.trim();
  const bandPpm = isPercentText(band, 4) ? percentTextToPpm(band, 4) : 0;
  if (bandPpm <= 0 || bandPpm >= 1_000_000) return { errorKey: 'vr.invalidBand' };
  const spendLimit = s.spendLimit.trim();
  if (!isPercentText(spendLimit, 4)) return { errorKey: 'vr.invalidSpendLimit' };
  const cycleDepositCents = signedUsdTextToCents(s.deposit);
  if (cycleDepositCents === null) return { errorKey: 'vr.invalidDeposit' };
  return {
    settings: { g, formula: s.formula, bandPpm, spendLimitPpm: percentTextToPpm(spendLimit, 4), cycleDepositCents },
  };
}
