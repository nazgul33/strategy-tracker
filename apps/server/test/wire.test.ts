import { describe, expect, test } from 'bun:test';
import { emptyState, parseUsd } from '@st/core';
import { buildPendingKeyboard } from '@st/telegram';
import type { FillRow, LedgerRow } from '../src/db/schema';
import { makeCaptureHandlers } from '../src/wire/capture';
import { parseEnv, todayEt } from '../src/wire/deps';

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
  runs?: FakeRow[];
}

function makeCaptureFakes(opts: FakeOpts = {}) {
  const runs = opts.runs ?? [];
  const pending: FakeRow[] = [];
  const fills: FillRow[] = [];
  const ledger: LedgerRow[] = [];
  const notifications: FakeRow[] = [];
  const captures: { id: number; runId: number; imageHash: string; status: string }[] = [];
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
    create: async () => 1,
    updateStatus: async () => {},
  };
  const bucketRepo = {
    loadState: async (runId: number) => stateFor(runId),
    saveState: async (runId: number, state: ReturnType<typeof emptyState>) => {
      bucketState.set(runId, state);
    },
  };
  const orderRepo = {
    insertMany: async () => {},
    listForDate: async (_date: string) => [] as FakeRow[],
    markStale: async () => [],
    setStatus: async () => {},
    listOpenBefore: async () => [],
  };
  const fillRepo = {
    insert: async (row: Omit<FillRow, 'id'>) => {
      fills.push({ ...(row as FillRow), id: fillId++ });
      return fillId - 1;
    },
    listForRun: async () => fills,
  };
  const pendingRepo = {
    insert: async (row: FakeRow) => {
      pending.push({ ...row, id: pendingId, status: 'pending' });
      return pendingId++;
    },
    get: async (id: number) => pending.find((p) => p.id === id) ?? null,
    listPending: async () => pending.filter((p) => p.status === 'pending'),
    decide: async (id: number, status: string, edited?: FakeRow) => {
      const p = pending.find((x) => x.id === id);
      if (!p || p.status !== 'pending') return;
      p.status = status;
      if (edited) Object.assign(p, edited);
    },
  };
  const captureRepo = {
    hasHash: async (runId: number, imageHash: string) => captures.some((c) => c.runId === runId && c.imageHash === imageHash),
    insert: async (c: { runId: number; chatId: string | null; imageHash: string; status: string }) => {
      if (captures.some((x) => x.runId === c.runId && x.imageHash === c.imageHash)) return { inserted: false as const };
      captures.push({ id: captures.length + 1, runId: c.runId, imageHash: c.imageHash, status: c.status });
      return { inserted: true as const, id: captures.length };
    },
  };
  const ledgerRepo = {
    insert: async (row: Omit<LedgerRow, 'id'>) => {
      ledger.push({ ...(row as LedgerRow), id: ledger.length + 1 });
      return ledger.length;
    },
    listForRun: async () => ledger,
  };
  const notificationRepo = {
    insert: async (row: FakeRow) => {
      notifications.push({ ...row });
      return notifications.length;
    },
  };
  const repos = { runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, captureRepo, ledgerRepo, notificationRepo };
  return { repos, pending, fills, ledger, notifications, captures, stateFor };
}

