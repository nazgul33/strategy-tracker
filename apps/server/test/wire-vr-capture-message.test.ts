import { describe, expect, test } from 'bun:test';
import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';
import type { VrCaptureOutcome } from '../src/domain/vr/capture';
import { vrCaptureMessage } from '../src/wire/vr-capture-message';

const msg = (outcome: VrCaptureOutcome, lang: Lang = 'en') => vrCaptureMessage({ runId: 100001, ticker: 'TQQQ', outcome }, lang);

const HEAD = "VR run #100001 TQQQ: fills waiting: 3. Confirm on the run's Pending tab in the web app.";
const DROPPED = 'Dropped as already booked, waiting or rejected: 2.';
const POSSIBLE = 'Marked as possible duplicates: 1. Check the price before confirming.';

describe('vrCaptureMessage in English', () => {
  test('fills waiting', () => {
    expect(msg({ waiting: 3, dropped: 0, possibleDuplicates: 0 })).toBe(HEAD);
  });

  test('fills waiting and some dropped', () => {
    expect(msg({ waiting: 3, dropped: 2, possibleDuplicates: 0 })).toBe(`${HEAD}\n${DROPPED}`);
  });

  test('fills waiting and a possible duplicate', () => {
    expect(msg({ waiting: 3, dropped: 0, possibleDuplicates: 1 })).toBe(`${HEAD}\n${POSSIBLE}`);
  });

  test('all three lines come in the order waiting, dropped, possible duplicates', () => {
    expect(msg({ waiting: 3, dropped: 2, possibleDuplicates: 1 })).toBe(`${HEAD}\n${DROPPED}\n${POSSIBLE}`);
  });

  test('nothing waiting', () => {
    expect(msg({ waiting: 0, dropped: 3, possibleDuplicates: 0 })).toBe(
      'VR run #100001 TQQQ: nothing new to confirm. Fills in this screenshot already booked, waiting or rejected: 3.',
    );
  });

  test('a screenshot already taken in for the run says nothing was added and does not claim fills are waiting', () => {
    const text = msg('duplicate');
    expect(text).toBe('VR run #100001 TQQQ: this screenshot was already taken in for this run. Nothing was added.');
    expect(text).not.toContain('waiting');
  });
});

describe('vrCaptureMessage in Korean', () => {
  const base = { id: 100001, ticker: 'TQQQ' };
  const cases: [string, VrCaptureOutcome, string][] = [
    ['waiting', { waiting: 3, dropped: 0, possibleDuplicates: 0 }, t('vr-capture-waiting', 'ko', { ...base, n: 3 })],
    [
      'waiting and dropped',
      { waiting: 3, dropped: 2, possibleDuplicates: 0 },
      [t('vr-capture-waiting', 'ko', { ...base, n: 3 }), t('vr-capture-dropped', 'ko', { n: 2 })].join('\n'),
    ],
    [
      'waiting and possible duplicate',
      { waiting: 3, dropped: 0, possibleDuplicates: 1 },
      [t('vr-capture-waiting', 'ko', { ...base, n: 3 }), t('vr-capture-possible-dup', 'ko', { n: 1 })].join('\n'),
    ],
    [
      'all lines',
      { waiting: 3, dropped: 2, possibleDuplicates: 1 },
      [t('vr-capture-waiting', 'ko', { ...base, n: 3 }), t('vr-capture-dropped', 'ko', { n: 2 }), t('vr-capture-possible-dup', 'ko', { n: 1 })].join('\n'),
    ],
    ['none', { waiting: 0, dropped: 3, possibleDuplicates: 0 }, t('vr-capture-none', 'ko', { ...base, n: 3 })],
    ['duplicate', 'duplicate', t('vr-capture-duplicate', 'ko', base)],
  ];

  for (const [name, outcome, expected] of cases) {
    test(`${name}: uses the Korean catalog and fills every placeholder`, () => {
      const text = msg(outcome, 'ko');
      expect(text).toBe(expected);
      expect(text).toContain('100001');
      expect(text).toContain('TQQQ');
      expect(text).not.toContain('{');
      expect(text).not.toBe(msg(outcome, 'en'));
    });
  }

  test('the waiting message has the exact Korean text', () => {
    expect(msg({ waiting: 3, dropped: 0, possibleDuplicates: 0 }, 'ko')).toBe(
      "VR 런 #100001 TQQQ: 체결 3건이 확인을 기다립니다. 웹 앱의 런 페이지 '확인 대기' 탭에서 확정하세요.",
    );
  });
});

describe('vrCaptureMessage input', () => {
  test('a vr-outcome event can be passed in directly', () => {
    const event = { type: 'vr-outcome' as const, runId: 100001, ticker: 'TQQQ', outcome: { waiting: 3, dropped: 0, possibleDuplicates: 0 } };
    expect(vrCaptureMessage(event, 'en')).toBe(HEAD);
  });
});
