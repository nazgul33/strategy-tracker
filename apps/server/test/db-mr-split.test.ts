import { describe, test, expect } from 'bun:test'
import { sql } from 'drizzle-orm'
import { applyMigrations } from '../src/db/client'
import {
  PRE_SPLIT_COUNT, RENAMES, INDEX_RENAMES, MOVED_COLUMNS, allMigrations, migrateThrough, withScratch, rows, seedPreSplit, dumpSchema, dumpData,
  type ScratchDb,
} from './mr-split-fixture'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip
const TIMEOUT = 120_000

// Each scenario is one real boot dying inside one migration file: `k` statements of file `fileIndex`
// ran (MariaDB DDL commits as it goes) but the file was never recorded.
const SCENARIOS: readonly (readonly [fileIndex: number, k: number])[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => [13, k] as const),
  ...[0, 1, 2].map((k) => [14, k] as const),
  ...[0, 1].map((k) => [15, k] as const),
]

const recordedCount = async (db: ScratchDb) => Number((await rows(db, 'SELECT COUNT(*) AS n FROM __drizzle_migrations'))[0]!.n)

const movedColumns = async (db: ScratchDb, table: string) =>
  (await rows(db, `SHOW FULL COLUMNS FROM ${table}`))
    .filter((r) => (MOVED_COLUMNS as readonly string[]).includes(String(r.Field)))
    .map((r) => ({ Field: r.Field, Type: r.Type, Null: r.Null, Default: r.Default, Collation: r.Collation }))
    .sort((a, b) => String(a.Field).localeCompare(String(b.Field)))

