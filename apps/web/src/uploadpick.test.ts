import { describe, expect, test } from 'bun:test';

import { MAX_UPLOAD_BYTES, UPLOAD_MIMES, fileSizeText, pickRefusal } from './uploadpick';

describe('pickRefusal', () => {
  test('accepts the four image types up to 8 MB', () => {
    for (const type of UPLOAD_MIMES) expect(pickRefusal({ type, size: MAX_UPLOAD_BYTES })).toBeNull();
  });

  test('refuses other types first', () => {
    for (const type of ['', 'image/heic', 'application/pdf']) {
      expect(pickRefusal({ type, size: 10 })).toBe('unsupported-image');
      expect(pickRefusal({ type, size: MAX_UPLOAD_BYTES + 1 })).toBe('unsupported-image');
    }
  });

  test('refuses above 8 MB', () => {
    expect(pickRefusal({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 })).toBe('image-too-large');
  });
});

describe('fileSizeText', () => {
  test('KB below 1 MiB, one-decimal MB above', () => {
    expect(fileSizeText(412 * 1024)).toBe('412 KB');
    expect(fileSizeText(10)).toBe('1 KB');
    expect(fileSizeText(3 * 1048576 + 104858)).toBe('3.1 MB');
  });
});
