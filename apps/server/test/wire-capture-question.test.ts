import { describe, expect, spyOn, test } from 'bun:test';
import type { RawFill } from '@st/ingest';
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing';
import { buildChoiceKeyboard } from '@st/telegram';
import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';
import { runBootSweeps } from '../src/wire/boot-sweeps';
import { makeCaptureHandlers } from '../src/wire/capture';
import { vrCaptureMessage } from '../src/wire/vr-capture-message';
import { DATE_NOTICE_EN, PNG_B64, activeRun, makeCaptureFakes, visionFetch } from './wire-capture-fakes';

const visionOf = (fills: object[]) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fills }) } }] }) })) as unknown as typeof fetch;

const THREE: RawFill[] = [
  { side: 'buy', ticker: 'TQQQ', shares: 3, price: '45.15', fee: '0.05', date: '2026-11-10', orderType: 'LOC', orderPrice: '45.20', orderedShares: 3 },
  { side: 'buy', ticker: 'TQQQ', shares: 3, price: '44.39', date: '2026-11-10' },
  { side: 'sell', ticker: 'TQQQ', shares: 2, price: '47.00', date: '2026-11-10' },
];

const LABELS_EN = { mr: 'Mean reversion', vr: 'VR', both: 'Both' };
const MR_FAILED = 'Could not take in this TQQQ screenshot for Mean reversion. Send the screenshot again.';
const VR_FAILED = 'Could not take in this TQQQ screenshot for VR. Send the screenshot again.';
const WAIT3 = { waiting: 3, dropped: 0, possibleDuplicates: 0 };

async function asker(o: { vr?: boolean; fills?: object[]; lang?: Lang; fetchImpl?: typeof fetch; vrTicker?: string } = {}) {
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
  const handlers = makeCaptureHandlers({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'env' },
    getVisionApiKey: async () => ({ key: 'k', source: 'env' as const }),
    today: () => today,
    now: () => clock.now,
    lang: o.lang,
    allowedChatIds: [],
    fetchImpl: o.fetchImpl ?? visionOf(o.fills ?? THREE),
    send: async (chatId, text, extra) => void sent.push({ chatId, text, extra }),
  });
  return {
    ...fakes,
    runs,
    sent,
    handlers,
    photo: () => handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' }),
    press: (data: string) => handlers.onChoice('777', data),
    clock,
    setToday: (d: string) => void (today = d),
    hours: (h: number) => void (clock.now = new Date(clock.now.getTime() + h * 3_600_000)),
  };
}

type Asker = Awaited<ReturnType<typeof asker>>;

async function asked(o: Parameters<typeof asker>[0] = {}): Promise<Asker> {
  const a = await asker(o);
  await a.photo();
  a.sent.length = 0;
  return a;
}

const silenced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    err.mockRestore();
  }
};

