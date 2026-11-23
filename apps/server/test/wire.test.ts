import { describe, expect, spyOn, test } from 'bun:test';
import { applyBuyFill, emptyState, parseUsd } from '@st/core';
import { buildPendingKeyboard } from '@st/telegram';
import { t, type Lang } from '@st/telegram/i18n';
import type { FillRow, LedgerRow } from '../src/domain/booking';
import type { NewCapture, NewFill, NewLedgerEntry, NewNotification, NewOrder, NewPending, NewRun, OrderRecord, OrderStatus, PendingDecisionPatch, PendingRow, RunRow, RunStatus } from '../src/domain/repo-types';
import type { CaptureImageInsert } from '../src/db/repos-vision';
import type { VisionReviewInsert } from '../src/domain/vision-review';
import { makeCaptureHandlers, type CaptureRepos } from '../src/wire/capture';
import { parseEnv, todayEt } from '../src/wire/deps';
import { NO_SNAPSHOT } from './booking-fakes';
import { fakeCorrectionRepo } from './fake-corrections';
import type { Expect, IsNever, ArityMismatches } from './type-assert';

// ---------- parseEnv ----------

const FULL_ENV = {
  DATABASE_URL: 'mysql://root:test@127.0.0.1:3307/st_test',
  APP_PASSWORD: 'hunter2',
  SESSION_SECRET: 's3cret',
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  TELEGRAM_ALLOWED_CHAT_IDS: '111,222',
  VISION_BASE_URL: 'https://vision.example/v1',
  VISION_MODEL: 'vision-model',
  VISION_API_KEY: 'vkey',
};

describe('parseEnv', () => {
  test('parses a full env and applies defaults', () => {
    const cfg = parseEnv(FULL_ENV);
    expect(cfg.port).toBe(8080);
    expect(cfg.databaseUrl).toBe('mysql://root:test@127.0.0.1:3307/st_test');
    expect(cfg.appPassword).toBe('hunter2');
    expect(cfg.sessionSecret).toBe('s3cret');
    expect(cfg.digestLang).toBe('en');
    expect(cfg.telegram).toEqual({
      token: '123456:ABC-DEF',
      allowedChatIds: ['111', '222'],
      visionBaseUrl: 'https://vision.example/v1',
      visionModel: 'vision-model',
    });
    expect(cfg.visionApiKey).toBe('vkey');
  });

  test('empty-string vars count as unset; telegram null disables the bot', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'mysql://x', APP_PASSWORD: 'p', SESSION_SECRET: 's', PORT: '9000',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_CHAT_IDS: '', VISION_BASE_URL: '', VISION_MODEL: '',
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.telegram).toBeNull();
  });

  test('one error lists every missing variable name', () => {
    let message = '';
    try {
      parseEnv({});
      throw new Error('should have thrown');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('invalid environment');
    for (const name of ['DATABASE_URL', 'APP_PASSWORD', 'SESSION_SECRET']) expect(message).toContain(name);
    for (const name of ['TELEGRAM_BOT_TOKEN', 'VISION_BASE_URL', 'VISION_MODEL']) expect(message).not.toContain(name);

    let msg2 = '';
    try {
      parseEnv({ TELEGRAM_BOT_TOKEN: 'tok', PORT: 'not-a-number', DIGEST_LANG: 'de' });
      throw new Error('should have thrown');
    } catch (err) {
      msg2 = (err as Error).message;
    }
    for (const name of ['DATABASE_URL', 'APP_PASSWORD', 'SESSION_SECRET', 'TELEGRAM_ALLOWED_CHAT_IDS', 'VISION_BASE_URL', 'VISION_MODEL', 'PORT', 'DIGEST_LANG'])
      expect(msg2).toContain(name);
  });

  describe('DEFAULT_COST_PERCENT', () => {
    test('unset defaults to 700 ppm', () => {
      expect(parseEnv(FULL_ENV).defaultCostPpm).toBe(700);
    });
    test('blank counts as unset', () => {
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: '  ' }).defaultCostPpm).toBe(700);
    });
    test('0 means zero, not unset', () => {
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: '0' }).defaultCostPpm).toBe(0);
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: '0.000' }).defaultCostPpm).toBe(0);
    });
    test.each([
      ['0.07', 700],
      ['0.125', 1250],
      ['0.1', 1000],
      ['0.001', 10],
      ['1', 10_000],
      ['12.5', 125_000],
      ['100', 1_000_000],
      ['100.000', 1_000_000],
    ])('%p converts exactly to %p ppm', (v, ppm) => {
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: v }).defaultCostPpm).toBe(ppm);
    });
    test.each(['abc', '0.0001', '-1', '101', '100.001', '1.', '.5', '1e1', '1,5'])('rejects %p by name', (v) => {
      expect(() => parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: v })).toThrow(/DEFAULT_COST_PERCENT/);
    });
    test('a bad value joins the other offending variables in one error', () => {
      let message = '';
      try {
        parseEnv({ DEFAULT_COST_PERCENT: 'abc', PORT: 'x' });
      } catch (err) {
        message = (err as Error).message;
      }
      for (const name of ['DATABASE_URL', 'PORT', 'DEFAULT_COST_PERCENT']) expect(message).toContain(name);
    });
  });
});

