export interface VisionConfig { baseUrl: string; apiKey: string; model: string; maxTokens: number; today?: string }
export interface RawFill { side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee?: string; date?: string; orderType?: string; orderPrice?: string; orderedShares?: number }
export type ExtractResult = { ok: true; fills: RawFill[] } | { ok: false; reason: 'http' | 'unparseable' | 'empty'; detail: string }

import { MPOP_FILL_EXTRACTION_PROMPT } from './prompt';

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
const KEY_RUN = 8;

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const stripTrailingPeriods = (s: string): string => s.replace(/\.+$/, '').trim();

// Services echo the API key in 401 bodies, sometimes whole: a word holding the whole key
// (keys of 4-7 chars) or any 8-char run of it (keys of 8+) is replaced.
function redactKey(text: string, apiKey: string): string {
  if (apiKey.length < 4) return text;
  const runs: string[] = [];
  if (apiKey.length < KEY_RUN) runs.push(apiKey);
  else for (let i = 0; i + KEY_RUN <= apiKey.length; i++) runs.push(apiKey.slice(i, i + KEY_RUN));
  return text
    .split(/(\s+)/)
    .map((tok) => (tok !== '' && !/^\s+$/.test(tok) && runs.some((r) => tok.includes(r)) ? '[redacted]' : tok))
    .join('');
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
  return body;
}

function visionErrorDetail(status: number, body: string, apiKey: string): string {
  const collapsed = pickErrorMessage(body).replace(/\s+/g, ' ').trim();
  const msg = stripTrailingPeriods(redactKey(collapsed, apiKey));
  if (msg === '') return `http ${status}`;
  const cps = [...msg];
  const capped = cps.length > MAX_ERROR_MESSAGE ? `${cps.slice(0, MAX_ERROR_MESSAGE - 1).join('')}…` : msg;
  return `http ${status}: ${capped}`;
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
    const redacted = redactKey(String(e?.message ?? e), cfg.apiKey);
    return { ok: false, reason: 'http', detail: stripTrailingPeriods(redacted) || redacted };
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
    return { ok: false, reason: 'unparseable', detail: 'response body not json' };
  }
  const rawContent = json?.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string') {
    return { ok: false, reason: 'unparseable', detail: 'no content' };
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
