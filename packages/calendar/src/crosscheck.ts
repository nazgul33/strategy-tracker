import { dayInfo } from './index';

export type FetchImpl = typeof fetch;

export async function calendarCrossCheck(
  date: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<{ agree: boolean; remoteOpen?: boolean; error?: string }> {
  try {
    const res = await fetchImpl(`https://howmanytradingdays.com/api/status?date=${date}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { agree: true, error: `HTTP ${res.status}` };
    }
    const json: any = await res.json();
    const remoteOpen =
      typeof json?.tradingDay === 'boolean'
        ? json.tradingDay
        : typeof json?.is_trading_day === 'boolean'
          ? json.is_trading_day
          : undefined;
    if (remoteOpen === undefined) {
      return { agree: true, error: 'invalid response' };
    }
    return { agree: remoteOpen === dayInfo(date).open, remoteOpen };
  } catch (e) {
    return { agree: true, error: e instanceof Error ? e.message : String(e) };
  }
}