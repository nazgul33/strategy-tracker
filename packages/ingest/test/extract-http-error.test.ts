import { expect, test } from 'bun:test';
import { extractFills } from '@st/ingest';

const CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 };

function failWith(status: number, body: string | (() => Promise<string>) | undefined): typeof fetch {
  const res: Record<string, unknown> = { ok: false, status };
  if (typeof body === 'string') res.text = async () => body;
  else if (body !== undefined) res.text = body;
  return (async () => res) as unknown as typeof fetch;
}

async function detailOf(fetchImpl: typeof fetch, cfg = CFG) {
  const r = await extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, fetchImpl);
  return r.ok ? null : [r.reason, r.detail];
}

test('OpenAI error shape: error.message', async () => {
  const body = JSON.stringify({ error: { message: "The model 'x' is not loaded; currently serving 'y'", type: 'invalid_request_error' } })
  expect(await detailOf(failWith(404, body))).toEqual(['http', "http 404: The model 'x' is not loaded; currently serving 'y'"])
})
test('top-level string error, then top-level message', async () => {
  expect(await detailOf(failWith(404, '{"error":"model not found"}'))).toEqual(['http', 'http 404: model not found'])
  expect(await detailOf(failWith(401, '{"message":"Unauthorized"}'))).toEqual(['http', 'http 401: Unauthorized'])
})
test('other JSON and plain text are used as the body text', async () => {
  expect(await detailOf(failWith(404, '{"detail":"Not Found"}'))).toEqual(['http', 'http 404: {"detail":"Not Found"}'])
  expect(await detailOf(failWith(502, 'Bad Gateway'))).toEqual(['http', 'http 502: Bad Gateway'])
})
test('trailing periods are trimmed; a message of only periods leaves http <status>', async () => {
  expect(await detailOf(failWith(404, 'Model not found.'))).toEqual(['http', 'http 404: Model not found'])
  expect(await detailOf(failWith(404, '{"error":{"message":"Model not found. "}}'))).toEqual(['http', 'http 404: Model not found'])
  expect(await detailOf(failWith(404, '...'))).toEqual(['http', 'http 404'])
})
test('an HTML error page collapses to one line', async () => {
  expect(await detailOf(failWith(502, '<html>\n  <body>\n\t<h1>502 Bad Gateway</h1>\n  </body>\n</html>\n')))
    .toEqual(['http', 'http 502: <html> <body> <h1>502 Bad Gateway</h1> </body> </html>'])
})
test('empty, whitespace-only, unreadable or missing body keeps http <status>', async () => {
  expect(await detailOf(failWith(500, ''))).toEqual(['http', 'http 500'])
  expect(await detailOf(failWith(500, '  \n\t '))).toEqual(['http', 'http 500'])
  expect(await detailOf(failWith(503, async () => { throw new Error('stream broke') }))).toEqual(['http', 'http 503'])
  expect(await detailOf(failWith(500, undefined))).toEqual(['http', 'http 500'])
})
test('cap: 200 code points kept whole, 201 cut to 199 plus an ellipsis', async () => {
  expect(await detailOf(failWith(400, 'a'.repeat(200)))).toEqual(['http', `http 400: ${'a'.repeat(200)}`])
  expect(await detailOf(failWith(400, 'a'.repeat(201)))).toEqual(['http', `http 400: ${'a'.repeat(199)}…`])
  // the cap applies after collapsing: 266 raw characters, 200 after
  const spaced = Array(67).fill('ab').join('\n\n')
  expect(await detailOf(failWith(400, spaced))).toEqual(['http', `http 400: ${Array(67).fill('ab').join(' ')}`])
})
test('a long run of periods that is not at the end is handled in linear time', async () => {
  const started = performance.now()
  expect(await detailOf(failWith(500, '.'.repeat(200_000) + 'x'))).toEqual(['http', `http 500: ${'.'.repeat(199)}…`])
  expect(performance.now() - started).toBeLessThan(1000)
})
test('the body is read only on a non-OK answer', async () => {
  let textCalls = 0
  const ok = (async () => ({ ok: true, status: 200, text: async () => { textCalls++; return '' }, json: async () => ({ choices: [{ message: { content: '{"fills":[]}' } }] }) })) as unknown as typeof fetch
  expect(await detailOf(ok)).toEqual(['empty', 'no valid fills'])
  expect(textCalls).toBe(0)
})
test('a network failure keeps the thrown message', async () => {
  const down = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234') }) as unknown as typeof fetch
  expect(await detailOf(down)).toEqual(['http', 'connect ECONNREFUSED 127.0.0.1:1234'])
  const hangUp = (async () => { throw new Error('socket hang up.') }) as unknown as typeof fetch
  expect(await detailOf(hangUp)).toEqual(['http', 'socket hang up'])
})
test('the whole key and 8+ character runs of it are redacted; masked forms and short runs are kept', async () => {
  const KEY = 'sk-LEAKCHECK-7f3a9c2e'
  const cfg = { ...CFG, apiKey: KEY }
  const masked = JSON.stringify({ error: { message: 'Incorrect API key provided: sk-LEA*********9c2e. You can find your API key at https://x.' } })
  expect(await detailOf(failWith(401, masked), cfg)).toEqual(['http', 'http 401: Incorrect API key provided: sk-LEA*********9c2e. You can find your API key at https://x'])
  expect(await detailOf(failWith(401, `bad key ${KEY}`), cfg)).toEqual(['http', 'http 401: bad key [redacted]'])
  expect(await detailOf(failWith(401, 'key ending CHECK-7f3a9c2e rejected'), cfg)).toEqual(['http', 'http 401: key ending [redacted] rejected'])
  expect(await detailOf(failWith(401, 'key ending 7f3a9c2 rejected'), cfg)).toEqual(['http', 'http 401: key ending 7f3a9c2 rejected'])
  const thrown = (async () => { throw new Error(`refused for Bearer ${KEY}`) }) as unknown as typeof fetch
  expect(await detailOf(thrown, cfg)).toEqual(['http', 'refused for Bearer [redacted]'])
})
test('ordinary words sharing short runs with the key are kept; short keys match whole only', async () => {
  expect(await detailOf(failWith(404, 'project not found for this deployment'), { ...CFG, apiKey: 'sk-proj-abcdef123456' }))
    .toEqual(['http', 'http 404: project not found for this deployment'])
  expect(await detailOf(failWith(401, 'token abcde refused, abcd ok'), { ...CFG, apiKey: 'abcde' }))
    .toEqual(['http', 'http 401: token [redacted] refused, abcd ok'])
  expect(await detailOf(failWith(401, 'kick back k'), { ...CFG, apiKey: 'k' })).toEqual(['http', 'http 401: kick back k'])
})
