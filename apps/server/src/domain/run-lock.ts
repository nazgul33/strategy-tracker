// Per-runId promise-chain mutex for the read-decide-write sections of booking.
// Two concurrent requests for one run could otherwise read the same state and
// write a duplicate pending row, a double-booked fill or a colliding bucket.
// In-process only: a second app instance on the same DB stays unprotected
// (GitHub issue #1). Non-reentrant — never call withRunLock for a runId from
// inside a locked section on the same runId, the inner call would deadlock.
const tails = new Map<number, Promise<void>>()

export function withRunLock<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(runId) ?? Promise.resolve()
  // `run` is the caller-visible result (may reject).
  const run = prev.then(fn)
  // `tail` is the never-rejecting chain link stored in the map, so a rejection
  // cannot poison later callers; it doubles as the map-entry cleanup token.
  const tail = run.then(() => {}, () => {})
  tails.set(runId, tail)
  void tail.then(() => {
    if (tails.get(runId) === tail) tails.delete(runId) // drop drained queues
  })
  return run
}
