import { fileURLToPath } from 'node:url'
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator'
import type { MySqlDialect, MySqlSession } from 'drizzle-orm/mysql-core'
import { getDb } from '../src/db/client'

// Shared by db-mr-split.test.ts only. Raw SQL throughout: the seed and the dumps must keep
// working after schema.ts stops describing the pre-split tables.
export const PRE_SPLIT_COUNT = 13

export const RENAMES: readonly (readonly [from: string, to: string])[] = [
  'pool_edits', 'buckets', 'orders', 'fills', 'ledger', 'pending_fills', 'fill_corrections', 'vision_reviews', 'sim_runs', 'sim_days',
].map((t) => [t, `mr_${t}`] as const)

export const INDEX_RENAMES: readonly (readonly [table: string, from: string, to: string])[] = [
  ['mr_orders', 'orders_run_trade_date_idx', 'mr_orders_run_trade_date_idx'],
  ['mr_orders', 'orders_trade_date_idx', 'mr_orders_trade_date_idx'],
  ['mr_vision_reviews', 'vision_reviews_pending_fill_unique', 'mr_vision_reviews_pending_fill_unique'],
  ['mr_vision_reviews', 'vision_reviews_capture_idx', 'mr_vision_reviews_capture_idx'],
  ['mr_fill_corrections', 'fill_corrections_fill_idx', 'mr_fill_corrections_fill_idx'],
  ['mr_sim_runs', 'sim_runs_draft_created_idx', 'mr_sim_runs_draft_created_idx'],
  ['mr_sim_days', 'sim_days_sim_run_trade_idx', 'mr_sim_days_sim_run_trade_idx'],
]

export const MOVED_COLUMNS = ['pool_cents', 'buy_gap_ppm', 'sell_gap_ppm', 'cut_loss_ppm', 'state_json'] as const

export type ScratchDb = Awaited<ReturnType<typeof getDb>>

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

export const allMigrations = (): MigrationMeta[] => readMigrationFiles({ migrationsFolder })

// Applies and records the first `count` files through drizzle's own recorder, exactly as a boot does.
export async function migrateThrough(db: ScratchDb, count: number): Promise<void> {
  const internal = db as unknown as { dialect: MySqlDialect; session: MySqlSession }
  await internal.dialect.migrate(allMigrations().slice(0, count), internal.session, { migrationsFolder })
}

export async function withScratch<T>(tag: string, fn: (db: ScratchDb) => Promise<T>): Promise<T> {
  const name = `st_mrsplit_${tag}_${Date.now().toString(36)}_${process.pid.toString(36)}`
  if (!/^st_mrsplit_[a-z0-9_]+$/.test(name)) throw new Error(`unexpected scratch db name '${name}'`)
  const url = new URL(process.env.TEST_DATABASE_URL!)
  const parent = await getDb(url.toString())
  let scratch: ScratchDb | undefined
  let created = false
  try {
    await parent.$client.query(`CREATE DATABASE \`${name}\``)
    created = true
    url.pathname = `/${name}`
    scratch = await getDb(url.toString())
    return await fn(scratch)
  } finally {
    try {
      await scratch?.$client.end()
      if (created) await parent.$client.query(`DROP DATABASE IF EXISTS \`${name}\``)
    } finally {
      await parent.$client.end()
    }
  }
}

export async function rows(db: ScratchDb, q: string): Promise<Record<string, unknown>[]> {
  const [r] = await db.$client.query(q)
  return (r as Record<string, unknown>[]).map((x) => ({ ...x }))
}

