import { expect, test } from 'bun:test';

import type { CaptureEventDto } from './api';
import { lookup } from './i18n/catalog';
import { captureEventLines, uploadItemLines, wantsPending } from './uploadlines';
import type { UploadLine } from './uploadlines';

const en = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);
const ko = (k: string, p?: Record<string, string | number>) => lookup('ko', k, p);

type VrEvent = Extract<CaptureEventDto, { type: 'vr-outcome' }>;
const vr = (outcome: VrEvent['outcome'], runId = 5): VrEvent => ({ type: 'vr-outcome', runId, ticker: 'TQQQ', outcome });
const counts = (waiting: number, dropped: number, possibleDuplicates: number) => vr({ waiting, dropped, possibleDuplicates });

const HEAD: UploadLine = { tone: 'ok', depth: 0, text: 'TQQQ → VR run #5: 3 waiting on its Pending tab', href: '#/vr/5?tab=pending' };
const NOTHING: UploadLine = { tone: 'info', depth: 0, text: 'TQQQ → VR run #5: nothing new to confirm.' };
const DROPPED: UploadLine = { tone: 'info', depth: 1, text: '2 already booked, waiting or rejected on this run — not added again.' };

test('waiting fills: one head line linking to the Pending tab', () => {
  expect(captureEventLines(counts(3, 0, 0), en)).toEqual([HEAD]);
});

test('waiting with dropped and possible duplicates: the head, then each count', () => {
  expect(captureEventLines(counts(3, 2, 1), en)).toEqual([
    HEAD,
    DROPPED,
    { tone: 'warn', depth: 1, text: 'Possible duplicates marked: 1 — compare before confirming.' },
  ]);
});

test('possible duplicates without dropped fills', () => {
  expect(captureEventLines(counts(3, 0, 4), en)).toEqual([
    HEAD,
    { tone: 'warn', depth: 1, text: 'Possible duplicates marked: 4 — compare before confirming.' },
  ]);
});

test('nothing waiting but fills dropped: its own line without a link, then the dropped line', () => {
  expect(captureEventLines(counts(0, 2, 0), en)).toEqual([NOTHING, DROPPED]);
});

test('nothing waiting and nothing dropped: the nothing-new line only', () => {
  expect(captureEventLines(counts(0, 0, 0), en)).toEqual([NOTHING]);
});

test("'duplicate': this screenshot was taken in already, linking to the Pending tab, without claiming fills wait", () => {
  expect(captureEventLines(vr('duplicate'), en)).toEqual([
    {
      tone: 'info',
      depth: 0,
      text: 'TQQQ → VR run #5: this screenshot was already taken in for this run — nothing was added.',
      href: '#/vr/5?tab=pending',
    },
  ]);
});

test('the dropped line reads right for one fill and for many', () => {
  expect(captureEventLines(counts(0, 1, 0), en)[1]!.text).toBe('1 already booked, waiting or rejected on this run — not added again.');
  expect(captureEventLines(counts(0, 7, 0), en)[1]!.text).toBe('7 already booked, waiting or rejected on this run — not added again.');
});

test('uploadItemLines keeps the order of a pin-skipped followed by a vr-outcome', () => {
  const lines = uploadItemLines({ events: [{ type: 'pin-skipped', runId: 5, tickers: ['SOXL'] }, counts(3, 0, 0)] }, en);
  expect(lines).toHaveLength(2);
  expect(lines[0]!.text).toContain('SOXL');
  expect(lines[1]).toEqual(HEAD);
});

test('ko: the head line reads in Korean with no placeholder left', () => {
  const lines = captureEventLines(counts(3, 2, 1), ko);
  expect(lines[0]!.text).toBe('TQQQ → VR 런 #5: 확인 대기 탭에 3건 대기 중');
  for (const l of [...lines, ...captureEventLines(vr('duplicate'), ko), ...captureEventLines(counts(0, 0, 0), ko)]) {
    expect(l.text).not.toContain('{');
  }
});

const upload = (...events: CaptureEventDto[]) => [{ events }];
const MR_PENDING = { type: 'outcome', runId: 1, ticker: 'QQQ', outcome: { pending: [{ id: 2 }] } } as unknown as CaptureEventDto;
const MR_DUPLICATE: CaptureEventDto = { type: 'outcome', runId: 1, ticker: 'QQQ', outcome: 'duplicate' };

test('wantsPending truth table for a vr-outcome', () => {
  // un-pinned (the mean-reversion Pending page): a VR outcome never makes "Go to pending" the main button
  expect(wantsPending(upload(counts(1, 0, 0)))).toBe(false);
  // pinned to the VR run the fills went to
  expect(wantsPending(upload(counts(1, 0, 0)), 5)).toBe(true);
  // pinned to another run
  expect(wantsPending(upload(counts(1, 0, 0)), 6)).toBe(false);
  // nothing waiting, or a duplicate: never
  expect(wantsPending(upload(counts(0, 2, 0)), 5)).toBe(false);
  expect(wantsPending(upload(vr('duplicate')), 5)).toBe(false);
  // beside a duplicate mean-reversion outcome
  expect(wantsPending(upload(MR_DUPLICATE, counts(1, 0, 0)), 5)).toBe(true);
  expect(wantsPending(upload(MR_DUPLICATE, counts(1, 0, 0)), 6)).toBe(false);
  expect(wantsPending([{ events: [MR_DUPLICATE] }, { events: [counts(2, 0, 0)] }], 5)).toBe(true);
});

test('wantsPending: mean-reversion outcomes answer as before, pinned or not', () => {
  expect(wantsPending(upload(MR_PENDING))).toBe(true);
  expect(wantsPending(upload(MR_PENDING), 1)).toBe(true);
  expect(wantsPending(upload(MR_DUPLICATE))).toBe(false);
  expect(wantsPending(upload(MR_DUPLICATE), 5)).toBe(false);
  expect(wantsPending([{}])).toBe(false);
});
