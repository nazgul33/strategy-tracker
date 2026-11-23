import { describe, expect, test } from 'bun:test';
import { applyBuyFill, parseUsd } from '@st/core';
import { t } from '@st/telegram/i18n';
import { DATE_NOTICE_EN, PNG_B64, activeRun, makeCapture } from './wire-capture-fakes';

const visionOf = (fills: Array<Record<string, unknown>>) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fills }) } }] }) }) as unknown as Response) as unknown as typeof fetch;

const sell = (extra: Record<string, unknown> = {}) => ({ side: 'sell', ticker: 'NVDA', shares: 5, price: '190.00', date: '2026-11-10', ...extra });
const buy = (extra: Record<string, unknown> = {}) => ({ side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50', date: '2026-11-10', ...extra });

async function hold(h: ReturnType<typeof makeCapture>, buckets: number[]) {
  let s = await h.repos.bucketRepo.loadState(1);
  for (const idx of buckets) s = applyBuyFill(s, idx, 10, parseUsd('180.00'), 0, '2026-11-01');
  await h.repos.bucketRepo.saveState(1, s);
}

async function photo(fills: Array<Record<string, unknown>>, held: number[], lang?: 'en' | 'ko') {
  const h = makeCapture({ runs: [activeRun(1, 'NVDA')], fetchImpl: visionOf(fills), lang });
  await hold(h, held);
  await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
  return h;
}

describe('capture rows the operator must act on', () => {
  test('a sell that needs a choice is sent without buttons', async () => {
    for (const lang of ['en', 'ko'] as const) {
      const h = await photo([sell()], [0, 1], lang);
      const msg = h.sent.at(-1)!;
      expect(msg.extra).toBeUndefined();
      expect(msg.text).toContain(t('capture-needs-bucket', lang));
    }
    expect(t('capture-needs-bucket', 'en')).toBe("⚠️ More than one bucket could have sold this. Choose the bucket and confirm this fill in the web app's Pending view.");
  });

  test('a future-dated fill is sent without buttons', async () => {
    for (const lang of ['en', 'ko'] as const) {
      const h = await photo([buy({ date: '2026-11-12' })], [], lang);
      const msg = h.sent.at(-1)!;
      expect(msg.extra).toBeUndefined();
      expect(msg.text).toContain(t('capture-date-after-today', lang, { date: '2026-11-12' }));
    }
    expect(t('capture-date-after-today', 'en', { date: '2026-11-12' })).toBe("⚠️ The trade date read from the screenshot (2026-11-12) is after today. Fix the date and confirm this fill in the web app's Pending view.");
  });

  test('an ordinary row keeps its buttons', async () => {
    const h = await photo([sell()], [0]);
    const msg = h.sent.at(-1)!;
    expect(msg.extra).toHaveProperty('reply_markup');
    expect(msg.text).toBe('Booked NVDA sell 5 sh @ $190.00 on 2026-11-10 — confirm?');
  });

  test('a substituted date still has no buttons', async () => {
    const h = await photo([buy({ date: undefined })], []);
    const msg = h.sent.at(-1)!;
    expect(msg.extra).toBeUndefined();
    expect(msg.text).toBe(`Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?\n${DATE_NOTICE_EN}`);
  });

  test('the notice lines come in order: date after today, then bucket', async () => {
    const h = await photo([sell({ date: '2026-11-12' })], [0, 1]);
    const lines = h.sent.at(-1)!.text.split('\n');
    expect(lines.slice(1)).toEqual([t('capture-date-after-today', 'en', { date: '2026-11-12' }), t('capture-needs-bucket', 'en')]);
  });

  test('Yes on a row that now needs a choice is refused and books nothing', async () => {
    const h = await photo([sell()], [0]);
    expect(h.sent.at(-1)!.extra).toHaveProperty('reply_markup');
    await hold(h, [1]);
    await h.handlers.onConfirm('777', `yes:${h.pending[0]!.id}`, true);
    expect(h.sent.at(-1)).toEqual({ chatId: '777', text: t('confirm-err-choose-bucket', 'en'), extra: undefined });
    expect(t('confirm-err-choose-bucket', 'en')).toBe("More than one bucket could have sold this — choose the bucket in the web app's Pending view.");
    expect(h.pending[0]!.status).toBe('pending');
    expect(h.fills).toHaveLength(0);
  });
});
