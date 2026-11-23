import { describe, expect, it } from 'bun:test';

import { ApiError, NetworkError } from './api';
import type { ApiErrorCode } from './api';
import { errorText } from './errortext';
import { lookup } from './i18n/catalog';

const en = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);
const ko = (k: string, p?: Record<string, string | number>) => lookup('ko', k, p);
const api = (status: number, code: string) => new ApiError(status, code as ApiErrorCode);

describe('errorText', () => {
  it('words an unreachable server, whatever the browser called it', () => {
    expect(errorText(new NetworkError('Failed to fetch'), en)).toBe('Could not reach the server. Check the connection and try again.');
    expect(errorText(new NetworkError('NetworkError when attempting to fetch resource.'), en, 'fillErr')).toBe(en('errNetwork'));
  });

  it('uses the prefixed catalog copy when the code has one', () => {
    expect(errorText(api(422, 'not-last'), en, 'fillErr')).toBe('Only the last fill of a bucket can be deleted.');
    expect(errorText(api(422, 'no-run'), en, 'recalcErr')).toBe('Run not found.');
    expect(errorText(api(500, 'pipeline-error'), en, 'triggerErr')).toBe(
      'The morning pipeline stopped before planning any run. See System notices below.',
    );
  });

  it('a code with no copy under the prefix, or no prefix at all, keeps its code in a worded fallback', () => {
    expect(errorText(api(422, 'weird-code'), en, 'fillErr')).toBe('The request failed (weird-code).');
    expect(errorText(api(422, 'not-last'), en)).toBe('The request failed (not-last).');
    expect(errorText(api(404, 'http-404'), en)).toBe('The request failed (http-404).');
    expect(errorText(api(401, 'unauthorized'), en)).toBe('The request failed (unauthorized).');
  });

  it('a 5xx status or an http-5xx code reads as a server problem', () => {
    const server = (code: string) =>
      `The server had a problem (${code}). Try again; if it keeps failing, check the server log.`;
    expect(errorText(api(500, 'http-500'), en)).toBe(server('http-500'));
    expect(errorText(api(502, 'http-502'), en, 'triggerErr')).toBe(server('http-502'));
    expect(errorText(api(500, 'apply-exploded'), en, 'fillErr')).toBe(server('apply-exploded'));
    expect(errorText(api(400, 'http-503'), en)).toBe(server('http-503'));
  });

  it('a server code cannot reach a catalog key outside its prefix', () => {
    expect(errorText(api(400, 'errNetwork'), en)).toBe('The request failed (errNetwork).');
    expect(errorText(api(400, 'not-last'), en, 'recalcErr')).toBe('The request failed (not-last).');
    expect(errorText(api(400, 'errNetwork'), en, 'fillErr')).toBe('The request failed (errNetwork).');
  });

  it('anything else keeps its own message', () => {
    expect(errorText(new Error('Check the values'), en, 'fillErr')).toBe('Check the values');
    expect(errorText('boom', en)).toBe('boom');
    expect(errorText(undefined, en)).toBe('undefined');
  });

  it('ko copy', () => {
    expect(errorText(new NetworkError('Failed to fetch'), ko)).toBe('서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.');
    expect(errorText(api(503, 'http-503'), ko)).toBe(
      '서버에 문제가 발생했습니다 (http-503). 다시 시도하고, 계속 실패하면 서버 로그를 확인하세요.',
    );
    expect(errorText(api(409, 'weird-code'), ko)).toBe('요청에 실패했습니다 (weird-code).');
    expect(errorText(api(500, 'pipeline-error'), ko, 'triggerErr')).toBe(
      '아침 파이프라인이 런을 하나도 계획하지 못하고 중단되었습니다. 아래 시스템 알림을 확인하세요.',
    );
  });
});