describe('asking which strategy', () => {
  test('a shared ticker is parked and asked about, and nothing is taken in', async () => {
    const a = await asker();
    await a.photo();
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.chatId).toBe('777');
    expect(a.sent[0]!.text).toBe('TQQQ, 3 fill(s): which strategy?');
    expect(a.sent[0]!.extra).toEqual({ reply_markup: buildChoiceKeyboard('1', LABELS_EN) });
    expect(a.choices).toHaveLength(1);
    expect(a.choices[0]).toMatchObject({
      chatId: '777', ticker: 'TQQQ', mrRunId: 1, vrRunId: 100001, readOn: '2026-11-10', answer: null, image: { base64: PNG_B64, mime: 'image/png' },
    });
    expect(a.choices[0]!.fills).toEqual(THREE);
    expect(a.captures).toHaveLength(0);
    expect(a.pending).toHaveLength(0);
    expect(a.vr.pending).toHaveLength(0);
  });

  test('the question and its buttons are in the configured language', async () => {
    const a = await asker({ lang: 'ko' });
    await a.photo();
    expect(a.sent[0]!.text).toBe(t('capture-choice-question', 'ko', { ticker: 'TQQQ', n: 3 }));
    expect(a.sent[0]!.extra).toEqual({
      reply_markup: buildChoiceKeyboard('1', { mr: t('capture-choice-mr', 'ko'), vr: t('capture-choice-vr', 'ko'), both: t('capture-choice-both', 'ko') }),
    });
    expect(t('capture-choice-mr', 'ko')).not.toBe(LABELS_EN.mr);
  });

  test('a ticker only mean reversion trades gets exactly the MR messages and no question', async () => {
    const a = await asker({ vrTicker: 'SOXL', fetchImpl: visionFetch });
    a.runs[0] = activeRun(1, 'NVDA');
    await a.photo();
    expect(a.sent).toEqual([
      { chatId: '777', text: 'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?', extra: { reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'yes:1' }, { text: 'No', callback_data: 'no:1' }]] } } },
    ]);
    expect(a.choices).toHaveLength(0);
  });

  test('when the question cannot be saved the owner is told, the error is logged, and nothing is thrown', async () => {
    const a = await asker();
    a.repos.captureChoiceRepo.park = async () => { throw new Error('Got a packet bigger than max_allowed_packet'); };
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await a.photo();
      expect(a.sent).toEqual([{ chatId: '777', text: t('capture-choice-park-failed', 'en', { ticker: 'TQQQ' }), extra: undefined }]);
      expect(a.sent[0]!.text).toContain('TQQQ');
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain('parking the strategy question failed');
      expect(JSON.stringify(err.mock.calls)).not.toContain(PNG_B64);
    } finally {
      err.mockRestore();
    }
    expect(a.captures).toHaveLength(0);
    expect(a.pending).toHaveLength(0);
    expect(a.vr.pending).toHaveLength(0);
  });

  test('a failing cleanup of old questions does not cost the owner the question', async () => {
    const a = await asker();
    a.repos.captureChoiceRepo.deleteOlderThan = async () => { throw new Error('db down'); };
    await silenced(() => a.photo());
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.text).toBe('TQQQ, 3 fill(s): which strategy?');
    expect(a.choices).toHaveLength(1);
  });
});

describe('answering mean reversion', () => {
  test('sends exactly the messages an MR-only setup sends for that photo and books no VR row', async () => {
    const a = await asked();
    await a.press('cs:1:m');
    const b = await asker({ vr: false });
    await b.photo();
    expect(a.sent.length).toBeGreaterThan(0);
    expect(a.sent).toEqual(b.sent);
    expect(a.pending).toEqual(b.pending);
    expect(a.pending).toHaveLength(3);
    expect(a.captures).toEqual(b.captures);
    expect(a.vr.pending).toHaveLength(0);
    expect(a.choices[0]!.answer).toBe('mr');
  });
});

describe('answering VR', () => {
  test('takes the fills in as waiting rows and sends the VR message', async () => {
    const a = await asked();
    await a.press('cs:1:v');
    expect(a.vr.pending).toHaveLength(3);
    expect(a.vr.pending.map((p) => p.fee)).toEqual([5, null, null]);
    for (const p of a.vr.pending) expect(p).toMatchObject({ runId: 100001, dateRead: true, dupPrice: null, status: 'pending' });
    expect(a.sent).toEqual([{ chatId: '777', text: vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome: WAIT3 }, 'en'), extra: undefined }]);
    expect(a.pending).toHaveLength(0);
    expect(a.captures).toHaveLength(1);
    expect(a.captures[0]!.runId).toBe(100001);
  });

  test('the same screenshot sent again for VR is reported as taken in already', async () => {
    const a = await asked();
    await a.press('cs:1:v');
    a.sent.length = 0;
    await a.photo();
    await a.press('cs:2:v');
    expect(a.sent.at(-1)!.text).toBe(vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome: 'duplicate' }, 'en'));
    expect(a.vr.pending).toHaveLength(3);
  });

  test('a run that was paused after the question still takes the fills', async () => {
    const a = await asked();
    await a.repos.vrRunRepo.updateStatus(100001, 'paused');
    await a.press('cs:1:v');
    expect(a.vr.pending).toHaveLength(3);
  });

  test('an MR run that was paused after the question still takes the fills', async () => {
    const a = await asked();
    a.runs[0]!.status = 'paused';
    await a.press('cs:1:m');
    expect(a.pending).toHaveLength(3);
  });

  test('a VR run that is gone is reported as unknown', async () => {
    const a = await asked();
    a.vr.runs.length = 0;
    await a.press('cs:1:v');
    expect(a.sent).toEqual([{ chatId: '777', text: t('unknown-run', 'en', { id: 100001 }), extra: undefined }]);
  });
});

