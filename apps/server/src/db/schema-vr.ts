import { mysqlTable, int, bigint, boolean, varchar, date, timestamp, mysqlEnum, index, uniqueIndex } from 'drizzle-orm/mysql-core'

export const vrRuns = mysqlTable('vr_runs', {
  runId: int('run_id').primaryKey(),
  g: int('g').notNull(),
  formula: mysqlEnum('formula', ['basic', 'skill']).notNull(),
  bandPpm: int('band_ppm').notNull(),
  spendLimitPpm: int('spend_limit_ppm').notNull(),
  cycleDepositCents: int('cycle_deposit_cents').notNull().default(0),
  initialVCents: int('initial_v_cents').notNull(),
})

export const vrCycles = mysqlTable('vr_cycles', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  seq: int('seq').notNull(),
  scheduledStart: date('scheduled_start', { mode: 'string' }).notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  vCents: int('v_cents').notNull(),
  bandMinCents: int('band_min_cents').notNull(),
  bandMaxCents: int('band_max_cents').notNull(),
  openShares: int('open_shares').notNull(),
  openPoolCents: int('open_pool_cents').notNull(),
  buyBudgetCents: int('buy_budget_cents').notNull(),
  buyLot: int('buy_lot').notNull(),
  sellLot: int('sell_lot').notNull(),
  prevClose: bigint('prev_close', { mode: 'bigint' }),
  evalCents: int('eval_cents'),
  poolBeforeCents: int('pool_before_cents'),
  g: int('g').notNull(),
  formula: mysqlEnum('formula', ['basic', 'skill']).notNull(),
  depositCents: int('deposit_cents').notNull().default(0),
  vKept: boolean('v_kept').notNull().default(false),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runSeqUnique: uniqueIndex('vr_cycles_run_seq_unique').on(t.runId, t.seq),
}))

export const vrFills = mysqlTable('vr_fills', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  side: varchar('side', { length: 8 }).$type<'buy' | 'sell'>().notNull(),
  shares: int('shares').notNull(),
  price: bigint('price', { mode: 'bigint' }).notNull(),
  fee: int('fee').notNull(),
  filledOn: date('filled_on', { mode: 'string' }).notNull(),
  source: mysqlEnum('source', ['manual', 'capture']).notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index('vr_fills_run_idx').on(t.runId),
}))

export const vrCashMoves = mysqlTable('vr_cash_moves', {
  id: int('id').primaryKey().autoincrement(),
  runId: int('run_id').notNull(),
  kind: mysqlEnum('kind', ['open', 'deposit', 'withdraw', 'adjust']).notNull(),
  amountCents: int('amount_cents').notNull(),
  movedOn: date('moved_on', { mode: 'string' }).notNull(),
  note: varchar('note', { length: 255 }),
  cycleId: int('cycle_id'),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index('vr_cash_moves_run_idx').on(t.runId),
}))
