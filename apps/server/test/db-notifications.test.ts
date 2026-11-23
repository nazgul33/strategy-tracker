import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db notifications', () => {
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  test('runRepo.getMany returns exactly the runs asked for', async () => {
    const mark = `gm-${Date.now()}-${process.pid}`
    const mk = (n: number, ticker: string) => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: `${mark}-${n}`, poolCents: 1000, costPpm: 10 })
    const a = await mk(1, 'GMA'); await mk(2, 'GMB'); const c = await mk(3, 'GMC')
    const got = await repos.runRepo.getMany([c, a, a, 999999999])
    expect(got.map((r) => [r.id, r.ticker]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([[a, 'GMA'], [c, 'GMC']])
    expect(await repos.runRepo.getMany([])).toEqual([])
  })

  test('listBefore pages newest first below the cursor', async () => {
    const mark = `nb-${Date.now()}-${process.pid}`
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'NB', name: mark, poolCents: 1000, costPpm: 10 })
    await repos.notificationRepo.insert({ runId: null, chatId: 'web', text: `${mark}-1` })
    await repos.notificationRepo.insert({ runId, chatId: '42', text: `${mark}-2` })
    await repos.notificationRepo.insert({ runId, chatId: '43', text: `${mark}-3` })
    const top = await repos.notificationRepo.listBefore(null, 3)
    expect(top.map((r) => [r.runId, r.chatId, r.text])).toEqual([[runId, '43', `${mark}-3`], [runId, '42', `${mark}-2`], [null, 'web', `${mark}-1`]])
    expect(top[0]!.id).toBeGreaterThan(top[1]!.id)
    expect(top[1]!.id).toBeGreaterThan(top[2]!.id)
    expect(typeof top[0]!.sentAt).toBe('string')
    expect((await repos.notificationRepo.listBefore(top[0]!.id, 2)).map((r) => r.id)).toEqual([top[1]!.id, top[2]!.id])
    expect((await repos.notificationRepo.listBefore(top[2]!.id, 1000)).every((r) => r.id < top[2]!.id)).toBe(true)
    expect(await repos.notificationRepo.listBefore(null, 1)).toHaveLength(1)
  })
})
