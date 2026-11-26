import { describe, expect, test } from 'bun:test';
import { t } from '@st/telegram/i18n';
import { vrCaptureMessage } from '../src/wire/vr-capture-message';
import { MR_FAILED, VR_FAILED, WAIT3, asked, asker, silenced } from './wire-capture-question-fixture';

const READ_FAILED = 'Could not read the question. Press the button again, or send the screenshot again.';
const MR_REPLY_FAILED = 'The Mean reversion fills for TQQQ were taken in, but the reply could not be sent. Check the pending fills in the web app.';
const VR_REPLY_FAILED = 'The VR fills for TQQQ were taken in, but the reply could not be sent. Check the pending fills in the web app.';

describe('one side of an answer never stops the other', () => {
  test('both, while every send throws: both sides are taken in and nothing escapes', async () => {
    const a = await asked();
    a.fail.next = Infinity;
    await silenced(() => a.press('cs:1:b'));
    expect(a.pending).toHaveLength(3);
    expect(a.vr.pending).toHaveLength(3);
    expect(a.choices[0]!.answer).toBe('both');
    expect(a.sent).toEqual([]);
  });

  test('both, MR take-in throws and the failure reply cannot be sent either: VR still runs', async () => {
    const a = await asked();
    a.repos.pendingRepo.insert = async () => { throw new Error('db-down'); };
    a.fail.next = 1;
    await silenced(() => a.press('cs:1:b'));
    expect(a.vr.pending).toHaveLength(3);
    expect(a.sent.map((m) => m.text)).toEqual([vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome: WAIT3 }, 'en')]);
  });

  test('both, VR take-in throws while sends fail: MR rows exist and nothing escapes', async () => {
    const a = await asked();
    a.repos.vrPendingRepo.insertMany = async () => { throw new Error('db-down'); };
    a.fail.next = Infinity;
    await silenced(() => a.press('cs:1:b'));
    expect(a.pending).toHaveLength(3);
    expect(a.vr.pending).toHaveLength(0);
  });

  test('both, MR take-in throws: the failure names mean reversion, then the VR rows and message follow', async () => {
    const a = await asked();
    a.repos.pendingRepo.insert = async () => { throw new Error('db-down'); };
    await silenced(() => a.press('cs:1:b'));
    expect(a.sent.map((m) => m.text)).toEqual([MR_FAILED, vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome: WAIT3 }, 'en')]);
    expect(a.vr.pending).toHaveLength(3);
  });
});

describe('a take-in that worked but whose reply failed', () => {
  test('m: the owner is told the fills were taken in, not to send the screenshot again', async () => {
    const a = await asked();
    a.fail.next = 1;
    await silenced(() => a.press('cs:1:m'));
    expect(a.pending).toHaveLength(3);
    expect(a.sent).toEqual([{ chatId: '777', text: MR_REPLY_FAILED, extra: undefined }]);
    expect(a.sent[0]!.text).not.toBe(MR_FAILED);
    expect(a.sent[0]!.text).not.toContain('Send the screenshot again');
  });

  test('v: the same for VR', async () => {
    const a = await asked();
    a.fail.next = 1;
    await silenced(() => a.press('cs:1:v'));
    expect(a.vr.pending).toHaveLength(3);
    expect(a.sent.map((m) => m.text)).toEqual([VR_REPLY_FAILED]);
  });

  test('the text is in Korean for a Korean setup, with the same placeholders filled', async () => {
    const a = await asked({ lang: 'ko' });
    a.fail.next = 1;
    await silenced(() => a.press('cs:1:v'));
    const text = a.sent[0]!.text;
    expect(text).toBe(t('capture-choice-reply-failed', 'ko', { ticker: 'TQQQ', strategy: t('capture-choice-vr', 'ko') }));
    expect(text).toContain('TQQQ');
    expect(text).not.toContain('{');
  });
});

describe('a throw before the answer is carried out', () => {
  const flaky = <K extends 'get' | 'deleteOlderThan' | 'answer'>(a: Awaited<ReturnType<typeof asker>>, method: K) => {
    const repo = a.repos.captureChoiceRepo as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const real = repo[method]!;
    repo[method] = async () => { throw new Error(`${method} failed`); };
    return () => { repo[method] = real; };
  };

  for (const method of ['get', 'deleteOlderThan', 'answer'] as const) {
    test(`${method} throwing: the owner gets the read-failed reply, nothing is taken in, and a later press works`, async () => {
      const a = await asked();
      const restore = flaky(a, method);
      await silenced(() => a.press('cs:1:b'));
      expect(a.sent).toEqual([{ chatId: '777', text: READ_FAILED, extra: undefined }]);
      expect(a.pending).toHaveLength(0);
      expect(a.vr.pending).toHaveLength(0);
      expect(a.captures).toHaveLength(0);
      expect(a.choices[0]!.answer).toBeNull();
      restore();
      a.sent.length = 0;
      await a.press('cs:1:v');
      expect(a.vr.pending).toHaveLength(3);
    });
  }

  test('the read-failed reply is in Korean for a Korean setup', async () => {
    const a = await asked({ lang: 'ko' });
    flaky(a, 'get');
    await silenced(() => a.press('cs:1:v'));
    expect(a.sent.map((m) => m.text)).toEqual([t('capture-choice-read-failed', 'ko')]);
  });

  test('a failing read-failed send does not escape', async () => {
    const a = await asked();
    flaky(a, 'get');
    a.fail.next = Infinity;
    await silenced(() => a.press('cs:1:v'));
    expect(a.sent).toEqual([]);
  });
});

describe('asking when the park-failed reply cannot be sent', () => {
  test('park throws and the send throws: ask does not throw', async () => {
    const a = await asker();
    a.repos.captureChoiceRepo.park = async () => { throw new Error('too large'); };
    a.fail.next = Infinity;
    await silenced(() => a.photo());
    expect(a.sent).toEqual([]);
    expect(a.captures).toHaveLength(0);
  });
});
