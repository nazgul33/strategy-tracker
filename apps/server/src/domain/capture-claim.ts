import type { RepoSurface } from './booking'

// Resolves which `captures` row a read of this image attaches to. A seen image
// is re-read onto its existing row unless one of that row's fills still awaits
// a decision. Returns the capture id, or null when the upload is a duplicate.
// Must run inside the run lock: the lookup, the status write and the caller's
// pending inserts are one decide→write span.
export async function claimCapture(
  repos: Pick<RepoSurface, 'captureRepo' | 'pendingRepo'>,
  runId: number,
  hash: string,
  status: 'parsed' | 'unparseable',
): Promise<number | null> {
  const existing = await repos.captureRepo.findByHash(runId, hash)
  if (existing) {
    const live = (await repos.pendingRepo.listPending()).some((p: any) => p.captureId === existing.id)
    if (live) return null
    await repos.captureRepo.setStatus(existing.id, status)
    return existing.id
  }
  const res = await repos.captureRepo.insert({ runId, chatId: null, imageHash: hash, status })
  return res.inserted ? res.id! : null
}
