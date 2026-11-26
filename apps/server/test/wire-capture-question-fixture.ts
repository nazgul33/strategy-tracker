import { spyOn } from 'bun:test';
import type { RawFill } from '@st/ingest';
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing';
import type { Lang } from '@st/telegram/i18n';
import { makeCaptureHandlers } from '../src/wire/capture';
import { PNG_B64, activeRun, makeCaptureFakes } from './wire-capture-fakes';

export const visionOf = (fills: object[]) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fills }) } }] }) })) as unknown as typeof fetch;

export const THREE: RawFill[] = [
  { side: 'buy', ticker: 'TQQQ', shares: 3, price: '45.15', fee: '0.05', date: '2026-11-10', orderType: 'LOC', orderPrice: '45.20', orderedShares: 3 },
  { side: 'buy', ticker: 'TQQQ', shares: 3, price: '44.39', date: '2026-11-10' },
  { side: 'sell', ticker: 'TQQQ', shares: 2, price: '47.00', date: '2026-11-10' },
];

export const LABELS_EN = { mr: 'Mean reversion', vr: 'VR', both: 'Both' };
export const MR_FAILED = 'Could not take in this TQQQ screenshot for Mean reversion. Send the screenshot again.';
export const VR_FAILED = 'Could not take in this TQQQ screenshot for VR. Send the screenshot again.';
export const WAIT3 = { waiting: 3, dropped: 0, possibleDuplicates: 0 };

export async function asker(o: { vr?: boolean; fills?: object[]; lang?: Lang; fetchImpl?: typeof fetch; vrTicker?: string } = {}) {
  const clock = { now: new Date('2026-11-10T15:00:00Z') };
  let today = '2026-11-10';
  const runs = [activeRun(1, 'TQQQ')];
  const fakes = makeCaptureFakes({ runs, now: () => clock.now });
  if (o.vr !== false) {
    await fakes.repos.vrRunRepo.create({
      ...DEFAULT_VR_SETTINGS, ticker: o.vrTicker ?? 'TQQQ', name: 'Q', costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-01',
    });
  }
  const sent: { chatId: string; text: string; extra?: Record<string, unknown> }[] = [];
  // the next `next` sends throw (Infinity: every send), as when Telegram rejects messages
  const fail = { next: 0 };
  const handlers = makeCaptureHandlers({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'env' },
    getVisionApiKey: async () => ({ key: 'k', source: 'env' as const }),
    today: () => today,
    now: () => clock.now,
    lang: o.lang,
    allowedChatIds: [],
    fetchImpl: o.fetchImpl ?? visionOf(o.fills ?? THREE),
    send: async (chatId, text, extra) => {
      if (fail.next > 0) {
        fail.next--;
        throw new Error('telegram rejected the message');
      }
      sent.push({ chatId, text, extra });
    },
  });
  return {
    ...fakes,
    runs,
    sent,
    fail,
    handlers,
    photo: () => handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }),
    press: (data: string) => handlers.onChoice('777', data),
    clock,
    setToday: (d: string) => void (today = d),
    hours: (h: number) => void (clock.now = new Date(clock.now.getTime() + h * 3_600_000)),
  };
}

export type Asker = Awaited<ReturnType<typeof asker>>;

export async function asked(o: Parameters<typeof asker>[0] = {}): Promise<Asker> {
  const a = await asker(o);
  await a.photo();
  a.sent.length = 0;
  return a;
}

export const silenced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    err.mockRestore();
  }
};
