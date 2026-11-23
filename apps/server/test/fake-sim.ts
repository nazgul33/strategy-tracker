import type { HttpRepoSurface } from '../src/http/app'
import type { SimRunRow, SimDayRow } from '../src/sim/sim'

// Array-backed simRepo with the same semantics as the real one (drafts, guarded rewrites,
// AUTO_INCREMENT-like ids); makeFakes exposes the stores as `simRuns` and `simDays`.
export function fakeSimRepo() {
  // monotonic like AUTO_INCREMENT: ids are never reused after a delete
  let simRunIdSeq = 1
  let simDayIdSeq = 1
  const simRuns: SimRunRow[] = []
  const simDays: SimDayRow[] = []
  const repo = {
    async insertRun(i) {
      const id = simRunIdSeq++
      simRuns.push({ id, createdAt: '2026-11-10T00:00:00Z', ...i, draft: true })
      return id
    },
    async insertDays(rows) { for (const r of rows) simDays.push({ id: simDayIdSeq++, ...r }) },
    // guarded like the real one: nothing is touched unless the run is still a draft
    async rewriteDraft(id, v, rows) {
      const r = simRuns.find((x) => x.id === id)
      if (!r || !r.draft) return false
      Object.assign(r, v)
      for (let i = simDays.length - 1; i >= 0; i--) if (simDays[i].simRunId === id) simDays.splice(i, 1)
      for (const d of rows) simDays.push({ id: simDayIdSeq++, ...d })
      return true
    },
    async finalize(id: number) {
      const r = simRuns.find((x) => x.id === id)
      if (!r || !r.draft) return false
      r.draft = false
      return true
    },
    async deleteRun(id: number) {
      const i = simRuns.findIndex((x) => x.id === id)
      if (i < 0 || !simRuns[i].draft) return false
      simRuns.splice(i, 1)
      for (let j = simDays.length - 1; j >= 0; j--) if (simDays[j].simRunId === id) simDays.splice(j, 1)
      return true
    },
    async sweepDrafts(createdBefore: Date) {
      let n = 0
      for (let i = simRuns.length - 1; i >= 0; i--) {
        const r = simRuns[i]
        if (!r.draft || new Date(r.createdAt).getTime() >= createdBefore.getTime()) continue
        simRuns.splice(i, 1)
        for (let j = simDays.length - 1; j >= 0; j--) if (simDays[j].simRunId === r.id) simDays.splice(j, 1)
        n += 1
      }
      return n
    },
    async listRuns() { return [...simRuns].sort((a, b) => b.id - a.id) },
    async getRun(id: number) { return simRuns.find((x) => x.id === id) ?? null },
    async listDays(id: number) { return simDays.filter((d) => d.simRunId === id).sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1)) },
  } satisfies HttpRepoSurface['simRepo']
  return { repo, simRuns, simDays }
}
