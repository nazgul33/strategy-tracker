import { ApiError, NetworkError } from './api';
import type { CaptureConflictDto, CaptureEventDto, CaptureOutcomeDto, CapturePendingRowDto } from './api';
import { errorText, type Translate } from './errortext';

export const VISION_TIMEOUT_DETAIL = 'vision timed out'; // mirrors apps/server/src/wire/capture-route.ts

export type UploadLineTone = 'ok' | 'info' | 'warn' | 'error';
export interface UploadLine { tone: UploadLineTone; depth: 0 | 1 | 2; text: string; href?: string }
export type UploadState = 'waiting' | 'reading' | 'done' | 'failed';
export interface UploadItem { key: number; file: File; state: UploadState; events?: CaptureEventDto[]; error?: unknown }

type Outcome = Exclude<CaptureOutcomeDto, string>;

const line = (tone: UploadLineTone, depth: 0 | 1 | 2, text: string, href?: string): UploadLine =>
  href === undefined ? { tone, depth, text } : { tone, depth, text, href };

const sideText = (side: 'buy' | 'sell', t: Translate) => t(side === 'buy' ? 'orderSideBuy' : 'orderSideSell');

const badExtract = (detail: string, t: Translate): UploadLine =>
  detail === VISION_TIMEOUT_DETAIL ? line('error', 0, t('upload.visionTimeout')) : line('error', 0, t('upload.badExtract', { detail }));

function conflictLine(c: CaptureConflictDto, t: Translate): UploadLine {
  const common = { side: sideText(c.side, t), shares: c.shares, ticker: c.ticker, date: c.filledOn, extracted: c.extractedPrice };
  if (c.matchedKind === 'pending') return line('warn', 0, t('upload.conflictPending', { ...common, id: c.pendingId, dupPrice: c.pendingPrice }));
  const params = { ...common, id: c.bookedId, dupPrice: c.bookedPrice };
  if (c.correction?.status === 'fill-gone') return line('warn', 0, t('upload.conflictGone', params));
  if (c.correction?.status === 'dismissed') return line('info', 0, t('upload.conflictDismissed', params));
  return line('warn', 0, t('upload.conflict', params));
}

function rowLines(r: CapturePendingRowDto, t: Translate): UploadLine[] {
  const lines = [line('ok', 1, t('upload.fillLine', { side: sideText(r.side, t), shares: r.shares, price: r.price, date: r.filledOn }))];
  if (r.detectedFilledOn === null) lines.push(line('warn', 2, t('upload.dateSubstituted', { date: r.filledOn })));
  if (r.dateAfterToday) lines.push(line('warn', 2, t('upload.dateAfterToday', { date: r.filledOn })));
  if (r.needsBucket) lines.push(line('warn', 2, t('upload.needsBucket')));
  return lines;
}

// Same order as the bot's capture reply: conflicts, booked-earlier warning, then the pending rows.
function outcomeLines(runId: number, ticker: string, o: Outcome, t: Translate): UploadLine[] {
  const pending = o.pending ?? [];
  const conflicts = o.conflicts ?? [];
  const lines: UploadLine[] = [];
  if (pending.length > 0 && conflicts.length > 0) lines.push(line('warn', 0, t('upload.conflictsHead')));
  for (const c of conflicts) lines.push(conflictLine(c, t));
  if (o.bookedEarlier && pending.length > 0) lines.push(line('warn', 0, t('upload.bookedEarlier')));
  if (pending.length > 0) {
    lines.push(line('ok', 0, t('upload.pendingHead', { ticker, id: runId, count: pending.length }), `#/runs/${runId}`));
    for (const r of pending) lines.push(...rowLines(r, t));
  }
  return lines;
}

export function captureEventLines(event: CaptureEventDto, t: Translate): UploadLine[] {
  switch (event.type) {
    case 'outcome':
      if (event.outcome === 'duplicate') return [line('info', 0, t('upload.duplicate'))];
      if (event.outcome === 'rejected') return [badExtract('no fills recognized', t)];
      return outcomeLines(event.runId, event.ticker, event.outcome, t);
    case 'bad-extract':
      return [badExtract(event.detail, t)];
    case 'no-run':
      return [line('info', 0, t('upload.noRun', { ticker: event.ticker }))];
    case 'ambiguous':
      return [line('info', 0, t('upload.ambiguous', { ticker: event.ticker }))];
    case 'pin-nomatch':
      return [line('info', 0, t('upload.pinNomatch', { ticker: event.ticker, id: event.runId }))];
    case 'pin-skipped':
      return [line('info', 0, t('upload.pinSkipped', { tickers: event.tickers.join(', '), id: event.runId }))];
  }
}

export function uploadErrorLines(err: unknown, t: Translate): UploadLine[] {
  if (err instanceof NetworkError) return [line('error', 0, t('upload.networkLost'))];
  if (err instanceof ApiError && err.code === 'vision-not-configured') return [line('error', 0, errorText(err, t, 'captureErr'), '#/settings')];
  return [line('error', 0, errorText(err, t, 'captureErr'))];
}

export function uploadItemLines(item: Pick<UploadItem, 'events' | 'error'>, t: Translate): UploadLine[] {
  if (item.error !== undefined) return uploadErrorLines(item.error, t);
  return (item.events ?? []).flatMap((e) => captureEventLines(e, t));
}

/** "Go to pending" is the primary action when Pending now holds something this upload put there. */
export function wantsPending(items: Pick<UploadItem, 'events'>[]): boolean {
  return items.some((item) =>
    (item.events ?? []).some((e) => {
      if (e.type !== 'outcome' || typeof e.outcome === 'string') return false;
      if ((e.outcome.pending ?? []).length > 0) return true;
      return (e.outcome.conflicts ?? []).some((c) => c.matchedKind === 'booked' && c.correction?.status === 'open');
    }),
  );
}
