import { expect, test } from 'bun:test';
import { extractFills } from '@st/ingest';

const CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };
const IMG = [{ base64: 'AAA', mime: 'image/png' }];

const answer = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
const real = (res: () => Response) => (async () => res()) as unknown as typeof fetch;

test('a 200 answer that states an error is a refused request with that error', async () => {
  const cases: Array<[unknown, string]> = [
    [{ error: { message: 'Rate limit exceeded', code: 429 } }, 'http 200: Rate limit exceeded'],
    [{ error: 'model overloaded' }, 'http 200: model overloaded'],
    [{ message: 'Unauthorized.' }, 'http 200: Unauthorized'],
    [{ detail: 'Not Found' }, 'http 200: Not Found'],
    [{ error: { message: 'x' } }, 'http 200: x'],
  ];
  for (const [body, detail] of cases) {
    expect(await extractFills(IMG, CFG, answer(body))).toEqual({ ok: false, reason: 'http', detail });
  }
});

test('the key is masked in a 200 error', async () => {
  const cfg = { ...CFG, apiKey: 'sk-LEAKCHECK-7f3a9c2e' };
  expect(await extractFills(IMG, cfg, answer({ error: { message: 'bad key sk-LEAKCHECK-7f3a9c2e here' } })))
    .toEqual({ ok: false, reason: 'http', detail: 'http 200: bad key sk-L....9c2e here' });
});

test('a 200 answer without a stated error stays incompatible', async () => {
  const bodies = [{}, { error: {} }, { error: { message: '   ' } }, { error: { message: '...' } }, { choices: [] }, []];
  for (const body of bodies) {
    expect(await extractFills(IMG, CFG, answer(body))).toEqual({ ok: false, reason: 'incompatible', detail: 'no content' });
  }
});

test('a reply with a message object is not treated as an error', async () => {
  expect(await extractFills(IMG, CFG, answer({ error: { message: 'x' }, choices: [{ message: { content: null } }] })))
    .toEqual({ ok: false, reason: 'unparseable', detail: 'no content' });
});

test('a real non-JSON 200 response is incompatible', async () => {
  const html = () => new Response('<html><body>hello</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  expect(await extractFills(IMG, CFG, real(html))).toEqual({ ok: false, reason: 'incompatible', detail: 'response body not json' });
});

test('a real empty 200 response is incompatible', async () => {
  const empty = () => new Response('', { status: 200 });
  expect(await extractFills(IMG, CFG, real(empty))).toEqual({ ok: false, reason: 'incompatible', detail: 'response body not json' });
});
