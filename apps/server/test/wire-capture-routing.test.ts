import { describe, expect, test } from 'bun:test';
import { parseUsd } from '@st/core';
import { t } from '@st/telegram/i18n';
import { makeCaptureHandlers } from '../src/wire/capture';
import { DATE_NOTICE_EN, NOTICE_EN, PNG_B64, activeRun, makeCapture, makeCaptureFakes, multiVisionFetch } from './wire-capture-fakes';

const ADVICE_EN = 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.';

describe('capture onPhoto — dedup and failures', () => {
  test('same image for the same run is recorded as duplicate, one pending row only', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.map((c) => c.status)).toEqual(['parsed']);
    expect(h.pending.length).toBe(1);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.text).toBe('Duplicate capture — all fills already booked or pending, or a correction is waiting in Pending.');
  });

  test('same image after rejecting its fill is read again', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    await h.handlers.onConfirm('777', `no:${h.pending[0]!.id}`, false);
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(1);
    expect(h.pending.map((p) => p.status)).toEqual(['rejected', 'pending']);
    expect(h.sent.at(-1)!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
    expect(h.sent.map((s) => s.text)).not.toContain(NOTICE_EN);
  });

  test('re-read of an image whose fill was confirmed warns before the fresh pending row', async () => {
    // first read carries a date, the re-read loses it, so the date-keyed matcher misses the booked fill
    let call = 0;
    const fills = [
      { side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-09' },
      { side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50' },
    ];
    const flaky = (async () => {
      const content = JSON.stringify({ fills: [fills[call++]] });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: flaky });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    await h.handlers.onConfirm('777', `yes:${h.pending[0]!.id}`, true);
    h.sent.length = 0;
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(1);
    expect(h.sent.map((s) => s.text)).toEqual([NOTICE_EN, `Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?\n${DATE_NOTICE_EN}`]);
    expect(h.sent[0]!.extra).toBeUndefined();
    expect(h.sent[1]!.extra).toBeUndefined();
  });

  test('booked-earlier notice has a Korean line', () => {
    expect(t('capture-booked-earlier', 'ko')).toBe(
      'ℹ️ 이 이미지의 체결은 이전에 이미 확정되었습니다 — 아래 항목은 중복일 수 있으니 확인 후 확정하세요.',
    );
  });

  test('extract failure: no pending row, user sees the reason, admin notified', async () => {
    const fakes = makeCaptureFakes({ runs: [activeRun(1, 'NVDA')] });
    const sent: { chatId: string; text: string }[] = [];
    const handlers = makeCaptureHandlers({
      repos: fakes.repos,
      vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'env' },
      getVisionApiKey: async () => ({ key: 'test-vision-key', source: 'env' as const }),
      today: () => '2026-11-10',
      allowedChatIds: [],
      fetchImpl: (async () => ({ ok: false, status: 500, text: async () => 'boom' }) as unknown as Response) as unknown as typeof fetch,
      send: async (chatId, text) => void sent.push({ chatId, text }),
    });
    await handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(fakes.pending.length).toBe(0);
    expect(fakes.captures.length).toBe(0);
    expect(sent).toEqual([
      {
        chatId: '777',
        text: [
          'The vision service did not accept the request — http 500: boom.',
          'In use: model vision-model (env), URL https://vision.example/v1 (env), key (env).',
          ADVICE_EN,
        ].join('\n'),
      },
    ]);
    expect(fakes.notifications.length).toBe(1);
    expect(fakes.notifications[0]).toMatchObject({ runId: null, chatId: '777' });
    expect(String(fakes.notifications[0]!.text)).toContain('The vision service did not accept the request — http 500: boom.');
  });

  test('no active run: user is told, nothing captured', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'AAPL')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe('No active run for NVDA — use /capture <runId> to pick one.');
  });

  test('two active runs with the same ticker are ambiguous', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(0);
    expect(h.sent[0]!.text).toBe('Multiple active runs for NVDA — use /capture <runId>.');
  });

  test('gone fill in a Korean chat sends the Korean gone line through onPhoto', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang: 'ko' });
    await h.repos.fillRepo.insert({
      runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10,
      price: parseUsd('999.99'), fee: 0, filledOn: '2026-11-10', source: 'manual',
    });
    const real = h.repos.fillRepo.listForRun.bind(h.repos.fillRepo);
    let calls = 0;
    h.repos.fillRepo.listForRun = async (runId: number) => (calls++ === 0 ? real(runId) : []);
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe(
      '⚠️ 2026-11-10 NVDA buy 10주 — 추출 가격 $180.50, 예약된 체결 #1이(가) 더 이상 없습니다. 수정할 항목이 없습니다.',
    );
    expect(h.corrections.length).toBe(0);
  });
});

