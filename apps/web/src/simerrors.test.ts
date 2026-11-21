import { describe, expect, test } from 'bun:test';

import { ApiError } from './api';
import type { ApiErrorCode } from './api';
import { lookup } from './i18n/catalog';
import { simErrorText } from './simerrors';

const en = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);
const ko = (k: string, p?: Record<string, string | number>) => lookup('ko', k, p);

describe('simErrorText', () => {
  test.each([
    ['market-data:http', "Couldn't reach the market data provider. Try again in a moment."],
    ['market-data:no-data', 'The market data provider has no prices for this ticker and date range.'],
    ['not-enough-bars', 'This date range has fewer than two trading days to simulate. Widen it.'],
    ['not-found', 'This simulation no longer exists.'],
    ['sim-finalized', 'This simulation is already saved and can no longer be changed.'],
  ])('maps %s to words', (code, text) => {
    expect(simErrorText(new ApiError(502, code as ApiErrorCode), en)).toBe(text);
  });

  test('any http-5xx fallback reads as a server error with its code', () => {
    expect(simErrorText(new ApiError(500, 'http-500'), en)).toBe('The server hit an error (http-500). Try again.');
    expect(simErrorText(new ApiError(503, 'http-503'), en)).toBe('The server hit an error (http-503). Try again.');
  });

  test('unknown codes fall back to the raw code', () => {
    expect(simErrorText(new ApiError(502, 'market-data:upstream' as ApiErrorCode), en)).toBe(
      'The request failed (market-data:upstream).',
    );
    expect(simErrorText(new ApiError(500, 'internal' as ApiErrorCode), en)).toBe('The request failed (internal).');
    expect(simErrorText(new ApiError(400, 'invalid from' as ApiErrorCode), en)).toBe(
      'The request failed (invalid from).',
    );
    expect(simErrorText(new ApiError(404, 'http-404'), en)).toBe('The request failed (http-404).');
  });

  test('a free-text code that equals a catalog key is not looked up', () => {
    expect(simErrorText(new ApiError(500, 'simErr.server' as ApiErrorCode), en)).toBe(
      'The request failed (simErr.server).',
    );
  });

  test('a non-API error shows its message', () => {
    expect(simErrorText(new Error('offline'), en)).toBe('offline');
  });

  test('anything else is stringified', () => {
    expect(simErrorText('boom', en)).toBe('boom');
  });

  test('ko copy', () => {
    expect(simErrorText(new ApiError(502, 'market-data:http' as ApiErrorCode), ko)).toBe(
      '시세 데이터 제공처에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
    expect(simErrorText(new ApiError(502, 'market-data:no-data' as ApiErrorCode), ko)).toBe(
      '시세 데이터 제공처에 이 티커와 기간의 가격이 없습니다.',
    );
    expect(simErrorText(new ApiError(422, 'not-enough-bars' as ApiErrorCode), ko)).toBe(
      '이 기간에는 시뮬레이션할 거래일이 두 개 미만입니다. 기간을 넓히세요.',
    );
    expect(simErrorText(new ApiError(404, 'not-found'), ko)).toBe('이 시뮬레이션은 더 이상 존재하지 않습니다.');
    expect(simErrorText(new ApiError(500, 'http-500'), ko)).toBe('서버 오류가 발생했습니다 (http-500). 다시 시도하세요.');
  });
});