describe('todayEt', () => {
  test('formats pinned instants in America/New_York', () => {
    // 04:30Z is 23:30 EST the *previous* day — proves the impl is TZ-aware, not a UTC date slice
    expect(todayEt(new Date('2025-12-31T04:30:00Z'))).toBe('2025-12-30');
    expect(todayEt(new Date('2025-12-31T05:30:00Z'))).toBe('2025-12-31');
    expect(todayEt(new Date('2026-01-01T05:30:00Z'))).toBe('2026-01-01');
  });
  test('defaults to the current date', () => {
    expect(todayEt()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------- capture handlers ----------

type FakeRow = Record<string, unknown>;
interface FakeOpts {
  runs?: RunRow[];
}

function makeCaptureFakes(opts: FakeOpts = {}) {
  const runs = opts.runs ?? [];
  const pending: PendingRow[] = [];
  const fills: FillRow[] = [];
  const ledger: LedgerRow[] = [];
  const notifications: NewNotification[] = [];
  const captures: Array<NewCapture & { id: number }> = [];
  let pendingId = 1;
  let fillId = 1;

  const bucketState = new Map<number, ReturnType<typeof emptyState>>();
  const stateFor = (runId: number) => {
    let s = bucketState.get(runId);
    if (!s) {
      s = emptyState(2);
      s.cashCents = 1_000_000;
      bucketState.set(runId, s);
    }
    return s;
  };

  const runRepo = {
    list: async () => runs,
    get: async (id: number) => runs.find((r) => r.id === id) ?? null,
    create: async (_input: NewRun) => 1,
    updateStatus: async (_id: number, _status: RunStatus) => {},
  };
  const bucketRepo = {
    loadState: async (runId: number) => stateFor(runId),
    saveState: async (runId: number, state: ReturnType<typeof emptyState>) => {
      bucketState.set(runId, state);
    },
  };
  const orderRepo = {
    insertMany: async (_orders: NewOrder[]) => {},
    get: async (_id: number) => null as OrderRecord | null,
    listForDate: async (_date: string) => [] as OrderRecord[],
    listForRun: async (_runId: number, _date?: string) => [] as OrderRecord[],
    listForRunFrom: async (_runId: number, _fromDate: string) => [] as OrderRecord[],
    markStale: async (_date: string) => 0,
    setStatus: async (_id: number, _status: OrderStatus, _cancelReason?: string) => {},
    listUnreportedStale: async (_runId: number) => [] as OrderRecord[],
    markReported: async (_ids: number[]) => {},
  };
  const fillRepo = {
    insert: async (row: NewFill) => {
      fills.push({ ...row, id: fillId++ });
    },
    listForRun: async (runId: number) => fills.filter((x) => x.runId === runId),
  };
  const pendingRepo = {
    insert: async (row: NewPending) => {
      pending.push({ ...row, id: pendingId, status: 'pending', createdAt: '' });
      return pendingId++;
    },
    get: async (id: number) => pending.find((p) => p.id === id) ?? null,
    listPending: async () => pending.filter((p) => p.status === 'pending'),
    hasLiveForCapture: async (captureId: number) => pending.some((p) => p.captureId === captureId && p.status === 'pending'),
    hasConfirmedForCapture: async (captureId: number) => pending.some((p) => p.captureId === captureId && p.status === 'confirmed'),
    decide: async (id: number, status: 'confirmed' | 'rejected', edited?: PendingDecisionPatch): Promise<boolean> => {
      const p = pending.find((x) => x.id === id);
      if (!p || p.status !== 'pending') return false;
      p.status = status;
      if (edited) Object.assign(p, edited);
      return true;
    },
  };
  const captureRepo = {
    findByHash: async (runId: number, imageHash: string) => {
      const c = captures.find((x) => x.runId === runId && x.imageHash === imageHash);
      return c ? { id: c.id, status: c.status } : null;
    },
    setStatus: async (id: number, status: 'parsed' | 'unparseable') => {
      const c = captures.find((x) => x.id === id);
      if (c) c.status = status;
    },
    insert: async (c: NewCapture) => {
      if (captures.some((x) => x.runId === c.runId && x.imageHash === c.imageHash)) return { inserted: false as const };
      captures.push({ ...c, id: captures.length + 1 });
      return { inserted: true as const, id: captures.length };
    },
  };
  const ledgerRepo = {
    insert: async (row: NewLedgerEntry) => {
      ledger.push({ ...row, id: ledger.length + 1, ts: '' });
    },
    listForRun: async (_runId: number) => ledger,
  };
  const notificationRepo = {
    insert: async (row: NewNotification) => {
      notifications.push({ ...row });
    },
  };
  const correctionFake = fakeCorrectionRepo();
  // Ingest stores the screenshot and a resolution archives it; these tests do not inspect either.
  const captureImageRepo = { async insertIgnore(_row: CaptureImageInsert) { return true }, async getBytes(_captureId: number) { return null }, async isKept(_captureId: number) { return false }, async setKeep(_captureId: number) {}, async deleteFor(_captureId: number) {}, async discard(_captureId: number) {}, async listKept(_limit: number) { return [] } };
  const visionReviewRepo = { async insertIgnore(_row: VisionReviewInsert) {}, async listForCaptures(_captureIds: number[]) { return [] }, async deleteFor(_captureId: number) {} };
  const repos = { runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: correctionFake.repo, captureRepo, captureImageRepo, visionReviewRepo, ledgerRepo, notificationRepo } satisfies CaptureRepos;
  return { repos, pending, fills, ledger, notifications, captures, corrections: correctionFake.store, stateFor };
}

const visionFetch = (async (url: string) => {
  const content = JSON.stringify({ fills: [{ side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-10' }] });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
}) as unknown as typeof fetch;

function activeRun(id: number, ticker: string): RunRow {
  return { id, ticker, status: 'active', poolCents: 10_000_000, costPpm: 10, strategyKey: 'mean-reversion', name: '', buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, stateJson: '', createdAt: '' };
}

type _wire = Expect<IsNever<ArityMismatches<ReturnType<typeof makeCaptureFakes>['repos'], CaptureRepos>>>;

function makeCapture(opts: FakeOpts & { today?: string; fetchImpl?: typeof fetch; lang?: Lang; allowedChatIds?: string[] } = {}) {
  const fakes = makeCaptureFakes(opts);
  const sent: { chatId: string; text: string; extra?: Record<string, unknown> }[] = [];
  const handlers = makeCaptureHandlers({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', model: 'vision-model' },
    getVisionApiKey: async () => 'test-vision-key',
    today: () => opts.today ?? '2026-11-10',
    lang: opts.lang,
    allowedChatIds: opts.allowedChatIds ?? [],
    fetchImpl: opts.fetchImpl ?? visionFetch,
    send: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
    },
  });
  return { ...fakes, sent, handlers };
}

// one screenshot, two different tickers in it (multi-position brokerage view)
const multiVisionFetch = (async () => {
  const content = JSON.stringify({
    fills: [
      { side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-10' },
      { side: 'buy', ticker: 'AAPL', shares: 5, price: '210.25', date: '2026-11-10' },
    ],
  });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
}) as unknown as typeof fetch;

const NOTICE_EN = 'ℹ️ Fills from this image were already confirmed earlier — the rows below may be duplicates. Check before confirming.';

const DATE_NOTICE_EN =
  '⚠️ No usable trade date was read from the screenshot, so the capture date 2026-11-10 was used. Check the date and confirm this fill in the web app\'s Pending view.';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

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
    expect(h.sent.at(-1)!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 0');
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
      vision: { baseUrl: 'https://vision.example/v1', model: 'vision-model' },
      getVisionApiKey: async () => 'test-vision-key',
      today: () => '2026-11-10',
      allowedChatIds: [],
      fetchImpl: (async () => ({ ok: false, status: 500, text: async () => 'boom' }) as unknown as Response) as unknown as typeof fetch,
      send: async (chatId, text) => void sent.push({ chatId, text }),
    });
    await handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(fakes.pending.length).toBe(0);
    expect(fakes.captures.length).toBe(0);
    expect(sent).toEqual([
      { chatId: '777', text: 'Could not read fills from this image — http 500. Book the fill manually in the web UI.' },
    ]);
    expect(fakes.notifications.length).toBe(1);
    expect(fakes.notifications[0]).toMatchObject({ runId: null, chatId: '777' });
    expect(String(fakes.notifications[0]!.text)).toContain('Could not read fills from this image — http 500');
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

describe('capture onConfirm — reply target', () => {
  test('the confirm reply goes to the chat the button was pressed in', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    await h.handlers.onConfirm('888', `yes:${p.id}`, true);
    expect(h.sent.at(-1)).toEqual({ chatId: '888', text: 'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 0', extra: undefined });

    const r = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await r.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    await r.handlers.onConfirm('888', `no:${r.pending[0]!.id}`, false);
    expect(r.sent.at(-1)).toEqual({ chatId: '888', text: 'Rejected — fill discarded.', extra: undefined });
  });

  test('a button pressed with no photo since start replies in its own chat', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    const id = await h.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'buy', ticker: 'NVDA', shares: 10, price: parseUsd('180.50'), fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT });
    await h.handlers.onConfirm('999', `yes:${id}`, true);
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent.every((s) => s.chatId === '999')).toBe(true);
  });

  test('callback data that is not a canonical id books nothing and answers nothing', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    const sentBefore = h.sent.length;
    await h.handlers.onConfirm('777', 'yes:007', true);
    await h.handlers.onConfirm('777', `yes:00${p.id}`, true);
    await h.handlers.onConfirm('777', `yes:0x${Number(p.id).toString(16)}`, true);
    await h.handlers.onConfirm('777', `no:00${p.id}`, false);
    await h.handlers.onConfirm('777', `yes:${p.id}\n`, true);
    await h.handlers.onConfirm('777', `no:${p.id}`, true);
    expect(h.sent.length).toBe(sentBefore);
    expect(h.pending[0]!.status).toBe('pending');
  });

  test('a yes button whose handler says reject books nothing and answers nothing', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    const sentBefore = h.sent.length;
    await h.handlers.onConfirm('777', `yes:${p.id}`, false);
    expect(h.sent.length).toBe(sentBefore);
    expect(h.fills.length).toBe(0);
    expect(p.status).toBe('pending');
  });

  test('a reject whose bookkeeping throws replies with the worded error in the pressing chat', async () => {
    for (const lang of ['en', 'ko'] as const) {
      const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
      await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
      const id = h.pending[0]!.id;
      h.repos.pendingRepo.decide = async () => {
        throw new Error('boom');
      };
      const sentBefore = h.sent.length;
      await h.handlers.onConfirm('888', `no:${id}`, false);
      expect(h.sent.slice(sentBefore)).toEqual([{ chatId: '888', text: t('confirm-err-unknown', lang, { code: 'boom' }), extra: undefined }]);
    }
  });

  test('pressing a button on an already-handled row says already handled', async () => {
    const sequences: [boolean, boolean][] = [[true, true], [true, false], [false, false], [false, true]];
    for (const lang of ['en', 'ko'] as const) {
      const expected = t('confirm-err-already-handled', lang);
      for (const [first, second] of sequences) {
        const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
        await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
        const id = h.pending[0]!.id;
        await h.handlers.onConfirm('777', `${first ? 'yes' : 'no'}:${id}`, first);
        await h.handlers.onConfirm('888', `${second ? 'yes' : 'no'}:${id}`, second);
        expect(h.sent.at(-1)).toMatchObject({ chatId: '888', text: expected });
      }
      const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
      await h.handlers.onConfirm('777', 'no:4242', false);
      expect(h.sent).toEqual([{ chatId: '777', text: expected, extra: undefined }]);
    }
    expect(t('confirm-err-already-handled', 'en')).toBe('Already handled — this fill was already confirmed or rejected.');
    expect(t('confirm-err-already-handled', 'ko')).toBe('이미 처리되었습니다 — 이 체결은 이미 확정되었거나 거부되었습니다.');
  });
});

describe('capture onConfirm — human-readable errors (#7)', () => {
  async function capturedPending(lang: 'en' | 'ko') {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    return { h, p: h.pending[0]! };
  }

  test('ticker-mismatch (Error code) is rendered from the en catalog', async () => {
    const { h, p } = await capturedPending('en');
    p.ticker = 'AAPL';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('Ticker does not match the run — tap No to reject this fill, then re-capture.');
    expect(h.fills.length).toBe(0);
  });

  test('ticker-mismatch is rendered from the ko catalog', async () => {
    const { h, p } = await capturedPending('ko');
    p.ticker = 'AAPL';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('티커가 런과 일치하지 않습니다 — \'No\'를 눌러 이 체결을 거부하고 다시 캡처하세요.');
  });

  test('confirming an already-handled row says so in en and ko', async () => {
    for (const [lang, text] of [
      ['en', 'Already handled — this fill was already confirmed or rejected.'],
      ['ko', '이미 처리되었습니다 — 이 체결은 이미 확정되었거나 거부되었습니다.'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
    }
  });

  test('DomainError kind (empty message) is mapped, not sent blank', async () => {
    const { h, p } = await capturedPending('en');
    p.side = 'sell';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('No held bucket can cover this sell — check the share count.');
  });

  test('DomainError kind is rendered in ko', async () => {
    const { h, p } = await capturedPending('ko');
    p.side = 'sell';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('이 매도를 처리할 수 있는 보유 버킷이 없습니다 — 수량을 확인하세요.');
  });

  test('bucket-not-held is rendered from the catalog in en and ko', async () => {
    for (const [lang, text] of [
      ['en', 'The matched bucket is not currently held — check the side and the share count.'],
      ['ko', '매칭된 버킷이 현재 보유 중이 아닙니다 — 매매 구분과 수량을 확인하세요.'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      p.side = 'sell';
      // an exact-price target on a bucket nothing is held in: the sell match is loud, not silent
      const orders: OrderRecord[] = [
        { id: 1, runId: 1, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('180.50'), shares: 10, status: 'open', skipReason: null, cancelReason: null, reportedAt: null },
      ];
      h.repos.orderRepo.listForRun = async () => orders;
      h.repos.orderRepo.listForRunFrom = async () => orders;
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
      expect(h.fills.length).toBe(0);
    }
  });

  test('a thrown bucket-not-found renders the worded copy in en and ko, not the unknown fallback', async () => {
    for (const [lang, text] of [
      ['en', 'That bucket no longer exists on this run; book it from the web Pending view.'],
      ['ko', '이 런에 해당 버킷이 더 이상 없습니다. 웹의 대기 목록에서 처리하세요.'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      h.repos.runRepo.get = async () => {
        throw new Error('bucket-not-found');
      };
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
      expect(h.sent.at(-1)!.text).not.toBe(t('confirm-err-unknown', lang, { code: 'bucket-not-found' }));
    }
  });

  test('unknown error falls back to a catalog line carrying the raw code', async () => {
    for (const [lang, text] of [
      ['en', 'Could not confirm this fill (boom).'],
      ['ko', '이 체결을 확정할 수 없습니다 (boom).'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      h.repos.runRepo.get = async () => {
        throw new Error('boom');
      };
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
    }
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

describe('capture status and orders', () => {
  test('onStatus renders the run progress view', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onStatus('777');
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toMatch(/Run #1 NVDA/);
    expect(h.sent[0]!.text).toContain('Cash: $10000.00');
    expect(h.sent[0]!.text).toContain('Bucket 0');
  });

  test('onStatus explains when there are no runs', async () => {
    const h = makeCapture({ runs: [] });
    await h.handlers.onStatus('777');
    expect(h.sent[0]!.text).toBe('No runs yet — start one from the web app.');
  });

  test('minor-2: onStatus omits non-active (archived) runs', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), { ...activeRun(2, 'AAPL'), status: 'closed' }] });
    await h.handlers.onStatus('777');
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toContain('Run #1 NVDA');
    expect(h.sent[0]!.text).not.toContain('Run #2');
  });

  test('onOrders lists orders due today and says so when empty', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), { ...activeRun(2, 'AAPL'), status: 'closed' }] });
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('No orders due on 2026-11-10.');

    const base = { bucketIdx: 0, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null } as const;
    const orders: OrderRecord[] = [
      { ...base, id: 1, runId: 1, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10 },
      { ...base, id: 2, runId: 2, kind: 'sell_loc', limitPrice: parseUsd('200.00'), shares: 5 },
      { ...base, id: 3, runId: 9, kind: 'buy_loc', limitPrice: parseUsd('50.00'), shares: 1 },
    ];
    h.repos.orderRepo.listForDate = async () => orders;
    await h.handlers.onOrders('777');
    expect(h.sent[1]!.text).toBe(
      'Run #1 NVDA\n#1 buy_loc 10 sh @ $170.00\n\nRun #2 AAPL\n#2 sell_loc 5 sh @ $200.00\n\nrun #9\n#3 buy_loc 1 sh @ $50.00',
    );
  });

  test('onOrders tells two runs on the same ticker apart, ordered by run id', async () => {
    const h = makeCapture({ runs: [activeRun(3, 'NVDA'), activeRun(1, 'NVDA')] });
    const base = { bucketIdx: 0, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null } as const;
    const orders: OrderRecord[] = [
      { ...base, id: 1, runId: 3, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10 },
      { ...base, id: 2, runId: 1, kind: 'sell_loc', limitPrice: parseUsd('200.00'), shares: 5 },
      { ...base, id: 3, runId: 3, kind: 'sell_loc', limitPrice: parseUsd('190.00'), shares: 10 },
    ];
    h.repos.orderRepo.listForDate = async () => orders;
    await h.handlers.onOrders('777');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe(
      'Run #1 NVDA\n#2 sell_loc 5 sh @ $200.00\n\nRun #3 NVDA\n#1 buy_loc 10 sh @ $170.00\n#3 sell_loc 10 sh @ $190.00',
    );
  });

  test('onOrders renders the run header in Korean', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang: 'ko' });
    const order: OrderRecord = { id: 1, runId: 1, bucketIdx: 0, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null };
    h.repos.orderRepo.listForDate = async () => [order];
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('런 #1 NVDA\n#1 buy_loc 10주 @ $170.00');
  });

  test('onOrders names a missing run in Korean', async () => {
    const h = makeCapture({ runs: [], lang: 'ko' });
    const order: OrderRecord = { id: 3, runId: 9, bucketIdx: 0, kind: 'buy_loc', limitPrice: parseUsd('50.00'), shares: 1, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null };
    h.repos.orderRepo.listForDate = async () => [order];
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('런 #9\n#3 buy_loc 1주 @ $50.00');
  });
});

