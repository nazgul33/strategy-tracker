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

describe('migration indexes', () => {
  const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))

  test('the orders and sim sweep indexes exist', async () => {
    const files = [...new Bun.Glob('*.sql').scanSync({ cwd: migrationsDir })].sort()
    const all = (await Promise.all(files.map((f) => Bun.file(migrationsDir + f).text()))).join('\n')
    const want = [
      /CREATE INDEX `orders_run_trade_date_idx` ON `orders` \(`run_id`,`trade_date`\)/,
      /CREATE INDEX `orders_trade_date_idx` ON `orders` \(`trade_date`\)/,
      /CREATE INDEX `sim_runs_draft_created_idx` ON `sim_runs` \(`draft`,`created_at`\)/,
      /CREATE INDEX `sim_days_sim_run_idx` ON `sim_days` \(`sim_run_id`\)/,
    ]
    for (const re of want) expect(all).toMatch(re)
  })
})
