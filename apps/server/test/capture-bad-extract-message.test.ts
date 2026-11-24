import { describe, expect, test } from 'bun:test';
import { badExtractMessage } from '../src/wire/capture-bad-extract-message';
import type { VisionInUse } from '../src/wire/capture-route';

const VISION: VisionInUse = { model: 'qwen2.5-vl', modelSource: 'settings', baseUrl: 'http://lm:1234/v1', baseUrlSource: 'env', keySource: 'none' };
const ADVICE_EN = 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.';
const ADVICE_KO = '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.';

describe('badExtractMessage', () => {
  test('http: main line, in-use line, setup advice', () => {
    expect(badExtractMessage({ type: 'bad-extract', reason: 'http', detail: "http 404: The model 'x' is not loaded", vision: VISION }, 'en')).toBe([
      "The vision service did not accept the request — http 404: The model 'x' is not loaded.",
      'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (not set).',
      ADVICE_EN,
    ].join('\n'));
  });

  test('unparseable: main line and in-use line, no advice', () => {
    expect(badExtractMessage({ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: { ...VISION, keySource: 'env' } }, 'en')).toBe([
      'The vision model answered, but not in a form the tracker understands — no json. Try again; if it keeps happening, check the vision model.',
      'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).',
    ].join('\n'));
  });

  test('empty: main line only', () => {
    expect(badExtractMessage({ type: 'bad-extract', reason: 'empty', detail: 'no valid fills' }, 'en'))
      .toBe('No fills were found in this image. Check that it shows the fills list, or book the fill manually.');
  });

  test('Korean, same three events', () => {
    expect(badExtractMessage({ type: 'bad-extract', reason: 'http', detail: "http 404: The model 'x' is not loaded", vision: VISION }, 'ko')).toBe([
      "비전 서비스가 요청을 받아들이지 않았습니다 — http 404: The model 'x' is not loaded.",
      '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (API Key 없음).',
      ADVICE_KO,
    ].join('\n'));
    expect(badExtractMessage({ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: { ...VISION, keySource: 'env' } }, 'ko')).toBe([
      '비전 모델이 응답했지만 트래커가 이해할 수 있는 형식이 아닙니다 — no json. 다시 시도하고, 계속 반복되면 비전 모델을 확인하세요.',
      '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (환경변수).',
    ].join('\n'));
    expect(badExtractMessage({ type: 'bad-extract', reason: 'empty', detail: 'no valid fills' }, 'ko'))
      .toBe('이 이미지에서 체결을 찾지 못했습니다. 체결 내역 화면인지 확인하거나 체결을 직접 예약하세요.');
  });

  test('a detail with brace text is not substituted', () => {
    expect(badExtractMessage({ type: 'bad-extract', reason: 'http', detail: 'http 400: unknown field {model}', vision: VISION }, 'en').split('\n')[0])
      .toBe('The vision service did not accept the request — http 400: unknown field {model}.');
  });
});
