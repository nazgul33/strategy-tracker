export interface VisionConfig { baseUrl: string; apiKey: string; model: string; maxTokens: number; today?: string }
export interface RawFill { side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee?: string; date?: string; orderType?: string; orderPrice?: string; orderedShares?: number }
export type ExtractResult = { ok: true; fills: RawFill[] } | { ok: false; reason: 'http' | 'unparseable' | 'incompatible' | 'empty'; detail: string }

import { MPOP_FILL_EXTRACTION_PROMPT } from './prompt';
import { maskKey } from './mask-key';

const PRICE_RE = /^\d+(\.\d{1,4})?$/;
const ORDER_PRICE_RE = /^\d{1,9}(\.\d{1,4})?$/;
const MAX_ORDERED_SHARES = 1_000_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export { MPOP_FILL_EXTRACTION_PROMPT } from './prompt';

export function validateFill(f: RawFill): boolean {
  if (!f || typeof f !== 'object') return false;
  if (f.side !== 'buy' && f.side !== 'sell') return false;
  if (!f.ticker || typeof f.ticker !== 'string') return false;
  if (typeof f.shares !== 'number' || !Number.isInteger(f.shares) || f.shares <= 0) return false;
  if (typeof f.price !== 'string' || !PRICE_RE.test(f.price)) return false;
  if (f.fee !== undefined && (typeof f.fee !== 'string' || !PRICE_RE.test(f.fee))) return false;
  return true;
}

function normalizeSide(s: any): 'buy' | 'sell' | null {
  if (s === 'buy' || s === '매수') return 'buy';
  if (s === 'sell' || s === '매도') return 'sell';
  return null;
}

const stripCommas = (v: any): any => (typeof v === 'string' ? v.replace(/,/g, '') : v);

// An order value is read only from a string or a number; anything else (true, [5]) is junk.
const readNumeric = (v: any): string | null => (typeof v === 'string' || typeof v === 'number' ? String(stripCommas(v)) : null);

// mPOP shows overseas tickers with a trailing exchange code ("SOXL.N" = Nasdaq);
// runs and fills store the bare symbol. Only .N/.O/.A are stripped, so dotted
// tickers like "BRK.B" survive.
const EXCHANGE_SUFFIX_RE = /\.(N|O|A)$/i;

function normalizeFill(raw: any): RawFill | null {
  const side = normalizeSide(raw?.side);
  if (!side) return null;
  const ticker = typeof raw?.ticker === 'string' ? raw.ticker.trim().replace(EXCHANGE_SUFFIX_RE, '') : raw?.ticker;
  const shares = Number(stripCommas(raw?.shares));
  const price = stripCommas(raw?.price);
  const fee = stripCommas(raw?.fee);
  const f: RawFill = { side, ticker, shares, price };
  if (fee !== undefined && fee !== null) f.fee = String(fee);
  if (typeof price !== 'string') f.price = String(price);
  if (typeof ticker !== 'string') return null;
  const date = typeof raw?.date === 'string' ? raw.date.trim() : undefined;
  if (date !== undefined && DATE_RE.test(date)) {
    const ts = Date.parse(date);
    // round-trip check: Date.parse silently rolls over calendar-invalid days (2026-02-30 -> 2026-03-02)
    if (!Number.isNaN(ts) && new Date(ts).toISOString().slice(0, 10) === date) f.date = date;
  }
  const orderType = typeof raw?.orderType === 'string' ? raw.orderType.trim() : '';
  if (orderType.length >= 1 && orderType.length <= 32) f.orderType = orderType;
  const orderPrice = readNumeric(raw?.orderPrice);
  if (orderPrice !== null && ORDER_PRICE_RE.test(orderPrice)) f.orderPrice = orderPrice;
  const orderedShares = Number(readNumeric(raw?.orderedShares));
  if (Number.isInteger(orderedShares) && orderedShares >= 1 && orderedShares <= MAX_ORDERED_SHARES) f.orderedShares = orderedShares;
  return f;
}

const MAX_ERROR_MESSAGE = 200;

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isSentenceEnd = (c: number) => c === 46 || c === 63 || c === 33; // . ? !
// A loop, not /[.?!]+$/: that regex backtracks quadratically on a long run of punctuation before other text.
function stripTrailingPunctuation(s: string): string {
  let end = s.length;
  while (end > 0 && isSentenceEnd(s.charCodeAt(end - 1))) end--;
  return s.slice(0, end).trim();
}

function pickErrorMessage(body: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (hasText(parsed?.error?.message)) return parsed.error.message;
  if (hasText(parsed?.error)) return parsed.error;
  if (hasText(parsed?.message)) return parsed.message;
  if (hasText(parsed?.detail)) return parsed.detail;
  return body;
}

// One line, key masked before the cap, no trailing sentence punctuation (it is placed in "— {detail}.").
function normalizeErrorText(text: string, apiKey: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const msg = stripTrailingPunctuation(maskKey(collapsed, apiKey));
  const cps = [...msg];
  return cps.length > MAX_ERROR_MESSAGE ? `${cps.slice(0, MAX_ERROR_MESSAGE - 1).join('')}…` : msg;
}

function visionErrorDetail(status: number, body: string, apiKey: string): string {
  const msg = normalizeErrorText(pickErrorMessage(body), apiKey);
  return msg === '' ? `http ${status}` : `http ${status}: ${msg}`;
}

export async function extractFills(
  images: Array<{ base64: string; mime: string }>,
  cfg: VisionConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ExtractResult> {
  if (!images || images.length === 0) {
    return { ok: false, reason: 'unparseable', detail: 'no images' };
  }
  const promptText = cfg.today ? `${MPOP_FILL_EXTRACTION_PROMPT}\nToday is ${cfg.today}. Resolve dates that omit the year against it.` : MPOP_FILL_EXTRACTION_PROMPT;
  const content: any[] = [{ type: 'text', text: promptText }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
  }
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content }],
  };
  const url = `${cfg.baseUrl}/chat/completions`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    return { ok: false, reason: 'http', detail: normalizeErrorText(String(e?.message ?? e), cfg.apiKey) || 'network error' };
  }
  if (!res.ok) {
    let errBody = '';
    try {
      const t = typeof res.text === 'function' ? await res.text() : '';
      if (typeof t === 'string') errBody = t;
    } catch {}
    return { ok: false, reason: 'http', detail: visionErrorDetail(res.status, errBody, cfg.apiKey) };
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'incompatible', detail: 'response body not json' };
  }
  const rawContent = json?.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string') {
    return { ok: false, reason: 'incompatible', detail: 'no content' };
  }
  // strip fences + find first { ... last }
  let text = rawContent.trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    return { ok: false, reason: 'unparseable', detail: 'no json' };
  }
  text = text.slice(first, last + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable', detail: 'json parse failed' };
  }
  const arr = parsed?.fills;
  if (!Array.isArray(arr)) {
    return { ok: false, reason: 'unparseable', detail: 'missing fills' };
  }
  const normalized: RawFill[] = [];
  for (const r of arr) {
    const nf = normalizeFill(r);
    if (nf && validateFill(nf)) {
      if (nf.date && cfg.today && Math.abs(Date.parse(nf.date) - Date.parse(cfg.today)) > 45 * DAY_MS) delete nf.date;
      normalized.push(nf);
    }
  }
  if (normalized.length === 0) {
    return { ok: false, reason: 'empty', detail: 'no valid fills' };
  }
  return { ok: true, fills: normalized };
}