async function insert(db: ScratchDb, table: string, cols: string[], values: unknown[][]): Promise<void> {
  await db.$client.query(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ?`, [values])
}

const EMPTY_STATE = '{"buckets":[],"cashCents":0,"closed":[],"ages":{}}'
const HELD_STATE = '{"buckets":[{"index":0,"state":"held","shares":3,"buyPrice":"512300","buyFeeCents":2,"filledOn":"2026-02-10"}],"cashCents":1080810,"closed":[],"ages":{"0":4}}'
const T1 = '2026-02-10 15:30:00'
const T2 = '2026-02-11 09:45:30'

export async function seedPreSplit(db: ScratchDb): Promise<void> {
  const runCols = ['id', 'strategy_key', 'ticker', 'name', 'pool_cents', 'cost_ppm', 'status', 'state_json', 'created_at']
  await insert(db, 'strategy_runs', [...runCols, 'buy_gap_ppm', 'sell_gap_ppm', 'cut_loss_ppm'],
    [[1, 'mean-reversion', 'AAA', 'run-active', 1234500, 70, 'active', HELD_STATE, T1, 10000, 20000, 150000]])
  await insert(db, 'strategy_runs', runCols, [
    [2, 'mean-reversion', 'BBB', 'run-paused', 500000, 55, 'paused', EMPTY_STATE, T1],
    [3, 'mean-reversion', 'CCC', 'run-closed', 99900, 0, 'closed', EMPTY_STATE, T2],
  ])
  await insert(db, 'pool_edits', ['id', 'run_id', 'pool_cents', 'edited_at'], [[1, 1, 1200000, T1], [2, 1, 1234500, T2]])
  await insert(db, 'buckets', ['id', 'run_id', 'idx', 'state', 'shares', 'buy_price_myriadths', 'buy_fee_cents', 'filled_on'], [
    [1, 1, 0, 'held', 3, 512300, 2, '2026-02-10'],
    [2, 1, 1, 'empty', 0, null, 0, null],
  ])
  await insert(db, 'orders', ['id', 'run_id', 'trade_date', 'kind', 'bucket_idx', 'limit_price', 'shares', 'status', 'skip_reason', 'cancel_reason', 'reported_at'], [
    [1, 1, '2026-02-10', 'buy_loc', 0, 512300, 3, 'cancelled', 'no cash', 'operator', T2],
    [2, 1, '2026-02-11', 'sell_loc', 0, 530000, 3, 'open', null, null, null],
  ])
  await insert(db, 'fills', ['id', 'run_id', 'bucket_idx', 'side', 'ticker', 'shares', 'price', 'fee', 'filled_on', 'source', 'created_at'], [
    [1, 1, 0, 'buy', 'AAA', 3, 512300, 2, '2026-02-10', 'capture', T1],
    [2, 1, 0, 'sell', 'AAA', 3, 530000, 3, '2026-02-11', 'manual', T2],
    [3, 2, 1, 'buy', 'BBB', 1, 100000, 1, '2026-02-11', 'seed', T2],
  ])
  await insert(db, 'ledger', ['id', 'run_id', 'ts', 'kind', 'amount_cents', 'ref'], [
    [1, 1, T1, 'buy', -153690, 'fill:1'],
    [2, 1, T2, 'pool_edit', 34500, null],
  ])
  await insert(db, 'captures', ['id', 'run_id', 'chat_id', 'image_hash', 'status', 'created_at'], [[1, 1, 'chat-1', 'hash-1', 'parsed', T1]])
  await insert(db, 'pending_fills', [
    'id', 'run_id', 'capture_id', 'bucket_idx', 'side', 'ticker', 'shares', 'price', 'fee', 'filled_on', 'status', 'created_at',
    'detected_side', 'detected_shares', 'detected_price', 'detected_filled_on', 'detected_fee', 'detected_at', 'fee_override',
    'detected_order_type', 'detected_order_price', 'detected_ordered_shares',
  ], [
    [1, 1, 1, 0, 'buy', 'AAA', 3, 512300, 2, '2026-02-10', 'confirmed', T1, 'buy', 3, 512300, '2026-02-10', 2, T1, 'set', 'limit', 512000, 3],
    [2, 1, null, null, 'sell', 'AAA', 3, 530000, null, '2026-02-11', 'pending', T2, null, null, null, null, null, null, null, null, null, null],
  ])
  await insert(db, 'fill_corrections', [
    'id', 'run_id', 'fill_id', 'capture_id', 'side', 'ticker', 'booked_shares', 'booked_filled_on', 'booked_price', 'booked_fee', 'proposed_price', 'proposed_fee', 'status', 'created_at',
  ], [
    [1, 1, 1, 1, 'buy', 'AAA', 3, '2026-02-10', 512300, 2, 512000, 3, 'applied', T1],
    [2, 1, 2, null, 'sell', 'AAA', 3, '2026-02-11', 530000, 3, 531000, null, 'open', T2],
  ])
  await insert(db, 'vision_reviews', [
    'id', 'run_id', 'capture_id', 'pending_fill_id', 'ticker', 'outcome',
    'detected_side', 'detected_shares', 'detected_price', 'detected_filled_on', 'detected_fee',
    'final_side', 'final_shares', 'final_price', 'final_filled_on', 'final_fee', 'edited', 'fee_overridden', 'created_at',
  ], [
    [1, 1, 1, 1, 'AAA', 'confirmed', 'buy', 3, 512300, '2026-02-10', 2, 'buy', 3, 512300, '2026-02-10', 2, 1, 1, T1],
    [2, 1, 1, 2, 'AAA', 'rejected', null, null, null, null, null, null, null, null, null, null, 0, 0, T2],
  ])
  await insert(db, 'sim_runs', ['id', 'ticker', 'from_date', 'to_date', 'pool_cents', 'cost_ppm', 'params_json', 'created_at', 'buy_gap_ppm', 'sell_gap_ppm', 'cut_loss_ppm', 'draft'], [
    [1, 'AAA', '2026-01-02', '2026-02-27', 1000000, 70, '{"n":1}', T1, 10000, 20000, 150000, 0],
    [2, 'BBB', '2026-01-05', '2026-03-02', 500000, 55, '{"n":2}', T2, 0, 0, 0, 1],
  ])
  await insert(db, 'sim_days', ['id', 'sim_run_id', 'trade_date', 'plan_json', 'state_json', 'events_json'], [
    [1, 1, '2026-01-02', '{"orders":[]}', EMPTY_STATE, '[]'],
    [2, 1, '2026-01-05', '{"orders":[1]}', HELD_STATE, '[{"kind":"buy"}]'],
  ])
  await db.$client.query('DELETE FROM `fills` WHERE `id` = 3')
}

async function tableNames(db: ScratchDb): Promise<string[]> {
  const found = await rows(db, "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '__drizzle_migrations' ORDER BY TABLE_NAME")
  return found.map((r) => String(r.name))
}

export async function dumpSchema(db: ScratchDb): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const t of await tableNames(db)) {
    const [row] = await rows(db, `SHOW CREATE TABLE \`${t}\``)
    out[t] = String(row!['Create Table']).replace(/ AUTO_INCREMENT=\d+/, '')
  }
  return out
}

export async function dumpData(db: ScratchDb): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const t of await tableNames(db)) out[t] = await rows(db, `SELECT * FROM \`${t}\` ORDER BY 1`)
  return out
}
