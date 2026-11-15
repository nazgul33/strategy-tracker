import { describe, expect, test } from 'bun:test';
import { extractFills, validateFill } from '@st/ingest';

function fakeFetch(responses: any[]) {
  const calls: any[] = [];
  const fn: any = async (url: any, init: any) => {
    calls.push({ url, init });
    const r = responses.shift();
    return r;
  };
  (fn as any).calls = calls;
  return fn;
}

function okJson(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };

describe('extract', () => {
  test('a) prose-wrapped JSON', async () => {
    const content = "Here are the fills:\n```json\n{\"fills\":[{\"side\":\"매수\",\"ticker\":\"TSLA\",\"shares\":\"120\",\"price\":\"340.22\",\"fee\":\"1.23\"},{\"side\":\"매도\",\"ticker\":\"TSLA\",\"shares\":\"2\",\"price\":\"341.13\",\"fee\":\"0.05\"}]}\n```";
    const f = fakeFetch([okJson(content)]);
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fills[0]).toEqual({ side: 'buy', ticker: 'TSLA', shares: 120, price: '340.22', fee: '1.23' });
      expect(r.fills[1]).toEqual({ side: 'sell', ticker: 'TSLA', shares: 2, price: '341.13', fee: '0.05' });
    }
  });

  test('b) unparseable', async () => {
    const f = fakeFetch([okJson("I can't read this")]);
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unparseable');
    expect((r as any).fills).toBeUndefined();
  });

  test('c) http 401', async () => {
    const f = fakeFetch([{ ok: false, status: 401, json: async () => ({}) }]);
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('http');
  });

  test('d) empty fills', async () => {
    const f = fakeFetch([okJson('{"fills":[]}')]);
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  test('e) request assertions', async () => {
    const content = '{"fills":[]}';
    const f = fakeFetch([okJson(content)]);
    const cfg = { baseUrl: 'http://base', apiKey: 'secret', model: 'm', maxTokens: 77 };
    const imgs = [
      { base64: 'PNGDATA', mime: 'image/png' },
      { base64: 'JPGDATA', mime: 'image/jpeg' },
    ];
    await extractFills(imgs, cfg, f);
    const call = f.calls[0];
    expect(call.url).toBe('http://base/chat/completions');
    const headers = call.init.headers;
    expect(headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(call.init.body);
    expect(body.model).toBe('m');
    expect(body.max_tokens).toBe(77);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const contentParts = body.messages[0].content;
    const textPart = contentParts.find((p: any) => p.type === 'text');
    expect(textPart.text).toContain('mPOP');
    const imgParts = contentParts.filter((p: any) => p.type === 'image_url');
    expect(imgParts.length).toBe(2);
    expect(imgParts[0].image_url.url).toBe('data:image/png;base64,PNGDATA');
    expect(imgParts[1].image_url.url).toBe('data:image/jpeg;base64,JPGDATA');
  });

  test('f) validateFill', () => {
    expect(validateFill({ side: 'buy', ticker: 'TSLA', shares: 120.5, price: '340.22' } as any)).toBe(false);
    expect(validateFill({ side: 'sell', ticker: 'TSLA', shares: 10, price: '3e5' } as any)).toBe(false);
    expect(validateFill({ side: 'buy', ticker: 'TSLA', shares: 10, price: '340.22' })).toBe(true);
    expect(validateFill({ side: 'buy', ticker: 'TSLA', shares: 0, price: '340.22' })).toBe(false);
    expect(validateFill({ side: 'buy', ticker: 'TSLA', shares: -1, price: '340.22' })).toBe(false);
    expect(validateFill({ side: 'x', ticker: 'TSLA', shares: 10, price: '340.22' } as any)).toBe(false);
    expect(validateFill({ side: 'buy', ticker: '', shares: 10, price: '340.22' })).toBe(false);
    expect(validateFill({ side: 'buy', ticker: 'TSLA', shares: 10, price: '340.22', fee: '1.2' })).toBe(true);
  });

  test('mixed array gate', async () => {
    const content = '{"fills":[{"side":"매수","ticker":"TSLA","shares":"120.5","price":"340.22"},{"side":"매수","ticker":"TSLA","shares":"10","price":"340.22"}]}';
    const f = fakeFetch([okJson(content)]);
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], CFG, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fills.length).toBe(1);
  });

  test('g) thousands separators from the screenshot are tolerated', async () => {
    const content =
      '{"fills":[{"side":"매수","ticker":"SOXL","shares":"1,268","price":"46,976.8042","fee":"1,234.56"},{"side":"매도","ticker":"GDXU","shares":"100","price":"77.7400"}]}';
    const f = fakeFetch([okJson(content)]);
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], CFG, f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fills[0]).toEqual({ side: 'buy', ticker: 'SOXL', shares: 1268, price: '46976.8042', fee: '1234.56' });
      expect(r.fills[1]).toEqual({ side: 'sell', ticker: 'GDXU', shares: 100, price: '77.7400' });
    }
  });

  test('h) unexecuted order rows (체결수량 0) are dropped, real fills kept', async () => {
    const content =
      '{"fills":[{"side":"매수","ticker":"SOXL","shares":"0","price":"14.6200"},{"side":"매도","ticker":"GDXU","shares":"21","price":"77.0000"},{"side":"매수","ticker":"SOXL","shares":"","price":"42.8400"}]}';
    const f = fakeFetch([okJson(content)]);
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], CFG, f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fills.length).toBe(1);
      expect(r.fills[0]).toEqual({ side: 'sell', ticker: 'GDXU', shares: 21, price: '77.0000' });
    }
  });

  test('i) keeps an ISO date inside the window and injects today into the prompt', async () => {
    const content = '{"fills":[{"side":"buy","ticker":"SOXL","shares":"10","price":"4.20","date":"2026-11-14"}]}';
    const f = fakeFetch([okJson(content)]);
    const r = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], { ...CFG, today: '2026-11-15' }, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fills[0]!.date).toBe('2026-11-14');
    const body = JSON.parse(f.calls[0].init.body);
    const text = body.messages[0].content[0].text as string;
    expect(text).toContain('Today is 2026-11-15');
  });

  test('j) drops malformed or far-out dates but keeps the fill', async () => {
    const content = JSON.stringify({ fills: [
      { side: 'buy', ticker: 'A', shares: '1', price: '1.00', date: '11.14' },
      { side: 'buy', ticker: 'B', shares: '1', price: '1.00', date: '2025-06-01' },
      { side: 'buy', ticker: 'C', shares: '1', price: '1.00', date: '2026-11-14T00:00:00' },
      { side: 'buy', ticker: 'D', shares: '1', price: '1.00', date: '2026-10-01' },
    ]});
    const f = fakeFetch([okJson(content)]);
    const r = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], { ...CFG, today: '2026-11-15' }, f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fills.map((x) => x.ticker)).toEqual(['A', 'B', 'C', 'D']); // all fills survive
      expect(r.fills.map((x) => x.date)).toEqual([undefined, undefined, undefined, '2026-10-01']);
    }
  });

  test('k) calendar-invalid dates (2026-13-45, rollover 2026-02-30) are dropped, fills survive (with and without today)', async () => {
    const content = JSON.stringify({ fills: [
      { side: 'buy', ticker: 'A', shares: '1', price: '1.00', date: '2026-13-45' },
      { side: 'buy', ticker: 'B', shares: '1', price: '1.00', date: '2026-02-30' },
    ]});
    const f1 = fakeFetch([okJson(content)]);
    const r1 = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], { ...CFG, today: '2026-11-15' }, f1);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.fills.map((x) => x.ticker)).toEqual(['A', 'B']);
      expect(r1.fills.map((x) => x.date)).toEqual([undefined, undefined]);
    }
    const f2 = fakeFetch([okJson(content)]);
    const r2 = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], CFG, f2);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.fills.map((x) => x.ticker)).toEqual(['A', 'B']);
      expect(r2.fills.map((x) => x.date)).toEqual([undefined, undefined]);
    }
  });

  test('l) future-side window: +45 days kept, +46 days dropped', async () => {
    const content = JSON.stringify({ fills: [
      { side: 'buy', ticker: 'A', shares: '1', price: '1.00', date: '2026-12-30' },
      { side: 'buy', ticker: 'B', shares: '1', price: '1.00', date: '2026-12-31' },
    ]});
    const f = fakeFetch([okJson(content)]);
    const r = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], { ...CFG, today: '2026-11-15' }, f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fills.map((x) => x.ticker)).toEqual(['A', 'B']); // all fills survive
      expect(r.fills.map((x) => x.date)).toEqual(['2026-12-30', undefined]);
    }
  });

  test('200 with non-JSON body -> unparseable, not a crash', async () => {
    const f = fakeFetch([{ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }]);
    const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], CFG, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unparseable');
  });
});
