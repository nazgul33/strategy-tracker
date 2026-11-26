/** Shared plumbing for the e2e step modules (scripts/e2e.ts drives them in order), including the `ok` check counter. */
export interface VisionFill { side: string; ticker: string; shares: number; price: string; fee?: string; date?: string; orderType?: string; orderPrice?: string; orderedShares?: number | string }

export interface E2eCtx {
  ok: (cond: unknown, label: string) => void
  req: (method: string, path: string, body?: unknown, token?: string) => Response | Promise<Response>
  token: string
  /** Sends a photo through the real capture handler while the fake vision endpoint answers with `fills`. */
  photo: (fills: VisionFill[], image: { base64: string; mime: string }) => Promise<void>
  /** Posts `form` to POST /api/captures while the fake vision endpoint answers with `fills`. */
  upload: (fills: VisionFill[], form: FormData) => Promise<Response>
}

export const jsonOf = async (r: Response): Promise<any> => r.json()

let checks = 0
/** Throws on a failed check; counts and prints a passed one. */
export function ok(cond: unknown, label: string): void {
  if (!cond) throw new Error(`E2E FAILED: ${label}`)
  checks++
  console.log(`  ok  ${label}`)
}
export const checksPassed = (): number => checks
