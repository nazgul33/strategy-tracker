import { DomainError, formatUsd } from '@st/core';
import { extractFills } from '@st/ingest';
import { buildPendingKeyboard } from '@st/telegram';
import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';

import { confirmPendingFill, ingestCapture, rejectPendingFill } from '../domain/booking';
import type { CaptureConflict, CaptureOutcome, RepoSurface } from '../domain/booking';
import { makeBookingNotifier } from './booking-notifier';

type PendingRow = { id: number; side: string; ticker: string; shares: number; price: bigint | string; bucketIdx: number | null; filledOn: string; status: string };

const CONFIRM_ERROR_KEYS: Record<string, string> = {
  'ticker-mismatch': 'confirm-err-ticker-mismatch',
  'pending-not-pending': 'confirm-err-already-handled',
  'pending-not-found-or-not-pending': 'confirm-err-already-handled',
  'no-empty-bucket': 'confirm-err-no-empty-bucket',
  'no-bucket-for-sell': 'confirm-err-no-bucket-for-sell',
  'too-many-shares': 'confirm-err-too-many-shares',
  'invalid-shares': 'confirm-err-invalid-shares',
  'invalid-side': 'confirm-err-invalid-side',
  'invalid-fee': 'confirm-err-invalid-fee',
  'bucket-not-held': 'confirm-err-bucket-not-held',
};

export interface CaptureRepos extends RepoSurface {
  pendingRepo: RepoSurface['pendingRepo'] & { get(id: number): Promise<PendingRow | null> };
}

export interface CaptureDeps {
  repos: CaptureRepos;
  vision: { baseUrl: string; model: string };
  getVisionApiKey(): Promise<string>;
  today(): string;
  lang?: Lang;
  // chats told to pull a cancelled sibling leg at the broker; omitted or empty: nobody
  allowedChatIds?: string[];
  send(chatId: string, text: string, extra?: Record<string, unknown>): Promise<void>;
  fetchImpl?: typeof fetch;
}

