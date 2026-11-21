// The simulation config, validated in one place. The new-sim form, the draft
// panel's Apply and the replay all go through this module, so a value that one
// accepts can never be rejected by another. Percent exists only in the UI: the
// wire carries integer ppm, converted with integer math (see gaps.ts).
import { usdToCents } from './api';
import type { SimInput, SimRunDto } from './api';
import { costInputText, isoDate } from './format';
import { cutLossToPpm, gapToPpm, isCutLossText, isGapText, isPercentText, percentTextToPpm, ppmToPercentText } from './gaps';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Za-z.]{1,10}$/;
const DEFAULT_MAX_AGE_DAYS = 20;

/** Every editable field, as the strings the inputs hold. The ticker is not here: it is the sim's identity. */
export interface SimConfigForm {
  from: string;
  to: string;
  /** USD text, e.g. `100000` or `1,000.50`. */
  pool: string;
  /** Percent text, up to 3 decimals. */
  cost: string;
  /** Percent text, up to 4 decimals; blank = not set. */
  buyGap: string;
  sellGap: string;
  /** Percent text, up to 1 decimal, 0–50; blank = off. */
  cutLoss: string;
  /** Blank = server default. */
  bucketCount: string;
  maxAge: string;
}

/** The wire shape of a validated config: ppm and cents, no ticker, no name. */
export type SimConfigInput = Omit<SimInput, 'ticker' | 'name'>;

export type SimConfigResult = { ok: true; input: SimConfigInput } | { ok: false; error: string };

export interface SimParams {
  bucketCount: number;
  maxAgeDays: number;
}

type Translate = (key: string) => string;

/** Which percent fields are present but malformed — drives the red border and a disabled submit. */
export function simFieldFlags(form: SimConfigForm): { cost: boolean; buyGap: boolean; sellGap: boolean; cutLoss: boolean } {
  const malformed = (value: string, ok: (text: string) => boolean) => value.trim() !== '' && !ok(value.trim());
  return {
    cost: malformed(form.cost, (s) => isPercentText(s, 3)),
    buyGap: malformed(form.buyGap, isGapText),
    sellGap: malformed(form.sellGap, isGapText),
    cutLoss: malformed(form.cutLoss, isCutLossText),
  };
}

/** Optional integer field → number | undefined (blank); `null` when out of range or malformed. */
function optionalInt(value: string, min: number, max: number): number | null | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n < min || n > max ? null : n;
}

export function validateSimConfig(form: SimConfigForm, t: Translate): SimConfigResult {
  const fail = (key: string): SimConfigResult => ({ ok: false, error: t(key) });

  if (!DATE_RE.test(form.from) || !DATE_RE.test(form.to)) return fail('simInvalidDate');
  if (form.from < '1970-01-01') return fail('simFromTooEarly');
  if (form.from >= form.to) return fail('simInvalidRange');
  const poolCents = usdToCents(form.pool);
  if (poolCents === null || poolCents <= 0) return fail('simInvalidPool');

  const cost = form.cost.trim();
  if (!isPercentText(cost, 3)) return fail('runInvalidCostPpm');
  const flags = simFieldFlags(form);
  if (flags.buyGap || flags.sellGap) return fail('simInvalidGap');
  if (flags.cutLoss) return fail('simInvalidCutLoss');

  const buckets = optionalInt(form.bucketCount, 2, 20);
  if (buckets === null) return fail('runInvalidBucketCount');
  const age = optionalInt(form.maxAge, 1, 250);
  if (age === null) return fail('runInvalidMaxAge');

  const input: SimConfigInput = {
    from: form.from,
    to: form.to,
    poolCents,
    costPpm: percentTextToPpm(cost, 3),
    // Blank means "not set" and goes out as the server's explicit unset value, 0.
    buyGapPpm: gapToPpm(form.buyGap.trim()),
    sellGapPpm: gapToPpm(form.sellGap.trim()),
    cutLossPpm: cutLossToPpm(form.cutLoss.trim()),
  };
  const params: NonNullable<SimInput['params']> = {};
  if (buckets !== undefined) params.bucketCount = buckets;
  if (age !== undefined) params.maxAgeDays = age;
  if (Object.keys(params).length > 0) input.params = params;
  return { ok: true, input };
}

/** Normalized ticker (upper case), or null when it is not 1–10 letters/dots. */
export function parseSimTicker(raw: string): string | null {
  const ticker = raw.trim().toUpperCase();
  return TICKER_RE.test(ticker) ? ticker : null;
}

/** Stored `paramsJson` → the two params; anything missing or unusable falls back. */
export function parseSimParams(paramsJson: string, fallbackBucketCount: number): SimParams {
  try {
    const raw = JSON.parse(paramsJson) as { bucketCount?: unknown; maxAgeDays?: unknown };
    return {
      bucketCount: typeof raw.bucketCount === 'number' && raw.bucketCount > 0 ? raw.bucketCount : fallbackBucketCount,
      maxAgeDays: typeof raw.maxAgeDays === 'number' && raw.maxAgeDays > 0 ? raw.maxAgeDays : DEFAULT_MAX_AGE_DAYS,
    };
  } catch {
    return { bucketCount: fallbackBucketCount, maxAgeDays: DEFAULT_MAX_AGE_DAYS };
  }
}

/** Integer cents → USD input text: `10000000 → "100000"`, `12345 → "123.45"`. */
export function centsToUsdText(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}

type StoredConfig = Pick<
  SimRunDto,
  'fromDate' | 'toDate' | 'poolCents' | 'costPpm' | 'buyGapPpm' | 'sellGapPpm' | 'cutLossPpm'
>;

/** Prefill the editable fields from a stored run and its parsed params. */
export function formFromRun(run: StoredConfig, params: SimParams): SimConfigForm {
  return {
    from: isoDate(run.fromDate),
    to: isoDate(run.toDate),
    pool: centsToUsdText(run.poolCents),
    cost: costInputText(run.costPpm),
    buyGap: ppmToPercentText(run.buyGapPpm),
    sellGap: ppmToPercentText(run.sellGapPpm),
    cutLoss: ppmToPercentText(run.cutLossPpm, 1),
    bucketCount: String(params.bucketCount),
    maxAge: String(params.maxAgeDays),
  };
}
