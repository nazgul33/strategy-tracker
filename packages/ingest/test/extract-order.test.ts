import { describe, expect, test } from 'bun:test';
import { extractFills, MPOP_FILL_EXTRACTION_PROMPT } from '@st/ingest';

function fakeFetch(responses: any[]) {
  const fn: any = async () => responses.shift();
  return fn;
}

function okJson(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 1024 };

async function fillsOf(entries: any[], cfg: typeof CFG & { today?: string } = CFG) {
  const f = fakeFetch([okJson(JSON.stringify({ fills: entries }))]);
  const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, f);
  if (!r.ok) throw new Error(`extract failed: ${r.reason}`);
  return r.fills;
}

const SELL = { side: '매도', ticker: 'SOXL', shares: '1', price: '43.2500', date: '2026-11-23' };

describe('extract order columns', () => {
  test('a filled stop-market row (IMG_2141)', async () => {
    const fills = await fillsOf([{ ...SELL, orderType: '매도/STOP(시장가)', orderPrice: '0.0000', orderedShares: '1' }]);
    expect(fills).toEqual([
      { side: 'sell', ticker: 'SOXL', shares: 1, price: '43.2500', date: '2026-11-23', orderType: '매도/STOP(시장가)', orderPrice: '0.0000', orderedShares: 1 },
    ]);
  });

  test('a filled limit sell (IMG_2112)', async () => {
    const fills = await fillsOf([{ ...SELL, shares: '44', price: '64.0700', orderType: '매도/보통(지정가)', orderPrice: '64.0700', orderedShares: '44' }]);
    expect(fills).toEqual([
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '64.0700', date: '2026-11-23', orderType: '매도/보통(지정가)', orderPrice: '64.0700', orderedShares: 44 },
    ]);
  });

  test('an amended sell (IMG_2103)', async () => {
    const fills = await fillsOf([{ ...SELL, shares: '270', price: '65.5300', orderType: '정정(매도)', orderPrice: '65.0000', orderedShares: '270' }]);
    expect(fills).toEqual([
      { side: 'sell', ticker: 'SOXL', shares: 270, price: '65.5300', date: '2026-11-23', orderType: '정정(매도)', orderPrice: '65.0000', orderedShares: 270 },
    ]);
  });

  test('a date-range row has no order keys', async () => {
    const [fill] = await fillsOf([SELL]);
    expect(fill).toEqual({ side: 'sell', ticker: 'SOXL', shares: 1, price: '43.2500', date: '2026-11-23' });
    expect('orderType' in fill).toBe(false);
    expect('orderPrice' in fill).toBe(false);
    expect('orderedShares' in fill).toBe(false);
  });

  test('thousands separators', async () => {
    const [fill] = await fillsOf([{ ...SELL, orderType: '매도/보통(지정가)', orderPrice: '1,234.5000', orderedShares: '1,268' }]);
    expect(fill.orderPrice).toBe('1234.5000');
    expect(fill.orderedShares).toBe(1268);
  });

  test('a numeric order price and count', async () => {
    const [fill] = await fillsOf([{ ...SELL, orderPrice: 64.07, orderedShares: 44 }]);
    expect(fill.orderPrice).toBe('64.07');
    expect(fill.orderedShares).toBe(44);
  });

  test('junk order values are dropped, the fill stays', async () => {
    const fills = await fillsOf([
      { ...SELL, orderType: 'x'.repeat(40), orderPrice: 'abc', orderedShares: '0' },
      { ...SELL, orderType: '  ', orderPrice: '-1', orderedShares: '1.5' },
    ]);
    expect(fills).toHaveLength(2);
    for (const fill of fills) {
      expect('orderType' in fill).toBe(false);
      expect('orderPrice' in fill).toBe(false);
      expect('orderedShares' in fill).toBe(false);
    }
  });

  test('the order type is trimmed', async () => {
    const [fill] = await fillsOf([{ ...SELL, orderType: '  매도/LOC  ' }]);
    expect(fill.orderType).toBe('매도/LOC');
  });

  test('a date after today is kept', async () => {
    const [fill] = await fillsOf([{ ...SELL, date: '2026-11-20' }], { ...CFG, today: '2026-11-12' });
    expect(fill.date).toBe('2026-11-20');
  });

  test('the prompt asks for the order columns', () => {
    for (const s of ['orderType', 'orderPrice', 'orderedShares', '매도/STOP(시장가)', '정정(매도)', 'NEVER 주문단가']) {
      expect(MPOP_FILL_EXTRACTION_PROMPT).toContain(s);
    }
  });
});
