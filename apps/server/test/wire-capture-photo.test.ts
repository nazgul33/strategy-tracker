import { describe, expect, test } from 'bun:test';
import { parseUsd } from '@st/core';
import { buildPendingKeyboard } from '@st/telegram';
import { t, type Lang } from '@st/telegram/i18n';
import { NO_SNAPSHOT } from './booking-fakes';
import { DATE_NOTICE_EN, PNG_B64, activeRun, makeCapture, visionFetch } from './wire-capture-fakes';

describe('capture onPhoto — happy path books via the real booking module', () => {
  test('single active run: capture is ingested, pending row created, user gets exact booked line + confirm keyboard', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });

    expect(h.captures.length).toBe(1);
    expect(h.captures[0].runId).toBe(1);
    expect(h.captures[0].status).toBe('parsed');
    expect(h.captures[0].imageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.pending.length).toBe(1);
    const p = h.pending[0]!;
    expect(p.runId).toBe(1);
    expect(p.ticker).toBe('NVDA');
    expect(p.side).toBe('buy');
    expect(p.shares).toBe(10);
    expect(p.price).toBe(parseUsd('180.50'));
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.chatId).toBe('777');
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?');
    expect(h.sent[0]!.extra).toEqual({ reply_markup: buildPendingKeyboard(String(p.id)) });

    // confirm through the real confirmPendingFill: bucket 0, fill row, ledger row
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(p.status).toBe('confirmed');
    expect(p.bucketIdx).toBe(0);
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]).toMatchObject({ runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10, source: 'capture' });
    expect(h.fills[0]!.price).toBe(parseUsd('180.50'));
    expect(h.ledger.length).toBe(1);
    expect(h.ledger[0]!.kind).toBe('buy');
    expect(h.stateFor(1).buckets[0]!.state).toBe('held');
    expect(h.stateFor(1).buckets[0]!.shares).toBe(10);
    expect(h.sent.at(-1)!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 1');
  });

  test('rejecting pending leaves no fill', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    await h.handlers.onConfirm('777', `no:${p.id}`, false);
    expect(p.status).toBe('rejected');
    expect(h.fills.length).toBe(0);
    expect(h.sent.at(-1)!.text).toBe('Rejected — fill discarded.');
  });

  test('re-detected fill matching a booked fill except price sends a conflict line and books nothing', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.repos.fillRepo.insert({
      runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10,
      price: parseUsd('999.99'), fee: 0, filledOn: '2026-11-10', source: 'manual',
    });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.pending.length).toBe(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe(
      '⚠️ Conflict: buy 10 NVDA on 2026-11-10 — extracted $180.50, booked fill #1 has $999.99. Correction listed in Pending.',
    );
    expect(h.corrections.length).toBe(1);
    expect(h.corrections[0]).toMatchObject({ fillId: 1, proposedPrice: parseUsd('180.50'), status: 'open' });
  });

  test('dismissed correction conflict uses the dismissed line', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.repos.fillRepo.insert({
      runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10,
      price: parseUsd('999.99'), fee: 0, filledOn: '2026-11-10', source: 'manual',
    });
    const id = await h.repos.correctionRepo.insert({
      runId: 1, fillId: 1, captureId: null, side: 'buy', ticker: 'NVDA', bookedShares: 10, bookedFilledOn: '2026-11-10',
      bookedPrice: parseUsd('999.99'), bookedFee: 0, proposedPrice: parseUsd('180.50'), proposedFee: null,
    });
    await h.repos.correctionRepo.decide(id, 'dismissed');
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe(
      'ℹ️ buy 10 NVDA on 2026-11-10 — extracted $180.50, booked fill #1 has $999.99. You dismissed this correction before; not listed again.',
    );
    expect(h.corrections.length).toBe(1);
  });

  test('gone fill uses the gone line', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.repos.fillRepo.insert({
      runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10,
      price: parseUsd('999.99'), fee: 0, filledOn: '2026-11-10', source: 'manual',
    });
    // The matcher reads the list first; the recorder's later read sees the fill gone.
    const real = h.repos.fillRepo.listForRun.bind(h.repos.fillRepo);
    let calls = 0;
    h.repos.fillRepo.listForRun = async (runId: number) => (calls++ === 0 ? real(runId) : []);
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe(
      '⚠️ buy 10 NVDA on 2026-11-10 — extracted $180.50, but booked fill #1 no longer exists. Nothing to correct.',
    );
    expect(h.corrections.length).toBe(0);
    expect(
      t('capture-conflict-gone', 'ko', { date: '2026-11-10', ticker: 'NVDA', side: 'buy', shares: 10, extracted: '180.50', id: 1 }),
    ).toBe('⚠️ 2026-11-10 NVDA buy 10주 — 추출 가격 $180.50, 예약된 체결 #1이(가) 더 이상 없습니다. 수정할 항목이 없습니다.');
  });

  // booked conflict (fill #1) + pending conflict (row #1) + one fresh fill, all in one screenshot
  const mixedFetch = (async () => {
    const content = JSON.stringify({
      fills: [
        { side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-10' },
        { side: 'sell', ticker: 'NVDA', shares: 4, price: '200.00', date: '2026-11-10' },
        { side: 'buy', ticker: 'NVDA', shares: 5, price: '170.00', date: '2026-11-10' },
      ],
    });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
  }) as unknown as typeof fetch;

  async function mixedOutcome(lang: Lang) {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: mixedFetch, lang });
    await h.repos.fillRepo.insert({
      runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10,
      price: parseUsd('999.99'), fee: 0, filledOn: '2026-11-10', source: 'manual',
    });
    await h.repos.pendingRepo.insert({
      runId: 1, captureId: null, bucketIdx: null, side: 'sell', ticker: 'NVDA', shares: 4,
      price: parseUsd('190.00'), fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT,
    });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    return h;
  }

  test('mixed outcome (conflicts + pending) sends the head, then conflict lines, then the booking prompt', async () => {
    const h = await mixedOutcome('en');
    expect(h.sent.map((s) => s.text)).toEqual([
      'Conflicts — these were not booked:',
      '⚠️ Conflict: buy 10 NVDA on 2026-11-10 — extracted $180.50, booked fill #1 has $999.99. Correction listed in Pending.',
      '⚠️ Conflict: sell 4 NVDA on 2026-11-10 — extracted $200.00, but pending row #1 has $190.00. Resolve that row first.',
      'Booked NVDA buy 5 sh @ $170.00 on 2026-11-10 — confirm?',
    ]);
    expect(h.sent.map((s) => s.extra !== undefined)).toEqual([false, false, false, true]);
    expect(h.pending.length).toBe(2); // the seeded row + the fresh one
    expect(h.corrections.length).toBe(1); // booked conflict only
  });

  test('mixed outcome renders the head and both conflict kinds in ko', async () => {
    const h = await mixedOutcome('ko');
    expect(h.sent.map((s) => s.text)).toEqual([
      '충돌 — 아래 체결은 예약되지 않았습니다:',
      '⚠️ 충돌: 2026-11-10 NVDA buy 10주 — 추출 가격 $180.50, 예약된 체결 #1 가격 $999.99. 수정 제안은 \'확인 대기\'에서 처리하세요.',
      '⚠️ 충돌: 2026-11-10 NVDA sell 4주 — 추출 가격 $200.00, 대기 중 행 #1 가격 $190.00. 먼저 해당 행을 처리하세요.',
      'NVDA buy 5주 @ $170.00 (2026-11-10) 예약 — 확인하시겠습니까?',
    ]);
  });
});

