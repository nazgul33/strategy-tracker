/**
 * Dashboard step of the operator e2e: GET /api/dashboard against the script's own reads, then the morning catch-up.
 * Every row and total is recomputed from the run lists, the run states and the newest stored close of the ticker,
 * marks included, once before and once after a morning run. A paused VR run on a ticker of its own (VRDB) has no
 * stored close until that morning stores it. The morning here has `latestStoredCloseDate` wired as main.ts does;
 * the other steps' mornings do not.
 */
import { prevTradingDay } from '../packages/calendar/src/index'
import { evalCents } from '../packages/strategies/src/value-rebalancing'
import { runMorningPipeline, type DayDeps } from '../apps/server/src/pipeline/day'
import { jsonOf, type E2eCtx } from './e2e-ctx'
import { storingCloses } from './e2e-vr'

type ClosesRepo = {
  upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]): Promise<number>
  listForTicker(ticker: string): Promise<{ tradeDate: string; close: bigint }[]>
}
interface Expected { id: number; ticker: string; shares: number; cashCents: number }
interface Want { id: number; shares: number; cashCents: number; stockCents: number | null; valueCents: number; close: string | null; closeDate: string | null; closeMark: string | null }

export async function checkDashboard(c: E2eCtx, today: string, dayDeps: DayDeps, ph: ClosesRepo): Promise<void> {
  const prev = prevTradingDay(today)
  const get = async (path: string) => jsonOf(await c.req('GET', path, undefined, c.token))
  const live = (r: { status: string }) => r.status === 'active' || r.status === 'paused'

  const expectedRuns = async (): Promise<[Expected[], Expected[], Set<number>, Set<number>]> => {
    const mrAll = (await get('/runs')) as any[]
    const vrAll = (await get('/vr/runs')) as any[]
    const mr: Expected[] = []
    for (const r of mrAll.filter(live).sort((a, b) => a.id - b.id)) {
      const s = (await get(`/runs/${r.id}`)).state
      mr.push({ id: r.id, ticker: r.ticker, shares: s.buckets.filter((b: any) => b.state !== 'empty').reduce((n: number, b: any) => n + b.shares, 0), cashCents: s.cashCents })
    }
    const vr = vrAll.filter(live).sort((a, b) => a.id - b.id).map((r): Expected => ({ id: r.id, ticker: r.ticker, shares: r.shares, cashCents: r.poolCents }))
    const closed = (all: any[]) => new Set<number>(all.filter((r) => !live(r)).map((r) => r.id))
    return [mr, vr, closed(mrAll), closed(vrAll)]
  }

  const checkAgainstLists = async (when: string) => {
    const res = await c.req('GET', '/dashboard', undefined, c.token)
    c.ok(res.status === 200, `GET /api/dashboard ${when} -> 200`)
    const d = await jsonOf(res)
    c.ok(d.today === today && JSON.stringify(d.groups.map((g: any) => g.strategy)) === JSON.stringify(['mean-reversion', 'value-rebalancing']),
      `dashboard ${when}: today ${today}, two groups in the fixed order`)
    const [mr, vr, closedMr, closedVr] = await expectedRuns()

    const stored = new Map<string, { tradeDate: string; close: bigint } | null>()
    for (const e of [...mr, ...vr]) stored.set(e.ticker, (await ph.listForTicker(e.ticker)).at(-1) ?? null)
    const lastOf = (e: Expected) => (e.shares === 0 ? null : stored.get(e.ticker) ?? null)
    const newest = [...mr, ...vr].map((e) => lastOf(e)?.tradeDate ?? null).reduce<string | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null)
    const want = (e: Expected): Want => {
      const last = lastOf(e)
      const stockCents = e.shares === 0 ? 0 : last ? evalCents(e.shares, last.close) : null
      const closeMark = e.shares > 0 && !stored.get(e.ticker) ? 'missing' : last && newest !== null && last.tradeDate < newest ? 'older' : null
      return { id: e.id, shares: e.shares, cashCents: e.cashCents, stockCents, valueCents: (stockCents ?? 0) + e.cashCents, close: last ? last.close.toString() : null, closeDate: last ? last.tradeDate : null, closeMark }
    }
    const got = (r: any): Want => ({ id: r.id, shares: r.shares, cashCents: r.cashCents, stockCents: r.stockCents, valueCents: r.valueCents, close: r.close, closeDate: r.closeDate, closeMark: r.closeMark })

    const groups: [string, Expected[], Set<number>][] = [['mean-reversion', mr, closedMr], ['value-rebalancing', vr, closedVr]]
    groups.forEach(([name, exp, closedHere], n) => {
      const g = d.groups[n]
      const wants = exp.map(want)
      c.ok(JSON.stringify(g.runs.map((r: any) => r.id)) === JSON.stringify(exp.map((e) => e.id)),
        `dashboard ${when}, ${name}: lists every active or paused run (ids ${exp.map((e) => e.id).join(',')}) in id order, ${closedHere.size} closed run(s) left out; got ${g.runs.map((r: any) => r.id).join(',')}`)
      const bad = g.runs.filter((r: any, i: number) => JSON.stringify(got(r)) !== JSON.stringify(wants[i]))
      c.ok(bad.length === 0, `dashboard ${when}, ${name}: shares, cash, stock, value, close and mark of all ${wants.length} row(s) match the lists and the stored closes${bad.length ? ` — off: ${JSON.stringify(bad.map((r: any) => [got(r), wants.find((w) => w.id === r.id)]))}` : ''}`)
      const total = wants.reduce((s, w) => s + w.valueCents, 0)
      c.ok(g.totalCents === total && g.incomplete === wants.some((w) => w.closeMark === 'missing') && g.olderClose === wants.some((w) => w.closeMark === 'older'),
        `dashboard ${when}, ${name}: total ${total}c, incomplete ${g.incomplete}, olderClose ${g.olderClose} as recomputed (got ${g.totalCents}c)`)
    })
    c.ok(d.closeDate === newest, `dashboard ${when}: closeDate ${newest} is the newest stored close of any row (got ${d.closeDate})`)
    const idsOf = (n: number) => new Set<number>(d.groups[n].runs.map((r: any) => r.id))
    c.ok([...closedMr].every((id) => !idsOf(0).has(id)) && [...closedVr].every((id) => !idsOf(1).has(id)),
      `dashboard ${when}: no closed run of either strategy is listed in its own group`)
    return d
  }

  // ---- a paused VR run on a ticker of its own, with shares and no stored close
  const created = await c.req('POST', '/vr/runs', { name: 'E2E VR dashboard', ticker: 'VRDB', cashCents: 1_000_000 }, c.token)
  c.ok(created.status === 201, 'POST /api/vr/runs VRDB -> 201')
  const id = ((await jsonOf(created)) as { id: number }).id
  const buy = await c.req('POST', `/vr/runs/${id}/fills`, { side: 'buy', shares: 27, price: '180.00', fee: '0.50', filledOn: today }, c.token)
  c.ok(buy.status === 201, 'opening buy 27 sh @ 180.00 -> 201')
  const pause = await c.req('PATCH', `/vr/runs/${id}`, { status: 'paused' }, c.token)
  c.ok(pause.status === 200 && (await jsonOf(pause)).ok === true, 'PATCH /api/vr/runs/:id paused -> 200 ok')
  c.ok((await ph.listForTicker('VRDB')).length === 0, 'nothing is stored for VRDB yet')

  const d1 = await checkAgainstLists('before the morning')
  const row1 = d1.groups[1].runs.find((r: any) => r.id === id)
  c.ok(row1?.status === 'paused' && row1.shares === 27 && row1.close === null && row1.closeDate === null && row1.closeMark === 'missing' && row1.stockCents === null
    && row1.cashCents === 513_950 && row1.valueCents === 513_950 && d1.groups[1].incomplete === true,
    `VRDB row before the morning: 27 sh, no close, 'missing', value = Pool 513950c, VR group incomplete: ${JSON.stringify(row1)}`)

  const catchUp: DayDeps = {
    ...storingCloses(dayDeps, ph),
    latestStoredCloseDate: async (ticker) => (await ph.listForTicker(ticker)).at(-1)?.tradeDate ?? null,
  }
  c.ok((await runMorningPipeline(catchUp)) === 'sent', 'morning pipeline with the close catch-up wired -> sent')
  const vrdb = (await ph.listForTicker('VRDB')).at(-1)
  c.ok(vrdb?.tradeDate === prev && vrdb.close === 1_800_000n, `VRDB now has a stored close for ${prev}: 180.00 (1800000)`)

  const d2 = await checkAgainstLists('after the morning')
  const row2 = d2.groups[1].runs.find((r: any) => r.id === id)
  c.ok(row2?.close === '1800000' && row2.closeDate === prev && row2.closeMark === null && row2.stockCents === evalCents(27, 1_800_000n) && row2.stockCents === 486_000
    && row2.valueCents === 999_950 && d2.groups[1].incomplete === false,
    `VRDB row after the morning: close 180.00 of ${prev}, no mark, stock 486000c, value 999950c, VR group complete: ${JSON.stringify(row2)}`)

  const closed = await c.req('PATCH', `/vr/runs/${id}`, { status: 'closed' }, c.token)
  c.ok(closed.status === 200, 'VRDB run closes -> 200')
  const d3 = await get('/dashboard')
  c.ok(!d3.groups[1].runs.some((r: any) => r.id === id), 'a closed VRDB run is gone from the dashboard')
}
