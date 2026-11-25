import { describe, test, expect, beforeAll } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { vrCycles } from '../src/db/schema'
import { VrNameTakenError, type NewVrCycle, type NewVrRun } from '../src/domain/vr/repo-types'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db integration: value rebalancing repositories', () => {
  let db: Awaited<ReturnType<typeof getDb>>
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  async function selectRows<T>(q: SQL): Promise<T[]> {
    const [rows] = (await db.execute(q)) as unknown as [T[], unknown]
    return rows
  }
  const count = async (table: 'vr_runs' | 'vr_cash_moves') =>
    Number((await selectRows<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`)))[0]!.n)

  let seq = 0
  const uniq = () => `${Date.now()}${seq++}`
  const newVr = (over: Partial<NewVrRun> = {}): NewVrRun => {
    const u = uniq()
    return {
      ticker: 'V' + u.slice(-10), name: 'vr-' + u, costPpm: 25,
      g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 12_300,
      initialVCents: 1_000_000, openingCashCents: 250_000, openedOn: '2026-11-02', ...over,
    }
  }
  const newCycle = (runId: number, seq: number, over: Partial<NewVrCycle> = {}): NewVrCycle => ({
    runId, seq, scheduledStart: '2026-11-02', startDate: '2026-11-02',
    vCents: 1_000_000, bandMinCents: 850_000, bandMaxCents: 1_150_000, openShares: 100, openPoolCents: 250_000, buyBudgetCents: 125_000,
    buyLot: 5, sellLot: 5, prevClose: null, evalCents: null, poolBeforeCents: null,
    g: 10, formula: 'skill', depositCents: 0, vKept: false, openFillId: 0, ...over,
  })

  test('create writes the run, its settings and the opening cash in one go', async () => {
    const input = newVr()
    const id = await repos.vrRunRepo.create(input)
    const row = (await repos.vrRunRepo.get(id))!
    expect(row).toMatchObject({
      id, strategyKey: 'value-rebalancing', ticker: input.ticker, name: input.name, costPpm: 25, status: 'active',
      g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 12_300, initialVCents: 1_000_000,
    })
    expect(Object.keys(row).sort()).toEqual(['bandPpm', 'costPpm', 'createdAt', 'cycleDepositCents', 'formula', 'g', 'id', 'initialVCents', 'name', 'spendLimitPpm', 'status', 'strategyKey', 'ticker'])
    const moves = await repos.vrCashRepo.listForRun(id)
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ runId: id, kind: 'open', amountCents: 250_000, movedOn: '2026-11-02', note: null, cycleId: null })
    expect(await selectRows(sql`SELECT strategy_key FROM strategy_runs WHERE id = ${id}`)).toEqual([{ strategy_key: 'value-rebalancing' }])
    expect((await repos.vrRunRepo.list()).filter((r) => r.id === id)).toHaveLength(1)
  })

  test('a taken name is refused and leaves nothing behind', async () => {
    const input = newVr()
    await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'M' + uniq().slice(-10), name: input.name, poolCents: 1000, costPpm: 10 })
    const runsBefore = await count('vr_runs')
    const movesBefore = await count('vr_cash_moves')
    await expect(repos.vrRunRepo.create(input)).rejects.toBeInstanceOf(VrNameTakenError)
    expect(await count('vr_runs')).toBe(runsBefore)
    expect(await count('vr_cash_moves')).toBe(movesBefore)
    // a second VR run with the same name is refused as well
    const dup = newVr()
    await repos.vrRunRepo.create(dup)
    await expect(repos.vrRunRepo.create({ ...newVr(), name: dup.name })).rejects.toBeInstanceOf(VrNameTakenError)
  })

  test('a name that contains the word duplicate is still created', async () => {
    const id = await repos.vrRunRepo.create(newVr({ name: 'duplicate-' + uniq() }))
    expect(await repos.vrRunRepo.get(id)).not.toBeNull()
  })

  test('each strategy sees only its own runs', async () => {
    const mrId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'M' + uniq().slice(-10), name: 'mr-' + uniq(), poolCents: 1000, costPpm: 10 })
    const vrId = await repos.vrRunRepo.create(newVr())
    expect(await repos.vrRunRepo.get(mrId)).toBeNull()
    expect((await repos.vrRunRepo.list()).some((r) => r.id === mrId)).toBe(false)
    expect(await repos.runRepo.get(vrId)).toBeNull()
    expect((await repos.runRepo.list()).some((r) => r.id === vrId)).toBe(false)
    const both = (await repos.sharedRunRepo.getMany([vrId, mrId])).sort((a, b) => a.id - b.id)
    expect(both.map((r) => [r.id, r.strategyKey])).toEqual([[mrId, 'mean-reversion'], [vrId, 'value-rebalancing']])
    expect(Object.keys(both[0]!).sort()).toEqual(['costPpm', 'createdAt', 'id', 'name', 'status', 'strategyKey', 'ticker'])
    expect(await repos.sharedRunRepo.getMany([])).toEqual([])
    const ids = (await repos.vrRunRepo.list()).map((r) => r.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  test('vrRunRepo.updateStatus leaves an MR run alone, and updateSettings round-trips', async () => {
    const mrId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'M' + uniq().slice(-10), name: 'mr-' + uniq(), poolCents: 1000, costPpm: 10 })
    const vrId = await repos.vrRunRepo.create(newVr())
    await repos.vrRunRepo.updateStatus(mrId, 'paused')
    expect((await repos.runRepo.get(mrId))!.status).toBe('active')
    await repos.vrRunRepo.updateStatus(vrId, 'paused')
    expect((await repos.vrRunRepo.get(vrId))!.status).toBe('paused')

    await repos.vrRunRepo.updateSettings(vrId, { g: 7, formula: 'basic', bandPpm: 100_000, spendLimitPpm: 400_000, cycleDepositCents: 5_000 })
    expect(await repos.vrRunRepo.get(vrId)).toMatchObject({ g: 7, formula: 'basic', bandPpm: 100_000, spendLimitPpm: 400_000, cycleDepositCents: 5_000, initialVCents: 1_000_000 })
  })

  test('cycles: open writes the cycle and a deposit that carries its id; reads order by seq', async () => {
    const runId = await repos.vrRunRepo.create(newVr())
    expect(await repos.vrCycleRepo.latest(runId)).toBeNull()
    const second = await repos.vrCycleRepo.open(newCycle(runId, 2, { prevClose: 1_234_500n, evalCents: 900_000, poolBeforeCents: 200_000, depositCents: 7_000, vKept: true }),
      { runId, kind: 'deposit', amountCents: 7_000, movedOn: '2026-11-16', note: null })
    const first = await repos.vrCycleRepo.open(newCycle(runId, 1), null)
    expect((await repos.vrCycleRepo.listForRun(runId)).map((c) => c.seq)).toEqual([1, 2])
    const latest = (await repos.vrCycleRepo.latest(runId))!
    expect(latest).toMatchObject({ id: second, seq: 2, prevClose: 1_234_500n, evalCents: 900_000, poolBeforeCents: 200_000, depositCents: 7_000, vKept: true, formula: 'skill', g: 10 })
    expect((await repos.vrCycleRepo.listForRun(runId))[0]).toMatchObject({ id: first, prevClose: null, evalCents: null, poolBeforeCents: null, vKept: false })
    const moves = await repos.vrCashRepo.listForRun(runId)
    expect(moves.filter((m) => m.kind === 'deposit').map((m) => m.cycleId)).toEqual([second])
  })

  test('openFillId round-trips and the column defaults to 0', async () => {
    const runId = await repos.vrRunRepo.create(newVr())
    await repos.vrCycleRepo.open(newCycle(runId, 1, { openFillId: 4_321 }), null)
    expect((await repos.vrCycleRepo.latest(runId))!.openFillId).toBe(4_321)
    const { openFillId: _omit, ...withoutIt } = newCycle(runId, 2)
    await db.insert(vrCycles).values(withoutIt as typeof vrCycles.$inferInsert)
    expect((await repos.vrCycleRepo.latest(runId))!).toMatchObject({ seq: 2, openFillId: 0 })
  })

  test('a second open with the same run and seq rejects and adds no cash move', async () => {
    const runId = await repos.vrRunRepo.create(newVr())
    await repos.vrCycleRepo.open(newCycle(runId, 1), null)
    const before = await repos.vrCashRepo.listForRun(runId)
    await expect(repos.vrCycleRepo.open(newCycle(runId, 1), { runId, kind: 'deposit', amountCents: 1_000, movedOn: '2026-11-16', note: null })).rejects.toThrow()
    expect(await repos.vrCashRepo.listForRun(runId)).toEqual(before)
    expect(await repos.vrCycleRepo.listForRun(runId)).toHaveLength(1)
  })

  test('fills are run-scoped and listed by date, then id', async () => {
    const a = await repos.vrRunRepo.create(newVr())
    const b = await repos.vrRunRepo.create(newVr())
    const fill = (runId: number, filledOn: string, shares: number) => ({ runId, side: 'buy' as const, shares, price: 500_000n, fee: 3, filledOn, source: 'manual' as const })
    const late = await repos.vrFillRepo.insert(fill(a, '2026-11-09', 1))
    const early1 = await repos.vrFillRepo.insert(fill(a, '2026-11-03', 2))
    const early2 = await repos.vrFillRepo.insert(fill(a, '2026-11-03', 3))
    expect((await repos.vrFillRepo.listForRun(a)).map((f) => f.id)).toEqual([early1, early2, late])
    expect(await repos.vrFillRepo.get(b, late)).toBeNull()
    expect((await repos.vrFillRepo.get(a, late))!.price).toBe(500_000n)

    const before = await repos.vrFillRepo.listForRun(a)
    await repos.vrFillRepo.update(b, early1, { side: 'sell', shares: 99, price: 1n, fee: 9, filledOn: '2026-12-01' })
    await repos.vrFillRepo.deleteById(b, early1)
    expect(await repos.vrFillRepo.listForRun(a)).toEqual(before)

    await repos.vrFillRepo.update(a, early1, { side: 'sell', shares: 4, price: 600_000n, fee: 5, filledOn: '2026-11-10' })
    expect(await repos.vrFillRepo.get(a, early1)).toMatchObject({ side: 'sell', shares: 4, price: 600_000n, fee: 5, filledOn: '2026-11-10', source: 'manual' })
    await repos.vrFillRepo.deleteById(a, early2)
    expect((await repos.vrFillRepo.listForRun(a)).map((f) => f.id)).toEqual([late, early1])
  })

  test('cash moves are run-scoped and listed by date, then id', async () => {
    const a = await repos.vrRunRepo.create(newVr({ openedOn: '2026-11-02' }))
    const b = await repos.vrRunRepo.create(newVr())
    const move = (runId: number, movedOn: string, amountCents: number) => ({ runId, kind: 'adjust' as const, amountCents, movedOn, note: null, cycleId: null })
    const late = await repos.vrCashRepo.insert(move(a, '2026-11-20', -500))
    const early1 = await repos.vrCashRepo.insert(move(a, '2026-11-05', 100))
    const early2 = await repos.vrCashRepo.insert(move(a, '2026-11-05', 200))
    const opening = (await repos.vrCashRepo.listForRun(a))[0]!
    expect(opening.kind).toBe('open')
    expect((await repos.vrCashRepo.listForRun(a)).map((m) => m.id)).toEqual([opening.id, early1, early2, late])
    expect(await repos.vrCashRepo.get(b, late)).toBeNull()

    const before = await repos.vrCashRepo.listForRun(a)
    await repos.vrCashRepo.update(b, early1, { amountCents: 9, movedOn: '2026-12-01', note: 'x' })
    await repos.vrCashRepo.deleteById(b, early1)
    expect(await repos.vrCashRepo.listForRun(a)).toEqual(before)

    await repos.vrCashRepo.update(a, late, { amountCents: -700, movedOn: '2026-11-21', note: 'fix' })
    expect(await repos.vrCashRepo.get(a, late)).toMatchObject({ kind: 'adjust', amountCents: -700, movedOn: '2026-11-21', note: 'fix' })
    await repos.vrCashRepo.deleteById(a, early2)
    expect((await repos.vrCashRepo.listForRun(a)).map((m) => m.id)).toEqual([opening.id, early1, late])
  })
})
