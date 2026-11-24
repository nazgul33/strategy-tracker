import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError, createApi } from './api';
import type { Http } from './api';

function recording(respond: () => Response = () => Response.json({ events: [] })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, api: createApi(http, { getToken: () => 'tok' }) };
}

const png = () => new File([new Uint8Array(3)], 'a.png', { type: 'image/png' });

describe('uploadCapture', () => {
  test('posts the file as multipart with the bearer header and no content-type', async () => {
    const { calls, api } = recording();
    await api.uploadCapture(png(), 7);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('/api/captures');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    const image = form.get('image');
    expect(image).toBeInstanceOf(File);
    expect((image as File).name).toBe('a.png');
    expect(form.get('runId')).toBe('7');
    expect(init?.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  test('omits runId for a global upload', async () => {
    const { calls, api } = recording();
    await api.uploadCapture(png());
    expect((calls[0]!.init!.body as FormData).get('runId')).toBeNull();
  });

  test('resolves to the events', async () => {
    const { api } = recording(() => Response.json({ events: [{ type: 'no-run', ticker: 'TSLA' }] }));
    expect(await api.uploadCapture(png())).toEqual([{ type: 'no-run', ticker: 'TSLA' }]);
  });

  test('an error body becomes ApiError with the code', async () => {
    const { api } = recording(() => Response.json({ error: 'image-too-large' }, { status: 413 }));
    const err = await api.uploadCapture(png()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(413);
    expect((err as ApiError).code).toBe('image-too-large');
  });

  test('a thrown fetch becomes NetworkError', async () => {
    const api = createApi(() => Promise.reject(new TypeError('Failed to fetch')), { getToken: () => 'tok' });
    const err = await api.uploadCapture(png()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NetworkError);
  });
});
