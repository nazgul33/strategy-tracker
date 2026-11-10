import { type ISODate } from '@st/calendar';

export class MarketDataError extends Error {
  kind: 'no-data' | 'http';
  constructor(kind: 'no-data' | 'http', message?: string) {
    super(message ?? kind);
    this.kind = kind;
  }
}

export interface OHLCBar {
  date: ISODate;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
}

function toMyriadths(x: number): bigint {
  return BigInt(Math.round(x * 10000));
}

function epochToEtDate(ts: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts * 1000));
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

function parseBars(json: any): { ts: number[]; q: any } | null {
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  if (json?.chart?.error) return null;
  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return null;
  return { ts, q };
}

export async function fetchDailyBars(
  ticker: string,
  from: ISODate,
  to: ISODate,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OHLCBar[]> {
  const period1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  const toDate = new Date(to + 'T00:00:00Z');
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const period2 = Math.floor(toDate.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new MarketDataError('http');
  const json = await res.json();
  if (json?.chart?.error) throw new MarketDataError('no-data');
  const parsed = parseBars(json);
  if (!parsed) throw new MarketDataError('no-data');
  const { ts, q } = parsed;
  const opens = q.open ?? [];
  const highs = q.high ?? [];
  const lows = q.low ?? [];
  const closes = q.close ?? [];
  const bars: OHLCBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (t == null || o == null || h == null || l == null || c == null) continue;
    bars.push({
      date: epochToEtDate(t),
      open: toMyriadths(o),
      high: toMyriadths(h),
      low: toMyriadths(l),
      close: toMyriadths(c),
    });
  }
  if (bars.length === 0) throw new MarketDataError('no-data');
  return bars;
}

export async function fetchLastClose(
  ticker: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ date: ISODate; close: bigint }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=10d&interval=1d`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new MarketDataError('http');
  const json = await res.json();
  if (json?.chart?.error) throw new MarketDataError('no-data');
  const parsed = parseBars(json);
  if (!parsed) throw new MarketDataError('no-data');
  const { ts, q } = parsed;
  const closes = q.close ?? [];
  let lastIdx = -1;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] != null && closes[i] != null) lastIdx = i;
  }
  if (lastIdx === -1) throw new MarketDataError('no-data');
  return { date: epochToEtDate(ts[lastIdx]), close: toMyriadths(closes[lastIdx]) };
}