describeIf('mr split migrations (db)', () => {
  test('existing rows survive under the new names', async () => {
    await withScratch('survive', async (db) => {
      await migrateThrough(db, PRE_SPLIT_COUNT)
      await seedPreSplit(db)

      const before: Record<string, Record<string, unknown>[]> = {}
      for (const [from] of RENAMES) before[from] = await rows(db, `SELECT * FROM ${from} ORDER BY id`)
      const runsBefore = await rows(db, 'SELECT * FROM strategy_runs ORDER BY id')
      const captureBefore = await rows(db, 'SELECT * FROM captures ORDER BY id')
      expect(runsBefore).toHaveLength(3)
      const columnsBefore = await movedColumns(db, 'strategy_runs')

      // These assertions describe the schema right after 0015. When a later migration changes
      // strategy_runs or an mr_* table, replace this call with migrateThrough(db, 16).
      await applyMigrations(db)

      expect(await movedColumns(db, 'mr_runs')).toEqual(columnsBefore)

      for (const [from, to] of RENAMES) {
        expect(before[from]!.length).toBeGreaterThanOrEqual(2)
        expect(await rows(db, `SELECT * FROM ${to} ORDER BY id`)).toEqual(before[from]!)
        expect(await rows(db, `SHOW TABLES LIKE '${from}'`)).toEqual([])
      }

      expect(await rows(db, 'SELECT * FROM mr_runs ORDER BY run_id')).toEqual(
        runsBefore.map((r) => ({
          run_id: r.id, pool_cents: r.pool_cents, buy_gap_ppm: r.buy_gap_ppm, sell_gap_ppm: r.sell_gap_ppm, cut_loss_ppm: r.cut_loss_ppm, state_json: r.state_json,
        })),
      )

      const trimmed = runsBefore.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !(MOVED_COLUMNS as readonly string[]).includes(k))))
      expect(await rows(db, 'SELECT * FROM strategy_runs ORDER BY id')).toEqual(trimmed)
      const fields = (await rows(db, 'SHOW COLUMNS FROM strategy_runs')).map((r) => String(r.Field)).sort()
      expect(fields).toEqual(['id', 'strategy_key', 'ticker', 'name', 'cost_ppm', 'status', 'created_at'].sort())

      for (const [table, from, to] of INDEX_RENAMES) {
        const keys = (await rows(db, `SHOW INDEX FROM ${table}`)).map((r) => String(r.Key_name))
        expect(keys).toContain(to)
        expect(keys).not.toContain(from)
      }

      const [header] = await db.$client.query(
        "INSERT INTO mr_fills (run_id, bucket_idx, side, ticker, shares, price, fee, filled_on, source) VALUES (1, 0, 'buy', 'AAA', 1, 100, 0, '2026-02-12', 'manual')",
      )
      expect((header as { insertId: number }).insertId).toBe(4)

      const [runHeader] = await db.$client.query(
        "INSERT INTO strategy_runs (strategy_key, ticker, name, cost_ppm) VALUES ('mean-reversion', 'EEE', 'run-after', 10)",
      )
      expect((runHeader as { insertId: number }).insertId).toBe(5)

      expect(await rows(db, 'SELECT * FROM captures ORDER BY id')).toEqual(captureBefore)
    })
  }, TIMEOUT)

  test('a stale mr_runs row is refreshed from strategy_runs', async () => {
    await withScratch('stale', async (db) => {
      await migrateThrough(db, PRE_SPLIT_COUNT)
      await seedPreSplit(db)
      const runsBefore = await rows(db, 'SELECT * FROM strategy_runs ORDER BY id')
      expect(runsBefore).toHaveLength(3)

      await migrateThrough(db, 14)
      await db.execute(sql.raw(allMigrations()[14]!.sql[0]!))
      await db.$client.query(
        "INSERT INTO mr_runs (run_id, pool_cents, buy_gap_ppm, sell_gap_ppm, cut_loss_ppm, state_json) VALUES (1, 1, 0, 0, 0, '{}')",
      )
      await applyMigrations(db)

      expect(await rows(db, 'SELECT * FROM mr_runs ORDER BY run_id')).toEqual(
        runsBefore.map((r) => ({
          run_id: r.id, pool_cents: r.pool_cents, buy_gap_ppm: r.buy_gap_ppm, sell_gap_ppm: r.sell_gap_ppm, cut_loss_ppm: r.cut_loss_ppm, state_json: r.state_json,
        })),
      )
    })
  }, TIMEOUT)

  test('a fresh database ends at the split schema and a second boot changes nothing', async () => {
    await withScratch('fresh', async (db) => {
      await applyMigrations(db)
      const tables = (await rows(db, "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")).map((r) => String(r.name))
      for (const [from, to] of RENAMES) {
        expect(tables).not.toContain(from)
        expect(tables).toContain(to)
      }
      expect(tables).toContain('mr_runs')

      const first = await dumpSchema(db)
      expect(await recordedCount(db)).toBe(allMigrations().length)
      await applyMigrations(db)
      expect(await dumpSchema(db)).toEqual(first)
      expect(await recordedCount(db)).toBe(allMigrations().length)
    })
  }, TIMEOUT)

  describe('a boot that died mid-migration is finished by the next boot', () => {
    let reference: Promise<{ schema: Record<string, string>; data: Record<string, unknown[]> }> | undefined
    const getReference = () =>
      (reference ??= withScratch('ref', async (db) => {
        await migrateThrough(db, PRE_SPLIT_COUNT)
        await seedPreSplit(db)
        await applyMigrations(db)
        return { schema: await dumpSchema(db), data: await dumpData(db) }
      }))

    for (const [fileIndex, k] of SCENARIOS) {
      test(`file ${fileIndex} with ${k} statement(s) applied but unrecorded`, async () => {
        const ref = await getReference()
        await withScratch(`f${fileIndex}k${k}`, async (db) => {
          await migrateThrough(db, PRE_SPLIT_COUNT)
          await seedPreSplit(db)
          await migrateThrough(db, fileIndex)
          for (const stmt of allMigrations()[fileIndex]!.sql.slice(0, k)) await db.execute(sql.raw(stmt))
          await applyMigrations(db)
          expect(await dumpSchema(db)).toEqual(ref.schema)
          expect(await dumpData(db)).toEqual(ref.data)
          expect(await recordedCount(db)).toBe(allMigrations().length)
        })
      }, TIMEOUT)
    }
  })
})
