import { emptyState } from '@st/core';
import type { Lang } from '@st/telegram/i18n';
import type { FillRow, LedgerRow } from '../src/domain/booking';
import type { NewCapture, NewFill, NewLedgerEntry, NewNotification, NewOrder, NewPending, NewRun, OrderRecord, OrderStatus, PendingDecisionPatch, PendingRow, RunRow, RunStatus } from '../src/domain/repo-types';
import type { CaptureImageInsert } from '../src/db/repos-vision';
import type { VisionReviewInsert } from '../src/domain/vision-review';
import { makeCaptureHandlers, type CaptureRepos } from '../src/wire/capture';
import { fakeCorrectionRepo } from './fake-corrections';
import { makeVrFakes } from './vr-fakes';
import { makeChoiceFakes } from './capture-choice-fakes';
import type { Expect, IsNever, ArityMismatches } from './type-assert';

// ---------- capture handlers ----------

export type FakeRow = Record<string, unknown>;
export interface FakeOpts {
  runs?: RunRow[];
  now?: () => Date;
}

export function makeCaptureFakes(opts: FakeOpts = {}) {
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
  const vrFakes = makeVrFakes({ otherRuns: () => runs });
  const choiceFakes = makeChoiceFakes(opts.now);
  const repos = { ...vrFakes.repos, captureChoiceRepo: choiceFakes.captureChoiceRepo, runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: correctionFake.repo, captureRepo, captureImageRepo, visionReviewRepo, ledgerRepo, notificationRepo } satisfies CaptureRepos;
  const vr = { runs: vrFakes.runs, cycles: vrFakes.cycles, fills: vrFakes.fills, cash: vrFakes.cash, pending: vrFakes.pending };
  return { repos, vr, choices: choiceFakes.choices, pending, fills, ledger, notifications, captures, corrections: correctionFake.store, stateFor };
}

export const visionFetch = (async (url: string) => {
  const content = JSON.stringify({ fills: [{ side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-10' }] });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
}) as unknown as typeof fetch;

export function activeRun(id: number, ticker: string): RunRow {
  return { id, ticker, status: 'active', poolCents: 10_000_000, costPpm: 10, strategyKey: 'mean-reversion', name: '', buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, stateJson: '', createdAt: '' };
}

type _wire = Expect<IsNever<ArityMismatches<ReturnType<typeof makeCaptureFakes>['repos'], CaptureRepos>>>;

export function makeCapture(opts: FakeOpts & { today?: string; fetchImpl?: typeof fetch; lang?: Lang; allowedChatIds?: string[] } = {}) {
  const fakes = makeCaptureFakes(opts);
  const sent: { chatId: string; text: string; extra?: Record<string, unknown> }[] = [];
  const handlers = makeCaptureHandlers({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'env' },
    getVisionApiKey: async () => ({ key: 'test-vision-key', source: 'env' as const }),
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
export const multiVisionFetch = (async () => {
  const content = JSON.stringify({
    fills: [
      { side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-10' },
      { side: 'buy', ticker: 'AAPL', shares: 5, price: '210.25', date: '2026-11-10' },
    ],
  });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
}) as unknown as typeof fetch;

export const NOTICE_EN = 'ℹ️ Fills from this image were already confirmed earlier — the rows below may be duplicates. Check before confirming.';

export const DATE_NOTICE_EN =
  '⚠️ No usable trade date was read from the screenshot, so the capture date 2026-11-10 was used. Check the date and confirm this fill in the web app\'s Pending view.';

// A vision service that echoes the whole key in its 401 body (the leak the pipeline must stop),
// plus its own masked form, which has fewer than 8 real consecutive key characters.
export const LEAK_KEY = 'sk-LEAKCHECK-7f3a9c2e';

export const keyEchoFetch = (async () => ({
  ok: false,
  status: 401,
  text: async () => JSON.stringify({ error: { message: `Incorrect API key provided: ${LEAK_KEY}; masked sk-LEA*********9c2e` } }),
})) as unknown as typeof fetch;

/** Every 8-character run of LEAK_KEY found in text; [] when nothing of the key leaked. */
export function keyParts(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i + 8 <= LEAK_KEY.length; i++) {
    const part = LEAK_KEY.slice(i, i + 8);
    if (text.includes(part)) parts.push(part);
  }
  return parts;
}

export const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
