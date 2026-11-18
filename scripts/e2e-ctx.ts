/** Shared plumbing for the e2e step modules (scripts/e2e.ts drives them in order). */
export interface VisionFill { side: string; ticker: string; shares: number; price: string; fee?: string; date?: string }

export interface E2eCtx {
  ok: (cond: unknown, label: string) => void
  req: (method: string, path: string, body?: unknown, token?: string) => Response | Promise<Response>
  token: string
  /** Sends a photo through the real capture handler while the fake vision endpoint answers with `fills`. */
  photo: (fills: VisionFill[], image: { base64: string; mime: string }) => Promise<void>
}

export const jsonOf = async (r: Response): Promise<any> => r.json()
