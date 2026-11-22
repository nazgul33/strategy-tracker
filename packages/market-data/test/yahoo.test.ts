import { describe, expect, test } from 'bun:test';
import { MarketDataError, fetchDailyBars, fetchLastClose } from '@st/market-data';

describe('market-data yahoo', () => {
  test('fetchDailyBars maps bars with tz edge and skips null', async () => {
    const ts1 = Math.floor(Date.UTC(2026, 1, 2, 14, 30) / 1000);
    const ts2 = Math.floor(Date.UTC(2026, 1, 3, 3, 0) / 1000);
    const ts3 = Math.floor(Date.UTC(2026, 1, 3, 14, 30) / 1000);
    const body = {
      chart: {
        result: [
          {
            timestamp: [ts1, ts2, ts3],
            indicators: {
              quote: [
                {
                  open: [100, 101, 102],
                  high: [105, 106, 107],
                  low: [99, 100, 101],
                  close: [352.0, 353.0, null],
                },
              ],
            },
          },
        ],
      },
    };
    const fetchImpl = (url: any) => {
      expect(String(url)).toContain('period1=');
      expect(String(url)).toContain('period2=');
      expect(String(url)).toContain('interval=1d');
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const bars = await fetchDailyBars('AAPL', '2026-02-01', '2026-02-05', fetchImpl as any);
    expect(bars.length).toBe(2);
    expect(bars[0]).toEqual({
      date: '2026-02-02',
      open: 1000000n,
      high: 1050000n,
      low: 990000n,
      close: 3520000n,
    });
    expect(bars[1].date).toBe('2026-02-02');
  });

  test('fetchLastClose returns last non-null', async () => {
    const ts1 = Math.floor(Date.UTC(2026, 1, 2, 14, 30) / 1000);
    const ts2 = Math.floor(Date.UTC(2026, 1, 3, 14, 30) / 1000);
    const body = {
      chart: {
        result: [
          {
            timestamp: [ts1, ts2],
            indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [10.0, 20.0] }] },
          },
        ],
      },
    };
    const fetchImpl = (url: any) => {
      expect(String(url)).toContain('range=10d');
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const r = await fetchLastClose('AAPL', fetchImpl as any);
    expect(r.close).toBe(200000n);
  });

  test('no-data error', async () => {
    const body = { chart: { error: { code: 'Not Found Data' } } };
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    await expect(fetchDailyBars('X', '2026-02-01', '2026-02-05', fetchImpl as any)).rejects.toBeInstanceOf(MarketDataError);
    try {
      await fetchDailyBars('X', '2026-02-01', '2026-02-05', fetchImpl as any);
    } catch (e: any) {
      expect(e.kind).toBe('no-data');
    }
    // empty result
    const body2 = { chart: { result: [] } };
    const fetchImpl2 = () => Promise.resolve(new Response(JSON.stringify(body2), { status: 200 }));
    await expect(fetchLastClose('X', fetchImpl2 as any)).rejects.toMatchObject({ kind: 'no-data' });
  });

  test('http error', async () => {
    const fetchImpl = () => Promise.resolve(new Response('err', { status: 500 }));
    await expect(fetchDailyBars('X', '2026-02-01', '2026-02-05', fetchImpl as any)).rejects.toMatchObject({ kind: 'http' });
    await expect(fetchLastClose('X', fetchImpl as any)).rejects.toMatchObject({ kind: 'http' });
  });

  test('a 400 whose error says the data does not exist for the range is no-data', async () => {
    const body = `{"chart":{"result":null,"error":{"code":"Bad Request","description":"Data doesn't exist for startDate = 1420070400, endDate = 1451606400"}}}`;
    const fetchImpl = () => Promise.resolve(new Response(body, { status: 400 }));
    await expect(fetchDailyBars('ABNB', '2015-01-01', '2015-12-31', fetchImpl as any)).rejects.toMatchObject({ kind: 'no-data' });
  });

  test('any other non-OK response is still an http error', async () => {
    const respond = (body: string, status: number) => () => Promise.resolve(new Response(body, { status }));
    const badInterval = `{"chart":{"result":null,"error":{"code":"Bad Request","description":"Invalid input - interval=1d is not supported"}}}`;
    await expect(fetchDailyBars('X', '2026-02-01', '2026-02-05', respond(badInterval, 400) as any)).rejects.toMatchObject({ kind: 'http' });
    await expect(fetchDailyBars('X', '2026-02-01', '2026-02-05', respond('upstream down', 500) as any)).rejects.toMatchObject({ kind: 'http' });
    await expect(fetchDailyBars('X', '2026-02-01', '2026-02-05', respond('<html>Not Found</html>', 404) as any)).rejects.toMatchObject({ kind: 'http' });
  });

  test("Yahoo's 404 for an unknown or delisted symbol is no-data, for bars and for the last close", async () => {
    const notFound = `{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`;
    const fetchImpl = () => Promise.resolve(new Response(notFound, { status: 404 }));
    await expect(fetchDailyBars('ZZZZQ', '2026-02-01', '2026-02-05', fetchImpl as any)).rejects.toMatchObject({ kind: 'no-data' });
    await expect(fetchLastClose('ZZZZQ', fetchImpl as any)).rejects.toMatchObject({ kind: 'no-data' });
  });

  test('a provider that cannot be reached is an http error carrying the cause', async () => {
    const fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
    const err = await fetchDailyBars('X', '2026-02-01', '2026-02-05', fetchImpl as any).catch((e) => e);
    expect(err).toBeInstanceOf(MarketDataError);
    expect(err).toMatchObject({ kind: 'http' });
    expect(err.message).toContain('Failed to fetch');
    await expect(fetchLastClose('X', fetchImpl as any)).rejects.toMatchObject({ kind: 'http' });
  });
});
