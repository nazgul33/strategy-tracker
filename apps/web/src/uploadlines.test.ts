import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError } from './api';
import type { CaptureConflictDto, CaptureEventDto, CapturePendingRowDto, VisionInUseDto } from './api';
import { lookup } from './i18n/catalog';
import { captureEventLines, uploadErrorLines, uploadItemLines, wantsPending } from './uploadlines';

const t = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);

const VISION: VisionInUseDto = { model: 'qwen2.5-vl', modelSource: 'settings', baseUrl: 'http://lm:1234/v1', baseUrlSource: 'env', keySource: 'none' };

const row = (over: Partial<CapturePendingRowDto> = {}): CapturePendingRowDto => ({
  id: 1,
  runId: 7,
  captureId: 3,
  side: 'buy',
  ticker: 'NVDA',
  shares: 10,
  price: '131.20',
  fee: null,
  filledOn: '2026-11-23',
  detectedFilledOn: '2026-11-23',
  status: 'pending',
  needsBucket: false,
  dateAfterToday: false,
  mergeHint: false,
  ...over,
});

const base = { side: 'buy' as const, ticker: 'NVDA', shares: 5, extractedPrice: '130.00', extractedFee: null, filledOn: '2026-11-20' };
const booked = (correction: Extract<CaptureConflictDto, { matchedKind: 'booked' }>['correction']): CaptureConflictDto => ({
  ...base,
  matchedKind: 'booked',
  bookedId: 12,
  bookedPrice: '131.00',
  correction,
});
const pendingConflict: CaptureConflictDto = { ...base, matchedKind: 'pending', pendingId: 44, pendingPrice: '129.50' };

const outcome = (o: Extract<CaptureEventDto, { type: 'outcome' }>['outcome']): CaptureEventDto => ({ type: 'outcome', runId: 7, ticker: 'NVDA', outcome: o });

const view = (lines: ReturnType<typeof captureEventLines>) => lines.map(({ tone, depth, text, href }) => ({ tone, depth, text, href }));

