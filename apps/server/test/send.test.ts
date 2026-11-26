import { describe, expect, test } from 'bun:test';
import { buildPendingKeyboard, createBot } from '@st/telegram';

import { makeSend } from '../src/wire/send';
import type { MessageApi } from '../src/wire/send';

function fakeApi() {
  const calls: [string, string, Record<string, unknown> | undefined][] = [];
  const api: MessageApi = {
    async sendMessage(chatId, text, other) {
      calls.push([chatId, text, other]);
    },
  };
  return { api, calls };
}

describe('makeSend', () => {
  test('forwards the reply markup to sendMessage', async () => {
    const { api, calls } = fakeApi();
    await makeSend(() => api)('111', 'Booked ...', { reply_markup: buildPendingKeyboard('5') });
    expect(calls).toEqual([['111', 'Booked ...', { reply_markup: buildPendingKeyboard('5') }]]);
  });

  test('a plain message reaches sendMessage with no options', async () => {
    const { api, calls } = fakeApi();
    await makeSend(() => api)('111', 'hi');
    expect(calls).toEqual([['111', 'hi', undefined]]);
  });

  test('without a bot it logs and sends nothing', async () => {
    const lines: string[] = [];
    await makeSend(() => null, (l) => lines.push(l))('42', 'x'.repeat(200));
    expect(lines).toEqual(['[send:42] ' + 'x'.repeat(120)]);
  });

  test('resolves the API on every call', async () => {
    const { api, calls } = fakeApi();
    let current: MessageApi | null = null;
    const lines: string[] = [];
    const send = makeSend(() => current, (l) => lines.push(l));
    await send('1', 'first');
    current = api;
    await send('1', 'second');
    expect(lines).toEqual(['[send:1] first']);
    expect(calls).toEqual([['1', 'second', undefined]]);
  });

  test("grammy's bot API satisfies MessageApi", () => {
    const api: MessageApi = createBot({ token: '1:x', allowedChatIds: [], onPhoto() {}, onConfirm() {}, onChoice() {}, onStatus() {}, onOrders() {} }).api;
    expect(typeof api.sendMessage).toBe('function');
  });
});