describe('capture confirm — sibling leg cancelled by a bucket-emptying sell', () => {
  async function setupSell(opts: { allowedChatIds?: string[]; send?: (chatId: string, text: string) => Promise<void> } = {}) {
    const fakes = makeCaptureFakes({ runs: [activeRun(1, 'NVDA')] });
    await fakes.repos.bucketRepo.saveState(1, applyBuyFill(fakes.stateFor(1), 0, 10, parseUsd('100.00'), 0, '2026-11-02'));
    const orders: FakeRow[] = [
      { id: 1, runId: 1, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('103.00'), shares: 10, status: 'open' },
      { id: 2, runId: 1, tradeDate: '2026-11-10', kind: 'stop_sell', bucketIdx: 0, limitPrice: parseUsd('97.00'), shares: 10, status: 'open' },
    ];
    Object.assign(fakes.repos.orderRepo, {
      listForDate: async () => orders,
      listForRun: async () => orders,
      listForRunFrom: async () => orders,
      get: async (id: number) => orders.find((o) => o.id === id) ?? null,
      setStatus: async (id: number, status: string, reason?: string) => {
        const o = orders.find((x) => x.id === id)!;
        o.status = status;
        if (reason !== undefined) o.cancelReason = reason;
      },
    });
    const pid = await fakes.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'sell', ticker: 'NVDA', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT });
    const sent: { chatId: string; text: string }[] = [];
    const handlers = makeCaptureHandlers({
      repos: fakes.repos,
      vision: { baseUrl: 'https://vision.example/v1', model: 'vision-model' },
      getVisionApiKey: async () => 'k',
      today: () => '2026-11-10',
      allowedChatIds: opts.allowedChatIds ?? ['111', '222'],
      send: opts.send ?? (async (chatId, text) => void sent.push({ chatId, text })),
    });
    return { fakes, orders, pid, sent, handlers };
  }

  test('confirming the sell tells every allowed chat to pull the cancelled leg and records the notifications', async () => {
    const { fakes, orders, pid, sent, handlers } = await setupSell();
    await handlers.onConfirm('111', `yes:${pid}`, true);
    const text = '⚠️ Run #1 NVDA: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.';
    expect(sent.filter((s) => s.text === text).map((s) => s.chatId)).toEqual(['111', '222']);
    expect(fakes.notifications).toEqual([
      { runId: 1, chatId: '111', text },
      { runId: 1, chatId: '222', text },
    ]);
    expect(orders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' });
    expect(orders[1]!.status).toBe('filled');
  });

  test('with no allowed chats the Telegram confirm records the notice for the web', async () => {
    const { fakes, pid, sent, handlers } = await setupSell({ allowedChatIds: [] });
    await handlers.onConfirm('111', `yes:${pid}`, true);
    const text = '⚠️ Run #1 NVDA: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.';
    expect(fakes.notifications).toEqual([{ runId: 1, chatId: 'web', text }]);
    expect(sent.some((s) => s.text === text)).toBe(false);
  });

  test('a Telegram outage on the notice never fails the confirm', async () => {
    const sent: { chatId: string; text: string }[] = [];
    const { fakes, orders, pid, handlers } = await setupSell({
      send: async (chatId, text) => {
        if (text.startsWith('⚠️ Run #1 NVDA: cancel')) throw new Error('telegram-down');
        sent.push({ chatId, text });
      },
    });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handlers.onConfirm('111', `yes:${pid}`, true);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.chatId).toBe('111');
      expect(sent[0]!.text).toStartWith('Booked NVDA sell 10 sh');
      expect(fakes.fills).toHaveLength(1);
      expect(fakes.ledger).toHaveLength(1);
      expect(orders[0]!.status).toBe('cancelled');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
