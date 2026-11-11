# Run lifecycle + bulk status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `closed` a server-enforced terminal state, delete the `done` status, and let the Runs list pause/resume/close many runs in one action.

**Architecture:** One transition table in the runs router gates every status change; a single bulk endpoint applies the same rules via one filtered `UPDATE … WHERE id IN (…)`. The web layer shrinks to three states and drives all buttons off two pure helpers in `viewmodels.ts`. A hand-edited migration rewrites `done` rows to `closed` before the enum ALTER.

**Tech Stack:** Bun, Hono, Drizzle + MariaDB, React (hash-router, no DOM test env — UI logic lives in `viewmodels.ts`), bun:test.

**Spec:** `docs/superpowers/specs/2026-11-11-run-lifecycle-bulk-status-design.md`

## Global Constraints

- All user-facing copy via en+ko catalogs; the two catalogs must expose exactly the same keys with the same `{placeholders}` (pinned by `apps/web/src/catalog.test.ts`).
- Money untouched; `packages/*` never import `apps/*`; no source file > ~300 lines.
- Commits: `feat|fix|docs|test|chore:`. Work on `main`.
- Gates from repo root: `bun test` (db.test self-skips), `bun run typecheck`; DB run with `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test` (container `st-mariadb-test`); E2E `TEST_DATABASE_URL=… bun scripts/e2e.ts`.
- Run statuses after this plan: `active | paused | closed`. Valid transitions: `active→paused`, `paused→active`, `active→closed`, `paused→closed`. Everything else (incl. `closed→*`, same→same) is invalid.

## Review Focus

- Direct API call on a closed run (`PATCH {status:'active'}`) → 409, not silent success — Task 2.
- Bulk endpoint given ids in mixed states incl. closed ones → only eligible rows change; `updated` counts real changes — Task 3.
- A production DB that still holds `done` rows → migration must UPDATE before ALTER, or server startup dies on 0002 — Task 4 (DB-gated test replays 0002 over a widened enum).
- Malformed bulk bodies (`ids: []`, `"x"`, `[0]`, `[1.5]`, unknown/`done` status) → 400 — Task 3.
- `PATCH` on a nonexistent run id → 404, not today's silent `ok:true` — Task 2.

---

### Task 1: Web collapses to three terminal-safe states

**Files:**
- Modify: `apps/web/src/api.types.ts:6`
- Modify: `apps/web/src/viewmodels.ts` (lines 12, 29-35)
- Modify: `apps/web/src/viewmodels.test.ts` (lines 35-54)
- Modify: `apps/web/src/pages/RunDetail.tsx:85-125`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (drop `statusDone` line 264, `actionStop` line 286)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `RunStatus = 'active' | 'paused' | 'closed'` (web); `RUN_STATUSES` with 3 entries; `export type RunAction = 'pause' | 'resume' | 'close'`; `runActions(status: RunStatus): RunAction[]`; `interface BulkPlan { pause: number[]; resume: number[]; close: number[] }`; `bulkPlan(rows: readonly { id: number; status: RunStatus }[]): BulkPlan` — Task 5 consumes these. `nextStatus` is deleted (only its test referenced it).

- [ ] **Step 1: Rewrite the status tests in `viewmodels.test.ts`.** Replace the `nextStatus` test with:

```ts
  test('runActions per status, closed is terminal', () => {
    expect(runActions('active')).toEqual(['pause', 'close']);
    expect(runActions('paused')).toEqual(['resume', 'close']);
    expect(runActions('closed')).toEqual([]);
  });

  test('bulkPlan buckets selected ids by the transitions they can take', () => {
    const plan = bulkPlan([
      { id: 1, status: 'active' },
      { id: 2, status: 'paused' },
      { id: 3, status: 'closed' },
    ]);
    expect(plan).toEqual({ pause: [1], resume: [2], close: [1, 2] });
  });
```

