import type { RawFill } from '@st/ingest';
import { buildChoiceKeyboard } from '@st/telegram';
import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';

import { ingestCapture } from '../domain/booking';
import type { CaptureOutcome } from '../domain/booking';
import { CHOICE_TTL_MS } from '../domain/capture-choice';
import type { ChoiceAnswer } from '../domain/capture-choice';
import { ingestVrCapture } from '../domain/vr/capture';
import { parseId } from '../http/params';
import type { CaptureDeps, CaptureRepos } from './capture';
import type { CaptureEvent } from './capture-route';
import { vrCaptureMessage } from './vr-capture-message';

export interface ChoiceDeps {
  repos: CaptureRepos;
  lang: Lang;
  today(): string;
  now(): Date;
  send: CaptureDeps['send'];
  sendOutcome(chatId: string, outcome: CaptureOutcome): Promise<void>;
}

type Image = { base64: string; mime: string };
type ChooseEvent = Extract<CaptureEvent, { type: 'choose' }>;

const ANSWERS: Record<string, ChoiceAnswer> = { m: 'mr', v: 'vr', b: 'both' };

// A driver error can echo the SQL parameters, which here means the screenshot: log a short cut, never the object.
const brief = (e: unknown): string => String(e).slice(0, 300);

export function makeChoiceHandlers(deps: ChoiceDeps) {
  const { repos, lang } = deps;

  const deleteExpired = () => repos.captureChoiceRepo.deleteOlderThan(new Date(deps.now().getTime() - CHOICE_TTL_MS));

  // A reply about a failure must never be the thing that stops the work behind it.
  async function safeSend(chatId: string, text: string): Promise<void> {
    try {
      await deps.send(chatId, text);
    } catch (e) {
      console.error('[capture] reply to the owner failed:', brief(e));
    }
  }

  async function ask(chatId: string, image: Image, event: ChooseEvent): Promise<void> {
    try {
      await deleteExpired();
    } catch (e) {
      console.error('[capture] expired question sweep failed:', brief(e));
    }
    let id: number;
    try {
      id = await repos.captureChoiceRepo.park({
        chatId, ticker: event.ticker, mrRunId: event.mrRunId, vrRunId: event.vrRunId, fills: event.fills, image, readOn: deps.today(),
      });
    } catch (e) {
      console.error('[capture] parking the strategy question failed:', { ticker: event.ticker }, brief(e));
      await safeSend(chatId, t('capture-choice-park-failed', lang, { ticker: event.ticker }));
      return;
    }
    const labels = { mr: t('capture-choice-mr', lang), vr: t('capture-choice-vr', lang), both: t('capture-choice-both', lang) };
    await deps.send(chatId, t('capture-choice-question', lang, { ticker: event.ticker, n: event.fills.length }), {
      reply_markup: buildChoiceKeyboard(String(id), labels),
    });
  }

  // Taking in writes the rows and returns what to tell the owner; it does not talk to the chat itself.
  async function takeInMr(runId: number, image: Image, fills: RawFill[], today: string, chatId: string): Promise<() => Promise<void>> {
    const outcome = await ingestCapture(runId, image, { ok: true, fills }, { repos, today });
    return () => deps.sendOutcome(chatId, outcome);
  }

  async function takeInVr(runId: number, ticker: string, image: Image, fills: RawFill[], today: string, chatId: string): Promise<(() => Promise<void>) | null> {
    const run = await repos.vrRunRepo.get(runId);
    if (!run) {
      await safeSend(chatId, t('unknown-run', lang, { id: runId }));
      return null;
    }
    const outcome = await ingestVrCapture(run, image, fills, { repos, today });
    return () => deps.send(chatId, vrCaptureMessage({ runId: run.id, ticker, outcome }, lang));
  }

  // One side of an answer. Taking in and replying fail separately and each failure is reported, never thrown,
  // so the other side always runs. A failed take-in asks for the screenshot again; a failed reply must not,
  // because the rows exist and sending again would only answer "duplicate".
  async function carryOut(
    chatId: string, id: number, side: 'mr' | 'vr', ticker: string, takeIn: () => Promise<(() => Promise<void>) | null>,
  ): Promise<void> {
    const strategy = t(side === 'mr' ? 'capture-choice-mr' : 'capture-choice-vr', lang);
    let reply: (() => Promise<void>) | null;
    try {
      reply = await takeIn();
    } catch (e) {
      console.error('[capture] answering the strategy question failed:', { id, side }, brief(e));
      await safeSend(chatId, t('capture-choice-failed', lang, { ticker, strategy }));
      return;
    }
    if (!reply) return;
    try {
      await reply();
    } catch (e) {
      console.error('[capture] replying to the strategy answer failed:', { id, side }, brief(e));
      await safeSend(chatId, t('capture-choice-reply-failed', lang, { ticker, strategy }));
    }
  }

  async function onChoice(chatId: string, cbData: string): Promise<void> {
    const m = /^cs:(\d+):([mvb])$/.exec(cbData);
    const id = m ? parseId(m[1]!) : null;
    if (!m || id === null) return;
    const answer = ANSWERS[m[2]!]!;

    // The parked chatId is deliberately not compared with the pressing chat: Telegram delivers a button press only
    // from the chat that holds the bot's message, and the bot's allowed-chat check has already run.
    let choice: Awaited<ReturnType<typeof repos.captureChoiceRepo.get>>;
    let claimed = false;
    try {
      // Expired questions are deleted before the read, so "older than 24 hours" is decided by the database alone.
      await deleteExpired();
      choice = await repos.captureChoiceRepo.get(id);
      // Answered before it is carried out: of two presses only the one that moves the question from open gets past here.
      if (choice) claimed = await repos.captureChoiceRepo.answer(id, answer);
    } catch (e) {
      console.error('[capture] reading the strategy question failed:', { id }, brief(e));
      await safeSend(chatId, t('capture-choice-read-failed', lang));
      return;
    }
    if (!choice) {
      await deps.send(chatId, t('capture-choice-expired', lang));
      return;
    }
    if (!claimed) {
      await deps.send(chatId, t('capture-choice-answered', lang));
      return;
    }

    const today = choice.readOn;
    const { image, fills, ticker } = choice;
    if (answer !== 'vr') await carryOut(chatId, id, 'mr', ticker, () => takeInMr(choice.mrRunId, image, fills, today, chatId));
    if (answer !== 'mr') await carryOut(chatId, id, 'vr', ticker, () => takeInVr(choice.vrRunId, ticker, image, fills, today, chatId));
  }

  return { ask, onChoice };
}