describe('capture onPhoto — vision request', () => {
  test('the vision request allows 4096 output tokens', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const recordingFetch = (async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return visionFetch(url, init);
    }) as unknown as typeof fetch;
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: recordingFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.max_tokens).toBe(4096);
  });
});

describe('capture prompt — trade date vision could not read', () => {
  const fetchWith = (date?: string) =>
    (async () => {
      const content = JSON.stringify({ fills: [{ side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', ...(date ? { date } : {}) }] });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

  test('a fill with no date carries the substitution notice and no buttons', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: fetchWith() });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent[0]!.text).toBe(`Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?\n${DATE_NOTICE_EN}`);
    expect(h.sent[0]!.extra).toBeUndefined();
  });

  test('a date the extractor dropped as too far from today gets the same notice', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: fetchWith('2026-01-02') });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent[0]!.text).toContain('capture date 2026-11-10 was used');
    expect(h.sent[0]!.extra).toBeUndefined();
  });

  test('the notice is rendered in ko', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: fetchWith(), lang: 'ko' });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent[0]!.text).toContain('캡처한 날짜 2026-11-10');
    expect(h.sent[0]!.text).toContain('웹 앱의 \'확인 대기\'에서 날짜를 확인한 뒤');
  });

  test('a readable date carries no notice', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: fetchWith('2026-11-10') });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.sent[0]!.text).not.toContain('\n');
    expect(h.sent[0]!.extra).toEqual({ reply_markup: buildPendingKeyboard(String(h.pending[0]!.id)) });
  });
});
