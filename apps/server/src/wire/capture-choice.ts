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
      await deps.send(chatId, t('capture-choice-park-failed', lang, { ticker: event.ticker }));
      return;
    }
    const labels = { mr: t('capture-choice-mr', lang), vr: t('capture-choice-vr', lang), both: t('capture-choice-both', lang) };
    await deps.send(chatId, t('capture-choice-question', lang, { ticker: event.ticker, n: event.fills.length }), {
      reply_markup: buildChoiceKeyboard(String(id), labels),
    });
  }

  async function takeInMr(chatId: string, runId: number, image: Image, fills: RawFill[], today: string): Promise<void> {
    const outcome = await ingestCapture(runId, image, { ok: true, fills }, { repos, today });
    await deps.sendOutcome(chatId, outcome);
  }

  async function takeInVr(chatId: string, runId: number, ticker: string, image: Image, fills: RawFill[], today: string): Promise<void> {
    const run = await repos.vrRunRepo.get(runId);
    if (!run) {
      await deps.send(chatId, t('unknown-run', lang, { id: runId }));
      return;
    }
    const outcome = await ingestVrCapture(run, image, fills, { repos, today });
    await deps.send(chatId, vrCaptureMessage({ runId: run.id, ticker, outcome }, lang));
  }

  async function onChoice(chatId: string, cbData: string): Promise<void> {
    const m = /^cs:(\d+):([mvb])$/.exec(cbData);
    const id = m ? parseId(m[1]!) : null;
    if (!m || id === null) return;
    const answer = ANSWERS[m[2]!]!;

    // Expired questions are deleted before the read, so "older than 24 hours" is decided by the database alone.
    await deleteExpired();
    const choice = await repos.captureChoiceRepo.get(id);
    if (!choice) {
      await deps.send(chatId, t('capture-choice-expired', lang));
      return;
    }
    // Answered before it is carried out: of two presses only the one that moves the question from open gets past here.
    if (!(await repos.captureChoiceRepo.answer(id, answer))) {
      await deps.send(chatId, t('capture-choice-answered', lang));
      return;
    }

    const today = choice.readOn;
    const sides: { side: 'mr' | 'vr'; run: () => Promise<void> }[] = [];
    if (answer !== 'vr') sides.push({ side: 'mr', run: () => takeInMr(chatId, choice.mrRunId, choice.image, choice.fills, today) });
    if (answer !== 'mr') sides.push({ side: 'vr', run: () => takeInVr(chatId, choice.vrRunId, choice.ticker, choice.image, choice.fills, today) });
    for (const { side, run } of sides) {
      try {
        await run();
      } catch (e) {
        console.error('[capture] answering the strategy question failed:', { id, side }, brief(e));
        const strategy = t(side === 'mr' ? 'capture-choice-mr' : 'capture-choice-vr', lang);
        await deps.send(chatId, t('capture-choice-failed', lang, { ticker: choice.ticker, strategy }));
      }
    }
  }

  return { ask, onChoice };
}
