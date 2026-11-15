// Only the repo methods the claim needs, declared here so this module stays
// independent of booking.ts (which imports claimCapture, never the other way
// round). RepoSurface satisfies it structurally.
export interface CaptureClaimRepos {
  captureRepo: {
    findByHash(runId: number, hash: string): Promise<{ id: number } | null>
    setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void>
    insert(c: any): Promise<{ inserted: boolean; id?: number }>
  }
  pendingRepo: {
    // status 'pending' only: a row still awaiting the operator's decision
    hasLiveForCapture(captureId: number): Promise<boolean>
    // status 'confirmed' only: a row that was booked as a fill
    hasConfirmedForCapture(captureId: number): Promise<boolean>
  }
  correctionRepo: { hasOpenForCapture(captureId: number): Promise<boolean> }
}

// `bookedEarlier`: the reused capture already has a confirmed pending row, so
// fresh rows from this read may duplicate fills that were booked from it.
export interface CaptureClaim { id: number; bookedEarlier: boolean }

// Resolves which `captures` row a read of this image attaches to. A seen image
// is re-read onto its existing row unless one of that row's fills still awaits
// a decision or an open correction proposed from it is still undecided.
// Returns the claim, or null when the upload is a duplicate.
// Must run inside the run lock: the lookup, the status write and the caller's
// pending inserts are one decide→write span.
export async function claimCapture(
  repos: CaptureClaimRepos,
  runId: number,
  hash: string,
  status: 'parsed' | 'unparseable',
): Promise<CaptureClaim | null> {
  const existing = await repos.captureRepo.findByHash(runId, hash)
  if (existing) {
    const live =
      (await repos.pendingRepo.hasLiveForCapture(existing.id)) ||
      (await repos.correctionRepo.hasOpenForCapture(existing.id))
    if (live) return null
    await repos.captureRepo.setStatus(existing.id, status)
    return { id: existing.id, bookedEarlier: await repos.pendingRepo.hasConfirmedForCapture(existing.id) }
  }
  const res = await repos.captureRepo.insert({ runId, chatId: null, imageHash: hash, status })
  return res.inserted ? { id: res.id!, bookedEarlier: false } : null
}
