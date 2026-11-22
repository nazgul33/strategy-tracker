import { describe, expect, it } from 'bun:test';

import { ApiError, NetworkError } from './api';
import { lookup } from './i18n/catalog';
import { visionReviewErrorText } from './visionreviewerrors';

const en = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);
const ko = (k: string, p?: Record<string, string | number>) => lookup('ko', k, p);

describe('visionReviewErrorText', () => {
  it('words an unreachable server', () => {
    expect(visionReviewErrorText(new NetworkError('Failed to fetch'), en)).toBe(en('errNetwork'));
  });

  it('words a 5xx status as a server error with its code', () => {
    expect(visionReviewErrorText(new ApiError(500, 'boom' as never), en)).toBe(
      en('visionReviewErr.server', { code: 'boom' }),
    );
  });

  it('words an http-5xx code as a server error even when the status is lower', () => {
    expect(visionReviewErrorText(new ApiError(503, 'http-503'), en)).toBe(
      en('visionReviewErr.server', { code: 'http-503' }),
    );
    expect(visionReviewErrorText(new ApiError(400, 'http-502'), en)).toBe(
      en('visionReviewErr.server', { code: 'http-502' }),
    );
  });

  it('words any other ApiError as a failed request with its code', () => {
    expect(visionReviewErrorText(new ApiError(409, 'whatever' as never), en)).toBe(
      en('visionReviewErr.other', { code: 'whatever' }),
    );
  });

  it('keeps the message of a plain Error and the text of anything else', () => {
    expect(visionReviewErrorText(new Error('x'), en)).toBe('x');
    expect(visionReviewErrorText('raw', en)).toBe('raw');
  });

  it('words the server error in Korean', () => {
    const text = visionReviewErrorText(new ApiError(500, 'boom' as never), ko);
    expect(text).toBe('서버 오류가 발생했습니다 (boom). 다시 시도하세요.');
  });
});
