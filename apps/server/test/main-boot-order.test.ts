import { test, expect } from 'bun:test'

// main() has no seam to inject a fake bot or server, so the order is pinned on the source: the
// screenshot janitor and the review rebuild are only safe while no confirm can be in flight.
test('main runs the boot sweeps before it starts the bot, the jobs and the HTTP server', async () => {
  const src = await Bun.file(new URL('../src/main.ts', import.meta.url)).text()
  const at = (needle: string) => { const i = src.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i }
  const sweeps = at('await runBootSweeps(')
  for (const later of ['createBot(', 'startJobs(', 'Bun.serve(']) expect(sweeps).toBeLessThan(at(later))
})

test('the HTTP server allows 60 idle seconds, so a 50-second vision read answers in time', async () => {
  const src = await Bun.file(new URL('../src/main.ts', import.meta.url)).text()
  expect(src).toMatch(/Bun\.serve\(\{\s*port: env\.port,\s*idleTimeout: 60,/)
  expect(src).toContain('settings.visionBaseUrl || env.visionBaseUrl')
  expect(src).toContain('settings.visionModel || env.visionModel')
})
