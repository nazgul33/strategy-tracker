import { formatUsd } from '@st/core';
import { extractFills } from '@st/ingest';
import { buildPendingKeyboard } from '@st/telegram';
import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';

import { confirmPendingFill, ingestCapture } from '../domain/booking';
import type { RepoSurface } from '../domain/booking';

type PendingRow = { id: number; side: string; ticker: string; shares: number; price: bigint | string; bucketIdx: number | null; status: string };

export interface CaptureRepos extends RepoSurface {
  pendingRepo: RepoSurface['pendingRepo'] & { get(id: number): Promise<PendingRow | null> };
}

export interface CaptureDeps {
  repos: CaptureRepos;
  vision: { baseUrl: string; model: string };
  getVisionApiKey(): Promise<string>;
  today(): string;
  lang?: Lang;
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

    let runId: number | null = null;
    const m = /(\d+)/.exec(caption ?? '');
    if (m) {
      const id = Number(m[1]);
      const run = await deps.repos.runRepo.get(id);
      if (!run) {
        await deps.send(chatId, t('unknown-run', lang, { id }));
        return;
      }
      runId = run.id;
    }

    const extract = await extractOrTell(chatId, image);
    if (!extract) return;

    if (runId === null) {
      const ticker = extract.fills[0]?.ticker;
      if (!ticker) {
        await deps.send(chatId, t('capture-bad-extract', lang, { detail: 'no fills recognized' }));
        return;
      }
      const active = (await deps.repos.runRepo.list()).filter((r: { status: string }) => r.status === 'active');
      const matches = active.filter((r: { ticker: string }) => r.ticker === ticker);
      if (matches.length === 0) {
        await deps.send(chatId, t('capture-no-run', lang, { ticker }));
        return;
      }
      if (matches.length > 1) {
        await deps.send(chatId, t('capture-ambiguous', lang, { ticker }));
        return;
      }
      runId = matches[0]!.id;
    }

    if (runId === null) return; // DB rows always carry an id

    const outcome = await ingestCapture(runId, image, extract, { repos: deps.repos, today: deps.today() });
    if (outcome === 'duplicate') {
      await deps.send(chatId, t('duplicate-capture', lang));
      return;
    }
    if (outcome === 'rejected') {
      await deps.send(chatId, t('capture-bad-extract', lang, { detail: 'no fills recognized' }));
      return;
    }
    for (const pending of outcome.pending) {
      const text = t('capture-booked', lang, {
        ticker: pending.ticker,
        side: pending.side,
        shares: pending.shares,
        price: pending.price,
      });
      await deps.send(chatId, text, { reply_markup: buildPendingKeyboard(String(pending.id)) });
    }
  }

  async function onConfirm(cbData: string, approved: boolean): Promise<void> {
    const chatId = lastChatId;
    const m = /^(yes|no):(\d+)$/.exec(cbData);
    if (!m) return;
    const id = Number(m[2]);
    if (approved) {
      try {
        await confirmPendingFill(id, null, { repos: deps.repos, today: deps.today() });
      } catch (e) {
        await deps.send(chatId, (e as Error).message);
        return;
      }
      const row = await deps.repos.pendingRepo.get(id);
      if (!row) return;
      const price = typeof row.price === 'string' ? row.price : formatUsd(row.price);
      await deps.send(
        chatId,
        t('booked', lang, { ticker: row.ticker, side: row.side, shares: row.shares, price, bucket: row.bucketIdx ?? 0 }),
      );
    } else {
      const row = await deps.repos.pendingRepo.get(id);
      if (!row || row.status !== 'pending') {
        await deps.send(chatId, t('duplicate-capture', lang));
        return;
      }
      await deps.repos.pendingRepo.decide(id, 'rejected');
      await deps.send(chatId, t('rejected-line', lang));
    }
  }

  async function onStatus(chatId: string): Promise<void> {
    const runs = await deps.repos.runRepo.list();
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
        `#${o.id} ${o.kind} ${o.ticker} ${o.shares} sh @ $${formatUsd(o.limitPrice)}`,
    );
    await deps.send(chatId, lines.join('\n'));
  }

  return { onPhoto, onConfirm, onStatus, onOrders };
}