const visionFetch = (async (url: string) => {
  const content = JSON.stringify({ fills: [{ side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50' }] });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
}) as unknown as typeof fetch;

function activeRun(id: number, ticker: string): FakeRow {
  return { id, ticker, status: 'active', poolCents: 10_000_000, costPpm: 10 };
}

function makeCapture(opts: FakeOpts & { today?: string; fetchImpl?: typeof fetch } = {}) {
  const fakes = makeCaptureFakes(opts);
  const sent: { chatId: string; text: string; extra?: Record<string, unknown> }[] = [];
  const handlers = makeCaptureHandlers({
    repos: fakes.repos as never,
    vision: { baseUrl: 'https://vision.example/v1', model: 'vision-model' },
    getVisionApiKey: async () => 'test-vision-key',
    today: () => opts.today ?? '2026-11-10',
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
      { side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50' },
      { side: 'buy', ticker: 'AAPL', shares: 5, price: '210.25' },
    ],
  });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
}) as unknown as typeof fetch;

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
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 — confirm?');
    expect(h.sent[0]!.extra).toEqual({ reply_markup: buildPendingKeyboard(String(p.id)) });

    // confirm through the real confirmPendingFill: bucket 0, fill row, ledger row
    await h.handlers.onConfirm(`yes:${p.id}`, true);
    expect(p.status).toBe('confirmed');
    expect(p.bucketIdx).toBe(0);
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]).toMatchObject({ runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10, source: 'capture' });
    expect(h.fills[0]!.price).toBe(parseUsd('180.50'));
    expect(h.ledger.length).toBe(1);
    expect(h.ledger[0]!.kind).toBe('buy');
    expect(h.stateFor(1).buckets[0]!.state).toBe('held');
    expect(h.stateFor(1).buckets[0]!.shares).toBe(10);
    expect(h.sent.at(-1)!.text).toBe('Booked NVDA buy 10 sh @ $180.50 into bucket 0');
  });

  test('rejecting pending leaves no fill', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    await h.handlers.onConfirm(`no:${p.id}`, false);
    expect(p.status).toBe('rejected');
    expect(h.fills.length).toBe(0);
    expect(h.sent.at(-1)!.text).toBe('Rejected — fill discarded.');
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
    expect(h.sent[1]!.text).toBe('Duplicate capture — already booked.');
  });

  test('extract failure: no pending row, user sees the reason, admin notified', async () => {
    const fakes = makeCaptureFakes({ runs: [activeRun(1, 'NVDA')] });
    const sent: { chatId: string; text: string }[] = [];
    const handlers = makeCaptureHandlers({
      repos: fakes.repos as never,
      vision: { baseUrl: 'https://vision.example/v1', model: 'vision-model' },
      getVisionApiKey: async () => 'test-vision-key',
      today: () => '2026-11-10',
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
});

describe('capture onPhoto — caption routing', () => {
  test('numeric caption selects that run even when the ticker has no active run', async () => {
    const h = makeCapture({ runs: [{ ...activeRun(7, 'NVDA'), status: 'paused' }] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 7');
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(7);
    expect(h.pending.length).toBe(1);
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 — confirm?');
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
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 — confirm?');
  });

  test('I1: "/capture 3" pins run 3 even when its ticker differs and an active NVDA run exists', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), activeRun(3, 'AAPL')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 3');
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(3);
    expect(h.pending.length).toBe(1);
    expect(h.pending[0]!.runId).toBe(3);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 — confirm?');
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
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 — confirm?');
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
    expect(h.sent[0]!.text).toBe('Booked NVDA buy 10 sh @ $180.50 — confirm?');
    expect(h.sent[1]!.text).toBe('Booked AAPL buy 5 sh @ $210.25 — confirm?');
  });

  test('if any ticker has no active run, nothing is booked and the error names it', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: multiVisionFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(0);
    expect(h.pending.length).toBe(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe('No active run for AAPL — use /capture <runId> to pick one.');
  });

  test('if any ticker is ambiguous, nothing is booked and the error names it', async () => {
    const h = makeCapture({
      runs: [activeRun(1, 'NVDA'), activeRun(2, 'AAPL'), activeRun(3, 'AAPL')],
      fetchImpl: multiVisionFetch,
    });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.captures.length).toBe(0);
    expect(h.pending.length).toBe(0);
    expect(h.sent[0]!.text).toBe('Multiple active runs for AAPL — use /capture <runId>.');
  });

  test('a numeric caption still pins one run for the whole extract', async () => {
    const h = makeCapture({ runs: [activeRun(5, 'MSFT')], fetchImpl: multiVisionFetch });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }, '/capture 5');
    expect(h.captures.length).toBe(1);
    expect(h.captures[0]!.runId).toBe(5);
    expect(h.pending.length).toBe(2);
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
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), { ...activeRun(2, 'AAPL'), status: 'archived' }] });
    await h.handlers.onStatus('777');
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toContain('Run #1 NVDA');
    expect(h.sent[0]!.text).not.toContain('Run #2');
  });

  test('onOrders lists orders due today and says so when empty', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('No orders due on 2026-11-10.');

    h.repos.orderRepo.listForDate = async () => [
      { id: 1, runId: 1, bucketIdx: 0, kind: 'buy_loc', ticker: 'NVDA', side: 'buy', limitPrice: parseUsd('170.00'), shares: 10, tradeDate: '2026-11-10', status: 'open' },
    ];
    await h.handlers.onOrders('777');
    expect(h.sent[1]!.text).toContain('#1 buy_loc NVDA 10 sh @ $170.00');
  });
});