describe('capture onPhoto — caption routing', () => {
  test('numeric caption selects that run even when the ticker has no active run', async () => {
    const h = makeCapture({ runs: [{ ...activeRun(7, 'NVDA'), status: 'paused' }] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 7');
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(7);
    expect(h.pending.length).toBe(1);
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
  });

  test('unknown run id in caption is reported', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 42');
    expect(h.sent[0]!.text).toBe('No run with id 42.');
    expect(h.captures.length).toBe(0);
  });

  test('caption routes to a second run with the same ticker', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 2');
    expect(h.captures[0]!.runId).toBe(2);
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
  });

  test('I1: "/capture 3" with a foreign-ticker extract books nothing and says so', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), activeRun(3, 'AAPL')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 3');
    expect(h.captures.length).toBe(0);
    expect(h.pending.length).toBe(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe('No AAPL fills in this image — run #3 unchanged.');
  });

  test('I1: "#7" prefix still routes to run 7', async () => {
    const h = makeCapture({ runs: [{ ...activeRun(7, 'NVDA'), status: 'paused' }] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '#7');
    expect(h.captures[0]!.runId).toBe(7);
  });

  test('I1: bare "7" still routes to run 7', async () => {
    const h = makeCapture({ runs: [{ ...activeRun(7, 'NVDA'), status: 'paused' }] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '7');
    expect(h.captures[0]!.runId).toBe(7);
  });

  test('I1: "NVDA 12/25" with no run 12 falls through to ticker auto-route, no unknown-run error', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, 'NVDA 12/25');
    expect(h.sent.map((s) => s.text)).not.toContain('No run with id 12.');
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(1);
    expect(h.pending.length).toBe(1);
    expect(h.pending[0]!.runId).toBe(1);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
  });
});

describe('capture onPhoto — multi-ticker auto-route (I3)', () => {
  test('two tickers with unique active runs produce one ingest per ticker group', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'AAPL')], fetchImpl: multiVisionFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });

    expect(h.captures.length).toBe(2);
    expect(h.captures.map((c) => c.runId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(h.pending.length).toBe(2);
    const nvda = h.pending.find((p) => p.ticker === 'NVDA')!;
    const aapl = h.pending.find((p) => p.ticker === 'AAPL')!;
    expect(nvda.runId).toBe(1);
    expect(aapl.runId).toBe(2);
    expect(nvda.shares).toBe(10);
    expect(aapl.shares).toBe(5);
    expect(h.sent.length).toBe(2);
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
    expect(h.sent[1]!.text).toBe('Booked AAPL buy 5 sh @ $210.25 on 2026-11-10 — confirm?');
  });

  test('a ticker with no active run is skipped with a notice; matched tickers still book', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: multiVisionFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(1);
    expect(h.pending.length).toBe(1);
    expect(h.pending[0]!.ticker).toBe('NVDA');
    expect(h.sent.map((s) => s.text)).toEqual([
      'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?',
      'No active run for AAPL — use /capture <runId> to pick one.',
    ]);
  });

  test('an ambiguous ticker is skipped with a notice; unique tickers still book', async () => {
    const h = makeCapture({
      runs: [activeRun(1, 'NVDA'), activeRun(2, 'AAPL'), activeRun(3, 'AAPL')],
      fetchImpl: multiVisionFetch,
    });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(1);
    expect(h.pending.length).toBe(1);
    expect(h.pending[0]!.ticker).toBe('NVDA');
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
    expect(h.sent[1]!.text).toBe('Multiple active runs for AAPL — use /capture <runId>.');
  });

  test('a numeric caption pins one run and books nothing when no fill has its ticker', async () => {
    const h = makeCapture({ runs: [activeRun(5, 'MSFT')], fetchImpl: multiVisionFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 5');
    expect(h.captures.length).toBe(0);
    expect(h.pending.length).toBe(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe('No MSFT fills in this image — run #5 unchanged.');
  });

  test('a pinned run keeps its own ticker and reports the ignored ones', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: multiVisionFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 1');
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(1);
    expect(h.pending.length).toBe(1);
    expect(h.pending[0]!.ticker).toBe('NVDA');
    expect(h.sent.map((s) => s.text)).toEqual([
      'Ignored AAPL — not the ticker of run #1.',
      'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?',
    ]);
  });
});
