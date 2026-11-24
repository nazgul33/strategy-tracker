// Mirrors the server's checks (apps/server/src/domain/capture-image.ts) so a bad pick is refused before upload.
export const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export function pickRefusal(file: { type: string; size: number }): 'unsupported-image' | 'image-too-large' | null {
  if (!(UPLOAD_MIMES as readonly string[]).includes(file.type)) return 'unsupported-image';
  if (file.size > MAX_UPLOAD_BYTES) return 'image-too-large';
  return null;
}

export function fileSizeText(bytes: number): string {
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