describe('answering both', () => {
  test('MR messages come first and the VR message last', async () => {
    const a = await asked();
    await a.press('cs:1:b');
    const b = await asker({ vr: false });
    await b.photo();
    expect(a.sent.slice(0, -1)).toEqual(b.sent);
    expect(a.sent.at(-1)).toEqual({ chatId: '777', text: vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome: WAIT3 }, 'en'), extra: undefined });
    expect(a.pending).toHaveLength(3);
    expect(a.vr.pending).toHaveLength(3);
    expect(a.captures.map((c) => c.runId).sort((x, y) => x - y)).toEqual([1, 100001]);
    expect(new Set(a.captures.map((c) => c.imageHash)).size).toBe(1);
  });

  test('a failure on the MR side is reported and the VR side still runs', async () => {
    const a = await asked();
    a.repos.pendingRepo.insert = async () => { throw new Error('db-down'); };
    await silenced(() => a.press('cs:1:b'));
    expect(a.sent.map((m) => m.text)).toEqual([MR_FAILED, vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome: WAIT3 }, 'en')]);
    expect(a.vr.pending).toHaveLength(3);
  });

  test('a failure on the VR side is reported after the MR messages, and the press resolves', async () => {
    const a = await asked();
    a.repos.vrPendingRepo.insertMany = async () => { throw new Error('db-down'); };
    await silenced(() => a.press('cs:1:b'));
    expect(a.pending).toHaveLength(3);
    expect(a.sent).toHaveLength(4);
    expect(a.sent.at(-1)!.text).toBe(VR_FAILED);
    expect(a.sent.slice(0, 3).map((m) => m.text)).not.toContain(VR_FAILED);
  });

  test('a failed take-in logs the strategy side and the id, never the error text or the image', async () => {
    const a = await asked();
    a.repos.pendingRepo.insert = async () => { throw new Error(`insert into x values ('${PNG_B64}')`); };
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await a.press('cs:1:m');
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain('answering the strategy question failed');
      expect(JSON.stringify(err.mock.calls[0]![1])).toContain('"mr"');
      expect(a.sent.map((m) => m.text)).toEqual([MR_FAILED]);
      expect(JSON.stringify(a.sent)).not.toContain(PNG_B64);
    } finally {
      err.mockRestore();
    }
  });

  test('when the carry-out failed the question stays answered, so a second press books nothing', async () => {
    const a = await asked();
    const real = a.repos.pendingRepo.insert;
    a.repos.pendingRepo.insert = async () => { throw new Error('db-down'); };
    await silenced(() => a.press('cs:1:m'));
    a.repos.pendingRepo.insert = real;
    a.sent.length = 0;
    await a.press('cs:1:m');
    expect(a.sent).toEqual([{ chatId: '777', text: t('capture-choice-answered', 'en'), extra: undefined }]);
    expect(a.pending).toHaveLength(0);
    expect(a.choices[0]!.answer).toBe('mr');
  });
});

describe('one answer per question', () => {
  test('pressing the same button twice carries it out once', async () => {
    const a = await asked();
    await a.press('cs:1:v');
    a.sent.length = 0;
    await a.press('cs:1:v');
    expect(a.sent).toEqual([{ chatId: '777', text: t('capture-choice-answered', 'en'), extra: undefined }]);
    expect(a.vr.pending).toHaveLength(3);
    expect(a.choices[0]!.answer).toBe('vr');
  });

  test('a different button after the first is also refused', async () => {
    const a = await asked();
    await a.press('cs:1:v');
    a.sent.length = 0;
    await a.press('cs:1:m');
    expect(a.sent.map((m) => m.text)).toEqual([t('capture-choice-answered', 'en')]);
    expect(a.pending).toHaveLength(0);
  });

  test('two presses started together carry out exactly one', async () => {
    const a = await asked();
    await Promise.all([a.press('cs:1:v'), a.press('cs:1:m')]);
    expect(a.vr.pending.length > 0).not.toBe(a.pending.length > 0);
    expect(a.sent.filter((m) => m.text === t('capture-choice-answered', 'en'))).toHaveLength(1);
    expect(a.captures).toHaveLength(1);
  });
});