Also add `expect(isRunStatus('done')).toBe(false);` to the `isRunStatus` test, and in the tone test replace `expect(runStatusTone('done')).toBe('neutral');` with `expect(runStatusTone('closed')).toBe('info');`. Import `runActions`/`bulkPlan` (and drop the `nextStatus` import).

- [ ] **Step 2: Run to verify failure** — `bun test apps/web/src/viewmodels.test.ts` — expect FAIL (exports missing).

- [ ] **Step 3: Implement in `viewmodels.ts`.** `RUN_STATUSES = ['active', 'paused', 'closed']`; delete `nextStatus`; add `RunAction`, `runActions`, `BulkPlan`, `bulkPlan` per the Interfaces block (bulkPlan: collect `row.id` under `pause` when `status === 'active'`, `resume` when `'paused'`, `close` when not `'closed'`). Update `api.types.ts:6` to the 3-value union. Update the stale doc comment above `nextStatus`'s old location — delete it with the function.

- [ ] **Step 4: Rebuild RunDetail's header buttons from `runActions`.** Delete the `lifecycle` ternary and `canClose` (lines 85-93). For `runActions(run.status)` render: pause → `Button variant="secondary"` `t('actionPause')` `setStatus('paused')` with `busy={busyStatus === 'paused'}`; resume → `variant="primary"` `t('actionResume')` `setStatus('active')`; close → `variant="danger"` `t('actionClose')` opening the existing confirm modal (`setShowClose(true)`). Closed → no buttons. Keep button order: pool, pause/resume, close (as today: status button first, Close right of it).

- [ ] **Step 5: Drop dead catalog keys.** Remove `statusDone` and `actionStop` from `en.json` and `ko.json` (both files, so `catalog.test.ts` stays green). Do not touch `simStatusDone`, `statusClosed`, `notifKindClose` — different concepts.

- [ ] **Step 6: Verify** — `bun test && bun run typecheck` — expect pass (RunDetail no longer references `'done'`; if any file still does, fix the reference, not the type).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: collapse web run lifecycle to active/paused/closed, closed terminal"`

### Task 2: Server PATCH enforces the transition table

**Files:**
- Modify: `apps/server/src/http/routes/runs.ts:82-89`
- Test: `apps/server/test/http.test.ts` (extend `describe('http runs')`)

**Interfaces:**
- Consumes: existing `runRepo.get/updateStatus(id, status)`.
- Produces: module-level `const RUN_TRANSITIONS: Record<string, string[]> = { active: ['paused', 'closed'], paused: ['active', 'closed'], closed: [] }` and `RUN_STATUSES_SERVER = ['active', 'paused', 'closed'] as const` in `runs.ts` — Task 3's bulk route reuses both.

- [ ] **Step 1: Write the failing test** in `describe('http runs')` (same fake/login style as its siblings, e.g. the `create run` test at line 182):

```ts
  test('patch status enforces lifecycle; closed is terminal', async () => {
    // …makeFakes/createApp/auth, create run → id (active)
    expect((await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    expect((await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
    expect((await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(400)
    // fresh run: same-status no-op is invalid too
    const id2 = (await (await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r2', ticker: 'B', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })).json()).id
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    expect((await app.request('/api/runs/999999', { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(404)
  })
```

- [ ] **Step 2: Run to verify failure** — `bun test apps/server/test/http.test.ts` — expect FAIL (first PATCH-closed→active gives 200; 404 becomes 200).

- [ ] **Step 3: Implement** in `runs.ts`: define `RUN_STATUSES_SERVER` + `RUN_TRANSITIONS` (Interfaces block, verbatim values). Rewrite the PATCH handler: invalid value (not in `RUN_STATUSES_SERVER`) → 400; `runRepo.get(id)` missing → 404 `{ error: 'not found' }`; `!(RUN_TRANSITIONS[run.status] ?? []).includes(status)` → 409 `{ error: 'invalid transition' }` (the `?? []` guards a legacy `done` row seen before migration 0002 lands); else `updateStatus` + `{ ok: true }`. Order matters: value check before lookup.

