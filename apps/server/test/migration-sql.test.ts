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
      /CREATE INDEX `sim_days_sim_run_trade_idx` ON `sim_days` \(`sim_run_id`,`trade_date`\)/,
      /DROP INDEX `sim_days_sim_run_idx` ON `sim_days`/,
    ]
    for (const re of want) expect(all).toMatch(re)
  })
})

// The backfill in 0010 is hand-appended, like 0007's: regenerating the migration drops it,
// and without it the first digest after deploy names every order that ever went stale.
describe('migration 0010 SQL', () => {
  const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))

  test('there is exactly one 0010 migration', () => {
    expect([...new Bun.Glob('0010_*.sql').scanSync({ cwd: migrationsDir })]).toHaveLength(1)
  })

  test('marks every already-stale order as reported, after the column exists', async () => {
    const [file] = [...new Bun.Glob('0010_*.sql').scanSync({ cwd: migrationsDir })].sort()
    expect(file).toBeDefined()
    const chunks = (await Bun.file(migrationsDir + file).text()).split('--> statement-breakpoint').map((c) => c.trim())
    const add = chunks.findIndex((c) => /ALTER TABLE `orders` ADD `reported_at` timestamp;/.test(c))
    const backfill = chunks.findIndex((c) => /UPDATE\s+`orders`\s+SET\s+`reported_at`\s*=\s*NOW\(\)\s+WHERE\s+`status`\s*=\s*'stale'/.test(c))
    expect(add).toBeGreaterThan(-1)
    expect(backfill).toBeGreaterThan(add)
  })
})

describe('mr split migrations', () => {
  const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))
  const TABLES = ['pool_edits', 'buckets', 'orders', 'fills', 'ledger', 'pending_fills', 'fill_corrections', 'vision_reviews', 'sim_runs', 'sim_days']
  const INDEXES = [
    ['mr_orders', 'orders_run_trade_date_idx'],
    ['mr_orders', 'orders_trade_date_idx'],
    ['mr_vision_reviews', 'vision_reviews_pending_fill_unique'],
    ['mr_vision_reviews', 'vision_reviews_capture_idx'],
    ['mr_fill_corrections', 'fill_corrections_fill_idx'],
    ['mr_sim_runs', 'sim_runs_draft_created_idx'],
    ['mr_sim_days', 'sim_days_sim_run_trade_idx'],
  ] as const
  const MOVED = ['pool_cents', 'buy_gap_ppm', 'sell_gap_ppm', 'cut_loss_ppm', 'state_json']
  const NEW_TAGS = ['0013_mr_rename_tables', '0014_mr_runs', '0015_strategy_runs_trim']
  const COPY_STATEMENT = `INSERT INTO \`mr_runs\` (\`run_id\`, \`pool_cents\`, \`buy_gap_ppm\`, \`sell_gap_ppm\`, \`cut_loss_ppm\`, \`state_json\`)
SELECT \`id\`, \`pool_cents\`, \`buy_gap_ppm\`, \`sell_gap_ppm\`, \`cut_loss_ppm\`, \`state_json\` FROM \`strategy_runs\`
ON DUPLICATE KEY UPDATE \`pool_cents\` = VALUES(\`pool_cents\`), \`buy_gap_ppm\` = VALUES(\`buy_gap_ppm\`), \`sell_gap_ppm\` = VALUES(\`sell_gap_ppm\`), \`cut_loss_ppm\` = VALUES(\`cut_loss_ppm\`), \`state_json\` = VALUES(\`state_json\`);`

  const statements = async (tag: string) =>
    (await Bun.file(`${migrationsDir}${tag}.sql`).text()).split('--> statement-breakpoint').map((c) => c.trim())

  test('journal timestamps strictly increase', async () => {
    const journal = (await Bun.file(`${migrationsDir}meta/_journal.json`).json()) as { entries: { when: number; tag: string }[] }
    journal.entries.forEach((e, i) => {
      if (i > 0) expect(e.when).toBeGreaterThan(journal.entries[i - 1]!.when)
    })
    expect(journal.entries.slice(13, 16).map((e) => e.tag)).toEqual(NEW_TAGS)
  })

  test('0013 renames ten tables in one statement, then seven indexes', async () => {
    const chunks = await statements('0013_mr_rename_tables')
    expect(chunks).toHaveLength(8)
    expect(chunks[0]!.startsWith('RENAME TABLE IF EXISTS')).toBe(true)
    for (const t of TABLES) expect(chunks[0]).toContain(`\`${t}\` TO \`mr_${t}\``)
    expect(chunks[0]!.split('` TO `')).toHaveLength(TABLES.length + 1)
    INDEXES.forEach(([table, old], i) => {
      expect(chunks[i + 1]).toBe(`ALTER TABLE \`${table}\` RENAME INDEX IF EXISTS \`${old}\` TO \`mr_${old}\`;`)
    })
  })

  test('0014 creates mr_runs and copies with an upsert', async () => {
    const chunks = await statements('0014_mr_runs')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.startsWith('CREATE TABLE IF NOT EXISTS `mr_runs`')).toBe(true)
    expect(chunks[1]!.startsWith('INSERT INTO `mr_runs`')).toBe(true)
    expect(chunks[1]).toContain('FROM `strategy_runs`')
    const normalise = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(normalise(chunks[1]!)).toBe(normalise(COPY_STATEMENT))
  })

  test('0015 drops the five moved columns in one statement', async () => {
    const chunks = await statements('0015_strategy_runs_trim')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.startsWith('ALTER TABLE `strategy_runs`')).toBe(true)
    for (const c of MOVED) expect(chunks[0]).toContain(`DROP COLUMN IF EXISTS \`${c}\``)
    expect(chunks[0]!.match(/DROP COLUMN/g)).toHaveLength(MOVED.length)
  })

  test('no new file both copies into mr_runs and drops a column', async () => {
    for (const tag of NEW_TAGS) {
      const text = await Bun.file(`${migrationsDir}${tag}.sql`).text()
      expect(/INSERT\s+(IGNORE\s+)?INTO\s+`mr_runs`/.test(text) && /DROP\s+COLUMN/i.test(text)).toBe(false)
    }
  })
})

describe('vr tables migration', () => {
  const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))

  test('the VR tables migration creates four tables and touches no other table', async () => {
    const files = [...new Bun.Glob('0016_*.sql').scanSync({ cwd: migrationsDir })]
    expect(files).toHaveLength(1)
    const text = await Bun.file(migrationsDir + files[0]).text()
    for (const t of ['vr_runs', 'vr_cycles', 'vr_fills', 'vr_cash_moves']) expect(text).toContain(`CREATE TABLE \`${t}\``)
    expect(text.match(/CREATE TABLE/g)).toHaveLength(4)
    expect(text).not.toMatch(/ALTER TABLE|DROP|RENAME/i)
    for (const m of text.matchAll(/(?:CREATE TABLE|ON) `(\w+)`/g)) expect(m[1]!.startsWith('vr_')).toBe(true)
  })
})
