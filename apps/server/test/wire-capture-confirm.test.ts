import { describe, expect, spyOn, test } from 'bun:test';
import { applyBuyFill, parseUsd } from '@st/core';
import { t } from '@st/telegram/i18n';
import { makeCaptureHandlers } from '../src/wire/capture';
import { NO_SNAPSHOT } from './booking-fakes';
import { PNG_B64, activeRun, makeCapture, makeCaptureFakes, type FakeRow } from './wire-capture-fakes';

describe('capture onConfirm — reply target', () => {
  test('the confirm reply goes to the chat the button was pressed in', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    await h.handlers.onConfirm('888', `yes:${p.id}`, true);
    expect(h.sent.at(-1)).toEqual({ chatId: '888', text: 'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 0', extra: undefined });

    const r = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await r.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    await r.handlers.onConfirm('888', `no:${r.pending[0]!.id}`, false);
    expect(r.sent.at(-1)).toEqual({ chatId: '888', text: 'Rejected — fill discarded.', extra: undefined });
  });

  test('a button pressed with no photo since start replies in its own chat', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    const id = await h.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'buy', ticker: 'NVDA', shares: 10, price: parseUsd('180.50'), fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT });
    await h.handlers.onConfirm('999', `yes:${id}`, true);
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent.every((s) => s.chatId === '999')).toBe(true);
  });

  test('callback data that is not a canonical id books nothing and answers nothing', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    const sentBefore = h.sent.length;
    await h.handlers.onConfirm('777', 'yes:007', true);
    await h.handlers.onConfirm('777', `yes:00${p.id}`, true);
    await h.handlers.onConfirm('777', `yes:0x${Number(p.id).toString(16)}`, true);
    await h.handlers.onConfirm('777', `no:00${p.id}`, false);
    await h.handlers.onConfirm('777', `yes:${p.id}\n`, true);
    await h.handlers.onConfirm('777', `no:${p.id}`, true);
    expect(h.sent.length).toBe(sentBefore);
    expect(h.pending[0]!.status).toBe('pending');
  });

  test('a yes button whose handler says reject books nothing and answers nothing', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    const p = h.pending[0]!;
    const sentBefore = h.sent.length;
    await h.handlers.onConfirm('777', `yes:${p.id}`, false);
    expect(h.sent.length).toBe(sentBefore);
    expect(h.fills.length).toBe(0);
    expect(p.status).toBe('pending');
  });

  test('a reject whose bookkeeping throws replies with the worded error in the pressing chat', async () => {
    for (const lang of ['en', 'ko'] as const) {
      const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
      await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
      const id = h.pending[0]!.id;
      h.repos.pendingRepo.decide = async () => {
        throw new Error('boom');
      };
      const sentBefore = h.sent.length;
      await h.handlers.onConfirm('888', `no:${id}`, false);
      expect(h.sent.slice(sentBefore)).toEqual([{ chatId: '888', text: t('confirm-err-unknown', lang, { code: 'boom' }), extra: undefined }]);
    }
  });

  test('pressing a button on an already-handled row says already handled', async () => {
    const sequences: [boolean, boolean][] = [[true, true], [true, false], [false, false], [false, true]];
    for (const lang of ['en', 'ko'] as const) {
      const expected = t('confirm-err-already-handled', lang);
      for (const [first, second] of sequences) {
        const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
        await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
        const id = h.pending[0]!.id;
        await h.handlers.onConfirm('777', `${first ? 'yes' : 'no'}:${id}`, first);
        await h.handlers.onConfirm('888', `${second ? 'yes' : 'no'}:${id}`, second);
        expect(h.sent.at(-1)).toMatchObject({ chatId: '888', text: expected });
      }
      const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
      await h.handlers.onConfirm('777', 'no:4242', false);
      expect(h.sent).toEqual([{ chatId: '777', text: expected, extra: undefined }]);
    }
    expect(t('confirm-err-already-handled', 'en')).toBe('Already handled — this fill was already confirmed or rejected.');
    expect(t('confirm-err-already-handled', 'ko')).toBe('이미 처리되었습니다 — 이 체결은 이미 확정되었거나 거부되었습니다.');
  });
});