export function makeCaptureHandlers(deps: CaptureDeps) {
  const lang: Lang = deps.lang ?? 'en';
  let lastChatId = '';

  async function extractOrTell(chatId: string, image: { base64: string; mime: string }) {
    const cfg = {
      baseUrl: deps.vision.baseUrl,
      apiKey: await deps.getVisionApiKey(),
      model: deps.vision.model,
      maxTokens: 1024,
      today: deps.today(),
    };
    const extract = await extractFills([image], cfg, deps.fetchImpl);
    if (!extract.ok) {
      const text = t('capture-bad-extract', lang, { detail: extract.detail });
      await deps.send(chatId, text);
      await deps.repos.notificationRepo.insert({ runId: null, chatId, text });
      return null;
    }
    return extract;
  }

  async function onPhoto(chatId: string, image: { base64: string; mime: string }, caption?: string): Promise<void> {
    lastChatId = chatId;

    let pinned: { id: number; ticker: string } | null = null;
    // the run id must be the caption's FIRST token: `7`, `#7` or `/capture 7`.
    // anything else (e.g. a "NVDA 12/25" note) falls through to ticker auto-route.
    const m = /^(?:\/capture\s+)?#?(\d+)(?:\s|$)/.exec(caption?.trim() ?? '');
    if (m) {
      const id = Number(m[1]);
      const run = await deps.repos.runRepo.get(id);
      if (!run) {
        await deps.send(chatId, t('unknown-run', lang, { id }));
        return;
      }
      pinned = { id: run.id, ticker: run.ticker };
    }

    const extract = await extractOrTell(chatId, image);
    if (!extract) return;

    if (pinned) {
      // pinned mode: book ONLY fills carrying the pinned run's own ticker — one run
      // has exactly one ticker — and tell the user what was ignored.
      const { id: pinId, ticker: pinTicker } = pinned;
      const own = extract.fills.filter((f: { ticker: string }) => f.ticker === pinTicker);
      const ignored = [...new Set(extract.fills.filter((f: { ticker: string }) => f.ticker !== pinTicker).map((f: { ticker: string }) => f.ticker))];
      if (own.length === 0) {
        await deps.send(chatId, t('capture-pin-nomatch', lang, { ticker: pinTicker, id: pinId }));
        return;
      }
      if (ignored.length > 0) {
        await deps.send(chatId, t('capture-pin-skipped', lang, { tickers: ignored.join(', '), id: pinId }));
      }
      const outcome = await ingestCapture(pinId, image, { ...extract, fills: own }, {
        repos: deps.repos,
        today: deps.today(),
      });
      await sendOutcome(chatId, outcome);
      return;
    }

    // auto-route: each ticker group resolves to exactly one active run; groups
    // without a unique run are skipped with a one-line notice, never abort the rest.
    const groups = new Map<string, typeof extract.fills>();
    for (const fill of extract.fills) {
      const g = groups.get(fill.ticker);
      if (g) g.push(fill);
      else groups.set(fill.ticker, [fill]);
    }
    if (groups.size === 0) {
      await deps.send(chatId, t('capture-bad-extract', lang, { detail: 'no fills recognized' }));
      return;
    }
    const active = (await deps.repos.runRepo.list()).filter((r: { status: string }) => r.status === 'active');
    for (const [ticker, fills] of groups) {
      const matches = active.filter((r: { ticker: string }) => r.ticker === ticker);
      if (matches.length === 0) {
        await deps.send(chatId, t('capture-no-run', lang, { ticker }));
        continue;
      }
      if (matches.length > 1) {
        await deps.send(chatId, t('capture-ambiguous', lang, { ticker }));
        continue;
      }
      const outcome = await ingestCapture(matches[0]!.id, image, { ...extract, fills }, {
        repos: deps.repos,
        today: deps.today(),
      });
      await sendOutcome(chatId, outcome);
    }
  }

  async function sendOutcome(chatId: string, outcome: CaptureOutcome): Promise<void> {
    if (outcome === 'duplicate') {
      await deps.send(chatId, t('duplicate-capture', lang));
      return;
    }
    if (outcome === 'rejected') {
      await deps.send(chatId, t('capture-bad-extract', lang, { detail: 'no fills recognized' }));
      return;
    }
    const pending = 'pending' in outcome ? outcome.pending : [];
    const conflicts = 'conflicts' in outcome ? outcome.conflicts : [];
    if (pending.length > 0 && conflicts.length > 0) {
      await deps.send(chatId, t('capture-conflicts-head', lang));
    }
    for (const c of conflicts) await deps.send(chatId, conflictLine(c));
    if (pending.length > 0 && 'bookedEarlier' in outcome && outcome.bookedEarlier) {
      await deps.send(chatId, t('capture-booked-earlier', lang));
    }
    for (const row of pending) {
      let text = t('capture-booked', lang, {
        ticker: row.ticker,
        side: row.side,
        shares: row.shares,
        price: row.price,
        date: row.filledOn,
      });
      if (row.detectedFilledOn === null) text += '\n' + t('capture-date-substituted', lang, { date: row.filledOn });
      await deps.send(chatId, text, { reply_markup: buildPendingKeyboard(String(row.id)) });
    }
  }

  function conflictLine(c: CaptureConflict): string {
    const base = { ticker: c.ticker, side: c.side, shares: c.shares, date: c.filledOn, extracted: c.extractedPrice };
    if (c.matchedKind === 'pending') {
      return t('capture-conflict-pending', lang, { ...base, id: c.pendingId, dupPrice: c.pendingPrice });
    }
    if (c.correction?.status === 'fill-gone') {
      return t('capture-conflict-gone', lang, { ...base, id: c.bookedId });
    }
    const key = c.correction?.status === 'dismissed' ? 'capture-conflict-dismissed' : 'capture-conflict';
    return t(key, lang, { ...base, id: c.bookedId, dupPrice: c.bookedPrice });
  }

  // confirmPendingFill throws plain Errors (code in message) and DomainErrors (code in kind, message empty).
  function confirmErrorText(e: unknown): string {
    const code = e instanceof DomainError ? e.kind : e instanceof Error ? e.message : String(e);
    if (Object.hasOwn(CONFIRM_ERROR_KEYS, code)) return t(CONFIRM_ERROR_KEYS[code]!, lang);
    return t('confirm-err-unknown', lang, { code: code || 'error' });
  }

  async function onConfirm(cbData: string, approved: boolean): Promise<void> {
    const chatId = lastChatId;
    const m = /^(yes|no):(\d+)$/.exec(cbData);
    if (!m) return;
    const id = Number(m[2]);
    if (approved) {
      try {
        await confirmPendingFill(id, null, {
          repos: deps.repos,
          today: deps.today(),
          notify: makeBookingNotifier({ repos: deps.repos, allowedChatIds: deps.allowedChatIds ?? [], send: deps.send, lang }),
        });
      } catch (e) {
        await deps.send(chatId, confirmErrorText(e));
        return;
      }
      const row = await deps.repos.pendingRepo.get(id);
      if (!row) return;
      const price = typeof row.price === 'string' ? row.price : formatUsd(row.price);
      await deps.send(
        chatId,
        t('booked', lang, { ticker: row.ticker, side: row.side, shares: row.shares, price, bucket: row.bucketIdx ?? 0, date: row.filledOn }),
      );
    } else {
      // No keep prompt over Telegram: the screenshot is not kept, but the reject
      // still freezes its record and sweeps the bytes when it was the last fill.
      const rejected = await rejectPendingFill(id, { repos: deps.repos }, { keepImage: false });
      if (!rejected) {
        await deps.send(chatId, t('duplicate-capture', lang));
        return;
      }
      await deps.send(chatId, t('rejected-line', lang));
    }
  }

  async function onStatus(chatId: string): Promise<void> {
    const runs = (await deps.repos.runRepo.list()).filter((r: { status: string }) => r.status === 'active');
    if (runs.length === 0) {
      await deps.send(chatId, t('no-runs', lang));
      return;
    }
    const blocks: string[] = [];
    for (const run of runs) {
      const st = await deps.repos.bucketRepo.loadState(run.id);
      const lines = [
        t('status-run-line', lang, { id: run.id, ticker: run.ticker }),
        t('status-cash', lang, { amount: formatUsd(BigInt(st.cashCents) * 100n) }),
      ];
      for (const b of st.buckets) {
        if (b.state === 'empty') {
          lines.push(t('bucket-idle', lang, { index: b.index }));
        } else if (b.state === 'force_sell') {
          lines.push(t('bucket-force-sell', lang, { index: b.index, shares: b.shares, price: formatUsd(b.buyPrice) }));
        } else {
          lines.push(t('bucket-held', lang, { index: b.index, shares: b.shares, price: formatUsd(b.buyPrice) }));
        }
      }
      blocks.push(lines.join('\n'));
    }
    await deps.send(chatId, blocks.join('\n\n'));
  }

  async function onOrders(chatId: string): Promise<void> {
    const date = deps.today();
    const orders = await deps.repos.orderRepo.listForDate(date);
    if (orders.length === 0) {
      await deps.send(chatId, t('no-orders', lang, { date }));
      return;
    }
    const lines = orders.map(
      (o: { id: number; kind: string; ticker: string; shares: number; limitPrice: bigint }) =>
        t('orders-line', lang, { id: o.id, kind: o.kind, ticker: o.ticker, shares: o.shares, price: formatUsd(o.limitPrice) }),
    );
    await deps.send(chatId, lines.join('\n'));
  }

  return { onPhoto, onConfirm, onStatus, onOrders };
}
