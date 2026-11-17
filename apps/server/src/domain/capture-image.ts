import type { RepoSurface } from './booking'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

// Image types the vision path accepts; anything else is stored as the default
// Telegram applies when it sends no mime_type, so the stored value always fits
// the column and the serving route never echoes an arbitrary header.
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const DEFAULT_MIME = 'image/jpeg'

// Stores the screenshot for a capture. Resolves false, touching nothing, when the
// image is over the cap: a missing screenshot must never block booking. A repeat
// for a capture that already holds an image keeps the first bytes (repo contract).
export async function storeCaptureImage(
  repos: Pick<RepoSurface, 'captureImageRepo'>,
  captureId: number,
  image: { base64: string; mime: string },
): Promise<boolean> {
  const bytes = Buffer.from(image.base64, 'base64')
  if (bytes.length > MAX_IMAGE_BYTES) return false
  const mime = ALLOWED_MIMES.has(image.mime) ? image.mime : DEFAULT_MIME
  await repos.captureImageRepo.insertIgnore({ captureId, mime, bytes, byteLen: bytes.length })
  return true
}