describe('captureEventLines', () => {
  test('pending rows: head with run link, fill lines, and the three fix-in-Pending reasons', () => {
    const lines = captureEventLines(
      outcome({
        pending: [
          row(),
          row({ id: 2, side: 'sell', shares: 10, price: '134.05', filledOn: '2026-11-23', detectedFilledOn: null, dateAfterToday: true, needsBucket: true }),
        ],
      }),
      t,
    );
    expect(view(lines)).toEqual([
      { tone: 'ok', depth: 0, text: 'NVDA → run #7: 2 waiting in Pending', href: '#/runs/7' },
      { tone: 'ok', depth: 1, text: 'Buy 10 @ $131.20 on 2026-11-23', href: undefined },
      { tone: 'ok', depth: 1, text: 'Sell 10 @ $134.05 on 2026-11-23', href: undefined },
      { tone: 'warn', depth: 2, text: 'No trade date was read, so 2026-11-23 was used — check it in Pending.', href: undefined },
      { tone: 'warn', depth: 2, text: 'The trade date read (2026-11-23) is after today — fix it in Pending.', href: undefined },
      { tone: 'warn', depth: 2, text: 'Choose the bucket in Pending.', href: undefined },
    ]);
    expect(lines.map((l) => l.depth)).toEqual([0, 1, 1, 2, 2, 2]);
  });

  test('booked-earlier warning sits above the pending head', () => {
    const lines = captureEventLines(outcome({ pending: [row()], bookedEarlier: true }), t);
    expect(view(lines)).toEqual([
      { tone: 'warn', depth: 0, text: 'Fills from this image were already confirmed earlier — the rows below may be duplicates. Check before confirming.', href: undefined },
      { tone: 'ok', depth: 0, text: 'NVDA → run #7: 1 waiting in Pending', href: '#/runs/7' },
      { tone: 'ok', depth: 1, text: 'Buy 10 @ $131.20 on 2026-11-23', href: undefined },
    ]);
    // Without pending rows there is nothing the warning could be about.
    expect(captureEventLines(outcome({ bookedEarlier: true, conflicts: [booked({ id: 1, status: 'open' })] }), t).map((l) => l.text)).not.toContain(
      t('upload.bookedEarlier'),
    );
  });

  test('conflicts: head only beside pending rows, and the four variants worded like the bot', () => {
    const conflicts = [booked({ id: 1, status: 'open' }), booked({ id: 2, status: 'dismissed' }), booked({ id: null, status: 'fill-gone' }), pendingConflict];
    expect(view(captureEventLines(outcome({ conflicts }), t))).toEqual([
      { tone: 'warn', depth: 0, text: 'Buy 5 NVDA on 2026-11-20 — read $130.00, booked fill #12 has $131.00. Correction listed in Pending.', href: undefined },
      { tone: 'info', depth: 0, text: 'Buy 5 NVDA on 2026-11-20 — read $130.00, booked fill #12 has $131.00. You dismissed this correction before; not listed again.', href: undefined },
      { tone: 'warn', depth: 0, text: 'Buy 5 NVDA on 2026-11-20 — read $130.00, but booked fill #12 no longer exists. Nothing to correct.', href: undefined },
      { tone: 'warn', depth: 0, text: 'Buy 5 NVDA on 2026-11-20 — read $130.00, but pending row #44 has $129.50. Resolve that row first.', href: undefined },
    ]);
    // A booked conflict without a correction row reads like an open one.
    expect(captureEventLines(outcome({ conflicts: [booked(null)] }), t)[0]!.text).toBe(
      'Buy 5 NVDA on 2026-11-20 — read $130.00, booked fill #12 has $131.00. Correction listed in Pending.',
    );

    const mixed = captureEventLines(outcome({ pending: [row()], conflicts: [pendingConflict] }), t);
    expect(view(mixed).slice(0, 3)).toEqual([
      { tone: 'warn', depth: 0, text: 'Conflicts — these were not booked:', href: undefined },
      { tone: 'warn', depth: 0, text: 'Buy 5 NVDA on 2026-11-20 — read $130.00, but pending row #44 has $129.50. Resolve that row first.', href: undefined },
      { tone: 'ok', depth: 0, text: 'NVDA → run #7: 1 waiting in Pending', href: '#/runs/7' },
    ]);
  });

  test('duplicate', () => {
    expect(view(captureEventLines(outcome('duplicate'), t))).toEqual([
      { tone: 'info', depth: 0, text: 'Already uploaded, nothing new — every fill is booked or pending, or a correction is waiting in Pending.', href: undefined },
    ]);
  });

  const emptyLine = {
    tone: 'error',
    depth: 0,
    text: 'No fills were found in this image. Check that it shows the fills list, or book the fill manually.',
    href: undefined,
  } as const;

  test('rejected', () => {
    expect(view(captureEventLines(outcome('rejected'), t))).toEqual([emptyLine]);
  });

  test('bad-extract empty', () => {
    expect(view(captureEventLines({ type: 'bad-extract', reason: 'empty', detail: 'no fills recognized' }, t))).toEqual([emptyLine]);
  });

  test('bad-extract http: error, the vision config in use, the setup advice linking to Settings, and the original error', () => {
    expect(view(captureEventLines({ type: 'bad-extract', reason: 'http', detail: "http 404: The model 'x' is not loaded", vision: VISION }, t))).toEqual([
      { tone: 'error', depth: 0, text: 'The vision service did not accept the request.', href: undefined },
      { tone: 'info', depth: 1, text: 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (not set).', href: undefined },
      {
        tone: 'info',
        depth: 1,
        text: 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.',
        href: '#/settings',
      },
      { tone: 'info', depth: 1, text: "Original error: http 404: The model 'x' is not loaded", href: undefined },
    ]);
  });

  test('bad-extract incompatible: error, config in use, compatibility advice linking to Settings, and the original error', () => {
    expect(view(captureEventLines({ type: 'bad-extract', reason: 'incompatible', detail: 'response body not json', vision: { ...VISION, keySource: 'env' } }, t))).toEqual([
      { tone: 'error', depth: 0, text: 'The vision service answered, but not as an OpenAI-compatible API.', href: undefined },
      { tone: 'info', depth: 1, text: 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).', href: undefined },
      {
        tone: 'info',
        depth: 1,
        text: 'Make sure the configured vision API is OpenAI-compatible. A URL or model changed in Settings applies after a server restart.',
        href: '#/settings',
      },
      { tone: 'info', depth: 1, text: 'Original error: response body not json', href: undefined },
    ]);
  });

  test('bad-extract unparseable: error and the vision config in use, no advice', () => {
    expect(view(captureEventLines({ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: { ...VISION, keySource: 'env' } }, t))).toEqual([
      {
        tone: 'error',
        depth: 0,
        text: 'The vision model answered, but not in a form the tracker understands — no json. Try again; if it keeps happening, check the vision model.',
        href: undefined,
      },
      { tone: 'info', depth: 1, text: 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).', href: undefined },
    ]);
  });

  test('brace text in the detail stays literal', () => {
    expect(captureEventLines({ type: 'bad-extract', reason: 'http', detail: 'http 400: unknown field {model}', vision: VISION }, t)[3]!.text).toBe(
      'Original error: http 400: unknown field {model}',
    );
  });

  test('vision timeout', () => {
    expect(view(captureEventLines({ type: 'bad-extract', reason: 'http', detail: 'vision timed out', vision: VISION }, t))).toEqual([
      { tone: 'error', depth: 0, text: 'Vision took too long to answer — nothing was booked. Upload the file again.', href: undefined },
    ]);
  });

  test('no-run', () => {
    expect(view(captureEventLines({ type: 'no-run', ticker: 'AAPL' }, t))).toEqual([
      { tone: 'info', depth: 0, text: 'AAPL: no active run — open the run and upload from its page.', href: undefined },
    ]);
  });

  test('ambiguous', () => {
    expect(view(captureEventLines({ type: 'ambiguous', ticker: 'AAPL' }, t))).toEqual([
      { tone: 'info', depth: 0, text: 'AAPL: several active runs — open the run you mean and upload from its page.', href: undefined },
    ]);
  });

  test('pin-nomatch', () => {
    expect(view(captureEventLines({ type: 'pin-nomatch', runId: 1, ticker: 'NVDA' }, t))).toEqual([
      { tone: 'info', depth: 0, text: 'No NVDA fills in this image — run #1 unchanged.', href: undefined },
    ]);
  });

  test('pin-skipped', () => {
    expect(view(captureEventLines({ type: 'pin-skipped', runId: 1, tickers: ['AAPL', 'TSLA'] }, t))).toEqual([
      { tone: 'info', depth: 0, text: 'Ignored AAPL, TSLA — not the ticker of run #1.', href: undefined },
    ]);
  });
});

describe('uploadErrorLines', () => {
  test('request failures', () => {
    expect(view(uploadErrorLines(new NetworkError('x'), t))).toEqual([
      {
        tone: 'error',
        depth: 0,
        text: 'The connection dropped before the server answered. The capture may still have completed — check Pending before uploading again.',
        href: undefined,
      },
    ]);
    expect(view(uploadErrorLines(new ApiError(503, 'vision-not-configured'), t))).toEqual([
      {
        tone: 'error',
        depth: 0,
        text: 'Vision is not set up: set the vision base URL and model in Settings, then restart the server.',
        href: '#/settings',
      },
    ]);
    expect(view(uploadErrorLines(new ApiError(413, 'image-too-large'), t))).toEqual([
      { tone: 'error', depth: 0, text: 'This image is larger than 8 MB.', href: undefined },
    ]);
    expect(view(uploadErrorLines(new ApiError(500, 'capture-failed'), t))).toEqual([
      {
        tone: 'error',
        depth: 0,
        text: 'The server failed while reading this screenshot. Fills from part of it may already be in Pending — check there before uploading it again.',
        href: undefined,
      },
    ]);
  });

  test('a proxy answer without a JSON body, and a run that went away', () => {
    const text = (err: unknown) => uploadErrorLines(err, t).map((l) => l.text);
    expect(text(new ApiError(413, 'http-413'))).toEqual([
      'The upload was refused as too large before it reached the tracker. Images up to 8 MB are accepted, so a proxy in front of the server may have a lower limit.',
    ]);
    expect(text(new ApiError(502, 'http-502'))).toEqual([
      'The server did not answer. The capture may still have completed — check Pending before uploading again.',
    ]);
    expect(text(new ApiError(504, 'http-504'))).toEqual([
      'The server did not answer in time. The capture may still have completed — check Pending before uploading again.',
    ]);
    expect(text(new ApiError(404, 'no-run'))).toEqual(['This run no longer exists.']);
  });

  test('uploadItemLines prefers the error, else flattens the events', () => {
    expect(uploadItemLines({ error: new ApiError(413, 'image-too-large') }, t).map((l) => l.text)).toEqual(['This image is larger than 8 MB.']);
    expect(
      uploadItemLines({ events: [{ type: 'no-run', ticker: 'AAPL' }, { type: 'ambiguous', ticker: 'TSLA' }] }, t).map((l) => l.text),
    ).toEqual(['AAPL: no active run — open the run and upload from its page.', 'TSLA: several active runs — open the run you mean and upload from its page.']);
    expect(uploadItemLines({}, t)).toEqual([]);
  });
});

describe('wantsPending', () => {
  test('true for a pending row or an open booked correction, false otherwise', () => {
    expect(wantsPending([{ events: [outcome({ pending: [row()] })] }])).toBe(true);
    expect(wantsPending([{ events: [outcome({ conflicts: [booked({ id: 1, status: 'open' })] })] }])).toBe(true);
    expect(wantsPending([{ events: [{ type: 'no-run', ticker: 'X' }] }, { events: [outcome({ pending: [row()] })] }])).toBe(true);

    expect(wantsPending([{ events: [outcome('duplicate')] }])).toBe(false);
    expect(wantsPending([{ events: [{ type: 'no-run', ticker: 'X' }] }])).toBe(false);
    expect(wantsPending([{ events: [outcome({ conflicts: [booked({ id: 2, status: 'dismissed' }), booked({ id: null, status: 'fill-gone' })] })] }])).toBe(false);
    expect(wantsPending([{ events: [outcome({ conflicts: [pendingConflict] })] }])).toBe(false);
    expect(wantsPending([{ events: undefined }])).toBe(false);
    expect(wantsPending([])).toBe(false);
  });
});

describe('ko catalog', () => {
  test('ko catalog renders the fill line in Korean', () => {
    expect(lookup('ko', 'upload.fillLine', { side: '매수', shares: 10, price: '131.20', date: '2026-11-23' })).toBe('2026-11-23 매수 10주 @ $131.20');
  });

  test('ko catalog renders the vision in-use line with the Korean source words', () => {
    const params = {
      model: 'm',
      modelSource: lookup('ko', 'upload.visionSourceSettings'),
      baseUrl: 'u',
      baseUrlSource: lookup('ko', 'upload.visionSourceEnv'),
      keySource: lookup('ko', 'upload.visionSourceNone'),
    };
    expect(lookup('ko', 'upload.visionInUse', params)).toBe('사용 중: 모델 m (설정), URL u (환경변수), 키 (API Key 없음).');
  });
});