- [ ] **Step 4: Verify** — `bun test apps/server/test/http.test.ts && bun run typecheck` — expect pass. The existing `patch status valid + invalid` test (paused on an active run, `nope` → 400) must still pass untouched.

- [ ] **Step 5: Commit** — `git commit -am "feat: server-enforced run status transitions, closed terminal (409)"`

### Task 3: Bulk status endpoint

**Files:**
- Modify: `apps/server/src/db/repos.ts` (`runRepo`, ~line 42; import `inArray` at line 2)
- Modify: `apps/server/src/http/routes/runs.ts` (new route)
- Test: `apps/server/test/http.test.ts` (extend the fake `runRepo` + `describe('http runs')`)

**Interfaces:**
- Consumes: `RUN_TRANSITIONS`, `RUN_STATUSES_SERVER` from Task 2.
- Produces: `runRepo.updateStatusMany(ids: number[], from: string[], to: string): Promise<number>` (affected-row count) and `POST /api/runs/bulk-status` — body `{ ids: number[], status: RunStatus }` → `200 { updated: n }` | 400. Task 5's web client calls exactly this route.

- [ ] **Step 1: Write the failing tests** in `describe('http runs')`:

```ts
  test('bulk-status updates eligible rows only', async () => {
    // …auth; create three runs a, b, c (all active); PATCH b → paused, c → closed
    const bulk = (body: unknown) => app.request('/api/runs/bulk-status', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...auth } })
    const pause = await bulk({ ids: [a, b, c], status: 'paused' })
    expect(pause.status).toBe(200)
    expect((await pause.json()).updated).toBe(1) // only a; b is already paused, c is terminal
    const close = await bulk({ ids: [a, b, c], status: 'closed' })
    expect((await close.json()).updated).toBe(2)
    expect(f.runs.find((x) => x.id === c)!.status).toBe('closed')
  })

  test('bulk-status rejects malformed bodies', async () => {
    // …auth
    for (const body of [{ ids: [], status: 'paused' }, { ids: 'x', status: 'paused' }, { ids: [0], status: 'paused' },
      { ids: [1.5], status: 'paused' }, { ids: [1], status: 'done' }, { ids: [1], status: 'nope' }, { status: 'paused' }]) {
      expect((await app.request('/api/runs/bulk-status', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(400)
    }
  })
```

- [ ] **Step 2: Extend the fake `runRepo` in `makeFakes`** (near its `updateStatus`, line ~32):

```ts
    async updateStatusMany(ids: number[], from: string[], to: string) {
      let n = 0
      for (const r of runs) if (ids.includes(r.id) && from.includes(r.status)) { r.status = to; n += 1 }
      return n
    },
```

- [ ] **Step 3: Run to verify failure** — `bun test apps/server/test/http.test.ts` — expect FAIL (404 on the new route / fake method missing).

- [ ] **Step 4: Implement `updateStatusMany`** in `repos.ts` `runRepo`: `if (ids.length === 0 || from.length === 0) return 0`, then `const [res] = await db.update(s.strategyRuns).set({ status: to as any }).where(and(inArray(s.strategyRuns.id, ids), inArray(s.strategyRuns.status, from)))`; `return (res as any)?.affectedRows ?? 0` (same `affectedRows` precedent as `pendingRepo.decide`). Add `inArray` to the `drizzle-orm` import.

- [ ] **Step 5: Add the route** in `runs.ts`, registered **before** `r.get('/runs/:id')` and the other `:id` routes: validate `Array.isArray(ids) && ids.length > 0 && ids.length <= 500 && ids.every((x: unknown) => Number.isInteger(x) && (x as number) > 0)` → else 400 `invalid ids`; `status` in `RUN_STATUSES_SERVER` → else 400 `invalid status`; derive `const from = Object.keys(RUN_TRANSITIONS).filter((f) => RUN_TRANSITIONS[f]!.includes(status))`; `return c.json({ updated: await deps.repos.runRepo.updateStatusMany(ids, from, status) })`.

