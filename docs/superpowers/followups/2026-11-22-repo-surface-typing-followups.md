# Repository surface typing (plan E) — deferred follow-ups

Date: 2026-11-22
Branch: `refactor/repo-surface-typing` (`394ca2f..` HEAD)
Spec: GitHub issue #67 (remove `any` from the server repository surface)
Plan: `docs/superpowers/plans/2026-11-22-repo-surface-typing.md`

The branch types every repository interface and row in `domain/repo-types.ts`,
has the real repos `satisfies` them on a typed Drizzle `Db`, and has the shared
fakes `satisfies` the same surfaces (arity-pinned in `test/type-assert.ts`). It
changed no behaviour, SQL, route JSON or Telegram message. What follows is what
the whole-branch review found and the branch deliberately left.

## Behaviour an operator could notice

- **Telegram `/orders` prints a blank ticker in production** (filed as #83). The `orders` table
  has no ticker column and `orderRepo.listForDate` does not join runs, so
  `onOrders` in `wire/capture.ts` reads `ticker` through a cast
  (`o as OrderRecord & { ticker?: string }`) with `?? ''`. That is
  output-identical to before, because `t()` maps a missing param to `''`. The
  `onOrders` test in `wire.test.ts` asserts an `NVDA` ticker that production
  cannot emit, because its fake supplies one. The fix needs a join (or a run
  lookup) and a message-level test; both change the message, so they were out of
  scope here. Fixed on `fix/issues-75-83`: `onOrders` now looks the ticker up from the order's run.

## Type-safety gaps left open

- **Bivariant parameters.** The interfaces in `domain/repo-types.ts` use method
  shorthand, so a fake or real method with a *narrower* parameter type still
  passes `satisfies`. Property-style members (`insert: (n: NewX) => ...`) would
  close it.
- **A domain file imports from `db/`.** `domain/repo-types.ts` imports
  `CaptureImageInsert` / `CaptureImageListing` from `db/repos-vision` (moved
  verbatim from `booking.ts`). They belong in the domain.
- **`BootSweepRepos` is outside `HttpRepoSurface`.** `sweepOrphans` and
  `listUnfrozenKept` (`wire/boot-sweeps.ts`) are therefore not covered by the
  `_real` arity pin.
- **`ArityMismatches` skips optional surface keys.** `test/type-assert.ts` ignores
  repository keys that are optional on the surface; none exist today.
- **`side` is a type-level claim only.** `$type<'buy' | 'sell'>()` on the `side`
  varchar columns in `db/schema.ts` has no DB constraint behind it.
- **`noUncheckedIndexedAccess` is off.** That is why each real `get` method needs
  an explicit `| null` return type: `rows[0] ?? null` infers as never-null.

## Polish deliberately left

- `wire.test.ts` "onStatus omits non-active (archived) runs" now uses a
  `'closed'` fixture; the title still says "archived".
- `http-fakes.test.ts` keeps a leftover `priceHistoryRepo as any` (and
  `simRepo as any`).
- `db/repos.ts` `loadState` carries a long inline stored-state annotation; a
  `StoredState` alias would read better.
- `listBars` (`db/repos-bars.ts`) narrows nullable OHLC columns with `flatMap`,
  while `listUnfrozenKept` uses a type-guard filter, for the same SQL-guaranteed
  narrowing. Pick one idiom.
- `db.test.ts` has redundant `!` assertions on values the typed repos already
  return non-null.
- `bucketRepo.loadState` on a missing run still throws a raw `TypeError` from
  `rows[0].stateJson`. Every caller guards first.
