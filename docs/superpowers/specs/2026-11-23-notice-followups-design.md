# Notice and digest follow-ups (#89, #90, #91, #92, + #76)

Follow-ups from the reviews of the #85-#87 work (`fix/issues-85-87`). Branch: `fix/issues-89-92`.

## Intent

The morning digest's "⚠️ N unconfirmed orders from <date>" line must name every stale order exactly once, even after two independent failures (#91). The reads behind that line and the System notices feed must not scan whole tables (#89). Every "could not read fills" reply must be recorded so a web-only operator sees it, and a send failure must not escape the photo handler (#90). A run-linked notice whose run is gone must stay readable (#92). #76 rides the same migration.

## Non-goals

- No `kind` column on `notifications`; no change to how the feed groups rows.
- No run deletion feature (#92 stays defensive).
- No splitting of oversized test files (#81); new tests go in new or small files rather than growing `wire.test.ts`.

## Approaches considered for #91

1. **`reported_at` on `orders` (chosen).** The line becomes "this run's stale orders not yet named in a recorded digest". Closes the two-failure gap and replaces #89's order-date inference with one indexed read.
2. No schema change: keep the date inference, ship only #89's narrow query, close #91 as a known limitation. Smaller, but the gap stays.
3. Key off the run's last digest notification row. Rejected: `notifications` has no kind column, so this means matching message text plus an ET date conversion of `sent_at`.

## Design

### Migration 0010 (`apps/server/src/db/schema.ts` → `db:generate`)

- `orders.reported_at` timestamp, nullable.
- Hand-edited backfill appended to the generated SQL: `UPDATE orders SET reported_at = NOW() WHERE status = 'stale'`, so the first morning after deploy does not list the whole history. Pin it in `apps/server/test/migration-sql.test.ts` the same way 0007's backfill is pinned (regenerating drops hand edits).
- #76: `sim_days_sim_run_trade_idx` on `(sim_run_id, trade_date)`; drop the now-redundant `sim_days_sim_run_idx` *(builder's call: drop it; the composite covers the filter)*. Update the index assertion in `migration-sql.test.ts`.

### Unconfirmed line (#91, orders half of #89) — `apps/server/src/pipeline/day.ts`

- `OrderRepo` gains `listUnreportedStale(runId)` (`run_id = ? AND status = 'stale' AND reported_at IS NULL`; `orders_run_trade_date_idx` narrows by run) and `markReported(ids)`. `OrderRecord` carries `reportedAt: string | null` where needed.
- `unconfirmedOrders` returns `listUnreportedStale(run.id)`, still read inside the run lock after this morning's roll. The `stale` roll map is no longer needed for the line (the roll still runs; its failure is still logged). `count` = rows, `date` = oldest `tradeDate`, as today (superseded: one line per trade date, see "Additions after the final review").
- After the digest broadcast, the reported ids are marked with `markReported`. They are marked only if at least one copy of the digest was recorded: `broadcastNotice` returns a `recorded` count alongside `failed`. A failed mark is logged; the orders are then named again next morning (accepted).
- Stale orders from a morning whose digest was never recorded are named the next morning (the issue's "arguably right" edge, now explicit).
- Orders that leave `stale` (late fill, broker-filled cancel) drop out of the line naturally.

### Notice feed tickers (#89, feed half) — `apps/server/src/http/routes/notifications.ts`

- `RunRepo` gains `getMany(ids)` (`WHERE id IN (...)`, empty input → no query). The route looks up only the distinct run ids on the page. Update `RepoSurface` picks, `http-fakes.ts` and other fakes.

### Capture replies (#90) — `apps/server/src/wire/capture.ts`

- All three "could not read fills" replies go through `broadcastNotice({ allowedChatIds: [chatId], send, notificationRepo }, null, text, { kind: 'capture-bad-extract' })`: the failed extract (lines 56-58), the empty auto-route group (line 112), and the `rejected` outcome in `sendOutcome` (line 140, missing from the issue). Recorded first, send guarded and logged, handler resolves on a send failure.
- Run id stays `null` for all three *(builder's call: they are System notices, consistent with today's recorded row)*.
- Tests: send throws → row still recorded and handler resolves; each variant records a row.

### Gone run in System notices (#92) — `apps/web/src/components/SystemNotices.tsx`

- No new server flag: with `getMany`, a run-linked entry with `ticker === null` means the run is gone.
- Such a row renders like a global notice: an inline expand button with full text and chats. The source column keeps `#<runId>`.
- Test in the component's colocated test.

## Constraints

- Money, i18n and file-size conventions from `AGENTS.md`; no new user-facing copy is expected.
- DB-suite pins for `listUnreportedStale`, `markReported`, `getMany` and the backfill (self-skip without `TEST_DATABASE_URL`).
- Keep `day-unconfirmed.test.ts`, `day.test.ts` (f) and `http-notifications.test.ts` green, adjusting them where the behaviour changes on purpose. Add a test for the two-failure case from #91.
- `bun run typecheck`, `bun test`, the DB suite and `scripts/e2e.ts` pass.

## Left to the builder

Exact repo method names, the shape of `broadcastNotice`'s widened result, test file placement, and commit split.

## Additions after the final review (operator request)

- **One line per date.** When a run's unreported stale orders span several trade dates, the digest carries one existing `unconfirmed` notice per date, oldest first: "⚠️ Unconfirmed orders from 2026-11-04: 1", then "⚠️ Unconfirmed orders from 2026-11-05: 2". A single date reads as before. No new notice code (the English wording changed, see the next bullet).
- **Count-neutral English copy.** The English line was ungrammatical for a count of 1 ("1 unconfirmed orders"). At the operator's request it became `⚠️ Unconfirmed orders from {date}: {count}`; the Korean line is unchanged.
- **`rollStale` returns only the count.** Its per-run map has had no production reader since the line moved to `listUnreportedStale`; it becomes `markStale` alone, and `OrderRepo.listOpenBefore` (its only caller) is removed.
- **README calendar caveat** says 2025–2028, matching `NYSE_YEARS`.