- [ ] **Step 6: Verify** — `bun test apps/server/test/http.test.ts && bun run typecheck` — expect pass.

- [ ] **Step 7: Commit** — `git commit -am "feat: POST /api/runs/bulk-status applying transitions to many runs"`

### Task 4: Drop `done` from the DB (migration 0002)

**Files:**
- Modify: `apps/server/src/db/schema.ts:10`
- Create: `apps/server/db/migrations/0002_*.sql` + `meta/0002_snapshot.json` (generated, then hand-edited)
- Test: `apps/server/test/db.test.ts` (DB-gated `describeIf`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `strategy_runs.status` enum `(‘active','paused','closed')`; `done` rows rewritten. No code interface changes.

- [ ] **Step 1: Shrink the schema enum** at `schema.ts:10` to `['active', 'paused', 'closed']`, then regenerate: `bun run --cwd apps/server db:generate` (from repo root). Expect a new `0002_*.sql` containing an `ALTER TABLE \`strategy_runs\` MODIFY \`status\` enum('active','paused','closed') …` and a `meta/0002_snapshot.json`.

- [ ] **Step 2: Hand-edit the generated SQL**: immediately **before** the `MODIFY` statement insert
  `UPDATE \`strategy_runs\` SET \`status\` = 'closed' WHERE \`status\` = 'done';`
  — on a legacy DB holding `done` rows the ALTER alone errors under strict mode and kills startup.

- [ ] **Step 3: Write the DB-gated replay test** in `db.test.ts` inside the existing `describeIf` block (uses `db`/`repos` from `beforeAll`; add `import { sql } from 'drizzle-orm'` — raw statements go through `db.execute(sql.raw(...))`, and verification reads go through `repos.runRepo.get`, which has a known return shape):

```ts
  test('0002 migration rewrites done rows before shrinking the enum', async () => {
    // widen back to the legacy enum so a `done` row is insertable again
    await db.execute(sql.raw(`ALTER TABLE strategy_runs MODIFY status enum('active','paused','closed','done') NOT NULL DEFAULT 'active'`))
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'M', name: 'done-' + Date.now(), poolCents: 100, costPpm: 10 })
    await db.execute(sql.raw(`UPDATE strategy_runs SET status = 'done' WHERE id = ${runId}`))
    const file = (await Array.fromAsync(Bun.file(new URL('../../db/migrations/', import.meta.url)).list()))
      .find((f) => f.name.startsWith('0002_'))
    expect(file).toBeDefined()
    for (const stmt of (await file!.text()).split(';').map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith('--'))) {
      await db.execute(sql.raw(stmt))
    }
    expect((await repos.runRepo.get(runId)).status).toBe('closed')
    // enum is really narrower again: writing `done` must now be rejected
    let rejected = false
    try { await db.execute(sql.raw(`UPDATE strategy_runs SET status = 'done' WHERE id = ${runId}`)) } catch { rejected = true }
    expect(rejected).toBe(true)
  })
```

(Re-running 0002's statements over an already-migrated DB is safe: the UPDATE hits zero rows, the MODIFY is idempotent — and this leaves the narrow enum in place for later tests. MariaDB in strict mode rejects out-of-enum values, hence `rejected`.)

- [ ] **Step 4: Run DB suite** — `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts` (start container `st-mariadb-test` if stopped) — expect PASS. Then plain `bun test` — expect pass with the new test self-skipped.

- [ ] **Step 5: Commit** — `git add apps/server/db/migrations apps/server/db/schema.ts apps/server/test/db.test.ts && git commit -m "feat: migration 0002 rewrites done runs to closed, shrinks status enum"`

### Task 5: Runs list — default filter, checkboxes, bulk bar

**Files:**
- Modify: `apps/web/src/api.ts` (interface ~line 99 + impl ~line 149)
- Modify: `apps/web/src/pages/RunsList.tsx`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (7 new keys)

**Interfaces:**
- Consumes: `POST /api/runs/bulk-status` (Task 3); `bulkPlan` / `RUN_STATUSES` (Task 1).
- Produces: `api.bulkSetRunStatus(ids: number[], status: RunStatus): Promise<number>` on the `ApiClient` interface.

- [ ] **Step 1: Add the client method.** In `api.ts` interface: `bulkSetRunStatus(ids: number[], status: RunStatus): Promise<number>;`; implementation beside `setRunStatus`: `bulkSetRunStatus: (ids, status) => send<{ updated: number }>('POST', '/api/runs/bulk-status', { ids, status }).then((r) => r.updated),`.

- [ ] **Step 2: Add catalog keys** (en / ko) — existing terminology: Pause=일시 정지, Resume=재개, Close=종료:
  - `bulkSelectAll`: "Select all" / "전체 선택"
  - `bulkSelected`: "{count} selected" / "{count}개 선택됨"
  - `bulkPause`: "Pause" / "일시 정지"
  - `bulkResume`: "Resume" / "재개"
  - `bulkClose`: "Close" / "종료"
  - `bulkCloseConfirm`: "Closing is final. Close {count} runs?" / "종료는 되돌릴 수 없습니다. {count}개 런을 종료할까요?"
  - `bulkDone`: "{count} runs updated" / "{count}개 런이 변경되었습니다"
  `catalog.test.ts` enforces identical keys/placeholders.

- [ ] **Step 3: RunsList changes** (keep the file's existing structure; ~300-line cap — the list stays well under):
  - Default filter: `useState<string>('active')`.
  - Selection state `const [selected, setSelected] = useState<Set<number>>(new Set())`; clear it whenever `filter` changes and after every `reload()`-completing action.
  - New first table column: header checkbox `aria-label={t('bulkSelectAll')}` toggling all **visible** `runs`; row checkbox `aria-label={r.name}` toggling `r.id`.
  - Bulk bar (visible when `selected.size > 0`, above the table): `t('bulkSelected', { count: selected.size })` plus `Pause (n)` / `Resume (n)` / `Close (n)` buttons whose `n` and target ids come from `bulkPlan(runs.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, status: r.status })))`; each button `disabled` when its id list is empty; labels `t('bulkPause')` etc. with the count appended in parentheses.
  - Pause/Resume: call `api.bulkSetRunStatus(ids, 'paused' | 'active')`; Close: opens a `Modal` (mirroring RunDetail's `confirmClose` modal: Cancel=`t('cancel')`, confirm `variant="danger"`=`t('confirm')`) showing `t('bulkCloseConfirm', { count })`, confirm calls `bulkSetRunStatus(ids, 'closed')`.
  - After any bulk action: `setSelected(new Set())`, `await reload()`, and show `t('bulkDone', { count: updated })` in a `role="status"` line styled like the existing `triggerResult` strip; API errors via the existing `ErrorNote` pattern.
  - All copy through `t()`; no hardcoded strings.

- [ ] **Step 4: Verify** — `bun test && bun run typecheck` — expect pass. Manual sanity via `bun apps/server/src/main.ts` (repo root, reads root `.env`) + a browser pass is optional here; Task 6's E2E covers the server leg.

- [ ] **Step 5: Commit** — `git commit -am "feat: bulk pause/resume/close + active-only default on the runs list"`

### Task 6: Whole-project gate sweep

**Files:** none new — fix stragglers only.

- [ ] **Step 1:** `bun test` from repo root — expect 0 fail, 6 db-test skips.
- [ ] **Step 2:** `bun run typecheck` — expect clean.
- [ ] **Step 3:** `docker start st-mariadb-test` if needed, then `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` — expect 0 fail, 0 skip.
- [ ] **Step 4:** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` — expect all `ok` lines (e2e only pins `status: 'active'` literals; no changes expected).
- [ ] **Step 5:** If anything failed, fix and re-run the failed command; commit fixes as `fix:` / `test:`. If `git status` is dirty (stragglers), commit them; otherwise no commit.
