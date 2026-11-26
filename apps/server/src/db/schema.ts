import { mysqlTable, bigint, boolean, int, varchar, text, longtext, date, timestamp, json, mysqlEnum, primaryKey, index, customType } from 'drizzle-orm/mysql-core'

// drizzle-orm/mysql-core has no blob helper; LONGBLOB needs a custom type.
const longblob = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'longblob' })

export const strategyRuns = mysqlTable('strategy_runs', {
  id: int('id').primaryKey().autoincrement(),
  strategyKey: varchar('strategy_key', { length: 64 }).notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  name: varchar('name', { length: 128 }).notNull().unique(),
  costPpm: int('cost_ppm').notNull(),
  status: mysqlEnum('status', ['active', 'paused', 'closed']).notNull().default('active'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

export const mrRuns = mysqlTable('mr_runs', {
  runId: int('run_id').primaryKey(),
  poolCents: int('pool_cents').notNull(),
  buyGapPpm: int('buy_gap_ppm').notNull().default(0),
  sellGapPpm: int('sell_gap_ppm').notNull().default(0),
  cutLossPpm: int('cut_loss_ppm').notNull().default(0),
  stateJson: text('state_json').notNull(),
})

export const mrPoolEdits = mysqlTable('mr_pool_edits', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  poolCents: int('pool_cents').notNull(),
  editedAt: timestamp('edited_at', { mode: 'string' }).notNull().defaultNow(),
})

export const mrBuckets = mysqlTable('mr_buckets', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  idx: int('idx').notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  shares: int('shares').notNull().default(0),
  buyPriceMyriadths: bigint('buy_price_myriadths', { mode: 'bigint' }),
  buyFeeCents: int('buy_fee_cents').notNull().default(0),
  filledOn: date('filled_on', { mode: 'string' }),
})

export const mrOrders = mysqlTable('mr_orders', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  kind: mysqlEnum('kind', ['buy_loc', 'sell_loc', 'market_sell', 'stop_sell']).notNull(),
  bucketIdx: int('bucket_idx').notNull(),
  limitPrice: bigint('limit_price', { mode: 'bigint' }).notNull(),
  shares: int('shares').notNull(),
  status: mysqlEnum('status', ['open', 'filled', 'stale', 'cancelled']).notNull().default('open'),
  skipReason: text('skip_reason'),
  cancelReason: varchar('cancel_reason', { length: 32 }),
  reportedAt: timestamp('reported_at', { mode: 'string' }),
}, (t) => ({
  runTradeDateIdx: index('mr_orders_run_trade_date_idx').on(t.runId, t.tradeDate),
  tradeDateIdx: index('mr_orders_trade_date_idx').on(t.tradeDate),
}))

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

export const mrPendingFills = mysqlTable('mr_pending_fills', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  captureId: int('capture_id'),
  bucketIdx: int('bucket_idx'),
  side: varchar('side', { length: 8 }).$type<'buy' | 'sell'>().notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  shares: int('shares').notNull(),
  price: bigint('price', { mode: 'bigint' }).notNull(),
  fee: int('fee'),
  filledOn: date('filled_on', { mode: 'string' }).notNull(),
  status: mysqlEnum('status', ['pending', 'confirmed', 'rejected']).notNull().default('pending'),
  // Vision snapshot frozen at insert. Nulls are honest "vision missed it".
  // detectedAt is date-granular: ingest writes the ET booking day (deps.today), stored as
  // midnight of that date. Only its presence is ever read (null = row predates the snapshot).
  detectedSide: varchar('detected_side', { length: 8 }),
  detectedShares: int('detected_shares'),
  detectedPrice: bigint('detected_price', { mode: 'bigint' }),
  detectedFilledOn: date('detected_filled_on', { mode: 'string' }),
  detectedFee: int('detected_fee'),
  detectedOrderType: varchar('detected_order_type', { length: 32 }),
  detectedOrderPrice: bigint('detected_order_price', { mode: 'bigint' }),
  detectedOrderedShares: int('detected_ordered_shares'),
  detectedAt: timestamp('detected_at', { mode: 'string' }),
  // How the confirm treated the fee, written by the statement that flips the row (null: still
  // pending, rejected, or decided before this column existed). Only the boot repair reads it.
  feeOverride: mysqlEnum('fee_override', ['none', 'cleared', 'set']),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

// Screenshot bytes, 1:1 with captures; presence means the bytes exist.
export const captureImages = mysqlTable('capture_images', {
  captureId: int('capture_id').primaryKey(),
  mime: varchar('mime', { length: 32 }).notNull(),
  bytes: longblob('bytes').notNull(),
  byteLen: int('byte_len').notNull(),
  keep: boolean('keep').notNull().default(false),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

// One frozen detected-vs-final record per resolved fill.
export const mrVisionReviews = mysqlTable('mr_vision_reviews', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  captureId: int('capture_id').notNull(),
  pendingFillId: int('pending_fill_id').notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  outcome: mysqlEnum('outcome', ['confirmed', 'rejected']).notNull(),
  detectedSide: varchar('detected_side', { length: 8 }),
  detectedShares: int('detected_shares'),
  detectedPrice: bigint('detected_price', { mode: 'bigint' }),
  detectedFilledOn: date('detected_filled_on', { mode: 'string' }),
  detectedFee: int('detected_fee'),
  finalSide: varchar('final_side', { length: 8 }),
  finalShares: int('final_shares'),
  finalPrice: bigint('final_price', { mode: 'bigint' }),
  finalFilledOn: date('final_filled_on', { mode: 'string' }),
  finalFee: int('final_fee'),
  edited: boolean('edited').notNull(),
  feeOverridden: boolean('fee_overridden').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  pendingFillUnique: uniqueIndex('mr_vision_reviews_pending_fill_unique').on(t.pendingFillId),
  captureIdx: index('mr_vision_reviews_capture_idx').on(t.captureId),
}))

export const mrFillCorrections = mysqlTable('mr_fill_corrections', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  fillId: int('fill_id').notNull(),
  captureId: int('capture_id'),
  side: varchar('side', { length: 8 }).$type<'buy' | 'sell'>().notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  bookedShares: int('booked_shares').notNull(),
  bookedFilledOn: date('booked_filled_on', { mode: 'string' }).notNull(),
  bookedPrice: bigint('booked_price', { mode: 'bigint' }).notNull(),
  bookedFee: int('booked_fee').notNull(),
  proposedPrice: bigint('proposed_price', { mode: 'bigint' }).notNull(),
  proposedFee: int('proposed_fee'),
  status: mysqlEnum('status', ['open', 'applied', 'dismissed']).notNull().default('open'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  fillIdx: index('mr_fill_corrections_fill_idx').on(t.fillId),
}))

