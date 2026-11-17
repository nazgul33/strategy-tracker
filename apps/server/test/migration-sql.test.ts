import { describe, test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

// The `draft = 0` backfill in 0007 is a hand-edit on top of what drizzle-kit
// generates, and the plan's number-one failure mode: without it every sim the
// operator saved before this migration hides behind the drafts UI. Regenerating
// 0007 drops the chunk, so this assertion must be visible on a plain `bun test` —
// db.test.ts replays it against a real database, but that block self-skips
// without TEST_DATABASE_URL.
describe('migration 0007 SQL', () => {
  const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))

  test('backfills draft = 0 for rows that existed before the migration', async () => {
    const [file] = [...new Bun.Glob('0007_*.sql').scanSync({ cwd: migrationsDir })].sort()
    expect(file).toBeDefined()
    const text = await Bun.file(migrationsDir + file).text()
    const backfill = text.split('--> statement-breakpoint').map((c) => c.trim()).find((c) => /UPDATE\s+`sim_runs`\s+SET\s+`draft`\s*=\s*0/.test(c))
    expect(backfill).toBeDefined()
  })
})
