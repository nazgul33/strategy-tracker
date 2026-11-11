import { mysqlTable, bigint, int, varchar, text, date, timestamp, json, mysqlEnum } from 'drizzle-orm/mysql-core'

export const strategyRuns = mysqlTable('strategy_runs', {
  id: int('id').primaryKey().autoincrement(),
  strategyKey: varchar('strategy_key', { length: 64 }).notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  name: varchar('name', { length: 128 }).notNull().unique(),
  poolCents: int('pool_cents').notNull(),
  costPpm: int('cost_ppm').notNull(),
  status: mysqlEnum('status', ['active', 'paused', 'closed', 'done']).notNull().default('active'),
  stateJson: text('state_json').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

export const poolEdits = mysqlTable('pool_edits', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  poolCents: int('pool_cents').notNull(),
  editedAt: timestamp('edited_at', { mode: 'string' }).notNull().defaultNow(),
})

export const buckets = mysqlTable('buckets', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  idx: int('idx').notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  shares: int('shares').notNull().default(0),
  buyPriceMyriadths: bigint('buy_price_myriadths', { mode: 'bigint' }),
  buyFeeCents: int('buy_fee_cents').notNull().default(0),
  filledOn: date('filled_on', { mode: 'string' }),
})

export const orders = mysqlTable('orders', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  kind: mysqlEnum('kind', ['buy_loc', 'sell_loc', 'market_sell']).notNull(),
  bucketIdx: int('bucket_idx').notNull(),
  limitPrice: bigint('limit_price', { mode: 'bigint' }).notNull(),
  shares: int('shares').notNull(),
  status: mysqlEnum('status', ['open', 'filled', 'stale', 'cancelled']).notNull().default('open'),
  skipReason: text('skip_reason'),
})

export const captures = mysqlTable('captures', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  chatId: varchar('chat_id', { length: 64 }),
  imageHash: varchar('image_hash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['pending', 'parsed', 'unparseable', 'duplicate', 'confirmed']).notNull().default('pending'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runHashUnique: uniqueIndex('captures_run_hash_unique').on(t.runId, t.imageHash),
}))

export const pendingFills = mysqlTable('pending_fills', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  captureId: int('capture_id'),
  bucketIdx: int('bucket_idx'),
  side: varchar('side', { length: 8 }).notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  shares: int('shares').notNull(),
  price: bigint('price', { mode: 'bigint' }).notNull(),
  fee: int('fee'),
  filledOn: date('filled_on', { mode: 'string' }).notNull(),
  status: mysqlEnum('status', ['pending', 'confirmed', 'rejected']).notNull().default('pending'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

export const fills = mysqlTable('fills', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  bucketIdx: int('bucket_idx').notNull(),
  side: varchar('side', { length: 8 }).notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  shares: int('shares').notNull(),
  price: bigint('price', { mode: 'bigint' }).notNull(),
  fee: int('fee').notNull(),
  filledOn: date('filled_on', { mode: 'string' }).notNull(),
  source: mysqlEnum('source', ['capture', 'manual', 'seed']).notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

export const ledger = mysqlTable('ledger', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  ts: timestamp('ts', { mode: 'string' }).notNull().defaultNow(),
  kind: varchar('kind', { length: 32 }).notNull(),
  amountCents: int('amount_cents').notNull(),
  ref: text('ref'),
})

export const notifications = mysqlTable('notifications', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id'),
  chatId: varchar('chat_id', { length: 64 }).notNull(),
  text: text('text').notNull(),
  sentAt: timestamp('sent_at', { mode: 'string' }).notNull().defaultNow(),
})

export const simRuns = mysqlTable('sim_runs', {
  id: int('id').primaryKey().autoincrement(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  toDate: date('to_date', { mode: 'string' }).notNull(),
  poolCents: int('pool_cents').notNull(),
  costPpm: int('cost_ppm').notNull(),
  paramsJson: text('params_json').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

export const simDays = mysqlTable('sim_days', {
  id: int('id').primaryKey().autoincrement(),
  simRunId: int('sim_run_id').notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  planJson: text('plan_json').notNull(),
  stateJson: text('state_json').notNull(),
  eventsJson: text('events_json').notNull(),
})

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
})

import { uniqueIndex } from 'drizzle-orm/mysql-core'