export const mrFills = mysqlTable('mr_fills', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  bucketIdx: int('bucket_idx').notNull(),
  side: varchar('side', { length: 8 }).$type<'buy' | 'sell'>().notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  shares: int('shares').notNull(),
  price: bigint('price', { mode: 'bigint' }).notNull(),
  fee: int('fee').notNull(),
  filledOn: date('filled_on', { mode: 'string' }).notNull(),
  source: mysqlEnum('source', ['capture', 'manual', 'seed']).notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
})

export const mrLedger = mysqlTable('mr_ledger', {
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

export const mrSimRuns = mysqlTable('mr_sim_runs', {
  id: int('id').primaryKey().autoincrement(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  toDate: date('to_date', { mode: 'string' }).notNull(),
  poolCents: int('pool_cents').notNull(),
  costPpm: int('cost_ppm').notNull(),
  buyGapPpm: int('buy_gap_ppm').notNull().default(0),
  sellGapPpm: int('sell_gap_ppm').notNull().default(0),
  cutLossPpm: int('cut_loss_ppm').notNull().default(0),
  paramsJson: text('params_json').notNull(),
  draft: boolean('draft').notNull().default(true),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  draftCreatedIdx: index('mr_sim_runs_draft_created_idx').on(t.draft, t.createdAt),
}))

export const mrSimDays = mysqlTable('mr_sim_days', {
  id: int('id').primaryKey().autoincrement(),
  simRunId: int('sim_run_id').notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  planJson: text('plan_json').notNull(),
  stateJson: text('state_json').notNull(),
  eventsJson: text('events_json').notNull(),
}, (t) => ({
  simRunTradeIdx: index('mr_sim_days_sim_run_trade_idx').on(t.simRunId, t.tradeDate),
}))

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
})

// Yahoo daily bars keyed by (ticker, trade_date): same-day refetch overwrites
// the row instead of duplicating; the morning pipeline backfills the close.
// open/high/low are null on legacy close-only rows.
export const priceHistory = mysqlTable('price_history', {
  ticker: varchar('ticker', { length: 16 }).notNull(),
  tradeDate: date('trade_date', { mode: 'string' }).notNull(),
  open: bigint('open', { mode: 'bigint' }),
  high: bigint('high', { mode: 'bigint' }),
  low: bigint('low', { mode: 'bigint' }),
  close: bigint('close', { mode: 'bigint' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.tradeDate] }),
}))

// Calendar-date ranges already fetched in full for a ticker; kept merged so a
// covered range never triggers a refetch.
export const barCoverage = mysqlTable('bar_coverage', {
  id: int('id').primaryKey().autoincrement(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  toDate: date('to_date', { mode: 'string' }).notNull(),
}, (t) => ({
  tickerIdx: index('bar_coverage_ticker_idx').on(t.ticker),
}))

// One parked Telegram question: the fills read for one ticker and the screenshot, as base64 text.
export const captureChoices = mysqlTable('capture_choices', {
  id: int('id').primaryKey().autoincrement(),
  chatId: varchar('chat_id', { length: 64 }).notNull(),
  ticker: varchar('ticker', { length: 16 }).notNull(),
  mrRunId: int('mr_run_id').notNull(),
  vrRunId: int('vr_run_id').notNull(),
  fillsJson: text('fills_json').notNull(),
  imageBase64: longtext('image_base64').notNull(),
  imageMime: varchar('image_mime', { length: 32 }).notNull(),
  readOn: date('read_on', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  answer: mysqlEnum('answer', ['mr', 'vr', 'both']),
  answeredAt: timestamp('answered_at', { mode: 'string' }),
})

export * from './schema-vr'

import { uniqueIndex } from 'drizzle-orm/mysql-core'
