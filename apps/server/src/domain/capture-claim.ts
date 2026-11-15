// Only the repo methods the claim needs, declared here so this module stays
// independent of booking.ts (which imports claimCapture, never the other way
// round). RepoSurface satisfies it structurally.
export interface CaptureClaimRepos {
  captureRepo: {
    findByHash(runId: number, hash: string): Promise<{ id: number } | null>
    setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void>
    insert(c: any): Promise<{ inserted: boolean; id?: number }>
  }
  pendingRepo: { listPending(): Promise<Array<{ captureId: number | null }>> }
  correctionRepo: { hasOpenForCapture(captureId: number): Promise<boolean> }
}

// Resolves which `captures` row a read of this image attaches to. A seen image
// is re-read onto its existing row unless one of that row's fills still awaits
// a decision or an open correction proposed from it is still undecided. Returns the capture id, or null when the upload is a duplicate.
// Must run inside the run lock: the lookup, the status write and the caller's
// pending inserts are one decide→write span.
export async function claimCapture(
  repos: CaptureClaimRepos,
  runId: number,
  hash: string,
  status: 'parsed' | 'unparseable',
): Promise<number | null> {
  const existing = await repos.captureRepo.findByHash(runId, hash)
  if (existing) {
    const live =
      (await repos.pendingRepo.listPending()).some((p) => p.captureId === existing.id) ||
      (await repos.correctionRepo.hasOpenForCapture(existing.id))
    if (live) return null
    await repos.captureRepo.setStatus(existing.id, status)
    return existing.id
  }
  const res = await repos.captureRepo.insert({ runId, chatId: null, imageHash: hash, status })
  return res.inserted ? res.id! : null
}
