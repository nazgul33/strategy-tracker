import { expect, test } from 'bun:test';

import type { VisionInUseDto } from './api';
import { lookup } from './i18n/catalog';
import { captureEventLines } from './uploadlines';

const ko = (k: string, p?: Record<string, string | number>) => lookup('ko', k, p);

const VISION: VisionInUseDto = { model: 'qwen2.5-vl', modelSource: 'settings', baseUrl: 'http://lm:1234/v1', baseUrlSource: 'env', keySource: 'none' };

// The expected strings are copied from the Telegram catalog (packages/telegram/src/i18n.ts), so
// both channels word a failure the same way in Korean.
test('ko: each kind reads as on Telegram', () => {
  const texts = (event: Parameters<typeof captureEventLines>[0]) => captureEventLines(event, ko).map((l) => l.text);

  expect(texts({ type: 'bad-extract', reason: 'http', detail: 'http 404: Not Found', vision: VISION })).toEqual([
    '비전 서비스가 요청을 받아들이지 않았습니다 — http 404: Not Found.',
    '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (API Key 없음).',
    '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.',
  ]);

  expect(texts({ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: { ...VISION, keySource: 'settings' } })).toEqual([
    '비전 모델이 응답했지만 트래커가 이해할 수 있는 형식이 아닙니다 — no json. 다시 시도하고, 계속 반복되면 비전 모델을 확인하세요.',
    '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (설정).',
  ]);

  expect(texts({ type: 'bad-extract', reason: 'empty', detail: 'no valid fills' })).toEqual([
    '이 이미지에서 체결을 찾지 못했습니다. 체결 내역 화면인지 확인하거나 체결을 직접 예약하세요.',
  ]);
});
