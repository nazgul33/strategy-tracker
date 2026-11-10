export interface VisionConfig { baseUrl: string; apiKey: string; model: string; maxTokens: number }
export interface RawFill { side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee?: string }
export type ExtractResult = { ok: true; fills: RawFill[] } | { ok: false; reason: 'http' | 'unparseable' | 'empty'; detail: string }

import { MPOP_FILL_EXTRACTION_PROMPT } from './prompt';

const PRICE_RE = /^\d+(\.\d{1,4})?$/;

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

function normalizeFill(raw: any): RawFill | null {
  const side = normalizeSide(raw?.side);
  if (!side) return null;
  const ticker = raw?.ticker;
  const shares = Number(raw?.shares);
  const price = raw?.price;
  const fee = raw?.fee;
  const f: RawFill = { side, ticker, shares, price };
  if (fee !== undefined && fee !== null) f.fee = String(fee);
  if (typeof price !== 'string') f.price = String(price);
  if (typeof ticker !== 'string') return null;
  return f;
}

export async function extractFills(
  images: Array<{ base64: string; mime: string }>,
  cfg: VisionConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ExtractResult> {
  if (!images || images.length === 0) {
    return { ok: false, reason: 'unparseable', detail: 'no images' };
  }
  const content: any[] = [{ type: 'text', text: MPOP_FILL_EXTRACTION_PROMPT }];
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
    return { ok: false, reason: 'http', detail: String(e?.message ?? e) };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http', detail: `http ${res.status}` };
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
    if (nf && validateFill(nf)) normalized.push(nf);
  }
  if (normalized.length === 0) {
    return { ok: false, reason: 'empty', detail: 'no valid fills' };
  }
  return { ok: true, fills: normalized };
}