describe('capture onConfirm — human-readable errors (#7)', () => {
  async function capturedPending(lang: 'en' | 'ko') {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang });
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    return { h, p: h.pending[0]! };
  }

  test('ticker-mismatch (Error code) is rendered from the en catalog', async () => {
    const { h, p } = await capturedPending('en');
    p.ticker = 'AAPL';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('Ticker does not match the run — tap No to reject this fill, then re-capture.');
    expect(h.fills.length).toBe(0);
  });

  test('ticker-mismatch is rendered from the ko catalog', async () => {
    const { h, p } = await capturedPending('ko');
    p.ticker = 'AAPL';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('티커가 런과 일치하지 않습니다 — \'No\'를 눌러 이 체결을 거부하고 다시 캡처하세요.');
  });

  test('confirming an already-handled row says so in en and ko', async () => {
    for (const [lang, text] of [
      ['en', 'Already handled — this fill was already confirmed or rejected.'],
      ['ko', '이미 처리되었습니다 — 이 체결은 이미 확정되었거나 거부되었습니다.'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
    }
  });

  test('DomainError kind (empty message) is mapped, not sent blank', async () => {
    const { h, p } = await capturedPending('en');
    p.side = 'sell';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('No held bucket can cover this sell — check the share count.');
  });

  test('DomainError kind is rendered in ko', async () => {
    const { h, p } = await capturedPending('ko');
    p.side = 'sell';
    await h.handlers.onConfirm('777', `yes:${p.id}`, true);
    expect(h.sent.at(-1)!.text).toBe('이 매도를 처리할 수 있는 보유 버킷이 없습니다 — 수량을 확인하세요.');
  });

  test('a thrown bucket-not-held renders the catalog copy in en and ko', async () => {
    for (const [lang, text] of [
      ['en', 'The matched bucket is not currently held — check the side and the share count.'],
      ['ko', '매칭된 버킷이 현재 보유 중이 아닙니다 — 매매 구분과 수량을 확인하세요.'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      h.repos.runRepo.get = async () => {
        throw new Error('bucket-not-held');
      };
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
      expect(h.fills.length).toBe(0);
    }
  });

  test('a thrown bucket-not-found renders the worded copy in en and ko, not the unknown fallback', async () => {
    for (const [lang, text] of [
      ['en', 'That bucket no longer exists on this run; book it from the web Pending view.'],
      ['ko', '이 런에 해당 버킷이 더 이상 없습니다. 웹의 대기 목록에서 처리하세요.'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      h.repos.runRepo.get = async () => {
        throw new Error('bucket-not-found');
      };
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
      expect(h.sent.at(-1)!.text).not.toBe(t('confirm-err-unknown', lang, { code: 'bucket-not-found' }));
    }
  });

  test('Yes on a future-dated row is refused with its own text', async () => {
    for (const lang of ['en', 'ko'] as const) {
      const { h, p } = await capturedPending(lang);
      p.filledOn = '2026-11-11';
      const sentBefore = h.sent.length;
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.slice(sentBefore)).toEqual([{ chatId: '777', text: t('confirm-err-fill-date-in-future', lang), extra: undefined }]);
      expect(h.sent.at(-1)!.text).not.toStartWith('Booked');
      expect(h.sent.at(-1)!.text).not.toBe(t('confirm-err-unknown', lang, { code: 'fill-date-in-future' }));
      expect(p.status).toBe('pending');
      expect(h.fills.length).toBe(0);
    }
    expect(t('confirm-err-fill-date-in-future', 'en')).toBe("The trade date is after today — fix the date in the web app's Pending view.");
  });

  test('unknown error falls back to a catalog line carrying the raw code', async () => {
    for (const [lang, text] of [
      ['en', 'Could not confirm this fill (boom).'],
      ['ko', '이 체결을 확정할 수 없습니다 (boom).'],
    ] as const) {
      const { h, p } = await capturedPending(lang);
      h.repos.runRepo.get = async () => {
        throw new Error('boom');
      };
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe(text);
    }
  });
});

describe('capture confirm — sibling leg cancelled by a bucket-emptying sell', () => {
  async function setupSell(opts: { allowedChatIds?: string[]; send?: (chatId: string, text: string) => Promise<void> } = {}) {
    const fakes = makeCaptureFakes({ runs: [activeRun(1, 'NVDA')] });
    await fakes.repos.bucketRepo.saveState(1, applyBuyFill(fakes.stateFor(1), 0, 10, parseUsd('100.00'), 0, '2026-11-02'));
    const orders: FakeRow[] = [
      { id: 1, runId: 1, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('103.00'), shares: 10, status: 'open' },
      { id: 2, runId: 1, tradeDate: '2026-11-10', kind: 'stop_sell', bucketIdx: 0, limitPrice: parseUsd('97.00'), shares: 10, status: 'open' },
    ];
    Object.assign(fakes.repos.orderRepo, {
      listForDate: async () => orders,
      listForRun: async () => orders,
      listForRunFrom: async () => orders,
      get: async (id: number) => orders.find((o) => o.id === id) ?? null,
      setStatus: async (id: number, status: string, reason?: string) => {
        const o = orders.find((x) => x.id === id)!;
        o.status = status;
        if (reason !== undefined) o.cancelReason = reason;
      },
    });
    const pid = await fakes.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'sell', ticker: 'NVDA', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT });
    const sent: { chatId: string; text: string }[] = [];
    const handlers = makeCaptureHandlers({
      repos: fakes.repos,
      vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'env' },
      getVisionApiKey: async () => ({ key: 'k', source: 'env' as const }),
      today: () => '2026-11-10',
      allowedChatIds: opts.allowedChatIds ?? ['111', '222'],
      send: opts.send ?? (async (chatId, text) => void sent.push({ chatId, text })),
    });
    return { fakes, orders, pid, sent, handlers };
  }

  test('confirming the sell tells every allowed chat to pull the cancelled leg and records the notifications', async () => {
    const { fakes, orders, pid, sent, handlers } = await setupSell();
    await handlers.onConfirm('111', `yes:${pid}`, true);
    const text = '⚠️ Run #1 NVDA: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.';
    expect(sent.filter((s) => s.text === text).map((s) => s.chatId)).toEqual(['111', '222']);
    expect(fakes.notifications).toEqual([
      { runId: 1, chatId: '111', text },
      { runId: 1, chatId: '222', text },
    ]);
    expect(orders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' });
    expect(orders[1]!.status).toBe('filled');
  });

  test('with no allowed chats the Telegram confirm records the notice for the web', async () => {
    const { fakes, pid, sent, handlers } = await setupSell({ allowedChatIds: [] });
    await handlers.onConfirm('111', `yes:${pid}`, true);
    const text = '⚠️ Run #1 NVDA: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.';
    expect(fakes.notifications).toEqual([{ runId: 1, chatId: 'web', text }]);
    expect(sent.some((s) => s.text === text)).toBe(false);
  });

  test('a Telegram outage on the notice never fails the confirm', async () => {
    const sent: { chatId: string; text: string }[] = [];
    const { fakes, orders, pid, handlers } = await setupSell({
      send: async (chatId, text) => {
        if (text.startsWith('⚠️ Run #1 NVDA: cancel')) throw new Error('telegram-down');
        sent.push({ chatId, text });
      },
    });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handlers.onConfirm('111', `yes:${pid}`, true);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.chatId).toBe('111');
      expect(sent[0]!.text).toStartWith('Booked NVDA sell 10 sh');
      expect(fakes.fills).toHaveLength(1);
      expect(fakes.ledger).toHaveLength(1);
      expect(orders[0]!.status).toBe('cancelled');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