describe('questions that expire', () => {
  test('a question 25 hours old is expired and books nothing', async () => {
    const a = await asked();
    a.hours(25);
    await a.press('cs:1:b');
    expect(a.sent).toEqual([{ chatId: '777', text: t('capture-choice-expired', 'en'), extra: undefined }]);
    expect(a.pending).toHaveLength(0);
    expect(a.vr.pending).toHaveLength(0);
    expect(a.captures).toHaveLength(0);
    expect(a.choices).toHaveLength(0);
  });

  test('a question 23 hours old still works', async () => {
    const a = await asked();
    a.hours(23);
    await a.press('cs:1:v');
    expect(a.vr.pending).toHaveLength(3);
  });

  test('a question that does not exist is expired', async () => {
    const a = await asked();
    await a.press('cs:99:v');
    expect(a.sent.map((m) => m.text)).toEqual([t('capture-choice-expired', 'en')]);
  });

  test('the expired text is in Korean for a Korean setup', async () => {
    const a = await asked({ lang: 'ko' });
    a.hours(25);
    await a.press('cs:1:v');
    expect(a.sent.map((m) => m.text)).toEqual([t('capture-choice-expired', 'ko')]);
  });

  test('asking deletes questions older than 24 hours', async () => {
    const a = await asker();
    await a.photo();
    a.hours(25);
    await a.photo();
    expect(a.choices).toHaveLength(1);
    expect(a.choices[0]!.createdAt).toBe('2026-11-11 16:00:00');
  });

  test('the boot sweep deletes questions older than 24 hours, answered or not', async () => {
    const a = await asker();
    await a.photo();
    await a.press('cs:1:v');
    await a.photo();
    expect(a.choices.length).toBeGreaterThan(0);
    a.hours(25);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runBootSweeps({
        simRepo: { sweepDrafts: async () => 0 },
        captureImageRepo: { sweepOrphans: async () => [] },
        visionReviewRepo: { listUnfrozenKept: async () => [], insertIgnore: async () => {} },
        captureChoiceRepo: a.repos.captureChoiceRepo,
      }, a.clock.now);
    } finally {
      log.mockRestore();
    }
    expect(a.choices).toHaveLength(0);
  });
});

describe('answers use the day the photo was read', () => {
  test('fills without a date are dated the day of the photo when the answer comes the next day', async () => {
    const a = await asked({ fills: THREE.map(({ date: _d, ...f }) => f) });
    a.setToday('2026-11-11');
    a.hours(2);
    await a.press('cs:1:b');
    expect(a.pending).toHaveLength(3);
    for (const p of a.pending) expect(p).toMatchObject({ filledOn: '2026-11-10', detectedFilledOn: null });
    expect(a.sent.some((m) => m.text.includes(DATE_NOTICE_EN))).toBe(true);
    expect(a.vr.pending).toHaveLength(3);
    for (const p of a.vr.pending) expect(p).toMatchObject({ filledOn: '2026-11-10', dateRead: false });
  });
});

describe('data that is not an answer', () => {
  for (const data of ['cs:x:v', 'cs:5:z', 'cs:5', 'cs:1:v ', 'cs:01:v', 'cs:1:V', 'cs::v']) {
    test(`${JSON.stringify(data)} is ignored`, async () => {
      const a = await asked();
      await a.press(data);
      expect(a.sent).toEqual([]);
      expect(a.pending).toHaveLength(0);
      expect(a.vr.pending).toHaveLength(0);
      expect(a.choices[0]!.answer).toBeNull();
    });
  }
});
