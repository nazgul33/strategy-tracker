// Upload popup fixtures. They need a registered DOM (window/document) at call time, not at import time.
import type { act as ReactAct } from 'react';
import { elementByTestId, inputByTestId } from './dom';
import { json } from './fetchStub';

type Act = typeof ReactAct;

let objectUrlCount = 0;

// Thumbnails come from object URLs; give the DOM a stand-in when it has none.
function ensureObjectUrls(): void {
  if (typeof URL.createObjectURL === 'function') return;
  URL.createObjectURL = () => {
    objectUrlCount += 1;
    return `blob:test/${objectUrlCount}`;
  };
  URL.revokeObjectURL = () => {};
}

export function imageFile(name: string, opts: { type?: string; size?: number } = {}): File {
  ensureObjectUrls();
  return new File([new Uint8Array(opts.size ?? 4)], name, { type: opts.type ?? 'image/png' });
}

export async function pickFiles(act: Act, files: File[]): Promise<void> {
  const input = inputByTestId('uploadInput');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export async function dropFiles(act: Act, files: File[]): Promise<void> {
  const zone = elementByTestId('uploadDrop');
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  await act(async () => {
    zone.dispatchEvent(event);
  });
}

export async function pasteFiles(act: Act, files: File[]): Promise<void> {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files } });
  await act(async () => {
    window.dispatchEvent(event);
  });
}

export type UploadAnswer = { status?: number; json: unknown } | 'network-error';

/**
 * Answers `POST /api/captures` from `answers` in order and records what each request carried.
 * Call it after `installFetchStub`, so `restoreFetch()` still puts the original back. Every
 * request still goes through the fetch installed before, and an upload's answer replaces what
 * came back: a `holdNext` installed first holds the upload after it is recorded in `sent`.
 */
export function stubUploads(answers: UploadAnswer[]): { sent: { name: string; runId: string | null }[] } {
  const inner = globalThis.fetch;
  const queue = [...answers];
  const sent: { name: string; runId: string | null }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'POST' || !String(input).includes('/api/captures')) return inner(input, init);
    const form = init?.body instanceof FormData ? init.body : new FormData();
    const image = form.get('image');
    const runId = form.get('runId');
    sent.push({ name: image instanceof File ? image.name : '', runId: typeof runId === 'string' ? runId : null });
    const answer = queue.shift();
    return inner(input, init).then(() => {
      if (answer === undefined) throw new Error('stubUploads: no answer left');
      if (answer === 'network-error') throw new TypeError('Failed to fetch');
      return json(answer.json, answer.status ?? 200);
    });
  }) as typeof fetch;
  return { sent };
}

/** Counts the GET requests whose URL contains `urlPart` from now on (wraps the installed fetch). */
export function countGets(urlPart: string): () => number {
  const inner = globalThis.fetch;
  let count = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'GET' && String(input).includes(urlPart)) count += 1;
    return inner(input, init);
  }) as typeof fetch;
  return () => count;
}
